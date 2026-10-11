/**
 * Runtime and restart-capability detection.
 *
 * The fixture values are not idealized inputs: the `REAL_DESKTOP_ARGV` and
 * `REAL_DESKTOP_ENV` constants below are the ACTUAL argv and environment of a
 * live `dsh-desktop-host` child on macOS, read off the running Electron app.
 * The idealized version of that launch was what got the detection wrong the
 * first time — an anchored `…dsh-desktop-host.js$` test looks correct against a
 * tidy example and matches nothing against the real thing, where the host entry
 * sits at a path segment followed by `/lib/index.js`.
 *
 * Both failure directions matter and are asserted here: a false negative kills
 * the process under the desktop shell, and a false positive takes the restart
 * button away from every plain `dsh web` user.
 */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SIGNAL_THRESHOLD,
  detectDesktopRuntime,
  detectDebugger,
  detectRuntime,
  detectSupervisor,
  isDesktopHostToken,
  hasActiveTasks,
  inspectTasks,
  isElectronParent,
  restartCapability,
} from '../../src/host/runtime.js'
import {
  desktopPlanForTest,
  desktopRelaunch,
  electronBundlePath,
  restartHelperSource,
  restartPlan,
  scheduleRestart,
} from '../../src/host/restart.js'

/**
 * The real argv of the `dsh-desktop-host` child of the Electron app
 * (pid 3660 on the machine this was developed on).
 */
const REAL_DESKTOP_ARGV = [
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  '--expose-internals',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
  '/Users/wf/.dsh/profiles/desktop',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
]

/**
 * The real environment of that process, filtered to the DSH/Electron-relevant
 * entries. Note what is NOT here: there is no `DSH_DESKTOP_*` variable at all
 * on this machine, which is why that probe cannot be the primary signal.
 */
const REAL_DESKTOP_ENV = {
  ELECTRON_RUN_AS_NODE: '1',
  DSH_CLIENT_VERSION: '0.2.0-rc.2',
} as NodeJS.ProcessEnv

/** The parent is the Electron binary, not a shell. */
const REAL_DESKTOP_PARENT_COMM = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const REAL_DESKTOP_EXEC_PATH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime'

/** A plain `dsh web` launched from a terminal. */
const WEB_ARGV = ['/usr/local/bin/node', '/Users/wf/dsh/deepseek-harness/bin.js', 'web', '--profile', 'desktop']
const WEB_ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/wf' } as NodeJS.ProcessEnv
const WEB_PARENT_COMM = '/bin/zsh'

/** Read a parent command from a fixed table, so tests never shell out. */
const parentReader = (comm: string | null) => (_pid: number): string | null => comm

/** The desktop options that reproduce the live machine. */
const onDesktopMachine = {
  argv: REAL_DESKTOP_ARGV,
  env: REAL_DESKTOP_ENV,
  ppid: 3649,
  execPath: REAL_DESKTOP_EXEC_PATH,
  parentComm: parentReader(REAL_DESKTOP_PARENT_COMM),
}

const onWebMachine = {
  argv: WEB_ARGV,
  env: WEB_ENV,
  ppid: 91_000,
  execPath: '/usr/local/bin/node',
  parentComm: parentReader(WEB_PARENT_COMM),
}

describe('isDesktopHostToken — the real macOS layout', () => {
  it('matches the real desktop-host entry, which ends at /lib/index.js', () => {
    // The exact case the anchored `…dsh-desktop-host.js$` pattern missed.
    expect(isDesktopHostToken(REAL_DESKTOP_ARGV[2]!)).toBe(true)
    expect(isDesktopHostToken(REAL_DESKTOP_ARGV[5]!)).toBe(true)
  })

  it('matches every shape of the entry', () => {
    expect(isDesktopHostToken('dsh-desktop-host')).toBe(true)
    expect(isDesktopHostToken('/x/node_modules/dsh-desktop-host/lib/index.js')).toBe(true)
    expect(isDesktopHostToken('/x/dsh-desktop-host.js')).toBe(true)
    expect(isDesktopHostToken('/x/dsh-desktop-host.mjs')).toBe(true)
  })

  it('matches a Windows layout too', () => {
    expect(isDesktopHostToken(String.raw`C:\x\node_modules\dsh-desktop-host\lib\index.js`)).toBe(true)
  })

  it('rejects a path that merely CONTAINS the words', () => {
    // The false positive that would cost every plain `dsh web` user their
    // button: a filename that happens to mention the host is not the host.
    expect(isDesktopHostToken('/tmp/dsh-desktop-host-notes.md')).toBe(false)
    expect(isDesktopHostToken('/x/dsh-desktop-hosts/lib/index.js')).toBe(false)
  })

  it('rejects a plain dsh web argv', () => {
    expect(WEB_ARGV.filter(isDesktopHostToken)).toHaveLength(0)
  })
})

