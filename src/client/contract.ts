/**
 * Wire types shared by the transport and the state machines.
 *
 * These mirror the host half's JSON exactly (see `src/host`). They live in
 * their own module so `state.ts` can depend on the shapes without depending on
 * `fetch`, keeping the state machines trivially unit-testable.
 */

/** Per-feature availability reported by `GET /capabilities`. */
export interface Capabilities {
  /** The host can list and apply plugin updates. */
  readonly update: boolean
  /** The host can check for updates (may be true while `update` is false). */
  readonly canCheck: boolean
  /** The host can restart the dsh process itself. */
  readonly restart: boolean
  /** Who owns restart when `restart` is false (e.g. `desktop-host`). */
  readonly managedBy: string | undefined
  /** Host-supplied explanation for an unsupported restart. */
  readonly reason: string | undefined
  /** Host package version, for diagnostics. */
  readonly version: string | undefined
  /** Runtime kind (`cli`, `desktop`, …). */
  readonly runtime: string | undefined
  /** Active DSH profile name. */
  readonly profile: string | undefined
}

/** One plugin row in the update summary. */
export interface PluginUpdate {
  /** Package name as declared in the profile. */
  readonly name: string
  /** Where the package comes from: `npm`, `git`, or `link`. */
  readonly source: string
  /** Version currently installed on disk (`''` when unknown). */
  readonly installedVersion: string
  /** Version the registry/git remote offers (`''` when unknown). */
  readonly latestVersion: string
}

/** `GET /updates/summary` payload. */
export interface UpdateSummary {
  /** How many packages were examined — the denominator of the badge. */
  readonly checked: number
  /** How many packages can move forward. */
  readonly updatable: number
  /** The updatable packages themselves. */
  readonly packages: readonly PluginUpdate[]
}

/** Per-package progress inside an operation. */
export interface OperationPackage {
  /** Package name. */
  readonly name: string
  /** Version before the update (`''` when unknown). */
  readonly from: string
  /** Version after (or targeted by) the update (`''` when unknown). */
  readonly to: string
  /** Lifecycle state of this package. */
  readonly state: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  /** Failure detail when `state === 'failed'`. */
  readonly error: string | undefined
}

/** One long-running host operation. */
export interface Operation {
  /** Opaque id used to poll. */
  readonly id: string
  /** Overall state; `success` and `partial` are both terminal successes. */
  readonly state: 'running' | 'success' | 'partial' | 'failed'
  /** Per-package progress, in profile order. */
  readonly packages: readonly OperationPackage[]
  /** True when the applied change only takes effect after a restart. */
  readonly restartRequired: boolean
  /** Human-readable failure detail when `state === 'failed'`. */
  readonly error: string | undefined
  /** Operation start epoch milliseconds. */
  readonly startedAt: number | undefined
  /** Operation finish epoch milliseconds, or undefined while running. */
  readonly finishedAt: number | undefined
}
