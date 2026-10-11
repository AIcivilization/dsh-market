/**
 * Applying an update, and the verification that makes it safe.
 *
 * Two lessons from the prior art shape this file, and both are about *not*
 * trusting the package manager's exit code:
 *
 *  - `pnpm add` exits 0 for a great many outcomes that are not the update the
 *    user asked for. A `latest` dist-tag that lags behind a pinned install
 *    rewrites the pin DOWNWARD and the profile stops booting; a mirror that
 *    serves a stale tarball installs the version that was already there and
 *    reports success. So the run is judged by what landed on disk, compared
 *    against what was asked for, in both directions:
 *      DOWNGRADE_DETECTED        — the version went backwards. Fatal.
 *      RESOLVED_VERSION_MISMATCH — the version is below the one requested. Fatal.
 *    Getting a version ABOVE the target is accepted: `latest` can move forward
 *    while a large package is still downloading, and rejecting the newer
 *    release would roll back a good update.
 *
 *  - The parent process may be the plugin being updated. The running code is
 *    already in memory, so "it activated" is not evidence that the bytes on
 *    disk changed.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, isUpgrade } from './semver.js'
import { readInstalledVersion, type HostPackageManager } from './profile.js'

/** Why an applied update was rejected after the package manager ran. */
export type VersionFailureCode = 'DOWNGRADE_DETECTED' | 'RESOLVED_VERSION_MISMATCH' | 'ENTRY_MISSING'

/** The outcome of one package manager run. */
export interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** A package manager invocation, resolved for this host. */
export interface PackageManagerInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /**
   * How the invocation was found. Reported so a failure can say whether the
   * host supplied its own manager or this fell back to PATH.
   */
  readonly origin: 'host' | 'path'
}

/** How long a single package manager run may take. */
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Resolve the package manager to run against a profile.
 *
 * The host's published manager is preferred and, when present, used
 * exclusively: a packaged desktop host ships its own pnpm and an Electron
 * runtime rather than a PATH executable, and mixing its command with a PATH
 * `pnpm` would run a different major against the same store. Only when the
 * host publishes nothing does this fall back to `pnpm` on PATH.
 */
/**
 * Decide which package manager to invoke.
 *
 * When the host published one, it is used EXCLUSIVELY: a host that publishes a
 * `packageManager` has decided how its profile is managed, and mixing that with
 * a PATH lookup would run two different managers against one profile.
 *
 * `undefined` is accepted as well as `null`, and that is deliberate rather than
 * defensive noise: the published value reaches here through an OPTIONAL field,
 * so "absent" and "explicitly nothing" are the same situation, and both mean
 * "fall back to a PATH lookup for pnpm". A `!== null` test alone would let
 * `undefined` through to the dereference below and throw — from inside
 * `createRoutes`, which runs inside the plugin's activation, so the symptom
 * would be both buttons silently vanishing with a stack trace in the host log.
 */
export function resolvePackageManager(published: HostPackageManager | null | undefined): PackageManagerInvocation {
  if (published !== null && published !== undefined) {
    return { command: published.command, args: published.args, env: published.env, origin: 'host' }
  }
  return { command: 'pnpm', args: [], env: {}, origin: 'path' }
}

/**
 * Whether `-w` must be injected for an `add` in this profile.
 *
 * pnpm 9 refuses to add at a workspace root without `-w`, and every pnpm
 * major refuses `-w` when the directory is NOT a workspace. The flag is
 * therefore injected exactly when the profile has a `pnpm-workspace.yaml`.
 */
export function workspaceArgs(dir: string, args: readonly string[]): readonly string[] {
  const [verb, ...rest] = args
  if (verb !== 'add' && verb !== 'remove' && verb !== 'install') return args
  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) return args
  if (rest.includes('-w') || rest.includes('--workspace-root')) return args
  return [verb, '-w', ...rest]
}

