/**
 * Which host this process is running under, and whether it may restart
 * itself.
 *
 * Restarting is the one action here that can destroy the user's session, so
 * it is gated on evidence rather than a single guess. Three cases, in order
 * of how much they constrain us:
 *
 *  - A **supervisor** (systemd, launchd, pm2) owns restarts. Under systemd's
 *    default `KillMode=control-group` everything in the unit's cgroup dies
 *    with the main process, including the detached helper that was supposed
 *    to bring the replacement up — so "restart" kills a service and nothing
 *    comes back.
 *
 *  - The **Electron desktop host** owns the process. It spawns a
 *    `dsh-desktop-host` child that owns the profile; killing that child from
 *    inside leaves the app with a dead profile and no way to bring it back,
 *    because the relaunch belongs to the shell.
 *
 *  - A plain **web** host (`dsh web` from a terminal) owns nothing but
 *    itself, so re-executing the exact invocation that booted it is safe.
 *
 * ## Why desktop detection needs more than one signal
 *
 * The two failure directions are asymmetric and both bad. A FALSE NEGATIVE
 * makes this plugin kill the process under the desktop shell, leaving a dead
 * profile the app cannot relaunch. A FALSE POSITIVE takes the restart button
 * away from everyone running plain `dsh web`.
 *
 * A single substring test over argv is not enough for either, and the real
 * Electron launch on macOS proves it: its argv is
 *
 *   [ "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
 *     "--expose-internals",
 *     ".../node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
 *     ".../app.asar/dsh",
 *     "~/.dsh/profiles/desktop",
 *     ".../dsh-desktop-host/lib/index.js" ]
 *
 * so the host entry sits at a PATH SEGMENT followed by `/lib/index.js`, and an
 * anchored `…dsh-desktop-host.js$` test matches nothing. And the environment
 * carries no `DSH_DESKTOP_*` variable at all on that machine — only
 * `DSH_CLIENT_VERSION` and `ELECTRON_RUN_AS_NODE`. Detection therefore
 * requires at least TWO independent signals to agree before the desktop
 * verdict is returned, and reports which ones fired.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import inspector from 'node:inspector'

/** The host flavour this process is serving. */
export type Runtime = 'web' | 'desktop'

/** Who is responsible for restarting this process. */
export type RestartManager = 'market' | 'desktop-host' | 'supervisor' | 'operator'

/** One independent piece of evidence that the desktop shell owns this process. */
export interface DesktopSignal {
  readonly id: 'argv-segment' | 'desktop-env' | 'electron-as-node' | 'parent-electron' | 'exec-path' | 'desktop-service'
  readonly fired: boolean
  /** What was observed, for the log line and the capabilities reason. */
  readonly detail: string
}

/** The desktop verdict plus the evidence behind it. */
export interface DesktopDetection {
  readonly desktop: boolean
  readonly signals: readonly DesktopSignal[]
  readonly reason: string
}

/**
 * A path whose segment is exactly `dsh-desktop-host`, optionally followed by
 * a file name and extension.
 *
 * Matches any of:
 *   `/…/@deepseek-ai/dsh-desktop-host/lib/index.js`   (the real macOS launch)
 *   `/…/node_modules/dsh-desktop-host/index.mjs`
 *   `dsh-desktop-host`                                 (bare, on PATH)
 *
 * Deliberately a SEGMENT test, not a substring test, so a path that merely
 * contains the words — `/tmp/dsh-desktop-host-notes.md`, say — does not
 * qualify. That is the false positive that would cost everyone their button.
 */
const DESKTOP_HOST_SEGMENT_RE = /(?:^|[\\/])dsh-desktop-host(?:[\\/](?:[^\\/]+)?|\.[cm]?js)?$/i

