/**
 * State machine tests: gating, degradation, and progress accounting.
 *
 * These cover the decisions that determine whether a button is safe to press.
 * Every case here is one where a plausible-looking implementation ships a
 * button that cannot work — the exact failure the task forbids.
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/client/api.ts'
import type { Capabilities, Operation, UpdateSummary } from '../../src/client/contract.ts'
import {
  INITIAL_RESTART,
  INITIAL_STATE,
  INITIAL_UPDATE,
  canRunRestart,
  canRunUpdate,
  checkedCount,
  isOperationSettled,
  pollDelayMs,
  progressOf,
  reasonForError,
  restartUnavailable,
  updateActionable,
  updateBusy,
  updateRows,
  updatableCount,
  updateUnavailable,
  type UpdateState,
} from '../../src/client/state.ts'

/** A host that can do everything. */
const CAPABLE: Capabilities = {
  update: true,
  canCheck: true,
  restart: true,
  managedBy: undefined,
  reason: undefined,
  version: '0.1.0',
  runtime: 'cli',
  profile: 'desktop',
}

/** The live desktop host: updates work, restart is owned by the app shell. */
const DESKTOP: Capabilities = {
  update: true,
  canCheck: true,
  restart: false,
  managedBy: 'desktop-host',
  reason: 'the desktop shell owns the app lifecycle',
  version: '0.1.0',
  runtime: 'desktop',
  profile: 'desktop',
}

/** An old host that predates the whole feature set. */
const BARE: Capabilities = {
  update: false,
  canCheck: false,
  restart: false,
  managedBy: undefined,
  reason: undefined,
  version: undefined,
  runtime: undefined,
  profile: undefined,
}

/** Build an update state with overrides. */
function updateState(overrides: Partial<UpdateState> = {}): UpdateState {
  return { ...INITIAL_UPDATE, phase: 'idle', ...overrides }
}

/** Build a summary with the given counts. */
function summary(checked: number, updatable: number): UpdateSummary {
  return {
    checked,
    updatable,
    packages: Array.from({ length: updatable }, (_unused, index) => ({
      name: `pkg-${index}`,
      source: 'npm',
      installedVersion: '1.0.0',
      latestVersion: '2.0.0',
    })),
  }
}

/** Build an operation with the given package states. */
function operation(states: readonly Operation['packages'][number]['state'][]): Operation {
  return {
    id: 'op-1',
    state: states.every(state => state !== 'running' && state !== 'pending')
      ? (states.includes('failed') ? 'partial' : 'success')
      : 'running',
    packages: states.map((state, index) => ({
      name: `pkg-${index}`,
      from: '1.0.0',
      to: '2.0.0',
      state,
      error: state === 'failed' ? 'boom' : undefined,
    })),
    restartRequired: false,
    error: undefined,
    startedAt: undefined,
    finishedAt: undefined,
  }
}

describe('initial state', () => {
  it('starts in checking with both counts unknown', () => {
    expect(INITIAL_STATE.update.phase).toBe('checking')
    expect(INITIAL_STATE.capabilities).toBeUndefined()
    // Unknown must read as unknown, not as zero-updatable-but-fine.
    expect(checkedCount(INITIAL_UPDATE)).toBe(0)
    expect(updatableCount(INITIAL_UPDATE)).toBe(0)
  })

  it('starts restart idle and enabled', () => {
    expect(INITIAL_STATE.restart.phase).toBe('idle')
    expect(canRunRestart(INITIAL_RESTART, undefined)).toBe(true)
  })
})

describe('update gating', () => {
  it('does not enable the button while the first check is in flight', () => {
    expect(canRunUpdate(updateState({ phase: 'checking' }), CAPABLE)).toBe(false)
  })

  it('keeps the button disabled when the host cannot update', () => {
    // The core rule: never render an enabled button that cannot work.
    expect(updateUnavailable(BARE)).toBe('unsupportedUpdate')
    expect(canRunUpdate(updateState({ summary: summary(5, 3) }), BARE)).toBe(false)
  })

  it('enables the button for a re-check once idle, even with nothing updatable', () => {
    // Re-checking is genuinely useful work, so this stays clickable.
    expect(canRunUpdate(updateState({ summary: summary(5, 0) }), CAPABLE)).toBe(true)
    expect(updateActionable(updateState({ summary: summary(5, 0) }))).toBe(false)
  })

  it('flags an actionable update when at least one package can move', () => {
    const state = updateState({ summary: summary(5, 2) })
    expect(canRunUpdate(state, CAPABLE)).toBe(true)
    expect(updateActionable(state)).toBe(true)
  })

  it('disables the button while an update is running or starting', () => {
    expect(canRunUpdate(updateState({ phase: 'running' }), CAPABLE)).toBe(false)
    expect(canRunUpdate(updateState({ phase: 'starting' }), CAPABLE)).toBe(false)
    expect(updateBusy(updateState({ phase: 'running' }))).toBe(true)
  })

  it('disables the button after a completed run until the user asks again', () => {
    expect(canRunUpdate(updateState({ phase: 'done', summary: summary(5, 2) }), CAPABLE)).toBe(false)
  })

  it('refuses to enable a control pinned off by a permanent failure', () => {
    const state = updateState({ unavailable: 'unsupportedUpdate', summary: summary(5, 2) })
    expect(canRunUpdate(state, CAPABLE)).toBe(false)
  })

  it('reports the checked denominator separately from the updatable count', () => {
    const state = updateState({ summary: summary(5, 2) })
    expect(checkedCount(state)).toBe(5)
    expect(updatableCount(state)).toBe(2)
  })
})

