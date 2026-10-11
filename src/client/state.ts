/**
 * The two control state machines, as pure transition helpers.
 *
 * Keeping this logic out of React makes the interesting parts — the badge
 * denominator, polling cadence, degraded-host handling, restart reconnection —
 * unit-testable without a DOM, and leaves the components a thin render of
 * `state + actions`.
 */
import type { ApiError, Capabilities, Operation, OperationPackage, UpdateSummary } from './api.ts'

/** Update button lifecycle. */
export type UpdatePhase =
  /** A summary request is in flight. */
  | 'checking'
  /** Summary is known; nothing running. */
  | 'idle'
  /** `POST /updates/all` sent, waiting for an operation id. */
  | 'starting'
  /** An operation is running; per-package progress is streaming in. */
  | 'running'
  /** The last operation settled. Terminal until the user acts again. */
  | 'done'

/** Restart button lifecycle. */
export type RestartPhase =
  /** Nothing requested. */
  | 'idle'
  /** `POST /restart` sent; the host has not answered yet. */
  | 'requesting'
  /** Host accepted; waiting for it to come back as a NEW process. */
  | 'restarting'
  /** A probe saw a different `bootId`: the page is about to reload. */
  | 'reloading'
  /** The host never came back within the budget. */
  | 'timeout'
  /** The host refused the restart. */
  | 'failed'

/** Why a control cannot be used, as a locale key of this plugin. */
export type UnavailableReason =
  | 'unsupportedHost'
  | 'unsupportedUpdate'
  | 'unsupportedRestart'
  | 'desktopRestartUnsupported'
  | 'hostUnreachable'
  | 'busyUpdate'

/** Update-button state. */
export interface UpdateState {
  readonly phase: UpdatePhase
  /** Latest summary, or undefined before the first successful check. */
  readonly summary: UpdateSummary | undefined
  /** Live operation while `phase` is `running`/`done`. */
  readonly operation: Operation | undefined
  /** Host/transport error text, cleared when a new attempt starts. */
  readonly error: string | undefined
  /** Disabling reason; when set, the button is not actionable. */
  readonly unavailable: UnavailableReason | undefined
  /** Epoch milliseconds of the last successful summary. */
  readonly checkedAt: number | undefined
}

/** Restart-button state. */
export interface RestartState {
  readonly phase: RestartPhase
  readonly error: string | undefined
  readonly unavailable: UnavailableReason | undefined
}

/** Both controls' state, owned by one hook. */
export interface ControlsState {
  readonly update: UpdateState
  readonly restart: RestartState
  /** Host capability probe result; undefined until it settles. */
  readonly capabilities: Capabilities | undefined
}

/** The state every control starts from, before capability detection. */
export const INITIAL_UPDATE: UpdateState = {
  phase: 'checking',
  summary: undefined,
  operation: undefined,
  error: undefined,
  unavailable: undefined,
  checkedAt: undefined,
}

/** The restart control's initial state. */
export const INITIAL_RESTART: RestartState = {
  phase: 'idle',
  error: undefined,
  unavailable: undefined,
}

/** Both controls' initial state. */
export const INITIAL_STATE: ControlsState = {
  update: INITIAL_UPDATE,
  restart: INITIAL_RESTART,
  capabilities: undefined,
}

/** How a package row reads in the popover. */
export interface UpdateRow {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly state: OperationPackage['state']
  readonly error: string | undefined
}

/**
 * Whether the restart control should be offered at all.
 *
 * A refused restart is a disabled button with an explanation, never an
 * enabled button that fails on click.
 * @param capabilities - host feature detection, or undefined while unknown.
 * @returns a disabling reason, or undefined when the control is usable.
 */
export function restartUnavailable(capabilities: Capabilities | undefined): UnavailableReason | undefined {
  if (capabilities === undefined) return undefined
  if (capabilities.restart) return undefined
  // A desktop shell owning the lifecycle deserves actionable advice, not a
  // bare "unsupported".
  return capabilities.managedBy === 'desktop-host' ? 'desktopRestartUnsupported' : 'unsupportedRestart'
}

/**
 * Whether the update control should be offered at all.
 * @param capabilities - host feature detection, or undefined while unknown.
 * @returns a disabling reason, or undefined when the control is usable.
 */
export function updateUnavailable(capabilities: Capabilities | undefined): UnavailableReason | undefined {
  if (capabilities === undefined) return undefined
  return capabilities.update ? undefined : 'unsupportedUpdate'
}

/**
 * How many packages can move forward.
 * @param state - current update state.
 * @returns the updatable count, or 0 before the first check settles.
 */
export function updatableCount(state: UpdateState): number {
  return state.summary?.updatable ?? 0
}

/**
 * How many packages the summary examined — the badge's denominator.
 * @param state - current update state.
 * @returns the checked count, or 0 before the first check settles.
 */
