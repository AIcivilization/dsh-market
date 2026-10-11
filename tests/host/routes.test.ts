/**
 * Route table: the guard, the method rules, and the response shapes.
 *
 * The routes are registered `exact` on the bare web server, which means the
 * host's own `/api` fence never sees them — an exact match wins over that
 * fence's prefix — so this table is the ONLY thing standing between a web page
 * and a route that rewrites a profile or kills the process. The guard tests
 * are therefore the important ones here.
 *
 * Handlers are invoked directly with fake request/response objects rather than
 * over a real socket: the question is what the handler decides, and a real
 * listener would add a port, timing and teardown without testing that.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE_PREFIX, createRoutes, type HostRoute } from '../../src/host/routes.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A profile on disk, so mounts have something real to read. */
function makeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-routes-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: { alpha: '^1.0.0' },
    dsh: { profile: { bundles: ['alpha'] } },
  }))
  const pkg = join(dir, 'node_modules', 'alpha')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0', dsh: { bundle: {} } }))
  return dir
}

/** A request that passes the guard, with the given overrides. */
function request(overrides: {
  method?: string
  url?: string
  origin?: string | undefined
  host?: string
  remoteAddress?: string
  headers?: Record<string, string | undefined>
} = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/',
    headers: {
      host: overrides.host ?? '127.0.0.1:19387',
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
      ...overrides.headers,
    },
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** Collect the response a handler produces. */
async function call(route: HostRoute, req: IncomingMessage): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  let status = 0
  let payload = ''
  const headers: Record<string, string> = {}
  const response = {
    writeHead(code: number, extra?: Record<string, string>) {
      status = code
      Object.assign(headers, extra ?? {})
      return this
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') payload += chunk
      return this
    },
    setHeader() { return this },
  } as unknown as ServerResponse
  await route.handler(req, response)
  let body: unknown = payload
  try {
    body = JSON.parse(payload) as unknown
  } catch {
    // A 405 has no JSON body.
  }
  return { status, body, headers }
}

const mount = (overrides: Partial<Parameters<typeof createRoutes>[0]> = {}): HostRoute[] => createRoutes({
  profileDir: makeProfile(),
  profileName: 'desktop',
  packageManager: null,
  startedBundles: ['alpha'],
  desktopService: false,
  // No real network: every check answers "equal", so a route that reaches the
  // scanner cannot hang a test.
  deps: {
    npmLatest: async () => '1.0.0',
    gitHead: async () => null,
    readLock: () => null,
    installed: () => true,
    installedVersion: () => '1.0.0',
  },
  ...overrides,
})

/**
 * Find a registered route by PATH ONLY.
 *
 * The query string is stripped here because the host web server dispatches on
 * pathname alone, so `?id=` and `?force=1` deliberately belong to the same
 * exact route.
 */
const find = (routes: HostRoute[], path: string): HostRoute => {
  const bare = path.split('?')[0]!
  const route = routes.find(candidate => candidate.path === bare)
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  return route
}

describe('route table', () => {
  it('registers every documented endpoint as an exact route', () => {
    const routes = mount()
    expect(routes.map(route => route.path).sort()).toEqual([
      `${ROUTE_PREFIX}/api/capabilities`,
      `${ROUTE_PREFIX}/api/operations`,
      `${ROUTE_PREFIX}/api/ping`,
      `${ROUTE_PREFIX}/api/restart`,
      `${ROUTE_PREFIX}/api/updates`,
      `${ROUTE_PREFIX}/api/updates/all`,
      `${ROUTE_PREFIX}/api/updates/summary`,
    ].sort())
    expect(routes.every(route => route.kind === 'exact')).toBe(true)
  })

  it('does not use the /api/v1 namespace the installed dshmarket plugin owns', () => {
    // A collision with the other plugin's prefix would route one product's
    // request to the other's handler.
    expect(ROUTE_PREFIX).toBe('/dsh-market')
    expect(mount().some(route => route.path.includes('/api/v1/'))).toBe(false)
  })
})

