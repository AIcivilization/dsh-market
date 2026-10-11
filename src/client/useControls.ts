/**
 * The controls' async orchestration, as one hook.
 *
 * Owns capability detection, the summary check, the update-all operation
 * poller, and the restart reconnection loop. Every loop is cancellation-aware:
 * an in-flight poll is aborted on unmount, so a detached timer can never write
 * state into an unmounted component.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchCapabilities,
  fetchOperation,
  fetchSummary,
  probeHost,
  requestRestart,
  startUpdateAll,
} from './api.ts'
import {
  INITIAL_RESTART,
  INITIAL_UPDATE,
  RESTART_PROBE_BUDGET_MS,
  RESTART_PROBE_INTERVAL_MS,
  canRunRestart,
  canRunUpdate,
  isOperationSettled,
  pollDelayMs,
  reasonForError,
  restartUnavailable,
  updateActionable,
  updateUnavailable,
  type ControlsState,
  type RestartPhase,
  type RestartState,
  type UnavailableReason,
  type UpdateState,
} from './state.ts'

/** What the controls expose to the components. */
export interface ControlsController {
  /** Current state of both controls. */
  readonly state: ControlsState
  /** Whether the update button is actionable right now. */
  readonly canUpdate: boolean
  /** Whether clicking update will start an operation (rather than re-check). */
  readonly updateIsActionable: boolean
  /** Whether the restart button is actionable right now. */
  readonly canRestart: boolean
  /** Click handler for the update button: re-check, or update all. */
  readonly onUpdateClick: () => void
  /** Click handler for the restart button. */
  readonly onRestartClick: () => void
}

/** Sleep that resolves early — with `true` — when aborted. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(true); return }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(true)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Drive the two controls.
 * @param now - clock seam, injectable for tests.
 * @returns the controller the components render.
 */
