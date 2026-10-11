/**
 * The host HTTP API.
 *
 * Every route is registered `exact` on the bare `webServer`, which means the
 * host's own `/api` fence does not see them (an exact match wins over that
 * fence's prefix) — so this file is the only guard, and it applies the same
 * rules to a read as to a mutation:
 *
 *  - loopback peer only;
 *  - no forwarding headers (a proxy makes every caller look like loopback);
 *  - a `Host` naming a loopback authority (the one header a DNS-rebinding
 *    page cannot forge);
 *  - reads are GET-only, mutations POST-only, anything else 405 with `Allow`.
 *    Mutations additionally require a present, matching `Origin`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  methodNotAllowed,
  readJsonObject,
  sameOriginMutation,
  sameOriginRead,
  sendJson,
} from './http.js'
import { buildCapabilities } from './capabilities.js'
import { OperationStore } from './operations.js'
import { addArgs, applyUpdate, resolvePackageManager, runCommand, verifyAppliedVersion } from './apply.js'
import { checkUpdates, realDeps, type UpdatablePackage, type UpdateSummary } from './updates.js'
import { restartCapability } from './runtime.js'
import { scheduleRestart, servingPort } from './restart.js'
import type { HostPackageManager } from './profile.js'

/** The route prefix this plugin owns. */
export const ROUTE_PREFIX = '/dsh-market'

/** How long a finished check stays fresh, so a double-click cannot re-scan. */
export const CHECK_TTL_MS = 60 * 1000

/** Text of the last-resort answer to a request that failed the guard. */
const REFUSED = '这个请求不是从本机页面发起的，已拒绝。 / This request did not come from this machine\'s page and was refused.'

/**
 * Map an internal row onto the wire shape.
 *
 * The one translation is the source name: the engine distinguishes `local`
 * (a `link:`/`file:`/`workspace:` spec) from `unknown`, and the public contract
 * calls that case `link`. Translating on the way out keeps the internal
 * vocabulary precise while the JSON stays exactly what the client was written
 * against.
 */
function wireRow(row: UpdatablePackage): {
  readonly name: string
  readonly source: 'npm' | 'git' | 'link' | 'unknown'
  readonly installedVersion: string | null
  readonly latestVersion: string | null
} {
  return {
    name: row.name,
    source: row.source === 'local' ? 'link' : row.source,
    installedVersion: row.installedVersion,
    latestVersion: row.latestVersion,
  }
}

/** One registered route, in the shape `webServer.register` expects. */
export interface HostRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

/** Everything the route table needs that is not process-global. */
export interface RouteDeps {
  /** The active profile's directory. */
  readonly profileDir: string
  /** The active profile's name. */
  readonly profileName: string
  /** The launcher's package manager, when it published one. */
  readonly packageManager: HostPackageManager | null | undefined
  /** The launcher's bundle list, when it published one. */
  readonly startedBundles: readonly string[] | null
  /** True when the desktop shell's service was present on the host context. */
  readonly desktopService: boolean
  /** The update-check inputs; defaults to the real network. */
  readonly deps?: ReturnType<typeof realDeps>
  /** The package manager runner, injectable for tests. */
  readonly run?: typeof runCommand
  /** The restart scheduler, injectable so tests never kill their runner. */
  readonly restart?: typeof scheduleRestart
  /** The clock, injectable for tests. */
  readonly now?: () => number
}

/** A cached update summary with the time it was taken. */
interface CheckCache {
  readonly at: number
  readonly summary: UpdateSummary
}

/**
 * Build the route table for one profile.
 *
 * State that must outlive a single request (the check cache, the operations,
 * the boot id) is created here, once per mount, rather than at module scope:
 * a module-level cache would be shared between two mounts in one process — a
 * real configuration on a host that reloads its tree.
 */