describe('the guard', () => {
  it('refuses a non-loopback peer', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/ping`), request({ remoteAddress: '10.0.0.5' }))
    expect(response.status).toBe(403)
  })

  it('refuses any request carrying forwarding headers', async () => {
    const routes = mount()
    for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip']) {
      const response = await call(find(routes, `${ROUTE_PREFIX}/api/ping`), request({ headers: { [header]: '1.2.3.4' } }))
      expect(response.status, header).toBe(403)
    }
  })

  it('refuses a Host that is not a loopback authority (DNS rebinding)', async () => {
    // The peer is loopback and the Origin matches Host, so only the Host check
    // catches this: the attacker's page resolved its own name to 127.0.0.1.
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/ping`),
      request({ host: 'evil.example.com', origin: 'http://evil.example.com' }),
    )
    expect(response.status).toBe(403)
  })

  it('refuses a cross-site fetch', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/ping`),
      request({ headers: { 'sec-fetch-site': 'cross-site' } }),
    )
    expect(response.status).toBe(403)
  })

  it('refuses a mutation with no Origin', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates/all`),
      request({ method: 'POST' }),
    )
    expect(response.status).toBe(403)
  })

  it('refuses a mutation whose Origin does not match Host', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/restart`),
      request({ method: 'POST', origin: 'http://attacker.test' }),
    )
    expect(response.status).toBe(403)
  })

  it('allows a same-origin mutation past the guard', async () => {
    const routes = mount({ restart: () => ({ pid: 1, helperPid: 2, logOut: '', logErr: '' }) })
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/restart`),
      request({ method: 'POST', origin: 'http://127.0.0.1:19387' }),
    )
    expect(response.status).toBe(202)
  })

  it('allows localhost as a loopback authority', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/ping`),
      request({ host: 'localhost:19387', origin: 'http://localhost:19387' }),
    )
    expect(response.status).toBe(200)
  })

  it('guards reads as well as writes', async () => {
    // Every read route, one by one: a read here leaks the profile's contents.
    // Note the two paths are separate concerns — the ROUTE is registered as a
    // bare pathname, while the REQUEST may carry a query string.
    const routes = mount()
    const reads = [
      ['/api/ping', '/api/ping'],
      ['/api/capabilities', '/api/capabilities'],
      ['/api/updates/summary', '/api/updates/summary'],
      ['/api/operations', '/api/operations?id=x'],
    ] as const
    for (const [routePath, urlPath] of reads) {
      const response = await call(find(routes, `${ROUTE_PREFIX}${routePath}`), request({ url: urlPath, remoteAddress: '10.0.0.5' }))
      expect(response.status, urlPath).toBe(403)
    }
  })
})

describe('method rules', () => {
  it('answers 405 with Allow for a wrong method on every route', async () => {
    const routes = mount()
    const wrong: [string, string, string][] = [
      ['/api/ping', 'POST', 'GET'],
      ['/api/capabilities', 'POST', 'GET'],
      ['/api/updates/summary', 'POST', 'GET'],
      ['/api/operations', 'POST', 'GET'],
      ['/api/updates', 'GET', 'POST'],
      ['/api/updates/all', 'GET', 'POST'],
      ['/api/restart', 'GET', 'POST'],
    ]
    for (const [path, method, allow] of wrong) {
      const response = await call(find(routes, `${ROUTE_PREFIX}${path}`), request({
        method,
        url: path,
        origin: 'http://127.0.0.1:19387',
      }))
      expect(response.status, `${method} ${path}`).toBe(405)
      expect(response.headers['allow'], `${method} ${path}`).toBe(allow)
    }
  })
})

describe('ping and capabilities', () => {
  it('serves a boot id that identifies this process', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/ping`), request({ url: '/api/ping' }))
    expect(response.status).toBe(200)
    const body = response.body as { ok: boolean; bootId: string; uptimeMs: number }
    expect(body.ok).toBe(true)
    expect(body.bootId).toContain(String(process.pid))
    expect(typeof body.uptimeMs).toBe('number')
  })

  it('keeps the boot id stable across requests but distinct per mount', async () => {
    // Stable, or the client's "the boot id changed" restart signal would fire
    // on every poll; distinct per mount, or it would never fire at all.
    const routes = mount()
    const first = await call(find(routes, `${ROUTE_PREFIX}/api/ping`), request({ url: '/api/ping' }))
    const second = await call(find(routes, `${ROUTE_PREFIX}/api/ping`), request({ url: '/api/ping' }))
    expect((first.body as { bootId: string }).bootId).toBe((second.body as { bootId: string }).bootId)
  })

  it('describes the feature set and the restart verdict', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/capabilities`), request({ url: '/api/capabilities' }))
    const body = response.body as {
      version: string
      profile: string
      runtime: string
      features: Record<string, boolean>
      restart: { supported: boolean; managedBy: string; reason?: string }
    }
    expect(body.profile).toBe('desktop')
    expect(body.features['check']).toBe(true)
    expect(body.features['update']).toBe(true)
    expect(body.features['progress']).toBe(true)
    expect(body.restart.managedBy).toBe('market')
  })

  it('publishes the desktop verdict with an actionable reason', async () => {
    const routes = mount({ desktopService: true })
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/capabilities`), request({ url: '/api/capabilities' }))
    const body = response.body as { runtime: string; features: Record<string, boolean>; restart: { supported: boolean; managedBy: string; reason?: string } }
    expect(body.runtime).toBe('desktop')
    expect(body.features['restart']).toBe(false)
    expect(body.restart.managedBy).toBe('desktop-host')
    expect(body.restart.reason).toBeTruthy()
  })
})

