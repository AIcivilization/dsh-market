/**
 * Self-restart: relaunch the exact DSH invocation that booted this host so a
 * pending plugin change takes effect without the user leaving the UI.
 *
 * The technique, and why each part of it is load-bearing:
 *
 *  1. A DETACHED helper is spawned, not the replacement directly. The helper
 *     has to outlive this process: if we spawned the replacement as a child
 *     of the host, the host's exit would take it down with it.
 *
 *  2. The helper WAITS FOR THE PORT TO GO QUIET before starting the
 *     replacement. A flat sleep is not enough — the process exits but its
 *     listening socket is not released immediately, so the replacement dies
 *     instantly with EADDRINUSE and the user sees a button that does
 *     nothing. The helper probes by CONNECTING, because binding to test would
 *     itself hold the port for the moment the replacement needs it.
 *
 *  3. It WRITES A LOG. A restart that fails is invisible by construction: the
 *     process that would have logged the failure is the one that just exited.
 *     The helper is the only surviving witness, so it records what it did.
 *
 *  4. The launch replays `process.argv` (entry script plus the original
 *     arguments), with ABSOLUTE paths: a source launch passes a relative
 *     entry that the child would resolve against its own cwd and die with
 *     MODULE_NOT_FOUND.
 */

import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { detectRuntime } from './runtime.js'

/** The Node binary to run the helper with. */
export function nodeExecutable(argv0: string | undefined = process.argv0, execPath: string = process.execPath): string {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/**
 * The boot invocation to replay for a DESKTOP host.
 *
 * On a desktop host there is nothing inside this process worth replaying: we
 * are a `spawn`ed child of the Electron shell, and the thing that must come
 * back is the whole application. The shell does this itself with
 *
 *   app.relaunch(); quitWithoutConfirmation()
 *
 * which is exactly `open -n -a <bundle>` followed by a non-interactive quit.
 * We cannot call `app.relaunch()` — it lives in the Electron main process, and
 * the shell rejects every IPC message outside its own six-type whitelist — so
 * we reproduce its effect from outside the process instead.
 *
 * `-n` is load-bearing, not cosmetic. The app takes a single-instance lock and
 * routes a second launch to `focusPrimaryWindow()`; a plain `open` while the
 * old app is still alive would therefore just focus the existing window and
 * change nothing. `-n` asks for a genuinely new instance, which only succeeds
 * once the old one has released the lock — and the helper already waits for the
 * port to go quiet before spawning, so the ordering is correct by construction.
 *
 * `open` is addressed by bundle identifier rather than name: a display name can
 * be renamed or localized, while `com.deepseek.dsh` is stable. The bundle path
 * is recovered from the Electron shell's argv when it can be, so an app that
 * lives somewhere unusual is relaunched from where it actually is.
 */
export function desktopRelaunch(bundleId: string, bundlePath?: string): { file: string; args: string[]; cwd: string; viaShell: boolean } {
  const args = bundlePath !== undefined && bundlePath !== ''
    ? ['-n', bundlePath]
    : ['-n', '-b', bundleId]
  return { file: 'open', args, cwd: process.cwd(), viaShell: false }
}

/**
 * The Electron application bundle that owns this process, if it can be found.
 *
 * The desktop host is launched as
 * `<bundle>/Contents/MacOS/<exe> --expose-internals <host entry> …`, so argv[0]
 * is the shell's own executable and the bundle is the third ancestor from it.
 * Falls back to undefined, which makes the relaunch address the bundle by
 * identifier instead.
 */
export function electronBundlePath(argv0: string | undefined = process.argv0): string | undefined {
  if (argv0 === undefined || argv0 === '') return undefined
  const match = /^(.*\.app)\/Contents\/MacOS\//.exec(argv0)
  return match?.[1]
}

/**
 * The exact boot invocation to replay.
 *
 * When argv[1] looks like a DSH entry (`bin.js`, `bin.ts`, `dsh`) the child is
 * started as `node <absolute entry> <original args>`, with cwd beside the
 * entry so `execArgv` imports (tsx/esm) still resolve on a source launch.
 * Otherwise the process was started through a PATH shim, which only a shell
 * can run on Windows.
 */
export function restartLaunch(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
  cwd: string = process.cwd(),
): { file: string; args: string[]; cwd: string; viaShell: boolean } {
  const entry = argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const absolute = resolve(entry)
    return { file: nodeExecutable(), args: [...execArgv, absolute], cwd: dirname(absolute), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd, viaShell: process.platform === 'win32' }
}

/**
 * Platform-correct spawn invocation for the replacement.
 *
 * On Windows a `detached` spawn maps to DETACHED_PROCESS, so the new host gets
 * NO console — and every console child it later spawns pops a visible window.
 * Wrapping the launch in `powershell -WindowStyle Hidden` gives the host a
 * hidden console that its children inherit instead. POSIX keeps the plain
 * detached spawn.
 */
export function respawnInvocation(
  launch: { file: string; args: string[]; viaShell: boolean },
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; viaShell: boolean; detached: boolean } {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  const quote = (part: string): string => `'${part.replace(/'/g, "''")}'`
  const file = launch.viaShell && !/\.(?:cmd|bat)$/i.test(launch.file) ? `${launch.file}.cmd` : launch.file
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  }
}