export function createRoutes(deps: RouteDeps): HostRoute[] {
  const prefix = ROUTE_PREFIX
  const store = new OperationStore()
  const now = deps.now ?? (() => Date.now())
  const depsReal = deps.deps ?? realDeps(deps.profileDir)
  const run = deps.run ?? runCommand
  const restart = deps.restart ?? scheduleRestart
  const manager = resolvePackageManager(deps.packageManager)
  let cache: CheckCache | null = null
  // Captured once, at mount: this identifies THIS process, and the client uses
  // "the boot id changed" as its signal that a restart completed. Computed per
  // request it would be a constant, and the client would reload the page
  // against the old process and conclude the restart failed.
  const bootId = `${String(process.pid)}-${String(Date.now())}`
  const startedAt = now()

  /** The capabilities document, rebuilt per request so runtime state is current. */
  const capabilities = (): ReturnType<typeof buildCapabilities> => buildCapabilities({
    profile: deps.profileName,
    desktopService: deps.desktopService,
  })

  /**
   * Run an update check, reusing a recent result.
   *
   * `force` bypasses the cache. Without it a page that mounts and then polls
   * would issue a full registry scan per request, which on a profile with
   * several plugins is a burst of requests to a public registry for an answer
   * that cannot have changed in the interval.
   */
  const scan = async (force: boolean): Promise<UpdateSummary> => {
    if (!force && cache !== null && now() - cache.at < CHECK_TTL_MS) return cache.summary
    const summary = await checkUpdates(deps.profileDir, depsReal, deps.startedBundles)
    cache = { at: now(), summary }
    return summary
  }

  /** Run every named update in order, driving one operation to completion. */
  const runUpdates = async (operationId: string, names: readonly string[]): Promise<void> => {
    const summary = await scan(true)
    // A restart is what makes new bytes take effect for a plugin layer: the
    // composed tree is built at boot, so the update is only *applied* here.
    let restartRequired = false
    for (const name of names) {
      const row = summary.all.find(candidate => candidate.name === name)
      if (row === undefined || !row.updatable) {
        store.markSkipped(operationId, name, row === undefined ? 'not installed' : `not updatable (${row.reason ?? 'unknown'})`)
        continue
      }
      store.markRunning(operationId, name)
      const outcome = await applyUpdate(
        deps.profileDir,
        {
          name,
          source: row.source,
          beforeVersion: row.installedVersion,
          beforeCommit: row.installedCommit,
          target: row.source === 'npm' ? row.latestVersion : null,
          spec: row.spec,
          installed: true,
        },
        manager,
        { run },
      )
      store.markResult(operationId, name, outcome.ok, outcome.afterVersion, outcome.error)
      if (outcome.ok) restartRequired = true
    }
    store.finish(operationId, restartRequired)
  }

  /** Start an operation for `names`, answering 202 or 409. */
  const startOperation = (response: ServerResponse, names: readonly string[], from: ReadonlyMap<string, string | null>): void => {
    const operation = store.start(names, from)
    if (operation === null) {
      sendJson(response, 409, { error: 'an update is already running' })
      return
    }
    sendJson(response, 202, { operationId: operation.operationId, total: names.length })
    // Detached on purpose: the response is already written, and awaiting the
    // package manager here would hold the socket open for minutes.
    void runUpdates(operation.operationId, names).catch(error => {
      for (const name of names) store.markResult(operation.operationId, name, false, null, String(error))
      store.finish(operation.operationId, false)
    })
  }

  const routes: HostRoute[] = [
    // ---------------------------------------------------------------- ping
    {
      kind: 'exact',
      path: `${prefix}/api/ping`,
      handler: (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
        if (!sameOriginRead(request)) return sendJson(response, 403, { error: REFUSED })
        sendJson(response, 200, { ok: true, bootId, uptimeMs: now() - startedAt })
      },
    },
    // -------------------------------------------------------- capabilities
    {
      kind: 'exact',
      path: `${prefix}/api/capabilities`,
      handler: (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
        if (!sameOriginRead(request)) return sendJson(response, 403, { error: REFUSED })
        sendJson(response, 200, capabilities())
      },
    },
    // --------------------------------------------------------- updates/summary
    {
      kind: 'exact',
      path: `${prefix}/api/updates/summary`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
        if (!sameOriginRead(request)) return sendJson(response, 403, { error: REFUSED })
        const force = new URL(request.url ?? '/', 'http://localhost').searchParams.get('force') === '1'
        try {
          const summary = await scan(force)
          sendJson(response, 200, {
            checked: summary.checked,
            updatable: summary.updatable,
            packages: summary.packages.map(wireRow),
            // Rows that cannot be updated are included so a client can explain
            // a package the user expected to move, rather than leaving them to
            // guess why it is missing.
            skipped: summary.all
              .filter(row => !row.updatable)
              .map(row => ({ ...wireRow(row), reason: row.reason })),
          })
        } catch (error) {
          // A failed scan must NOT answer 200 with checked:0 — the client
          // cannot tell that apart from "a healthy profile with nothing to
          // update", and would report everything as up to date.
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------------------- updates
    {
      kind: 'exact',
      path: `${prefix}/api/updates`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
        if (!sameOriginMutation(request)) return sendJson(response, 403, { error: REFUSED })
        const body = await readJsonObject(request)
        const packageName = body?.['packageName']
        if (typeof packageName !== 'string' || packageName.trim() === '') {
          sendJson(response, 400, { error: 'packageName is required' })
          return
        }
        const name = packageName.trim()
        let summary: UpdateSummary
        try {
          summary = await scan(false)
        } catch (error) {
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const row = summary.all.find(candidate => candidate.name === name)
        if (row === undefined) {
          sendJson(response, 400, { error: `${name} is not a dependency of this profile` })
          return
        }
        if (!row.updatable) {
          sendJson(response, 400, { error: `${name} is not updatable (${row.reason ?? 'unknown'})` })
          return
        }
        startOperation(response, [name], new Map([[name, row.installedVersion]]))
      },
    },
    // ----------------------------------------------------------- updates/all
    {
      kind: 'exact',
      path: `${prefix}/api/updates/all`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
        if (!sameOriginMutation(request)) return sendJson(response, 403, { error: REFUSED })
        let summary: UpdateSummary
        try {
          // Forced: "update all" is an explicit instruction from a human, and
          // serving it a cached list could act on a state that has moved.
          summary = await scan(true)
        } catch (error) {
          sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const names = summary.packages.map(row => row.name)
        if (names.length === 0) {
          sendJson(response, 400, { error: 'no updatable plugins' })
          return
        }
        startOperation(response, names, new Map(summary.all.map(row => [row.name, row.installedVersion])))
      },
    },
    // ------------------------------------------------------------ operations
    {
      kind: 'exact',
      path: `${prefix}/api/operations`,
      handler: (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
        if (!sameOriginRead(request)) return sendJson(response, 403, { error: REFUSED })
        const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id')
          ?? new URL(request.url ?? '/', 'http://localhost').searchParams.get('operationId')
        if (id === null || id === '') {
          sendJson(response, 400, { error: 'operationId is required' })
          return
        }
        const view = store.view(id)
        if (view === undefined) {
          sendJson(response, 404, { error: 'unknown operation' })
          return
        }
        sendJson(response, 200, view)
      },
    },
    // --------------------------------------------------------------- restart
    {
      kind: 'exact',
      path: `${prefix}/api/restart`,
      handler: (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
        if (!sameOriginMutation(request)) return sendJson(response, 403, { error: REFUSED })
        const capability = restartCapability({ desktopService: deps.desktopService })
        if (!capability.supported) {
          sendJson(response, 409, { error: capability.reason, reason: capability.managedBy })
          return
        }
        // Refuse while an update runs: the package manager is mid-write to the
        // profile, and killing the host under it leaves exactly the
        // half-applied state the update path spends its effort avoiding.
        if (store.busy) {
          sendJson(response, 409, { error: 'an update is running; wait for it to finish before restarting', reason: 'update-in-progress' })
          return
        }
        const port = servingPort(request.headers.host)
        try {
          restart(port)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        sendJson(response, 202, { accepted: true })
      },
    },
  ]
  return routes
}

/** Re-exported so the entry point can describe the surface in one place. */
export { addArgs, verifyAppliedVersion }