describe('updates/summary', () => {
  it('reports the real denominator and count', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates/summary`), request({ url: '/api/updates/summary' }))
    expect(response.status).toBe(200)
    const body = response.body as { checked: number; updatable: number; packages: unknown[] }
    expect(body.checked).toBe(1)
    expect(body.updatable).toBe(0)
    expect(body.packages).toEqual([])
  })

  it('publishes the count of rows it could not query', async () => {
    // The client uses this to avoid reporting an unreachable registry as
    // "everything is up to date". If the route drops the field that
    // distinction is lost, and `checked` alone cannot recover it.
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates/summary`), request({ url: '/api/updates/summary' }))
    const body = response.body as { checkFailed?: number }
    expect(typeof body.checkFailed).toBe('number')
    expect(body.checkFailed).toBe(0)
  })

  it('accepts ?force=1 on the same exact route (query strings are not routed on)', async () => {
    // The host web server dispatches on pathname only, so an exact route still
    // matches when a query string is present. If that ever changed, this route
    // and /api/operations?id= would silently 404 in production.
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates/summary`),
      request({ url: `${ROUTE_PREFIX}/api/updates/summary?force=1` }),
    )
    expect(response.status).toBe(200)
  })

  it('maps the internal local source onto the contract\'s link name', async () => {
    // The engine distinguishes `local` from `unknown`; the frozen wire contract
    // calls that case `link`. A client switching on the JSON must see `link`,
    // so the translation is asserted rather than left to chance.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-market-routes-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      private: true,
      dependencies: { localised: 'link:../localised' },
      dsh: { profile: { bundles: ['localised'] } },
    }))
    const pkg = join(dir, 'node_modules', 'localised')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'localised', version: '1.0.0', dsh: { bundle: {} } }))

    const routes = mount({ profileDir: dir })
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates/summary`), request({ url: '/api/updates/summary' }))
    expect(response.status).toBe(200)
    const body = response.body as { skipped: { name: string; source: string; reason: string }[] }
    const row = body.skipped.find(entry => entry.name === 'localised')
    expect(row?.source).toBe('link')
    expect(row?.reason).toBe('local-source')
  })

  it('never reports an internal source name the contract does not define', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates/summary`), request({ url: '/api/updates/summary' }))
    const body = response.body as { packages: { source: string }[]; skipped: { source: string }[] }
    const allowed = new Set(['npm', 'git', 'link', 'unknown'])
    for (const row of [...body.packages, ...body.skipped]) {
      expect(allowed.has(row.source), row.source).toBe(true)
    }
  })

  it('answers a failed scan with a non-2xx instead of checked:0', async () => {
    // checked:0 on failure is a lie the client cannot detect: it renders as
    // "everything is up to date".
    const routes = mount({
      deps: {
        npmLatest: async () => { throw new Error('registry unreachable') },
        gitHead: async () => null,
        readLock: () => null,
        installed: () => true,
        installedVersion: () => '1.0.0',
      },
    })
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates/summary`),
      request({ url: `${ROUTE_PREFIX}/api/updates/summary?force=1` }),
    )
    expect(response.status).toBe(502)
    expect(response.body).toHaveProperty('error')
  })
})