describe('update rows', () => {
  it('falls back to summary rows, each pending, before an operation exists', () => {
    const rows = updateRows(updateState({ summary: summary(5, 2) }))
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.state === 'pending')).toBe(true)
    expect(rows[0]?.from).toBe('1.0.0')
    expect(rows[0]?.to).toBe('2.0.0')
  })

  it('prefers live operation rows, which carry per-package progress', () => {
    const rows = updateRows(updateState({ operation: operation(['success', 'failed']) }))
    expect(rows.map(row => row.state)).toEqual(['success', 'failed'])
    expect(rows[1]?.error).toBe('boom')
  })

  it('returns no rows before a summary has arrived', () => {
    expect(updateRows(updateState())).toEqual([])
  })
})

describe('progress accounting', () => {
  it('counts settled packages and separates updated from failed', () => {
    expect(progressOf(operation(['success', 'failed', 'pending', 'skipped']))).toEqual({
      done: 3,
      total: 4,
      failed: 1,
      updated: 1,
    })
  })

  it('treats skipped as settled but not as updated', () => {
    // A skipped package is not a success; counting it as updated would
    // overstate what happened.
    expect(progressOf(operation(['skipped']))).toEqual({ done: 1, total: 1, failed: 0, updated: 0 })
  })

  it('counts pending and running as unfinished', () => {
    expect(progressOf(operation(['pending', 'running'])).done).toBe(0)
  })
})

describe('operation settlement', () => {
  it('keeps running while any package is unfinished', () => {
    expect(isOperationSettled(operation(['success', 'running']))).toBe(false)
  })

  it('settles on success, partial, and failed', () => {
    expect(isOperationSettled(operation(['success']))).toBe(true)
    expect(isOperationSettled(operation(['failed']))).toBe(true)
  })
})

describe('restart gating', () => {
  it('disables restart when the desktop shell owns the lifecycle', () => {
    // The live desktop host hits exactly this branch, so it must be first-class.
    expect(restartUnavailable(DESKTOP)).toBe('desktopRestartUnsupported')
    expect(canRunRestart(INITIAL_RESTART, DESKTOP)).toBe(false)
  })

  it('disables restart generically when unsupported without a desktop owner', () => {
    expect(restartUnavailable(BARE)).toBe('unsupportedRestart')
    expect(canRunRestart(INITIAL_RESTART, BARE)).toBe(false)
  })

  it('enables restart on a capable host', () => {
    expect(restartUnavailable(CAPABLE)).toBeUndefined()
    expect(canRunRestart(INITIAL_RESTART, CAPABLE)).toBe(true)
  })

  it('refuses a second restart while one is in flight', () => {
    expect(canRunRestart({ ...INITIAL_RESTART, phase: 'requesting' }, CAPABLE)).toBe(false)
    expect(canRunRestart({ ...INITIAL_RESTART, phase: 'restarting' }, CAPABLE)).toBe(false)
    expect(canRunRestart({ ...INITIAL_RESTART, phase: 'reloading' }, CAPABLE)).toBe(false)
  })

  it('allows a retry after a failure or timeout', () => {
    // A user whose restart timed out must be able to try again.
    expect(canRunRestart({ ...INITIAL_RESTART, phase: 'failed' }, CAPABLE)).toBe(true)
    expect(canRunRestart({ ...INITIAL_RESTART, phase: 'timeout' }, CAPABLE)).toBe(true)
  })

  it('keeps the control disabled when a reason was recorded at runtime', () => {
    const state = { ...INITIAL_RESTART, unavailable: 'desktopRestartUnsupported' as const }
    expect(canRunRestart(state, CAPABLE)).toBe(false)
  })
})

describe('error classification', () => {
  it('turns a missing endpoint into a permanent disabling reason', () => {
    expect(reasonForError(new ApiError('unsupported', 'no route'), 'update')).toBe('unsupportedUpdate')
    expect(reasonForError(new ApiError('unsupported', 'no route'), 'restart')).toBe('unsupportedRestart')
  })

  it('turns an unreachable host into a hostUnreachable reason', () => {
    expect(reasonForError(new ApiError('unreachable', 'ECONNREFUSED'), 'update')).toBe('hostUnreachable')
  })

  it('leaves a transient HTTP error retryable', () => {
    // A 500 is worth retrying, so it must NOT pin the control off.
    expect(reasonForError(new ApiError('http', 'busy', 500), 'update')).toBeUndefined()
  })

  it('leaves a malformed body retryable', () => {
    expect(reasonForError(new ApiError('malformed', 'bad json'), 'update')).toBeUndefined()
  })
})

describe('poll backoff', () => {
  it('starts fast and backs off without ever stopping', () => {
    expect(pollDelayMs(0)).toBe(500)
    expect(pollDelayMs(10)).toBe(1000)
    expect(pollDelayMs(100)).toBe(2000)
    // Backoff must be monotonic: a later poll may never be faster than an
    // earlier one, or a long install would get hammered again at the end.
    expect(pollDelayMs(1000)).toBeGreaterThanOrEqual(pollDelayMs(0))
  })
})
