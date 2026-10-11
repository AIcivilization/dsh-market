/**
 * Transport tests: the fetch layer's interpretation of the host contract.
 *
 * These are the failures that are invisible until a user hits them — an
 * endpoint that answers 404 turning into an enabled-but-dead button, a host
 * that dies mid-request being reported as a permanent incapability, or the
 * update badge reporting "up to date" because the host had not actually
 * checked anything.
 */
import { describe, expect, it } from 'vitest'
import {
  API_PREFIX,
  ApiError,
  ENDPOINTS,
  fetchCapabilities,
  fetchOperation,
  fetchSummary,
  probeHost,
  requestRestart,
  startUpdateAll,
  type RestartOutcome,
} from '../../src/client/api.ts'
import {
  CAPABILITIES_BODY,
  OPERATION_DONE_BODY,
  SUMMARY_BODY,
  createAbortStub,
  createFetchStub,
  type Reply,
} from './fetch-stub.ts'

/** One JSON reply, for terse test setup. */
function json(status: number, body: unknown): Reply {
  return { kind: 'json', status, body }
}

/**
 * Narrow a `RestartOutcome` to its refusal variant.
 *
 * `RestartOutcome` is a union whose members share only the `accepted` flag, so
 * `expect(outcome.accepted).toBe(false)` does not narrow for TypeScript —
 * `reason` does not exist on the union. The `throw` is what narrows, and it
 * also fails the test loudly rather than letting a silent `undefined` flow on.
 * @param outcome - the result under test.
 * @returns the refusal variant.
 */
function refusalOf(outcome: RestartOutcome): { reason: string } {
  if (outcome.accepted) throw new Error('expected the host to refuse the restart, but it accepted')
  return outcome
}

/**
 * Narrow a settled value to an `ApiError`.
 *
 * `instanceof` is used rather than a property probe: `ApiError` is a class, so
 * this narrows cleanly AND asserts the failure was our own error type rather
 * than any object that happens to carry a `code`.
 * @param value - the settled value under test.
 * @returns the error.
 */
function asApiError(value: unknown): ApiError {
  if (!(value instanceof ApiError)) {
    throw new Error(`expected an ApiError, got ${String(value)}`)
  }
  return value
}

describe('endpoint table', () => {
  it('uses the frozen /dsh-market prefix and same-origin relative URLs', () => {
    expect(API_PREFIX).toBe('/dsh-market/api')
    for (const url of Object.values(ENDPOINTS)) {
      // A relative URL is what keeps the shell's session cookie attached; an
      // absolute one would be a different origin and would not authenticate.
      expect(url.startsWith('/')).toBe(true)
      expect(url.startsWith('http')).toBe(false)
    }
  })

  it('addresses the operations endpoint by id query parameter', () => {
    expect(ENDPOINTS.operations).toBe('/dsh-market/api/operations')
  })
})

describe('fetchCapabilities', () => {
  it('reads the feature flags and the restart block', async () => {
    const { fetchImpl, calls } = createFetchStub([json(200, CAPABILITIES_BODY)])
    const capabilities = await fetchCapabilities({ fetchImpl })

    expect(capabilities.update).toBe(true)
    expect(capabilities.canCheck).toBe(true)
    // The live desktop host genuinely reports restart as unsupported; the
    // client must carry that through rather than assuming it can restart.
    expect(capabilities.restart).toBe(false)
    expect(capabilities.managedBy).toBe('desktop-host')
    expect(capabilities.reason).toBe('the desktop shell owns the app lifecycle')
    expect(calls[0]?.credentials).toBe('same-origin')
  })

  it('treats a missing capabilities endpoint as "nothing is supported", not as an error', async () => {
    // An older host without this route must degrade, never throw: this is the
    // graceful-degradation contract the UI is built on.
    const { fetchImpl } = createFetchStub([json(404, { error: 'not found' })])
    const capabilities = await fetchCapabilities({ fetchImpl })

    expect(capabilities).toEqual({
      update: false,
      canCheck: false,
      restart: false,
      managedBy: undefined,
      reason: undefined,
      version: undefined,
      runtime: undefined,
      profile: undefined,
    })
  })

  it('accepts a host that flaps restart as a bare boolean', async () => {
    const { fetchImpl } = createFetchStub([json(200, {
      features: { check: true, update: true, restart: true },
    })])
    const capabilities = await fetchCapabilities({ fetchImpl })
    expect(capabilities.restart).toBe(true)
  })
})