export function useControls(now: () => number = Date.now): ControlsController {
  const [update, setUpdate] = useState<UpdateState>(INITIAL_UPDATE)
  const [restart, setRestart] = useState<RestartState>(INITIAL_RESTART)
  const [capabilities, setCapabilities] = useState<ControlsState['capabilities']>(undefined)

  /** Abort controllers for the in-flight request of each loop. */
  const checkAbort = useRef<AbortController | undefined>(undefined)
  const pollAbort = useRef<AbortController | undefined>(undefined)
  const restartAbort = useRef<AbortController | undefined>(undefined)
  /** Guard so a late poll response cannot overwrite a newer one. */
  const checkGeneration = useRef(0)

  useEffect(() => () => {
    checkAbort.current?.abort()
    pollAbort.current?.abort()
    restartAbort.current?.abort()
  }, [])

  /**
   * Run one summary check and fold it into state.
   * @param force - bypass the host's cache (used by explicit re-checks).
   */
  const runCheck = useCallback(async (force: boolean): Promise<void> => {
    checkAbort.current?.abort()
    const controller = new AbortController()
    checkAbort.current = controller
    const generation = ++checkGeneration.current

    setUpdate(previous => ({ ...previous, phase: 'checking', error: undefined }))

    try {
      const summary = await fetchSummary({ signal: controller.signal, force })
      if (generation !== checkGeneration.current) return
      setUpdate(previous => ({
        ...previous,
        phase: 'idle',
        summary,
        // A completed check supersedes any finished operation's rows.
        operation: undefined,
        error: undefined,
        checkedAt: now(),
        unavailable: undefined,
      }))
    } catch (error) {
      if (generation !== checkGeneration.current) return
      if (error instanceof ApiError && error.code === 'aborted') return
      const reason: UnavailableReason | undefined = error instanceof ApiError
        ? reasonForError(error, 'update')
        : undefined
      setUpdate(previous => ({
        ...previous,
        phase: 'idle',
        error: error instanceof ApiError ? error.detail : String(error),
        unavailable: reason ?? previous.unavailable,
      }))
    }
  }, [now])

  /**
   * Start an update-all and stream its progress until it settles.
   */
  const runUpdateAll = useCallback(async (): Promise<void> => {
    pollAbort.current?.abort()
    const controller = new AbortController()
    pollAbort.current = controller
    setUpdate(previous => ({ ...previous, phase: 'starting', error: undefined }))

    let operationId: string
    try {
      const started = await startUpdateAll({ signal: controller.signal })
      operationId = started.id
    } catch (error) {
      if (error instanceof ApiError && error.code === 'aborted') return
      setUpdate(previous => ({
        ...previous,
        phase: 'idle',
        error: error instanceof ApiError ? error.detail : String(error),
        unavailable: error instanceof ApiError
          ? (reasonForError(error, 'update') ?? previous.unavailable)
          : previous.unavailable,
      }))
      return
    }

    setUpdate(previous => ({ ...previous, phase: 'running' }))

    for (let attempt = 0; !controller.signal.aborted; attempt += 1) {
      try {
        const operation = await fetchOperation(operationId, { signal: controller.signal })
        setUpdate(previous => ({ ...previous, operation, phase: isOperationSettled(operation) ? 'done' : 'running' }))
        if (isOperationSettled(operation)) {
          // Re-read the summary so the badge reflects the new on-disk versions
          // and the next click does not re-offer what was just installed.
          void runCheck(true)
          return
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'aborted') return
        if (error instanceof ApiError && error.permanent) {
          setUpdate(previous => ({
            ...previous,
            phase: 'done',
            error: error.detail,
            unavailable: reasonForError(error, 'update') ?? previous.unavailable,
          }))
          return
        }
        // A transient poll failure (host busy, restarting) is survivable: the
        // operation keeps running on the host, so keep polling.
        setUpdate(previous => ({
          ...previous,
          error: error instanceof ApiError ? error.detail : String(error),
        }))
      }
      if (await delay(pollDelayMs(attempt), controller.signal)) return
    }
  }, [runCheck])

  // Initial capability probe and first check. Both are fire-and-forget: the
  // components render a sensible "checking" state until they settle.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      let detected: ControlsState['capabilities']
      try {
        detected = await fetchCapabilities({ signal: controller.signal })
      } catch {
        // A capability probe that cannot answer is not fatal: the button stays
        // enabled and the check below will surface the real error.
        detected = undefined
      }
      if (controller.signal.aborted) return
      setCapabilities(detected)
      setRestart(previous => ({ ...previous, unavailable: restartUnavailable(detected) }))
      if (detected !== undefined && !detected.update) {
        setUpdate(previous => ({ ...previous, phase: 'idle', unavailable: updateUnavailable(detected) }))
        return
      }
      await runCheck(false)
    })()
    return () => { controller.abort() }
  }, [runCheck])

  /**
   * Restart, then wait for a genuinely different process before reloading.
   */
  const runRestart = useCallback(async (): Promise<void> => {
    restartAbort.current?.abort()
    const controller = new AbortController()
    restartAbort.current = controller

    const setPhase = (phase: RestartPhase, error?: string): void => {
      setRestart(previous => ({ ...previous, phase, error }))
    }

    setPhase('requesting')
    // The pre-restart identity. A reload is only justified once this changes,
    // because the old process answers 200 again the moment it is touched.
    const before = await probeHost({ signal: controller.signal })
    const baselineBootId = before.bootId

    let accepted: boolean
    let reason = ''
    try {
      const outcome = await requestRestart({ signal: controller.signal })
      accepted = outcome.accepted
      reason = outcome.accepted ? '' : outcome.reason
    } catch (error) {
      if (error instanceof ApiError && error.code === 'aborted') return
      setPhase('failed', error instanceof ApiError ? error.detail : String(error))
      return
    }

    if (!accepted) {
      setRestart(previous => ({
        ...previous,
        phase: 'failed',
        error: reason,
        unavailable: restartUnavailable(capabilities) ?? 'unsupportedRestart',
      }))
      return
    }

    setPhase('restarting')

    const deadline = now() + RESTART_PROBE_BUDGET_MS
    let sawDown = false
    while (!controller.signal.aborted && now() < deadline) {
      if (await delay(RESTART_PROBE_INTERVAL_MS, controller.signal)) return
      const ping = await probeHost({ signal: controller.signal })
      if (!ping.alive) {
        // The host has actually stopped listening; everything after this is
        // the new process coming up.
        sawDown = true
        setPhase('restarting')
        continue
      }
      if (baselineBootId !== undefined && ping.bootId !== undefined) {
        if (ping.bootId !== baselineBootId) { setPhase('reloading'); reloadPage(); return }
        // Same process still answering: it has not cycled yet.
        continue
      }
      // Without a bootId to compare (older host, or a non-JSON ping), fall back
      // to "it went away and came back", which is the strongest evidence left.
      if (sawDown) { setPhase('reloading'); reloadPage(); return }
    }

    if (!controller.signal.aborted) setPhase('timeout')
  }, [capabilities, now])

  return {
    state: { update, restart, capabilities },
    canUpdate: canRunUpdate(update, capabilities),
    updateIsActionable: updateActionable(update),
    canRestart: canRunRestart(restart, capabilities),
    onUpdateClick: useCallback(() => {
      if (!canRunUpdate(update, capabilities)) return
      // A click with something to do updates all; otherwise it re-checks,
      // which is what makes the button useful before the first summary lands.
      if (updateActionable(update)) void runUpdateAll()
      else void runCheck(true)
    }, [capabilities, runCheck, runUpdateAll, update]),
    onRestartClick: useCallback(() => {
      if (!canRunRestart(restart, capabilities)) return
      void runRestart()
    }, [capabilities, restart, runRestart]),
  }
}

/**
 * Reload the page, after letting the DOM paint the final state.
 *
 * The timeout keeps the transition visible instead of flashing straight to a
 * blank document.
 */
function reloadPage(): void {
  setTimeout(() => { window.location.reload() }, 250)
}
