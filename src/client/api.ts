/**
 * Transport for the top-row controls: the ONLY module that knows the host's
 * HTTP contract, so a path or shape change is a single-file edit.
 *
 * The host half mounts a route family under {@link API_PREFIX}. Every call is
 * same-origin (a relative URL), so the DSH shell's own session cookie rides
 * along automatically — there is no token to mint, no CSRF header to set, and
 * no CORS preflight. Errors are normalized into {@link ApiError} with a
 * machine-readable `code`, so the UI can tell "retry" apart from "this host
 * will never do that, disable the button".
 */
import type { Capabilities, Operation, OperationPackage, UpdateSummary } from './contract.ts'

export type { Capabilities, Operation, OperationPackage, PluginUpdate, UpdateSummary } from './contract.ts'

/** Route prefix the host half mounts its API family under. */
export const API_PREFIX = '/dsh-market/api'

/** Absolute (same-origin) endpoint table. */
export const ENDPOINTS = {
  /** Feature detection: which capabilities this host actually implements. */
  capabilities: `${API_PREFIX}/capabilities`,
  /** Update summary: installed vs latest for every profile plugin. */
  summary: `${API_PREFIX}/updates/summary`,
  /** Start updating every updatable package; returns an operation id. */
  updateAll: `${API_PREFIX}/updates/all`,
  /** Poll one operation by `?id=`. */
  operations: `${API_PREFIX}/operations`,
  /** Restart the DSH host process. */
  restart: `${API_PREFIX}/restart`,
  /** Liveness + process identity; `bootId` changes across a restart. */
  ping: `${API_PREFIX}/ping`,
} as const

/** Why a request failed, in a form the UI can branch on. */
export type ApiErrorCode =
  /** The host does not implement this endpoint (404/405/501): a permanent gap. */
  | 'unsupported'
  /** The request never reached a listener (offline, restarting, DNS reset). */
  | 'unreachable'
  /** The host answered with a non-2xx status. */
  | 'http'
  /** The host answered 2xx but the body was not the JSON shape we expect. */
  | 'malformed'
  /** The caller aborted the request (unmount / superseded poll). */
  | 'aborted'

/** Normalized transport failure. */
export class ApiError extends Error {
  /** Machine-readable cause, used for graceful-degradation decisions. */
  readonly code: ApiErrorCode
  /** HTTP status when one was received. */
  readonly status: number | undefined
  /** Host-supplied `{ error }` text from a non-2xx body, when present. */
  readonly hostError: string | undefined
  /**
   * Host-supplied `{ reason }` field from a non-2xx body, when present.
   *
   * Kept separate from {@link hostError} deliberately. On the wire the two
   * fields carry DIFFERENT KINDS of thing, and the names are counter-intuitive
   * enough that collapsing them causes exactly the class of bug where the user
   * is shown a log line instead of a sentence:
   *
   * - `error`  — user-facing, actionable prose. The host's `/restart` refusal
   *              sends `capability.reason` here ("the desktop shell owns the
   *              app lifecycle"). This is what a tooltip should show.
   * - `reason` — a machine-readable token. The same refusal sends
   *              `capability.managedBy` here (literally `"desktop-host"`), and
   *              the busy refusal sends `"update-in-progress"`.
   *
   * So: render `hostError`; branch on `hostReason`. Never swap them.
   */
  readonly hostReason: string | undefined

  constructor(
    code: ApiErrorCode,
    message: string,
    status?: number,
    hostError?: string,
    hostReason?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.hostError = hostError
    this.hostReason = hostReason
  }

  /**
   * Whether the failure means "this endpoint will never work here", as opposed
   * to a transient condition worth retrying. A missing endpoint is permanent;
   * a network blip is not.
   */
  get permanent(): boolean {
    return this.code === 'unsupported'
  }

  /** The most user-useful description available, preferring the host's own wording. */
  get detail(): string {
    return this.hostError ?? this.message
  }
}