export function checkedCount(state: UpdateState): number {
  return state.summary?.checked ?? 0
}

/**
 * The rows the popover renders, preferring live operation data.
 *
 * Before an operation starts the rows come from the summary (each pinned at
 * `pending`); once one is running the operation rows are authoritative because
 * they carry per-package progress and outcomes.
 * @param state - current update state.
 * @returns one row per package, in host order.
 */
export function updateRows(state: UpdateState): readonly UpdateRow[] {
  if (state.operation !== undefined) {
    return state.operation.packages.map(entry => ({
      name: entry.name,
      from: entry.from,
      to: entry.to,
      state: entry.state,
      error: entry.error,
    }))
  }
  return (state.summary?.packages ?? []).map(entry => ({
    name: entry.name,
    from: entry.installedVersion,
    to: entry.latestVersion,
    state: 'pending' as const,
    error: undefined,
  }))
}

/**
 * Whether an update currently occupies the control.
 * @param state - current update state.
 * @returns true while checking, starting, or running.
 */
export function updateBusy(state: UpdateState): boolean {
  return state.phase === 'checking' || state.phase === 'starting' || state.phase === 'running'
}

/**
 * Whether the update button should be clickable right now.
 *
 * Clicking performs useful work in three cases only: a first check may be
 * started, a manual re-check may be run, or at least one package can move
 * forward. A host without the capability, or a control mid-flight, disables it.
 * @param state - current update state.
 * @param capabilities - host feature detection.
 * @returns true when clicking does something.
 */
export function canRunUpdate(state: UpdateState, capabilities: Capabilities | undefined): boolean {
  if (state.unavailable !== undefined) return false
  if (capabilities !== undefined && !capabilities.update) return false
  if (updateBusy(state)) return false
  if (state.phase === 'done') return false
  return true
}

/**
 * Whether the update button starts an operation (rather than a re-check) on click.
 * @param state - current update state.
 * @returns true when at least one package can be updated.
 */
export function updateActionable(state: UpdateState): boolean {
  return state.summary !== undefined && updatableCount(state) > 0
}

/**
 * Whether the restart button should be clickable.
 * @param state - current restart state.
 * @param capabilities - host feature detection.
 * @returns true when clicking is meaningful.
 */
export function canRunRestart(state: RestartState, capabilities: Capabilities | undefined): boolean {
  if (state.unavailable !== undefined) return false
  if (capabilities !== undefined && !capabilities.restart) return false
  return state.phase === 'idle' || state.phase === 'failed' || state.phase === 'timeout'
}

/**
 * Classify a transport failure into a disabling reason.
 *
 * A permanent failure (missing endpoint) pins the control off; a transient one
 * leaves it retryable.
 * @param error - the normalized transport error.
 * @param feature - which control failed.
 * @returns a locale key explaining the state, or undefined to stay retryable.
 */
export function reasonForError(error: ApiError, feature: 'update' | 'restart'): UnavailableReason | undefined {
  if (error.code === 'unsupported') {
    return feature === 'update' ? 'unsupportedUpdate' : 'unsupportedRestart'
  }
  if (error.code === 'unreachable') return 'hostUnreachable'
  return undefined
}

/** How much of an operation is finished, for the progress line. */
export interface Progress {
  /** Packages in a terminal state (success, skipped, or failed). */
  readonly done: number
  /** Total packages in the operation. */
  readonly total: number
  /** Packages that failed. */
  readonly failed: number
  /** Packages updated successfully. */
  readonly updated: number
}

/**
 * Count an operation's settled packages.
 * @param operation - the live operation.
 * @returns done/total/failed/updated counts.
 */
export function progressOf(operation: Operation): Progress {
  let done = 0
  let failed = 0
  let updated = 0
  for (const entry of operation.packages) {
    if (entry.state === 'success') { done += 1; updated += 1 }
    else if (entry.state === 'failed') { done += 1; failed += 1 }
    else if (entry.state === 'skipped') done += 1
  }
  return { done, total: operation.packages.length, failed, updated }
}

/**
 * Whether an operation has settled.
 * @param operation - the live operation.
 * @returns true once the host reports a terminal state.
 */
export function isOperationSettled(operation: Operation): boolean {
  return operation.state !== 'running'
}

/**
 * Polling cadence for the operation poller.
 *
 * Fast at first (the first package usually resolves quickly, and the user is
 * watching), then backing off so a long package-manager run does not hammer
 * the host.
 * @param attempt - zero-based poll attempt.
 * @returns delay in milliseconds.
 */
export function pollDelayMs(attempt: number): number {
  if (attempt < 5) return 500
  if (attempt < 20) return 1000
  return 2000
}

/** Reconnection polling interval after a restart. */
export const RESTART_PROBE_INTERVAL_MS = 700
/** How long to wait for the host to come back before giving up. */
export const RESTART_PROBE_BUDGET_MS = 120_000