/**
 * Run a command to completion, capturing both streams.
 *
 * A timeout kills the child rather than abandoning it: a package manager left
 * running would keep mutating the profile after the operation was reported as
 * failed, which is the half-applied state this module exists to avoid.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise(resolve => {
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // A `.cmd` shim on Windows can only be started by a shell.
        shell: process.platform === 'win32',
      })
    } catch (error) {
      finish({ exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    // spawn reports a missing or unexecutable file asynchronously; without
    // this listener that failure is completely silent.
    child.on('error', (error: Error) => {
      finish({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
    child.on('close', (code: number | null) => {
      finish({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

/** The arguments that install a specific spec into a profile. */
export function addArgs(name: string, target: string, dir: string): readonly string[] {
  return workspaceArgs(dir, ['add', `${name}@${target}`, '--reporter', 'append-only'])
}

/**
 * What an update run is allowed to change, and what it must be checked against.
 *
 * `target` is the version this run asked for and is authoritative for
 * verification. It is null only for a git source, which has no version to
 * compare and is judged by commit instead.
 */
export interface UpdatePlan {
  readonly name: string
  readonly source: 'npm' | 'git' | 'local' | 'unknown'
  beforeVersion: string | null
  readonly beforeCommit: string | null
  /** The version this run asks for; authoritative for verification. */
  readonly target: string | null
  /** The git spec to reinstall, for a git source. */
  readonly spec?: string
  readonly installed: boolean
}

/** The verified outcome of applying one update. */
export interface ApplyOutcome {
  readonly name: string
  readonly ok: boolean
  readonly beforeVersion: string | null
  readonly afterVersion: string | null
  readonly target: string | null
  /** Set only when the run was rejected after the fact. */
  readonly failureCode: VersionFailureCode | null
  /** True when the package manager itself failed or timed out. */
  readonly commandFailed: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
  /** The user-facing message, when `ok` is false. */
  readonly error: string | null
  /**
   * The on-disk version is newer than before but the run reported failure —
   * the spec was changed even though the package manager objected.
   */
  readonly changedButFailed: boolean
}

/**
 * Decide whether the bytes that landed match what the run asked for.
 *
 * Pure, so the two failure modes are unit-testable without running pnpm:
 * a version that went backwards is a downgrade whatever the target said, and
 * a version below an explicitly requested target is a mismatch. A version
 * ABOVE the target is accepted — see the file header.
 *
 * @returns the failure code, or null when the result is acceptable.
 */
export function verifyAppliedVersion(
  before: string | null,
  after: string | null,
  target: string | null,
  source: 'npm' | 'git' | 'local' | 'unknown',
): VersionFailureCode | null {
  if (source !== 'npm') return null
  if (after === null) return 'ENTRY_MISSING'
  if (before !== null) {
    const direction = compareVersions(after, before)
    if (direction !== null && direction < 0) return 'DOWNGRADE_DETECTED'
  }
  if (target === null) return null
  const order = compareVersions(after, target)
  if (order === null) return after === target ? null : 'RESOLVED_VERSION_MISMATCH'
  return order < 0 ? 'RESOLVED_VERSION_MISMATCH' : null
}

/**
 * Decide whether a run that reported success actually delivered the update.
 *
 * A run that exits 0 while the on-disk version is unchanged has not updated
 * anything — the classic shape is a registry mirror serving a stale tarball,
 * or pnpm's fresh-release hold silently declining to move. Reporting success
 * there is worse than reporting failure, because the user stops looking.
 */
export function deliveredUpdate(plan: UpdatePlan, afterVersion: string | null, afterCommit: string | null): boolean {
  if (plan.source === 'git') {
    if (plan.beforeCommit === null || afterCommit === null) return true
    return plan.beforeCommit !== afterCommit
  }
  if (plan.target === null) return true
  if (afterVersion === null) return false
  return isUpgrade(plan.beforeVersion, afterVersion) || afterVersion === plan.target
}

/** Read the installed version of a package, tolerating a missing tree. */
function versionNow(dir: string, name: string): string | null {
  return readInstalledVersion(dir, name)
}

