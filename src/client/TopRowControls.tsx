/**
 * The two controls: 更新 (update) and 重启 DSH (restart).
 *
 * They belong in the PLUGINS PAGE header, beside that page's own refresh icon
 * and "add plugin" button. `@deepseek-ai/dsh-client-ui-plugin-manager` renders
 * that toolbar itself and declares no slot inside it (its only injectable slots
 * are `plugins.detail.*`, `plugins.item`, `plugins.row.config` and
 * `plugins.bundle.*`), so there is nowhere to register into.
 *
 * Instead this component renders into `shell.overlay` and MOVES ITSELF into the
 * plugin page's toolbar once that page mounts. The portal target is found by
 * `data-plugin-panel` — the stable hook the plugin manager puts on its `<section>`
 * — and the toolbar is the element that holds the page's refresh button, so the
 * match never depends on a hashed CSS-module class name.
 *
 * Nothing is shown while the plugins page is closed: the controls exist only
 * there, so the shell stays exactly as DSH ships it.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  IconWarningOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { UpdatePanel } from './UpdatePanel.tsx'
import { useControls } from './useControls.ts'
import {
  RESTART_PROBE_BUDGET_MS,
  checkFailedCount,
  checkedCount,
  updatableCount,
  updateBusy,
  type RestartState,
  type UnavailableReason,
  type UpdateState,
} from './state.ts'
import type { Translate } from './translate.ts'
import type { TopRowControlsLocaleKey } from './locales.ts'
import css from './TopRowControls.module.css'

/**
 * Composed props: the runtime share of the overlay entry plus its locale seat.
 *
 * Both framework types are generic, so the slot key and namespace are supplied
 * here and this is the single place they are declared.
 */
export type TopRowControlsProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshMarket.topRow'>


/**
 * Whether a reason key should be prefixed with the generic "unsupported"
 * sentence, or stands alone.
 * @param reason - the disabling reason.
 * @returns the locale key to render.
 */
function reasonKey(reason: UnavailableReason): TopRowControlsLocaleKey {
  return reason
}

/**
 * Turn a host/transport error into tooltip text.
 *
 * The host's own wording wins when it supplied one, because it knows more than
 * a generic client-side sentence.
 * @param error - error text, or undefined.
 * @param t - namespace-bound translate.
 * @returns tooltip text.
 */
function errorText(error: string | undefined, t: Translate): string {
  return error !== undefined && error !== '' ? error : t('hostUnreachable')
}

/**
 * Locate the plugins page toolbar and keep track of it as the page mounts and
 * unmounts.
 *
 * `@deepseek-ai/dsh-client-ui-plugin-manager` marks its page root with
 * `data-plugin-panel`; the toolbar we want is the element inside that page which
 * contains the page's own refresh control (it is an `<button>` carrying
 * `aria-busy`, set from the page's `refreshing` state). Matching on those two
 * structural facts avoids hashed CSS-module class names entirely, so a DSH
 * restyle cannot silently detach the controls.
 *
 * The page is mounted and unmounted as the user opens and closes the 插件 panel,
 * and it swaps between a `main`/`detail` view, so this re-scans on DOM changes
 * and reports `undefined` whenever the toolbar is not on screen.
 * @returns the toolbar element to portal into, or undefined when absent.
 */
