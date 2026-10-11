/**
 * A stubbed `fetch` for the transport tests.
 *
 * The transport layer is the only part of the client half that touches the
 * network, so it is the only part that needs a fake. This stub records every
 * call and answers from a script, which lets the tests assert on BOTH the
 * request the client builds (URL, method, credentials) and how it interprets
 * each response shape the host can legitimately return.
 */

/** One recorded call to the stubbed fetch. */
export interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly credentials: string | undefined
  readonly body: string | undefined
}

/** A scripted response: either a JSON body or a transport-level failure. */
export type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'text'; readonly status: number; readonly body: string }
  /** Simulate a socket failure: what `fetch` rejects with when a host dies. */
  | { readonly kind: 'network'; readonly message?: string }

/** Build a stub `fetch` plus its call log. */
export function createFetchStub(replies: readonly Reply[]): {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let index = 0

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })

    // Repeating the last reply keeps poll loops (restart, progress) simple to
    // script without padding the array.
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply === undefined) throw new Error('fetch stub ran out of replies')

    if (reply.kind === 'network') {
      throw new TypeError(reply.message ?? 'fetch failed')
    }

    const body = reply.kind === 'text' ? reply.body : JSON.stringify(reply.body)
    return new Response(body, {
      status: reply.status,
      headers: { 'content-type': reply.kind === 'text' ? 'text/plain' : 'application/json' },
    })
  }) as typeof fetch

  return { fetchImpl, calls }
}

/**
 * A `fetch` that rejects the way a REAL fetch does when its signal aborts.
 *
 * Browsers and Node's undici reject with a `DOMException` named `AbortError`.
 * The plain {@link createFetchStub} cannot express this, because its `network`
 * reply always throws an unnamed `TypeError` — which would make an abort
 * indistinguishable from a dead host and hide exactly the bug this covers.
 *
 * The request aborts itself on the first call, so the caller does not have to
 * race a timer. `errorName` is configurable so a test can also exercise the
 * defensive path where the signal is aborted but the throwable is NOT an
 * `AbortError`, which the client must still classify as an abort.
 * @param options - how to shape the rejection.
 * @returns a stub `fetch`, its call log, and the controller whose signal to pass.
 */
export function createAbortStub(options: {
  /** The throwable's `name`; defaults to the real-world `'AbortError'`. */
  readonly errorName?: string
} = {}): {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
  readonly signal: AbortSignal
  readonly controller: AbortController
} {
  const calls: RecordedCall[] = []
  const controller = new AbortController()
  const name = options.errorName ?? 'AbortError'

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    // Abort for real (so `signal.aborted` flips) and reject — the same
    // ordering a real fetch produces when the caller unmounts mid-request.
    controller.abort()
    const failure = new Error(`The operation was aborted. (${name})`)
    failure.name = name
    throw failure
  }) as typeof fetch

  return { fetchImpl, calls, signal: controller.signal, controller }
}

/** A canned capabilities payload matching the frozen host contract. */
export const CAPABILITIES_BODY = {
  version: '0.1.0',
  profile: 'desktop',
  runtime: 'desktop',
  features: { check: true, update: true, restart: false, progress: true },
  restart: { supported: false, managedBy: 'desktop-host', reason: 'the desktop shell owns the app lifecycle' },
} as const

/** A canned summary with two updatable packages out of five checked. */
export const SUMMARY_BODY = {
  checked: 5,
  updatable: 2,
  packages: [
    { name: 'dsh-vps', source: 'npm', installedVersion: '1.0.0', latestVersion: '1.1.0' },
    { name: 'dsh-model', source: 'npm', installedVersion: '2.0.0', latestVersion: '2.1.0' },
  ],
} as const

/** A canned terminal operation payload. */
export const OPERATION_DONE_BODY = {
  operationId: 'op-1',
  state: 'success',
  startedAt: 1_000,
  finishedAt: 2_000,
  restartRequired: true,
  packages: [
    { name: 'dsh-vps', from: '1.0.0', to: '1.1.0', state: 'success' },
    { name: 'dsh-model', from: '2.0.0', to: '2.1.0', state: 'failed', error: 'registry timeout' },
  ],
} as const