/** Whether one argv token names the desktop host entry. */
export function isDesktopHostToken(token: string): boolean {
  const normalized = token.replace(/^file:\/\//, '').replace(/[?#].*$/, '')
  if (DESKTOP_HOST_SEGMENT_RE.test(normalized)) return true
  // A token that continues past the segment (e.g. `…/dsh-desktop-host/lib/
  // index.js`) is covered by the alternation above, but a Windows path with
  // backslashes before a `node_modules` segment needs the same segment found
  // anywhere in the string.
  return /[\\/]dsh-desktop-host[\\/]/i.test(normalized)
}

/** The argv signal: does this process's own argv name the desktop host entry? */
export function argvDesktopSignal(argv: readonly string[]): DesktopSignal {
  const hit = argv.find(token => isDesktopHostToken(token))
  return hit === undefined
    ? { id: 'argv-segment', fired: false, detail: 'argv names no dsh-desktop-host entry' }
    : { id: 'argv-segment', fired: true, detail: `argv names the desktop host entry (${hit})` }
}

/** The env signal: any non-empty `DSH_DESKTOP_*` variable. */
export function desktopEnvSignal(env: NodeJS.ProcessEnv): DesktopSignal {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('DSH_DESKTOP_') && typeof value === 'string' && value !== '') {
      return { id: 'desktop-env', fired: true, detail: `${key} is set` }
    }
  }
  return { id: 'desktop-env', fired: false, detail: 'no DSH_DESKTOP_* variable is set' }
}

/** The Electron signal: the shell runs its node child with this flag. */
export function electronAsNodeSignal(env: NodeJS.ProcessEnv): DesktopSignal {
  const value = env['ELECTRON_RUN_AS_NODE']
  const fired = value !== undefined && value !== '' && value !== '0'
  return { id: 'electron-as-node', fired, detail: fired ? 'ELECTRON_RUN_AS_NODE is set' : 'ELECTRON_RUN_AS_NODE is not set' }
}

/**
 * The exec-path signal: this process is running out of an application bundle
 * rather than from a `node` binary.
 *
 * Cheap and structural — a `dsh web` from a terminal has node's own path —
 * but weak on its own, since a user may point `dsh` at a bundled runtime.
 */
export function execPathSignal(execPath: string = process.execPath): DesktopSignal {
  const bundled = /(?:^|[\\/])(?:node_modules[\\/]electron|Electron|DeepSeek Harness)(?:\.app)?(?:[\\/]|$)/i.test(execPath)
    || /[\\/](?:app\.asar|MacOS|Frameworks)[\\/]/i.test(execPath)
  return {
    id: 'exec-path',
    fired: bundled,
    detail: bundled ? `execPath is an application bundle (${execPath})` : 'execPath is a plain node binary',
  }
}

/**
 * The parent signal: the parent process is the Electron app, not a shell.
 *
 * This is the strongest available structural tell — it says who OWNS this
 * process rather than what the process was told about itself — but it needs
 * a reliable read of the parent's command line, and the platform differs:
 * `/proc/<pid>/comm` on Linux, `ps -o command=` elsewhere (macOS has no
 * /proc). Where neither can be read the signal does not fire, and detection
 * falls back to the others rather than guessing.
 */
export function parentComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim()
  } catch {
    // Not Linux, or the process is gone: fall through to ps.
  }
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Whether a parent command line names an Electron/desktop application. */
export function isElectronParent(comm: string | null): boolean {
  if (comm === null) return false
  return /Electron|DeepSeek Harness/i.test(comm)
    || /\.app\/Contents\/MacOS\//i.test(comm)
}

/** Build the parent-process signal. */
export function parentSignal(ppid: number, read: (pid: number) => string | null = parentComm): DesktopSignal {
  const comm = read(ppid)
  const fired = isElectronParent(comm)
  return {
    id: 'parent-electron',
    fired,
    detail: fired
      ? `parent ${String(ppid)} is the Electron app (${comm ?? 'unknown'})`
      : comm === null
        ? `parent ${String(ppid)} could not be identified`
        : `parent ${String(ppid)} is not the Electron app (${comm})`,
  }
}

/**
 * How many independent signals must agree before the desktop verdict is
 * returned.
 *
 * Two, not one: every signal here can be produced by something other than the
 * desktop shell, and the cost of being wrong is asymmetric (see the file
 * header). Two independent facts agreeing is the smallest count that is not a
 * single point of failure.
 */
export const DESKTOP_SIGNAL_THRESHOLD = 2

/**
 * Decide whether the Electron desktop host owns this process, with evidence.
 *
 * @param argv - this process's argv.
 * @param env - this process's environment.
 * @param options.ppid - the parent pid to inspect.
 * @param options.execPath - this process's executable path.
 * @param options.parentComm - injectable parent reader (tests).
 * @param options.desktopService - true when the host context published the
 *   desktop shell's own service, which is a signal that needs no guessing.
 */