/**
 * The port this process is serving on, read off the request that asked for the
 * restart.
 *
 * The alternative is parsing it out of the launch argv, which is wrong for
 * every host that binds from config or an environment variable. The `Host`
 * header is what the browser actually reached us on, so it is the port the
 * replacement has to take over — and it has already been validated against
 * `Origin` by the route's guard before this runs.
 */
export function servingPort(host: string | undefined): number | null {
  if (host === undefined) return null
  const match = /:(\d{1,5})$/.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** What a scheduled restart reports back for logging and the response. */
export interface RestartResult {
  readonly pid: number
  readonly helperPid: number | undefined
  readonly logOut: string
  readonly logErr: string
  /** Whether this restarted the whole Electron app rather than the host. */
  readonly desktop: boolean
}

/**
 * Source for the detached helper.
 *
 * Emitted as a string for `node -e` rather than written to a file: the helper
 * must run even from a source checkout where no built sibling exists, and a
 * `-e` program cannot be broken by a stale build artifact.
 *
 * Every literal is JSON-encoded, so a path with a quote or a backslash cannot
 * escape into the program text.
 */
export function restartHelperSource(
  spawned: { file: string; args: string[]; viaShell: boolean; detached: boolean },
  launch: { cwd: string },
  logs: { out: string; err: string },
  port: number | null,
  dying: number | null = null,
): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    `const dying = ${JSON.stringify(dying)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, "[dsh-market] " + line + "\\n") } catch {} }',
    'process.on("exit", (code) => note("helper exiting (code " + code + ")"))',
    'process.on("uncaughtException", (e) => note("helper crashed: " + (e && e.stack ? e.stack : e)))',
    'process.on("unhandledRejection", (e) => note("helper rejection: " + (e && e.stack ? e.stack : e)))',
    // "Free" means nothing accepts a connection. Probed by connecting rather
    // than binding: binding to test would hold the port for the moment the
    // replacement needs it.
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    // `process.kill(pid, 0)` asks the OS whether the process still exists
    // without delivering a signal. EPERM means it exists but is not ours.
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e && e.code === "EPERM" } }',
    'const main = async () => {',
    '  note("helper up (pid " + process.pid + ") for port " + port + ", waiting on " + dying)',
    // THE ORDER THAT MATTERS. On macOS the replacement is an Electron app
    // guarded by requestSingleInstanceLock(), and the old app holds that lock
    // until its process is GONE — it is never released explicitly. Launching
    // while the old app is still dying lets the new instance start, fail the
    // lock, and call application.quit() on itself: `open -n` exits 0 and
    // nothing appears. The port goes quiet well before the lock frees, so
    // waiting on the port is not enough — we wait for the process itself.
    '  if (dying) {',
    '    const deadline = Date.now() + 30000',
    '    while (Date.now() < deadline && alive(dying)) await sleep(200)',
    '    note(alive(dying) ? "old process " + dying + " still alive after 30s; launching anyway" : "old process " + dying + " is gone; the single-instance lock is free")',
    '    await sleep(400)',
    '  }',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note("port " + port + " was still in use after 30s; starting anyway")',
    // A released socket can still sit in TIME_WAIT for a moment.
    '    await sleep(300)',
    '    note("port " + port + " is free; starting the replacement")',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell, windowsHide: true })',
    // spawn reports a missing or unexecutable file ASYNCHRONOUSLY; without
    // this listener that failure is exactly as silent as the bug it prevents.
    '    child.on("error", (e) => note("could not start the replacement: " + (e && e.message ? e.message : e)))',
    '    child.unref()',
    '    note("replacement started (pid " + child.pid + ")")',
    '  } catch (e) {',
    '    note("could not start the replacement: " + (e && e.message ? e.message : e))',
    '    return',
    '  }',
    // Outliving the spawn matters on Windows: a helper that exits the instant
    // it has spawned can take the replacement with it, because the child is in
    // its process group and has not finished detaching.
    '  if (!port) { await sleep(3000); return }',
    '  const SETTLE_MS = 8000',
    '  const upBy = Date.now() + 45000 + SETTLE_MS',
    '  let steadySince = null',
    '  while (Date.now() < upBy) {',
    // Success is not "the port answered once": a boot that fails its
    // activation audit has already bound the port by the time the audit runs.
    // The port has to answer CONTINUOUSLY for SETTLE_MS instead.
    '    if (await listening()) { if (steadySince === null) steadySince = Date.now(); if (Date.now() - steadySince >= SETTLE_MS) { note("replacement is serving on port " + port); return } }',
    '    else steadySince = null',
    '    await sleep(250)',
    '  }',
    '  note("the replacement never came up on port " + port + " — see the log above")',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Spawn the detached helper, then ask this process to exit.
 *
 * The exit is deferred by a moment so the HTTP response is flushed first:
 * answering 202 and then dying immediately can cut the response off, which
 * the client sees as a failed request and reports as "the button did nothing".
 *
 * @param port - the port the replacement must bind, when it is known.
 * @param schedule - how the current process is asked to stop; injectable so
 *   tests never kill their own runner.
 * @param plan - the launch to replay and how to stop; defaults to the plan for
 *   the detected runtime.
 */
export function scheduleRestart(
  port: number | null,
  schedule: (fn: () => void) => void = fn => { setTimeout(fn, 500) },
  stop?: () => void,
  deps: { readonly spawnHelper?: typeof spawn; readonly plan?: RestartPlan } = {},
): RestartResult {
  const plan = deps.plan ?? restartPlan(detectRuntime(process.argv, process.env) === 'desktop')
  const launch = plan.launch
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-market-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-market-restart-${stamp}.err.log`)
  const helperSpawn = deps.spawnHelper ?? spawn
  const helper = helperSpawn(
    nodeExecutable(),
    ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port, plan.dying)],
    { detached: true, stdio: 'ignore', env: process.env },
  )
  helper.unref()
  // The delay lets the 202 response flush before the process goes away; a
  // response cut off mid-write reads to the client as a failed request, which
  // is indistinguishable from "the button did nothing".
  const stopper = stop ?? plan.stop
  schedule(() => { stopper() })
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr, desktop: plan.desktop }
}