/** Whether the package's declared entry artifact exists, when it declares one. */
export function hasLoadableEntry(dir: string, name: string): boolean {
  const manifestPath = join(dir, 'node_modules', name, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: unknown }
    // A package that declares an entry point must have it on disk; a
    // source-only tarball from a mirror is the reported failure this catches.
    const declared = typeof manifest.main === 'string' ? manifest.main : null
    if (declared === null) return true
    return existsSync(join(join(dir, 'node_modules', name), declared))
  } catch {
    return true
  }
}

/**
 * Apply one update, then verify it.
 *
 * The verification runs on every path, including the one where the package
 * manager failed: a failed run can still have moved the version, and that is
 * precisely the half-applied state worth noticing. The caller decides what to
 * do about it — this function only reports what is true on disk now.
 *
 * @param dir - the profile directory.
 * @param plan - what the run is allowed to change.
 * @param manager - the resolved package manager invocation.
 * @param deps - injectable pieces, for tests.
 */
export async function applyUpdate(
  dir: string,
  plan: UpdatePlan,
  manager: PackageManagerInvocation,
  deps: {
    readonly run?: typeof runCommand
    readonly versionNow?: (name: string) => string | null
  } = {},
): Promise<ApplyOutcome> {
  const run = deps.run ?? runCommand
  const readVersion = deps.versionNow ?? ((name: string) => versionNow(dir, name))
  const target = plan.target
  // A git source is reinstalled by spec (its branch or commit), because there
  // is no version to name; an npm source is reinstalled by the exact version
  // this run verified against, never by a floating tag — pinning is what keeps
  // a `latest` that moves mid-download from mattering.
  const spec = plan.source === 'git' ? (plan.spec ?? '') : (target ?? 'latest')
  const result = await run(manager.command, [...manager.args, ...addArgs(plan.name, spec, dir)], {
    cwd: dir,
    env: manager.env,
  })
  const afterVersion = readVersion(plan.name)
  const commandFailed = result.exitCode !== 0 || result.timedOut

  if (commandFailed) {
    return {
      name: plan.name,
      ok: false,
      beforeVersion: plan.beforeVersion,
      afterVersion,
      target,
      failureCode: null,
      commandFailed: true,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.timedOut
        ? `${plan.name}: the package manager did not finish within ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s and was stopped`
        : `${plan.name}: the package manager exited with code ${String(result.exitCode)}`,
      changedButFailed: afterVersion !== plan.beforeVersion,
    }
  }

  const failureCode = verifyAppliedVersion(plan.beforeVersion, afterVersion, target, plan.source)
  if (failureCode !== null) {
    return {
      name: plan.name,
      ok: false,
      beforeVersion: plan.beforeVersion,
      afterVersion,
      target,
      failureCode,
      commandFailed: false,
      exitCode: result.exitCode,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
      error: failureCode === 'DOWNGRADE_DETECTED'
        ? `${plan.name} resolved to v${afterVersion ?? 'unknown'}, below the installed v${plan.beforeVersion ?? 'unknown'}; the downgrade was rejected`
        : failureCode === 'ENTRY_MISSING'
          ? `${plan.name}: the package manager reported success but nothing is installed at that path now`
          : `${plan.name} targeted v${target ?? 'unknown'} but installed v${afterVersion ?? 'unknown'}`,
      changedButFailed: true,
    }
  }

  const delivered = deliveredUpdate(plan, afterVersion, null)
  return {
    name: plan.name,
    ok: delivered,
    beforeVersion: plan.beforeVersion,
    afterVersion,
    target,
    failureCode: delivered ? null : 'RESOLVED_VERSION_MISMATCH',
    commandFailed: false,
    exitCode: result.exitCode,
    timedOut: false,
    stdout: result.stdout,
    stderr: result.stderr,
    error: delivered
      ? null
      : `${plan.name} reported success but is still at v${afterVersion ?? 'unknown'} (wanted ${target ?? 'latest'})`,
    changedButFailed: !delivered,
  }
}