export function detectDesktopRuntime(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly ppid?: number
    readonly execPath?: string
    readonly parentComm?: (pid: number) => string | null
    readonly desktopService?: boolean
  } = {},
): DesktopDetection {
  const signals: DesktopSignal[] = [
    argvDesktopSignal(argv),
    desktopEnvSignal(env),
    electronAsNodeSignal(env),
    parentSignal(options.ppid ?? process.ppid, options.parentComm ?? parentComm),
    execPathSignal(options.execPath ?? process.execPath),
  ]
  if (options.desktopService === true) {
    signals.push({ id: 'desktop-service', fired: true, detail: 'the host context published the desktopProfiles service' })
  }
  const fired = signals.filter(signal => signal.fired)
  const desktop = fired.length >= DESKTOP_SIGNAL_THRESHOLD
  const reason = desktop
    ? `${String(fired.length)} signals indicate the desktop shell: ${fired.map(signal => signal.detail).join('; ')}`
    : fired.length === 0
      ? 'no desktop-host signal fired'
      : `only ${String(fired.length)} signal(s) fired (${fired.map(signal => signal.id).join(', ')}), below the threshold of ${String(DESKTOP_SIGNAL_THRESHOLD)}`
  return { desktop, signals, reason }
}

/**
 * The process supervisor running this host, when one can be identified.
 *
 * TWO signals are required, and the second is the whole point. `INVOCATION_ID`
 * is INHERITED: every descendant of a systemd unit carries it, which on Linux
 * includes an ordinary desktop terminal (its shell descends from a user-session
 * unit) and a CI runner. Treating inheritance as ownership would disable the
 * button for a large population of hosts where it works fine — a worse bug
 * than the one being fixed. The parent test is what separates being the unit's
 * own main process from merely descending from one: a terminal's node has a
 * shell as its parent, and a runner's has the agent.
 *
 * `ppid === 1` only holds for SYSTEM units. A per-user unit's service is
 * forked by that user's manager instance — an ordinary PID — so the parent's
 * command is checked too, and `systemd` is the one name both manager instances
 * share and the false-positive parents never carry.
 *
 * SCOPE, stated plainly because it is platform-bound: this detects **systemd
 * on Linux only**. `/proc` is Linux-only, which is exactly as wide as systemd
 * itself; elsewhere the parent cannot be identified, the second signal never
 * fires, and the answer is "no supervisor detected" — NOT "no supervisor".
 * launchd and pm2 are not detected at all: pm2 sets `pm_id`, but it is
 * inherited the same way and pm2's God daemon (not PID 1) is the parent, so
 * there is no equivalent second signal, and a guess there would reintroduce
 * exactly the false positive this pair exists to avoid. On macOS a
 * launchd-managed dsh is therefore treated as a plain web host.
 */
export function detectSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
  readParent: (pid: number) => string | null = parentComm,
): string | null {
  const set = (name: string): boolean => (env[name] ?? '') !== ''
  if (!set('INVOCATION_ID') && !set('JOURNAL_STREAM')) return null
  if (ppid === 1) return 'systemd'
  const comm = readParent(ppid)
  // macOS `ps -o comm=` prints the full path, so match on the basename too.
  if (comm !== null && /(?:^|[\\/])systemd$/i.test(comm.trim())) return 'systemd'
  return null
}

/** Flags that mean a debugger owns this process. */
const INSPECT_ARG_PREFIXES = ['--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait'] as const

function argvHasInspectFlag(tokens: readonly string[]): boolean {
  return tokens.some(token => INSPECT_ARG_PREFIXES.some(prefix => token === prefix || token.startsWith(`${prefix}=`))
    || token === '--debug-brk' || token.startsWith('--debug-brk=')
    || token === '--debug' || token.startsWith('--debug='))
}

/**
 * Whether a debugger is attached, when one can be identified.
 *
 * Killing a debug-attached host from a UI button is never the right answer,
 * so this is a latch rather than an operator setting. Primary signal is
 * `inspector.url()` (covers `--inspect` at boot, `inspector.open()`, and a
 * SIGUSR1 attach); secondary is inspect-family flags in `execArgv` and
 * `NODE_OPTIONS`, matched by token PREFIX so a script path like
 * `.../inspect-tool.js` does not false-positive.
 */