function usePluginToolbar(): HTMLElement | undefined {
  const [toolbar, setToolbar] = useState<HTMLElement>()

  useEffect(() => {
    const locate = (): void => {
      const page = document.querySelector<HTMLElement>('[data-plugin-panel]')
      const found = page === null
        ? undefined
        : [...page.querySelectorAll<HTMLElement>('button[aria-busy]')]
            .map(button => button.parentElement)
            .find((candidate): candidate is HTMLElement => candidate !== null && candidate !== undefined)
      setToolbar(previous => (previous === found ? previous : found))
    }

    locate()
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return toolbar
}

/**
 * Render the update + restart controls inside the plugins page header.
 * @param props - composed slot props (runtime share + locale seat).
 * @returns the controls element, or null while the plugins page is closed.
 */
export function TopRowControls({ t }: TopRowControlsProps) {
  const controls = useControls()
  const toolbar = usePluginToolbar()
  const [panelOpen, setPanelOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const { update, restart } = controls.state

  // Close the panel when clicking outside it: the overlay floats above the
  // whole app, so a stray panel would otherwise cover the conversation.
  useEffect(() => {
    if (!panelOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current?.contains(event.target as Node) !== true) setPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [panelOpen])

  // A restart in flight closes the panel: progress there is moot once the
  // process is going away.
  useEffect(() => {
    if (restart.phase === 'restarting' || restart.phase === 'reloading') setPanelOpen(false)
  }, [restart.phase])

  const updateTitle = updateTooltip(update, t)
  const restartTitle = restartTooltip(restart, t)

  const content = (
    <div
      ref={root}
      className={css.root}
    >
      <div className={css.buttons}>
        <Tooltip label={updateTitle} side="bottom" delayMs={400}>
          <button
            type="button"
            className={css.button}
            data-busy={updateBusy(update) ? 'true' : undefined}
            data-state={updateStateAttr(update)}
            aria-label={updateTitle}
            aria-busy={updateBusy(update)}
            aria-expanded={panelOpen}
            aria-controls={panelOpen ? panelId : undefined}
            title={updateTitle}
            disabled={!controls.canUpdate}
            onClick={() => {
              // Opening the panel is the click's other job: a user who just
              // wants to see what is pending should not have to start a run.
              setPanelOpen(true)
              controls.onUpdateClick()
            }}
          >
            <UpdateGlyph update={update} />
            <span className={css.label}>{t('updateLabel')}</span>
            {updatableCount(update) > 0 && (
              <span
                className={css.badge}
                data-stale={update.phase === 'checking' ? 'true' : undefined}
                aria-hidden="true"
              >
                {updatableCount(update)}
              </span>
            )}
          </button>
        </Tooltip>

        <Tooltip label={restartTitle} side="bottom" delayMs={400}>
          <button
            type="button"
            className={css.button}
            data-busy={restart.phase === 'requesting' || restart.phase === 'restarting' ? 'true' : undefined}
            data-state={restart.phase === 'failed' || restart.phase === 'timeout' ? 'error' : undefined}
            aria-label={restartTitle}
            aria-busy={restart.phase === 'requesting' || restart.phase === 'restarting'}
            title={restartTitle}
            disabled={!controls.canRestart}
            onClick={() => { controls.onRestartClick() }}
          >
            <RestartGlyph restart={restart} />
            <span className={css.label}>{t('restartLabel')}</span>
          </button>
        </Tooltip>
      </div>

      {/* The live region is always mounted so screen readers observe its
          updates; it carries the same facts the tooltip shows. */}
      <span className={css.visuallyHidden} role="status" aria-live="polite">
        {updateTitle}
        {' '}
        {restartTitle}
      </span>

      {panelOpen && (
        <div id={panelId}>
          <UpdatePanel state={update} t={t} onClose={() => { setPanelOpen(false) }} />
        </div>
      )}
    </div>
  )

  // Inside the plugin page's toolbar the controls stack with its own refresh and
  // "add plugin" buttons, so they render plainly there; the overlay path is only
  // used before the page exists (never visible) to keep the slot entry stable.
  return toolbar === undefined ? null : createPortal(content, toolbar)
}

/** The update button's glyph, reflecting its phase. */
function UpdateGlyph({ update }: { readonly update: UpdateState }) {
  if (updateBusy(update)) return <IconLoadingOutlineRegular className={css.spinner} size={16} />
  if (update.phase === 'done') return <IconCheckOutlineRegular size={16} />
  if (update.unavailable !== undefined || update.error !== undefined) {
    return <IconWarningOutlineRegular size={16} />
  }
  // Warn on a check that could not examine anything, rather than showing the
  // neutral refresh glyph as though nothing had gone wrong.
  if (update.phase === 'idle' && checkFailedCount(update) > 0
    && checkFailedCount(update) === checkedCount(update)) {
    return <IconWarningOutlineRegular size={16} />
  }
  return <IconRefreshOutlineRegular size={16} />
}

/** The restart button's glyph, reflecting its phase. */
function RestartGlyph({ restart }: { readonly restart: RestartState }) {
  if (restart.phase === 'requesting' || restart.phase === 'restarting') {
    return <IconLoadingOutlineRegular className={css.spinner} size={16} />
  }
  if (restart.phase === 'failed' || restart.phase === 'timeout') return <IconWarningOutlineRegular size={16} />
  return <IconRefreshOutlineRegular size={16} />
}

/** Data attribute driving the update button's error/ok coloring. */
function updateStateAttr(update: UpdateState): string | undefined {
  if (update.unavailable !== undefined || update.error !== undefined) return 'error'
  if (update.phase === 'done') return 'ok'
  // A check where no row could be queried is a failure, not a quiet success:
  // flag it so the button does not look like everything is fine.
  if (update.phase === 'idle' && checkFailedCount(update) > 0
    && checkFailedCount(update) === checkedCount(update)) return 'error'
  return undefined
}

/**
 * Tooltip text for the update button: what it will do, or why it cannot.
 * @param update - current update state.
 * @param t - namespace-bound translate.
 * @returns the tooltip label.
 */
function updateTooltip(update: UpdateState, t: Translate): string {
  if (update.unavailable !== undefined) return t(reasonKey(update.unavailable))
  if (update.phase === 'checking') return t('updateChecking')
  if (update.phase === 'starting') return t('updateStarting')
  if (update.phase === 'running') return t('updateRunning', { done: 0, total: updatableCount(update) })
  if (update.phase === 'done') {
    if (update.error !== undefined) return `${t('updateFailed')}: ${errorText(update.error, t)}`
    if (update.operation?.restartRequired === true) return t('updateRestartRequired')
    const progress = update.operation
    if (progress === undefined) return t('updateDoneNoop')
    const failed = progress.packages.filter(entry => entry.state === 'failed').length
    const updated = progress.packages.filter(entry => entry.state === 'success').length
    if (failed > 0) return t('updatePartial', { ok: updated, failed })
    return updated === 0 ? t('updateDoneNoop') : t('updateDone', { count: updated })
  }
  if (update.error !== undefined) return `${t('updateFailed')}: ${errorText(update.error, t)}`
  if (updatableCount(update) > 0) {
    // The denominator matters: "2 of 7 checked" is not "up to date".
    return `${t('updateAvailable', { count: updatableCount(update) })} (${updatableCount(update)}/${checkedCount(update)})`
  }
  // Three genuinely different facts, and conflating any two of them misleads:
  // a check that never ran, a check that ran but could not query every row, and
  // a check that examined them all and found nothing. Only the last is good news.
  if (update.summary === undefined) return t('updateNeverChecked')
  if (checkedCount(update) === 0) return t('updateNeverChecked')
  const failed = checkFailedCount(update)
  if (failed > 0) {
    return failed === checkedCount(update)
      ? t('updateCheckFailed')
      : t('updatePartialCheck', { checked: checkedCount(update) - failed, total: checkedCount(update), failed })
  }
  return t('updateUpToDate')
}

/**
 * Tooltip text for the restart button.
 * @param restart - current restart state.
 * @param t - namespace-bound translate.
 * @returns the tooltip label.
 */
function restartTooltip(restart: RestartState, t: Translate): string {
  if (restart.unavailable !== undefined) {
    const base = t(reasonKey(restart.unavailable))
    return restart.error !== undefined && restart.error !== '' ? `${base} ${restart.error}` : base
  }
  switch (restart.phase) {
    case 'requesting': return t('restarting')
    case 'restarting': return `${t('restartWaiting')} (${Math.round(RESTART_PROBE_BUDGET_MS / 1000)}s)`
    case 'reloading': return t('restartReloading')
    case 'timeout': return t('restartTimeout')
    case 'failed': return restart.error !== undefined && restart.error !== ''
      ? `${t('restartFailed')}: ${restart.error}`
      : t('restartFailed')
    default: return t('restartConfirmHint')
  }
}