/**
 * Which launch to replay, and which process to stop afterwards.
 *
 * A web host replays its own invocation and stops itself. A desktop host
 * relaunches the application bundle and stops the whole app, because the host
 * it is running in is a child that the shell would otherwise keep alive.
 */
export interface RestartPlan {
  readonly launch: { file: string; args: string[]; cwd: string; viaShell: boolean }
  /** How the process that owns the port is asked to stop. */
  readonly stop: () => void
  /** Whether this plan relaunches the Electron bundle rather than the host. */
  readonly desktop: boolean
  /**
   * The process that must EXIT before the launch is attempted, or null.
   *
   * On the desktop this is the whole Electron application: it owns the
   * single-instance lock, and the lock only frees when the process is gone.
   * Launching earlier makes the replacement quit itself on the failed lock —
   * a silent no-op whose only symptom is "I quit and nothing came back".
   */
  readonly dying: number | null
}

/**
 * Build the restart plan for the detected runtime.
 *
 * @param desktop - whether the Electron shell owns this process.
 * @returns the launch to replay and how to stop the current process.
 */
export function restartPlan(desktop: boolean): RestartPlan {
  if (!desktop) {
    return {
      launch: restartLaunch(),
      stop: () => { process.kill(process.pid, 'SIGTERM') },
      desktop: false,
      dying: null,
    }
  }
  // Electron spawns the desktop host, which is this process, so the shell is
  // our PARENT — not, as it is tempting to write, the parent's parent.
  // Signalling it is what `quitWithoutConfirmation()` amounts to from outside;
  // the app's single-instance lock is then free for the relaunched bundle to
  // take.
  const shellPid = process.ppid
  return {
    launch: desktopRelaunch(DESKTOP_BUNDLE_ID, electronBundlePath()),
    stop: () => {
      try {
        process.kill(shellPid, 'SIGTERM')
      } catch {
        // The shell may already be gone; the relaunch is still correct.
      }
    },
    desktop: true,
    dying: shellPid,
  }
}

/**
 * The desktop plan for tests and probes, with real signalling neutralised.
 *
 * `restartPlan(true).stop()` sends SIGTERM to the parent process, which is
 * exactly right in production and exactly wrong under a test runner — the
 * runner is the parent, so invoking it kills the suite mid-file. Callers that
 * want to exercise the launch command without arming a signal use this.
 *
 * @param signal - what to do instead of signalling; records or ignores.
 * @returns the desktop plan with a recording stop.
 */
export function desktopPlanForTest(signal: (pid: number) => void = () => {}): RestartPlan {
  const plan = restartPlan(true)
  return { ...plan, stop: () => { signal(process.ppid) } }
}

/** The Electron application's stable bundle identifier. */
const DESKTOP_BUNDLE_ID = 'com.deepseek.dsh'

/** Whether this host may restart at all — the runtime's own answer. */
export function restartSupported(desktopService = false): boolean {
  return detectRuntime(process.argv, process.env, desktopService) === 'web'
}