export function detectDebugger(
  inspectorUrl: string | undefined = inspector.url(),
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env['NODE_OPTIONS'] ?? '',
): boolean {
  if (inspectorUrl !== undefined && inspectorUrl !== '') return true
  if (argvHasInspectFlag(execArgv)) return true
  const options = nodeOptions.trim()
  return options !== '' && argvHasInspectFlag(options.split(/\s+/))
}

/** Everything the capabilities payload needs to describe restart. */
export interface RestartCapability {
  readonly supported: boolean
  readonly managedBy: RestartManager
  /** How the runtime was determined, naming the signals that fired. */
  readonly runtimeReason: string
  /** The supervisor's name, when one was detected. */
  readonly supervisor: string | null
  /** The parent process command, when it could be read. */
  readonly parentComm: string | null
  /** How many desktop signals fired, and which. */
  readonly desktopSignals: readonly DesktopSignal[]
  /** True when a debugger is attached; restart is refused for the same reason. */
  readonly debuggerAttached: boolean
  /** User-facing, actionable explanation when `supported` is false. */
  readonly reason: string | null
}

/** The all-clear answer, reused so every supported path reports identically. */
function supportedCapability(
  detection: DesktopDetection,
  parent: string | null,
  supervisor: string | null,
): RestartCapability {
  return {
    supported: true,
    managedBy: 'market',
    runtimeReason: detection.reason,
    supervisor,
    parentComm: parent,
    desktopSignals: detection.signals,
    debuggerAttached: false,
    reason: null,
  }
}

/**
 * Decide whether this process may restart itself, and why not when it may not.
 *
 * Checked in order of how much each constraint overrides the others: the
 * desktop shell owns the process outright, a supervisor owns the service, and
 * a debugger owns the session. Only a plain, unowned `dsh web` may restart
 * itself.
 */
export function restartCapability(options: {
  readonly desktopService?: boolean
  readonly argv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly ppid?: number
  readonly execPath?: string
  readonly parentComm?: (pid: number) => string | null
  readonly debuggerAttached?: boolean
} = {}): RestartCapability {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const readParent = options.parentComm ?? parentComm
  const ppid = options.ppid ?? process.ppid
  const detection = detectDesktopRuntime(argv, env, {
    ppid,
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    parentComm: readParent,
    ...(options.desktopService === true ? { desktopService: true } : {}),
  })
  const supervisor = detectSupervisor(env, ppid, readParent)
  const debuggerAttached = options.debuggerAttached ?? detectDebugger()
  const parent = readParent(ppid)

  if (detection.desktop) {
    return {
      supported: false,
      managedBy: 'desktop-host',
      runtimeReason: detection.reason,
      supervisor,
      parentComm: parent,
      desktopSignals: detection.signals,
      debuggerAttached,
      reason: 'DSH Desktop 拥有这个进程的生命周期，插件无法重启它。请退出并重新打开 DSH Desktop 应用来完成重启。 / DSH Desktop owns this process, so the plugin cannot restart it. Quit and reopen the DSH Desktop app to restart.',
    }
  }
  if (supervisor !== null) {
    return {
      supported: false,
      managedBy: 'supervisor',
      runtimeReason: detection.reason,
      supervisor,
      parentComm: parent,
      desktopSignals: detection.signals,
      debuggerAttached,
      reason: `这个 dsh 由 ${supervisor} 托管，重启由它负责——从这里重启会让服务起不来。请用 ${supervisor} 重启该服务。 / This dsh is managed by ${supervisor}, which owns restarts; restarting from here would kill the service and nothing would bring it back. Restart the service with ${supervisor} instead.`,
    }
  }
  if (debuggerAttached) {
    return {
      supported: false,
      managedBy: 'operator',
      runtimeReason: detection.reason,
      supervisor: null,
      parentComm: parent,
      desktopSignals: detection.signals,
      debuggerAttached: true,
      reason: '有调试器连接着这个 dsh 进程，重启会中断调试会话。请先断开调试器，或手动重启 dsh。 / A debugger is attached to this dsh process and a restart would end the debug session. Detach the debugger, or restart dsh yourself.',
    }
  }
  return supportedCapability(detection, parent, null)
}

/** The runtime flavour, from the same evidence `restartCapability` uses. */
export function detectRuntime(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  desktopService = false,
): Runtime {
  if (desktopService) return 'desktop'
  return detectDesktopRuntime(argv, env).desktop ? 'desktop' : 'web'
}