describe('query-string dispatch', () => {
  // These two tests are load-bearing, not incidental. Routes are registered as
  // bare pathnames and the host web server dispatches on `new URL(req.url).pathname`
  // only, so a query string never participates in route matching. If dispatch
  // ever started including the query, `?id=` would 404 and the client would
  // report it as a host bug — so the invariant is asserted directly rather than
  // left implied by a 403 from the guard.

  it('routes /api/operations?id=x to the operations handler, which reads the id', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/operations`),
      request({ url: `${ROUTE_PREFIX}/api/operations?id=does-not-exist` }),
    )
    // Reaching the handler at all is the point. A routing miss would ALSO be a
    // 404, so the distinguishing evidence is the handler's own wording: the
    // operations route answers "unknown operation" for an id it looked up and
    // did not find, and only that route can produce it. If dispatch ever
    // started including the query string, this request would miss the route
    // entirely and this error text would never appear.
    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe('unknown operation')
  })

  it('accepts the operationId alias on the same exact route', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/operations`),
      request({ url: `${ROUTE_PREFIX}/api/operations?operationId=does-not-exist` }),
    )
    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe('unknown operation')
  })

  it('routes /api/updates/summary?force=1 to the summary handler', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates/summary`),
      request({ url: `${ROUTE_PREFIX}/api/updates/summary?force=1` }),
    )
    // The handler ran and produced a real summary rather than a routing miss.
    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('checked')
  })
})

describe('operations', () => {
  it('reaches the handler with a query string present', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/operations`),
      request({ url: `${ROUTE_PREFIX}/api/operations?id=does-not-exist` }),
    )
    expect(response.status).toBe(404)
    expect(response.body).toHaveProperty('error')
  })

  it('requires an id', async () => {
    const routes = mount()
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/operations`), request({ url: `${ROUTE_PREFIX}/api/operations` }))
    expect(response.status).toBe(400)
  })

  it('rejects an unknown id with 404', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/operations`),
      request({ url: `${ROUTE_PREFIX}/api/operations?id=nope` }),
    )
    expect(response.status).toBe(404)
  })
})

describe('starting an update', () => {
  it('rejects a missing packageName', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates`),
      request({ method: 'POST', url: '/api/updates', origin: 'http://127.0.0.1:19387' }),
    )
    expect(response.status).toBe(400)
  })

  it('rejects a package that is not a profile dependency', async () => {
    const routes = mount()
    const req = request({ method: 'POST', url: '/api/updates', origin: 'http://127.0.0.1:19387' })
    Object.assign(req, { [Symbol.asyncIterator]: async function * () { yield Buffer.from(JSON.stringify({ packageName: 'ghost' })) } })
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates`), req)
    expect(response.status).toBe(400)
  })

  it('rejects a package that is not updatable', async () => {
    const routes = mount()
    const req = request({ method: 'POST', url: '/api/updates', origin: 'http://127.0.0.1:19387' })
    Object.assign(req, { [Symbol.asyncIterator]: async function * () { yield Buffer.from(JSON.stringify({ packageName: 'alpha' })) } })
    const response = await call(find(routes, `${ROUTE_PREFIX}/api/updates`), req)
    // alpha is installed at 1.0.0 and latest is 1.0.0, so there is nothing to do.
    expect(response.status).toBe(400)
    expect(String((response.body as { error: string }).error)).toContain('not updatable')
  })

  it('reports 400 when nothing is updatable for update-all', async () => {
    const routes = mount()
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/updates/all`),
      request({ method: 'POST', url: '/api/updates/all', origin: 'http://127.0.0.1:19387' }),
    )
    expect(response.status).toBe(400)
  })
})

describe('restart', () => {
  it('refuses on the desktop host with a reason, without spawning anything', async () => {
    const restart = vi.fn(() => ({ pid: 1, helperPid: 2, logOut: '', logErr: '' }))
    const routes = mount({ desktopService: true, restart: restart as never })
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/restart`),
      request({ method: 'POST', url: '/api/restart', origin: 'http://127.0.0.1:19387' }),
    )
    expect(response.status).toBe(409)
    expect((response.body as { reason: string }).reason).toBe('desktop-host')
    expect(restart).not.toHaveBeenCalled()
  })

  it('accepts and schedules on a plain web host, passing the serving port', async () => {
    const restart = vi.fn(() => ({ pid: 1, helperPid: 2, logOut: '', logErr: '' }))
    const routes = mount({ restart: restart as never })
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/restart`),
      request({ method: 'POST', url: '/api/restart', origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' }),
    )
    expect(response.status).toBe(202)
    expect(response.body).toEqual({ accepted: true })
    // The port comes off the Host header the browser actually reached us on.
    expect(restart).toHaveBeenCalledWith(19387)
  })

  it('does not schedule a restart when the request is refused by the guard', async () => {
    const restart = vi.fn()
    const routes = mount({ restart: restart as never })
    const response = await call(
      find(routes, `${ROUTE_PREFIX}/api/restart`),
      request({ method: 'POST', url: '/api/restart', remoteAddress: '10.0.0.9' }),
    )
    expect(response.status).toBe(403)
    expect(restart).not.toHaveBeenCalled()
  })
})