/** Caller-supplied cancellation and test seams. */
export interface RequestOptions {
  /** Abort the request (component unmount, superseded poll). */
  readonly signal?: AbortSignal
  /** Fetch implementation override; defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Perform one JSON request against the host API.
 *
 * Never throws anything but {@link ApiError}, so callers reason about exactly
 * one failure type.
 * @param url - same-origin endpoint.
 * @param init - fetch init; `signal`/`fetch` come from `options`.
 * @param options - cancellation and test seams.
 * @returns the parsed JSON body.
 */
async function requestJson(url: string, init: RequestInit, options: RequestOptions): Promise<unknown> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new ApiError('unsupported', 'fetch is not available in this environment')
  }

  let response: Response
  try {
    // `signal` is assigned rather than spread: under exactOptionalPropertyTypes
    // an explicit `undefined` is not assignable to `AbortSignal | null`.
    const merged: RequestInit = {
      ...init,
      // Same-origin: the DSH shell's session cookie is sent automatically.
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
    }
    if (options.signal !== undefined) merged.signal = options.signal
    response = await doFetch(url, merged)
  } catch (error) {
    // Abort is classified FIRST. An aborted request from a caller that
    // navigated away, or superseded its own poll, must not be reported to the
    // user as an unreachable host.
    if (isAbortError(error, options.signal)) throw new ApiError('aborted', 'request aborted')
    throw new ApiError(
      'unreachable',
      `cannot reach the DSH host: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    // A missing route means the capability does not exist on this host;
    // anything else is a real (possibly transient) host error. 409 from
    // /restart is deliberately NOT "unsupported": the endpoint exists and the
    // body carries the reason, which the caller surfaces verbatim.
    const code: ApiErrorCode = response.status === 404 || response.status === 405 || response.status === 501
      ? 'unsupported'
      : 'http'
    const failure = await readErrorFields(response)
    throw new ApiError(
      code,
      `${init.method ?? 'GET'} ${url} failed with ${response.status}`,
      response.status,
      failure.error,
      failure.reason,
    )
  }

  if (response.status === 204) return null

  try {
    return await response.json()
  } catch {
    throw new ApiError('malformed', `${init.method ?? 'GET'} ${url} returned a non-JSON body`, response.status)
  }
}

/** The two diagnostic strings a non-2xx body may carry, kept distinct. */
interface ErrorFields {
  /** `{ error }` — user-facing, actionable prose. Safe to render. */
  readonly error: string | undefined
  /** `{ reason }` — machine-readable token (e.g. `"desktop-host"`). Branch on it, never render it. */
  readonly reason: string | undefined
}

/**
 * Best-effort read of a non-2xx body's diagnostic fields.
 *
 * The body may be empty, HTML from a proxy, or malformed; every one of those is
 * a missing detail, never a secondary failure.
 *
 * `error` and `reason` are read into SEPARATE fields and deliberately not
 * collapsed. The host's `/restart` refusal sends `{ error: <sentence>,
 * reason: <machine token> }`, so a single "best available string" field
 * fallback would happily surface `"desktop-host"` to the user whenever `error`
 * happened to be absent. Callers render `error` and branch on `reason`.
 * @param response - the failed response.
 * @returns both fields, each undefined when absent or not a string.
 */
async function readErrorFields(response: Response): Promise<ErrorFields> {
  try {
    const body: unknown = await response.json()
    const record = asRecord(body)
    if (record === undefined) return { error: undefined, reason: undefined }
    const error = record['error']
    const reason = record['reason']
    return {
      error: typeof error === 'string' ? error : undefined,
      reason: typeof reason === 'string' ? reason : undefined,
    }
  } catch {
    return { error: undefined, reason: undefined }
  }
}

/**
 * Whether a rejected `fetch` was caused by the caller aborting it.
 *
 * Two checks, because neither alone is sufficient:
 *
 * - The error's `name`. Browsers and Node's undici reject with a `DOMException`
 *   named `AbortError`, but that is convention rather than a guarantee, and a
 *   polyfilled or wrapped fetch may reject with something else.
 * - `signal.aborted`. This is authoritative: if the caller aborted, the abort
 *   is the cause of the failure whatever the throwable happens to look like.
 *
 * Getting this wrong is user-visible. Both are `!response.ok`-free paths, so a
 * misclassified abort falls through to `unreachable` and tells the user "cannot
 * reach the DSH host" when they simply navigated away — a false diagnosis of a
 * network fault that does not exist.
 * @param error - the value a `fetch` promise rejected with.
 * @param signal - the caller's abort signal, when one was supplied.
 * @returns true when the request was aborted by the caller.
 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError'
}

/** Narrow an unknown to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read a required string field, or throw a malformed-body error. */
function readString(source: Record<string, unknown>, field: string, url: string): string {
  const value = source[field]
  if (typeof value !== 'string') {
    throw new ApiError('malformed', `${url} is missing string field "${field}"`)
  }
  return value
}

/** Read a string field that the host may legitimately report as null. */
function readNullableString(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  return typeof value === 'string' ? value : ''
}

/** Read an optional string field. */
function readOptionalString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field]
  return typeof value === 'string' ? value : undefined
}

/** Read a boolean field, defaulting when absent. */
function readBoolean(source: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = source[field]
  return typeof value === 'boolean' ? value : fallback
}

/** Read a numeric field, defaulting when absent. */
function readNumber(source: Record<string, unknown>, field: string, fallback: number): number {
  const value = source[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read an optional numeric field. */
function readOptionalNumber(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse the capabilities payload.
 *
 * An older host that predates this endpoint answers 404; that is reported as
 * "nothing is supported" rather than as an error, which is precisely the
 * graceful-degradation contract the UI needs.
 * @param options - cancellation and test seams.
 * @returns per-feature availability.
 */
export async function fetchCapabilities(options: RequestOptions = {}): Promise<Capabilities> {
  try {
    const body = asRecord(await requestJson(ENDPOINTS.capabilities, { method: 'GET' }, options))
    if (body === undefined) {
      throw new ApiError('malformed', `${ENDPOINTS.capabilities} did not return an object`)
    }
    const features = asRecord(body['features']) ?? {}
    const restart = asRecord(body['restart']) ?? {}
    // `supported` is authoritative when present; older hosts may instead flap
    // the boolean directly in `features.restart`.
    const supported = typeof restart['supported'] === 'boolean'
      ? restart['supported']
      : readBoolean(features, 'restart', false)
    return {
      // Checking and updating share one capability gate: without `update`
      // there is nothing actionable, even if `check` alone is offered.
      update: readBoolean(features, 'update', false),
      canCheck: readBoolean(features, 'check', false),
      restart: supported,
      managedBy: readOptionalString(restart, 'managedBy'),
      reason: readOptionalString(restart, 'reason'),
      version: readOptionalString(body, 'version'),
      runtime: readOptionalString(body, 'runtime'),
      profile: readOptionalString(body, 'profile'),
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unsupported') {
      return { update: false, canCheck: false, restart: false, managedBy: undefined, reason: undefined, version: undefined, runtime: undefined, profile: undefined }
    }
    throw error
  }
}

/**
 * Read the current update summary.
 * @param options - cancellation and test seams; pass `force` to bypass the host's cache.
 * @returns the summary, normalized to a readonly snapshot.
 */
export async function fetchSummary(
  options: RequestOptions & { readonly force?: boolean } = {},
): Promise<UpdateSummary> {
  const url = options.force === true ? `${ENDPOINTS.summary}?force=1` : ENDPOINTS.summary
  const body = asRecord(await requestJson(url, { method: 'GET' }, options))
  if (body === undefined) throw new ApiError('malformed', `${url} did not return an object`)

  const rawPackages = body['packages']
  const packages = Array.isArray(rawPackages)
    ? rawPackages.map((entry) => {
      const record = asRecord(entry) ?? {}
      return {
        name: readString(record, 'name', url),
        source: readOptionalString(record, 'source') ?? 'npm',
        installedVersion: readNullableString(record, 'installedVersion'),
        latestVersion: readNullableString(record, 'latestVersion'),
      }
    })
    : []

  return {
    // `checked` is the denominator the badge reports against: "0 of 5
    // checked" must never read as "up to date".
    checked: readNumber(body, 'checked', packages.length),
    updatable: readNumber(body, 'updatable', 0),
    packages,
  }
}

/** Parse one operation payload. */
function parseOperation(body: Record<string, unknown>, url: string): Operation {
  const rawState = body['state']
  const state: Operation['state'] = rawState === 'success' || rawState === 'partial' || rawState === 'failed'
    ? rawState
    : 'running'

  const rawPackages = body['packages']
  const packages: OperationPackage[] = Array.isArray(rawPackages)
    ? rawPackages.map((entry) => {
      const record = asRecord(entry) ?? {}
      const raw = record['state']
      const packageState: OperationPackage['state'] = raw === 'pending'
        || raw === 'running'
        || raw === 'success'
        || raw === 'failed'
        || raw === 'skipped'
        ? raw
        : 'pending'
      return {
        name: readString(record, 'name', url),
        from: readNullableString(record, 'from'),
        to: readNullableString(record, 'to'),
        state: packageState,
        error: readOptionalString(record, 'error'),
      }
    })
    : []

  return {
    id: readOptionalString(body, 'operationId') ?? readOptionalString(body, 'id') ?? '',
    state,
    packages,
    restartRequired: readBoolean(body, 'restartRequired', false),
    error: readOptionalString(body, 'error'),
    startedAt: readOptionalNumber(body, 'startedAt'),
    finishedAt: readOptionalNumber(body, 'finishedAt'),
  }
}

/**
 * Start updating every updatable package.
 * @param options - cancellation and test seams.
 * @returns the started operation's id and its package count.
 */
export async function startUpdateAll(options: RequestOptions = {}): Promise<{ readonly id: string; readonly total: number }> {
  const url = ENDPOINTS.updateAll
  const body = asRecord(await requestJson(url, { method: 'POST' }, options))
  if (body === undefined) throw new ApiError('malformed', `${url} did not return an object`)
  const id = readOptionalString(body, 'operationId') ?? readOptionalString(body, 'id')
  if (id === undefined || id === '') {
    throw new ApiError('malformed', `${url} did not return an operationId`)
  }
  return { id, total: readNumber(body, 'total', 0) }
}

/**
 * Poll one operation.
 * @param operationId - id returned by {@link startUpdateAll}.
 * @param options - cancellation and test seams.
 * @returns the operation's current state.
 */
export async function fetchOperation(operationId: string, options: RequestOptions = {}): Promise<Operation> {
  const url = `${ENDPOINTS.operations}?id=${encodeURIComponent(operationId)}`
  const body = asRecord(await requestJson(url, { method: 'GET' }, options))
  if (body === undefined) throw new ApiError('malformed', `${url} did not return an object`)
  return parseOperation(body, url)
}

/** Outcome of asking the host to restart. */
export type RestartOutcome =
  /** The host accepted; the process will go away shortly. */
  | { readonly accepted: true }
  /** The host refused; the reason is already localized by the caller. */
  | { readonly accepted: false; readonly reason: string }

/**
 * Ask the host to restart itself.
 *
 * A 409 is a first-class answer here, not an exception: it is how the host
 * says "restart is not mine to perform", and the body carries the reason.
 * Likewise, the socket dying as the process exits is the expected outcome of a
 * successful call, so `unreachable` immediately after is treated as accepted.
 * @param options - cancellation and test seams.
 * @returns whether the host accepted the restart.
 */
export async function requestRestart(options: RequestOptions = {}): Promise<RestartOutcome> {
  try {
    await requestJson(ENDPOINTS.restart, { method: 'POST' }, options)
    return { accepted: true }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.code === 'unreachable') return { accepted: true }
    if (error.code === 'http' && error.status === 409) {
      // `hostError` (the wire's `error` field) is the USER-FACING sentence and
      // is what belongs in a tooltip. The wire's `reason` field is a machine
      // token — for the desktop refusal it is literally "desktop-host" — so it
      // must NOT be used as the user-visible text. `hostReason` is carried on
      // the error for callers that want to branch on the slug.
      return { accepted: false, reason: error.hostError ?? '' }
    }
    throw error
  }
}

/** Result of a liveness probe. */
export interface HostPing {
  /** True once any HTTP response arrived. */
  readonly alive: boolean
  /** Process identity; changes across a restart. */
  readonly bootId: string | undefined
}

/**
 * Probe the host's liveness and identity.
 *
 * `bootId` is the restart signal: the host answers 200 again the instant it
 * rebinds, but the page must not reload until it is genuinely a new process.
 * @param options - cancellation and test seams.
 * @returns liveness plus the current `bootId` when the host reports one.
 */
export async function probeHost(options: RequestOptions = {}): Promise<HostPing> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { alive: false, bootId: undefined }
  try {
    const probe: RequestInit = {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    }
    if (options.signal !== undefined) probe.signal = options.signal
    const response = await doFetch(ENDPOINTS.ping, probe)
    // Any response — even 401 from an auth gate or 404 from a host that has no
    // ping route — proves the listener is accepting connections again.
    let bootId: string | undefined
    try {
      bootId = readOptionalString(asRecord(await response.json()) ?? {}, 'bootId')
    } catch {
      bootId = undefined
    }
    return { alive: true, bootId }
  } catch {
    return { alive: false, bootId: undefined }
  }
}