describe('fetchSummary', () => {
  it('reports the checked denominator separately from the updatable count', async () => {
    // The product's core honesty claim: "0 of 5 checked" is NOT "up to date".
    // These two numbers must never be conflated into one.
    const { fetchImpl } = createFetchStub([json(200, SUMMARY_BODY)])
    const summary = await fetchSummary({ fetchImpl })

    expect(summary.checked).toBe(5)
    expect(summary.updatable).toBe(2)
    expect(summary.packages).toHaveLength(2)
    expect(summary.packages[0]?.installedVersion).toBe('1.0.0')
    expect(summary.packages[0]?.latestVersion).toBe('1.1.0')
  })

  it('preserves checked: 0 distinctly, so the badge cannot claim "up to date"', async () => {
    const { fetchImpl } = createFetchStub([json(200, { checked: 0, updatable: 0, packages: [] })])
    const summary = await fetchSummary({ fetchImpl })

    expect(summary.checked).toBe(0)
    expect(summary.updatable).toBe(0)
  })

  it('normalizes a null version to an empty string instead of failing', async () => {
    // A linked/git dependency legitimately has no registry version.
    const { fetchImpl } = createFetchStub([json(200, {
      checked: 1,
      updatable: 0,
      packages: [{ name: 'local-dep', source: 'link', installedVersion: null, latestVersion: null }],
    })])
    const summary = await fetchSummary({ fetchImpl })

    expect(summary.packages[0]?.installedVersion).toBe('')
    expect(summary.packages[0]?.latestVersion).toBe('')
    expect(summary.packages[0]?.source).toBe('link')
  })

  it('requests a forced re-check only when asked', async () => {
    const plain = createFetchStub([json(200, SUMMARY_BODY)])
    await fetchSummary({ fetchImpl: plain.fetchImpl })
    expect(plain.calls[0]?.url).toBe('/dsh-market/api/updates/summary')

    const forced = createFetchStub([json(200, SUMMARY_BODY)])
    await fetchSummary({ fetchImpl: forced.fetchImpl, force: true })
    expect(forced.calls[0]?.url).toBe('/dsh-market/api/updates/summary?force=1')
  })
})