describe('detectDesktopRuntime — signals and threshold', () => {
  it('detects the live desktop machine', () => {
    const detection = detectDesktopRuntime(REAL_DESKTOP_ARGV, REAL_DESKTOP_ENV, {
      ppid: 3649,
      execPath: REAL_DESKTOP_EXEC_PATH,
      parentComm: parentReader(REAL_DESKTOP_PARENT_COMM),
    })
    expect(detection.desktop).toBe(true)
    const fired = detection.signals.filter(signal => signal.fired).map(signal => signal.id)
    expect(fired).toContain('argv-segment')
  })

  it('does NOT fire the env probe on the real machine, and says so', () => {
    // Documented behaviour, not an oversight: there is no DSH_DESKTOP_*
    // variable on the real launch, so this branch is inert there and the
    // verdict must not depend on it.
    const detection = detectDesktopRuntime(REAL_DESKTOP_ARGV, REAL_DESKTOP_ENV, {
      ppid: 3649,
      execPath: REAL_DESKTOP_EXEC_PATH,
      parentComm: parentReader(REAL_DESKTOP_PARENT_COMM),
    })
    const envSignal = detection.signals.find(signal => signal.id === 'desktop-env')
    expect(envSignal?.fired).toBe(false)
  })

  it('requires two signals, so argv alone is not enough', () => {
    // Only the argv signal fires: below threshold, so the verdict stays web.
    // This is what keeps a future Electron launch that passes the entry
    // differently from silently flipping the answer either way.
    const detection = detectDesktopRuntime(REAL_DESKTOP_ARGV, {} as NodeJS.ProcessEnv, {
      ppid: 91_000,
      execPath: '/usr/local/bin/node',
      parentComm: parentReader('/bin/zsh'),
    })
    expect(detection.signals.filter(signal => signal.fired)).toHaveLength(1)
    expect(detection.desktop).toBe(false)
    expect(detection.reason).toContain('below the threshold')
  })

  it('requires two signals, so Electron env alone is not enough', () => {
    // ELECTRON_RUN_AS_NODE is inheritable, so on its own it proves nothing.
    const detection = detectDesktopRuntime(WEB_ARGV, { ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv, {
      ppid: 91_000,
      execPath: '/usr/local/bin/node',
      parentComm: parentReader('/bin/zsh'),
    })
    expect(detection.desktop).toBe(false)
  })

  it('accepts the parent-process signal combined with Electron env', () => {
    const detection = detectDesktopRuntime(WEB_ARGV, { ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv, {
      ppid: 3649,
      execPath: '/usr/local/bin/node',
      parentComm: parentReader(REAL_DESKTOP_PARENT_COMM),
    })
    expect(detection.desktop).toBe(true)
  })

  it('treats the published desktop service as a signal needing no guessing', () => {
    const detection = detectDesktopRuntime(WEB_ARGV, WEB_ENV, {
      ppid: 91_000,
      execPath: '/usr/local/bin/node',
      parentComm: parentReader('/bin/zsh'),
      desktopService: true,
    })
    // One signal only — the service — which is deliberately NOT enough on its
    // own. `restartCapability` short-circuits on that signal separately.
    expect(detection.signals.filter(signal => signal.fired)).toHaveLength(1)
  })
})

describe('detectRuntime', () => {
  it('reports desktop for the live machine', () => {
    expect(detectRuntime(REAL_DESKTOP_ARGV, REAL_DESKTOP_ENV, true)).toBe('desktop')
  })

  it('reports web for a plain terminal launch', () => {
    expect(detectRuntime(WEB_ARGV, WEB_ENV, false)).toBe('web')
  })
})

describe('isElectronParent', () => {
  it('recognizes the macOS app bundle parent', () => {
    expect(isElectronParent(REAL_DESKTOP_PARENT_COMM)).toBe(true)
  })

  it('does not mistake a shell for the app', () => {
    expect(isElectronParent('/bin/zsh')).toBe(false)
    expect(isElectronParent('/usr/local/bin/node')).toBe(false)
    expect(isElectronParent(null)).toBe(false)
  })
})

describe('detectSupervisor', () => {
  it('requires both the systemd marker and a matching parent', () => {
    // INVOCATION_ID is inherited, so on its own it must not count: a terminal
    // inside a systemd session would otherwise be treated as supervised.
    expect(detectSupervisor({ INVOCATION_ID: 'abc' } as NodeJS.ProcessEnv, 4242, parentReader('/bin/bash'))).toBeNull()
    expect(detectSupervisor({ INVOCATION_ID: 'abc' } as NodeJS.ProcessEnv, 1, parentReader(null))).toBe('systemd')
    expect(detectSupervisor({ INVOCATION_ID: 'abc' } as NodeJS.ProcessEnv, 4242, parentReader('systemd'))).toBe('systemd')
  })

  it('matches systemd when ps prints a full path (macOS form)', () => {
    expect(detectSupervisor({ JOURNAL_STREAM: '8:1' } as NodeJS.ProcessEnv, 500, parentReader('/usr/lib/systemd'))).toBe('systemd')
  })

  it('reports no supervisor without the systemd marker', () => {
    expect(detectSupervisor(WEB_ENV, 4242, parentReader('systemd'))).toBeNull()
  })
})

describe('detectDebugger', () => {
  it('detects an inspector URL', () => {
    expect(detectDebugger('ws://127.0.0.1:9229/uuid', [], '')).toBe(true)
  })

  it('detects inspect flags in execArgv and NODE_OPTIONS', () => {
    expect(detectDebugger(undefined, ['--inspect'], '')).toBe(true)
    expect(detectDebugger(undefined, [], '--inspect-brk=9229')).toBe(true)
    expect(detectDebugger(undefined, ['--inspect-wait'], '')).toBe(true)
  })

  it('does not false-positive on a script path containing "inspect"', () => {
    expect(detectDebugger(undefined, [], '')).toBe(false)
    expect(detectDebugger('', ['/usr/lib/inspect-tool.js'], '/app/inspect-tool.js')).toBe(false)
  })
})

describe('restartCapability', () => {
  it('supports restart on the desktop host through the app bundle', () => {
    // The desktop host is a child of the Electron shell and cannot call
    // app.relaunch(), so restart works by relaunching the bundle and stopping
    // the shell — a different mechanism, reported as a different manager.
    const capability = restartCapability(onDesktopMachine)
    expect(capability.supported).toBe(true)
    expect(capability.managedBy).toBe('desktop-host')
    expect(capability.reason).toBeNull()
  })

  it('allows a plain web host', () => {
    const capability = restartCapability(onWebMachine)
    expect(capability.supported).toBe(true)
    expect(capability.managedBy).toBe('market')
    expect(capability.reason).toBeNull()
  })

  it('refuses under a supervisor, whichever way the desktop question went', () => {
    const capability = restartCapability({
      ...onWebMachine,
      env: { ...WEB_ENV, INVOCATION_ID: 'abc' },
      ppid: 1,
      parentComm: parentReader(null),
    })
    expect(capability.supported).toBe(false)
    expect(capability.managedBy).toBe('supervisor')
    expect(capability.supervisor).toBe('systemd')
  })

  it('prioritizes the desktop verdict over everything else', () => {
    const capability = restartCapability({
      ...onDesktopMachine,
      env: { ...REAL_DESKTOP_ENV, INVOCATION_ID: 'abc' },
      ppid: 1,
      parentComm: parentReader(null),
    })
    expect(capability.managedBy).toBe('desktop-host')
  })

  it('refuses while a debugger is attached', () => {
    const capability = restartCapability({ ...onWebMachine, debuggerAttached: true })
    expect(capability.supported).toBe(false)
    expect(capability.managedBy).toBe('operator')
  })

  it('reports the evidence behind the verdict', () => {
    const capability = restartCapability(onDesktopMachine)
    expect(capability.desktopSignals.filter(signal => signal.fired).length).toBeGreaterThanOrEqual(DESKTOP_SIGNAL_THRESHOLD)
    expect(capability.runtimeReason).toContain('signals indicate the desktop shell')
  })
})

/**
 * The desktop relaunch command.
 *
 * A desktop host cannot call `app.relaunch()` — it lives in the Electron main
 * process, and the shell rejects every IPC message outside its own whitelist.
 * The equivalent command is therefore issued from outside the process, and
 * these tests pin the two details that make it work at all.
 */
describe('desktop relaunch', () => {
  it('addresses the bundle by identifier when the path is unknown', () => {
    const launch = desktopRelaunch('com.deepseek.dsh')
    expect(launch.file).toBe('open')
    // -n is load-bearing: without it macOS routes the launch to the existing
    // instance's single-instance-lock handler, which only focuses the window.
    expect(launch.args).toContain('-n')
    expect(launch.args).toEqual(['-n', '-b', 'com.deepseek.dsh'])
  })

  it('prefers the real bundle path when it can be recovered', () => {
    const launch = desktopRelaunch('com.deepseek.dsh', '/Applications/DeepSeek Harness.app')
    expect(launch.args).toEqual(['-n', '/Applications/DeepSeek Harness.app'])
  })

  it('recovers the bundle from a real Electron argv0', () => {
    expect(electronBundlePath('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'))
      .toBe('/Applications/DeepSeek Harness.app')
    // A nested app must resolve to the OUTERMOST bundle, or the relaunch would
    // start a helper process instead of the application.
    expect(electronBundlePath('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'))
      .not.toContain('/Contents/MacOS')
  })

  it('returns undefined for a non-Electron argv0', () => {
    expect(electronBundlePath('/usr/local/bin/node')).toBeUndefined()
    expect(electronBundlePath(undefined)).toBeUndefined()
    expect(electronBundlePath('')).toBeUndefined()
  })

  it('relaunches the bundle and stops the shell on a desktop host', () => {
    // The real stop() signals process.ppid, which under vitest is the test
    // runner itself — calling it would kill this suite mid-file. The recorder
    // captures the intended target instead.
    let signalled: number | undefined
    const plan = desktopPlanForTest(pid => { signalled = pid })
    expect(plan.desktop).toBe(true)
    expect(plan.launch.file).toBe('open')
    expect(plan.launch.args).toContain('-n')
    plan.stop()
    // The Electron shell is this process's PARENT, not its parent's parent:
    // Electron spawns the desktop host directly.
    expect(signalled).toBe(process.ppid)
    expect(signalled).not.toBe(process.pid)
  })

  it('still replays its own invocation on a web host', () => {
    const plan = restartPlan(false)
    expect(plan.desktop).toBe(false)
    expect(plan.launch.file).not.toBe('open')
  })
})

/**
 * The interruption predicate.
 *
 * Mirrors the shell's own `hasDesktopActiveTasks`. Every branch is asserted
 * because a laxer version here would keep the confirmation dialog silent while
 * a restart kills real work.
 */
describe('hasActiveTasks', () => {
  const noJobs = (): readonly { status?: string }[] => []

  it('is idle with no agents and no jobs', () => {
    expect(hasActiveTasks([], noJobs)).toBe(false)
  })

  it('counts a running agent', () => {
    expect(hasActiveTasks([{ id: 'a', status: 'running' }], noJobs)).toBe(true)
  })

  it('counts queued work on an otherwise idle agent', () => {
    // An agent between turns still has claimed work; restarting drops it.
    expect(hasActiveTasks([{ id: 'a', status: 'idle', inbox: { nextTurn: [{}] } }], noJobs)).toBe(true)
    expect(hasActiveTasks([{ id: 'a', status: 'idle', inbox: { nextStep: [{}] } }], noJobs)).toBe(true)
  })

  it('ignores an idle agent with an empty inbox', () => {
    expect(hasActiveTasks([{ id: 'a', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }], noJobs)).toBe(false)
  })

  it('counts a running job, including in the unowned pool', () => {
    // A job with no agent still runs, and a restart still kills it — this is
    // why `undefined` is queried alongside every agent id.
    const jobs = (id: string | undefined): readonly { status?: string }[] =>
      id === undefined ? [{ status: 'running' }] : []
    expect(hasActiveTasks([], jobs)).toBe(true)
  })

  it('counts a stopping job but not a finished one', () => {
    expect(hasActiveTasks([], () => [{ status: 'stopping' }])).toBe(true)
    expect(hasActiveTasks([], () => [{ status: 'done' }, { status: 'failed' }])).toBe(false)
  })

  it('reports the two flags the dialog branches on', () => {
    expect(inspectTasks([{ id: 'a', status: 'running' }], noJobs, false))
      .toEqual({ activeTasks: true, scheduledTasks: false })
    expect(inspectTasks([], noJobs, true))
      .toEqual({ activeTasks: false, scheduledTasks: true })
  })
})

describe('the restart helper waits for the right thing', () => {
  const spawned = { file: 'open', args: ['-n', '/Applications/DSH.app'], viaShell: false, detached: true }

  it('waits for the dying process, not just the port', () => {
    // The regression this pins: the app was quitting and never coming back.
    // macOS holds the single-instance lock until the old app's process is
    // GONE, and the port goes quiet well before that. Launching on "port free"
    // let the replacement start, fail requestSingleInstanceLock(), and call
    // application.quit() on itself — `open -n` exits 0 and nothing appears.
    const source = restartHelperSource(spawned, { cwd: '/' }, { out: 'o', err: 'e' }, 19387, 4242)
    expect(source).toContain('const dying = 4242')
    expect(source).toContain('process.kill(pid, 0)')
  })

  it('checks the dying process BEFORE it starts the replacement', () => {
    const source = restartHelperSource(spawned, { cwd: '/' }, { out: 'o', err: 'e' }, 19387, 4242)
    const waitAt = source.indexOf('while (Date.now() < deadline && alive(dying))')
    const spawnAt = source.indexOf('spawn(file, args,')
    expect(waitAt).toBeGreaterThan(-1)
    expect(spawnAt).toBeGreaterThan(-1)
    // Order is the whole fix; both present but reversed is still broken.
    expect(waitAt).toBeLessThan(spawnAt)
  })

  it('has nothing to wait for on a web host', () => {
    // A web host replays its own invocation and has no instance lock, so the
    // guard must not stall it.
    expect(restartHelperSource(spawned, { cwd: '/' }, { out: 'o', err: 'e' }, 19999, null))
      .toContain('const dying = null')
  })

  it('gives the desktop plan a dying pid and the web plan none', () => {
    expect(restartPlan(true).dying).toBe(process.ppid)
    expect(desktopPlanForTest().dying).toBe(process.ppid)
  })

  it('actually runs the wait: the spawned helper is told a real pid', () => {
    // A source-shape assertion alone would pass while the call site drops the
    // argument. This drives scheduleRestart and reads what the helper receives
    // — pid, ordering, and gate in one observable.
    const calls: { args: readonly string[] }[] = []
    scheduleRestart(
      19387,
      () => {},                       // never ask anything to stop
      () => {},                       // and never signal
      {
        plan: desktopPlanForTest(),
        spawnHelper: ((_file: string, args: readonly string[]) => {
          calls.push({ args })
          return { pid: 12345, unref: () => {} }
        }) as never,
      },
    )
    expect(calls).toHaveLength(1)
    const program = calls[0]!.args[1]!
    expect(program).toContain(`const dying = ${process.ppid}`)
    expect(program.indexOf('while (Date.now() < deadline && alive(dying))'))
      .toBeLessThan(program.indexOf('spawn(file, args,'))
  })
})