describe('startUpdateAll', () => {
  it('returns the operation id and package count from a 202', async () => {
    const { fetchImpl, calls } = createFetchStub([json(202, { operationId: 'op-9', total: 3 })])
    const started = await startUpdateAll({ fetchImpl })

    expect(started).toEqual({ id: 'op-9', total: 3 })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/dsh-market/api/updates/all')
  })

  it('rejects a 202 that carries no operation id', async () => {
    // Without an id there is nothing to poll, so accepting this would leave
    // the button spinning forever. It must be a hard error.
    const { fetchImpl } = createFetchStub([json(202, { total: 3 })])
    await expect(startUpdateAll({ fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('fetchOperation', () => {
  it('parses per-package progress and the restart-required flag', async () => {
    const { fetchImpl, calls } = createFetchStub([json(200, OPERATION_DONE_BODY)])
    const operation = await fetchOperation('op-1', { fetchImpl })

    expect(operation.state).toBe('success')
    expect(operation.restartRequired).toBe(true)
    expect(operation.packages.map(entry => entry.state)).toEqual(['success', 'failed'])
    expect(operation.packages[1]?.error).toBe('registry timeout')
    expect(calls[0]?.url).toContain('id=op-1')
  })

  it('encodes an operation id so a stray character cannot forge a query', async () => {
    const { fetchImpl, calls } = createFetchStub([json(200, OPERATION_DONE_BODY)])
    await fetchOperation('a&b=c', { fetchImpl })
    expect(calls[0]?.url).toBe('/dsh-market/api/operations?id=a%26b%3Dc')
  })

  it('maps an unrecognized state to running rather than declaring false success', async () => {
    // A partially-updated host must never be read as "finished".
    const { fetchImpl } = createFetchStub([json(200, { operationId: 'op-1', state: 'weird', packages: [] })])
    const operation = await fetchOperation('op-1', { fetchImpl })
    expect(operation.state).toBe('running')
  })

  it('reports a failed operation as failed, not as a transport error', async () => {
    const { fetchImpl } = createFetchStub([json(200, {
      operationId: 'op-2',
      state: 'failed',
      packages: [],
      restartRequired: false,
      error: 'pnpm exited 1',
    })])
    const operation = await fetchOperation('op-2', { fetchImpl })
    expect(operation.state).toBe('failed')
    expect(operation.error).toBe('pnpm exited 1')
  })
})

describe('requestRestart', () => {
  it('accepts a 202 as the restart being taken', async () => {
    const { fetchImpl } = createFetchStub([json(202, { accepted: true })])
    await expect(requestRestart({ fetchImpl })).resolves.toEqual({ accepted: true })
  })

  it('turns a 409 into a refusal carrying the host\'s user-facing sentence', async () => {
    // WIRE-ACCURATE fixture, taken from the host's own refusal sites:
    //   routes.ts:308  sendJson(409, { error: capability.reason,    reason: capability.managedBy })
    //   routes.ts:315  sendJson(409, { error: <sentence>,           reason: 'update-in-progress' })
    // The field naming is counter-intuitive: the wire's `error` holds the
    // user-facing prose and the wire's `reason` holds a machine token. The
    // tooltip must show the SENTENCE, so the assertion below pins `hostError`.
    const { fetchImpl } = createFetchStub([json(409, {
      error: 'the desktop shell owns the app lifecycle',
      reason: 'desktop-host',
    })])
    const outcome = await requestRestart({ fetchImpl })

    expect(outcome.accepted).toBe(false)
    expect(outcome).toEqual({ accepted: false, reason: 'the desktop shell owns the app lifecycle' })
    // The bug this guards: preferring the wire's `reason` would put the token
    // "desktop-host" in front of the user.
    expect(refusalOf(outcome).reason).not.toBe('desktop-host')
  })

  it('carries the machine token separately for the busy refusal', async () => {
    const { fetchImpl } = createFetchStub([json(409, {
      error: 'an update is running; wait for it to finish before restarting',
      reason: 'update-in-progress',
    })])
    const outcome = await requestRestart({ fetchImpl })

    expect(outcome).toEqual({
      accepted: false,
      reason: 'an update is running; wait for it to finish before restarting',
    })
  })

  it('reports a 403 refusal as a decision, with the host sentence', async () => {
    // The same-origin fence answers 403 with an `error` sentence just like the
    // 409 refusals do. Handling only 409 threw the 403 as a raw error, so the
    // user saw an exception instead of the host's explanation.
    const { fetchImpl } = createFetchStub([json(403, {
      error: "This request did not come from this machine's page and was refused.",
      reason: 'no-origin',
    })])
    const outcome = await requestRestart({ fetchImpl })

    expect(outcome).toEqual({
      accepted: false,
      reason: "This request did not come from this machine's page and was refused.",
    })
  })

  it('keeps the machine token on the error, not in the rendered reason', async () => {
    // Both fields are carried, but on separate properties, so a future caller
    // can branch on the slug without ever rendering it.
    const { fetchImpl } = createFetchStub([json(409, { error: 'nope', reason: 'desktop-host' })])
    await expect(requestRestart({ fetchImpl })).resolves.toEqual({ accepted: false, reason: 'nope' })

    const { fetchImpl: probeStub } = createFetchStub([json(409, { error: 'nope', reason: 'desktop-host' })])
    await expect(fetchSummary({ fetchImpl: probeStub })).rejects.toMatchObject({
      hostError: 'nope',
      hostReason: 'desktop-host',
    })
  })

  it('never promotes a machine token into hostError when error is absent', async () => {
    // The guard against a "best available string" fallback: a body carrying
    // only `reason` must leave the renderable field empty rather than showing
    // the user a slug.
    const { fetchImpl } = createFetchStub([json(409, { reason: 'desktop-host' })])
    const outcome = await requestRestart({ fetchImpl })

    expect(outcome.accepted).toBe(false)
    expect(refusalOf(outcome).reason).toBe('')
  })

  it('treats a dropped connection as success, because the process is exiting', async () => {
    // The host answers and then dies; the socket error IS the expected outcome
    // of a successful restart. Reporting it as failure would be a false alarm.
    const { fetchImpl } = createFetchStub([{ kind: 'network' }])
    await expect(requestRestart({ fetchImpl })).resolves.toEqual({ accepted: true })
  })

  it('still surfaces a genuine server error', async () => {
    const { fetchImpl } = createFetchStub([json(500, { error: 'boom' })])
    await expect(requestRestart({ fetchImpl })).rejects.toMatchObject({ code: 'http', status: 500 })
  })
})

describe('probeHost', () => {
  it('reports the bootId so a restart can be detected as a new process', async () => {
    // A 200 alone is NOT proof of a restart: the old process answers again the
    // instant it is touched. bootId is the only sound signal.
    const { fetchImpl } = createFetchStub([json(200, { ok: true, bootId: '3660-abc', uptimeMs: 10 })])
    await expect(probeHost({ fetchImpl })).resolves.toEqual({ alive: true, bootId: '3660-abc' })
  })

  it('reports alive without a bootId when the body is not JSON', async () => {
    // Any HTTP response proves the listener is back, even one we cannot parse.
    const { fetchImpl } = createFetchStub([{ kind: 'text', status: 401, body: 'unauthorized' }])
    await expect(probeHost({ fetchImpl })).resolves.toEqual({ alive: true, bootId: undefined })
  })

  it('reports not-alive while the host is down', async () => {
    const { fetchImpl } = createFetchStub([{ kind: 'network' }])
    await expect(probeHost({ fetchImpl })).resolves.toEqual({ alive: false, bootId: undefined })
  })
})

describe('error classification', () => {
  it('marks a missing endpoint permanent and a 500 as retryable', async () => {
    const missing = createFetchStub([json(404, {})])
    await expect(fetchSummary({ fetchImpl: missing.fetchImpl }))
      .rejects.toMatchObject({ code: 'unsupported', permanent: true })

    const serverError = createFetchStub([json(500, { error: 'busy' })])
    await expect(fetchSummary({ fetchImpl: serverError.fetchImpl }))
      .rejects.toMatchObject({ code: 'http', permanent: false, detail: 'busy' })
  })

  it('reports an unreachable host distinctly from a 4xx', async () => {
    const { fetchImpl } = createFetchStub([{ kind: 'network', message: 'ECONNREFUSED' }])
    await expect(fetchSummary({ fetchImpl })).rejects.toMatchObject({ code: 'unreachable', permanent: false })
  })

  it('reports a malformed body rather than trusting it', async () => {
    const { fetchImpl } = createFetchStub([{ kind: 'text', status: 200, body: 'not json' }])
    await expect(fetchSummary({ fetchImpl })).rejects.toMatchObject({ code: 'malformed' })
  })

  it('honours an aborted request as aborted, not as an unreachable host', async () => {
    // Unmount must not be reported to the user as "cannot reach the DSH host":
    // that is a false diagnosis of a network fault that does not exist. The
    // message is asserted exactly, because the message is what the user reads.
    const { fetchImpl, signal } = createAbortStub()
    await expect(fetchSummary({ fetchImpl, signal })).rejects.toMatchObject({
      code: 'aborted',
      permanent: false,
    })

    // The message is asserted exactly, because the message is what the user
    // reads. `asApiError` narrows the promise's union result properly.
    const failure = asApiError(await fetchSummary({ fetchImpl, signal }).catch((error: unknown) => error))
    expect(failure.message).not.toContain('cannot reach the DSH host')
  })

  it('classifies an abort even when the throwable is not named AbortError', async () => {
    // Engine behaviour on abort rejection is not guaranteed, so the signal is
    // consulted as well as the name. Without that check this falls through to
    // `unreachable` and misreports a deliberate cancellation as a dead host.
    const { fetchImpl, signal } = createAbortStub({ errorName: 'TypeError' })
    await expect(fetchSummary({ fetchImpl, signal })).rejects.toMatchObject({ code: 'aborted' })
  })

  it('still reports a genuine connection failure as unreachable', async () => {
    // The abort check must not swallow real network failures: an unaborted
    // signal plus a socket error is exactly what `unreachable` is for.
    const { fetchImpl } = createFetchStub([{ kind: 'network', message: 'ECONNREFUSED' }])
    const idle = new AbortController()
    await expect(fetchSummary({ fetchImpl, signal: idle.signal }))
      .rejects.toMatchObject({ code: 'unreachable' })
  })

  it('does not treat an abort as a capability downgrade', async () => {
    // A cancelled check must leave the control retryable. If it were
    // classified `unsupported` the button would latch off permanently on a
    // mere unmount, which is a one-way trip for the user until a reload.
    const { fetchImpl, signal } = createAbortStub()
    const failure = asApiError(await fetchSummary({ fetchImpl, signal }).catch((error: unknown) => error))

    expect(failure.code).toBe('aborted')
    // `permanent` gates the "disable forever" path; abort must not trip it.
    expect(failure.permanent).toBe(false)
  })
})
