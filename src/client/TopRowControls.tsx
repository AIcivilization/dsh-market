/**
 * The two top-row controls: 更新 (update) and 重启 DSH (restart).
 *
 * Rendered into `shell.overlay` and absolutely positioned over the sidebar's
 * logo row, so it must never assume it owns the column: it is a small,
 * self-sized floating box that leaves the logo and collapse toggle visible and
 * clickable.
 *
 * Positioning needs to know which sidebar width is in play, and the overlay
 * slot hands out no owner props (it is frame-wide, not sidebar-scoped), so the
 * component derives the state from the DOM: it watches the sidebar column's
 * measured width. That keeps the plugin working across DSH versions without
 * patching ui-sidebar.
 */
import { useEffect, useId, useRef, useState } from 'react'
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

/** Width at or below which the sidebar renders its 56px control rail. */
const RAIL_MAX_WIDTH = 60

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
 * Derive the sidebar's collapsed state from the live DOM.
 *
 * ui-sidebar owns the column; the overlay does not receive its width. Measuring
 * the rendered column is the only upgrade-safe way to follow it.
 * @returns collapsed flag plus the measured expanded width.
 */
function useSidebarGeometry(): { readonly collapsed: boolean; readonly width: number } {
  const [geometry, setGeometry] = useState({ collapsed: false, width: 260 })

  useEffect(() => {
    const measure = (): void => {
      // The sidebar column is the first grid child of the frame; identify it by
      // its own inline width or, failing that, by being a narrow first column.
      const candidates = document.querySelectorAll<HTMLElement>('body > * *, [class*="root"]')
      let best: HTMLElement | undefined
      for (const element of candidates) {
        const rect = element.getBoundingClientRect()
        // The column is tall, starts at the very left, and is narrower than
        // half the viewport (an expanded sidebar is ~200–320px).
        if (rect.top <= 2 && rect.left <= 2 && rect.height > window.innerHeight * 0.5 && rect.width > 0
          && rect.width <= Math.min(400, window.innerWidth * 0.5)) {
          if (best === undefined || rect.width > best.getBoundingClientRect().width) best = element
        }
      }
      const width = best?.getBoundingClientRect().width
      if (width === undefined) return
      setGeometry(previous => (previous.collapsed === (width <= RAIL_MAX_WIDTH) && previous.width === width
        ? previous
        : { collapsed: width <= RAIL_MAX_WIDTH, width }))
    }

    measure()
    const observer = new MutationObserver(measure)
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'], subtree: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return geometry
}

/** Height of the band the controls occupy, in px; mirrors `--dsh-controls-row-height`. */
const RESERVED_ROW_HEIGHT = 34

/**
 * Push ui-sidebar's own content down so the floating controls get a band of
 * their own.
 *
 * The overlay layer is painted ABOVE the columns and intercepts nothing, so
 * without this the buttons would sit on top of the brand row or the first
 * content row — whichever we choose, they would cover a real control, because
 * the sidebar's top area is fully packed: a 60px brand band starting at 6px,
 * then the new-session button at 70px, then the panel list.
 *
 * ui-sidebar lays those rows out as direct children of its own root, so there
 * is no single scroller to pad. Instead we find the brand row and push every
 * following sibling down by the band height with `margin-top`. That leaves the
 * brand row untouched (it stays where DSH put it) and opens exactly the gap the
 * controls need. Every override is recorded and undone on unmount.
 */
function useReservedRow(): void {
  useEffect(() => {
    /** Elements we have shifted, with their original `margin-top` values. */
    const shifted = new Map<HTMLElement, string>()

    const release = (): void => {
      for (const [element, value] of shifted) element.style.marginTop = value
      shifted.clear()
    }

    const apply = (): void => {
      const brandRow = document.querySelector<HTMLElement>('[class*="logoRow"]')
      const parent = brandRow?.parentElement
      if (brandRow === null || brandRow === undefined || parent === null || parent === undefined) return

      const rows = [...parent.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
      const index = rows.indexOf(brandRow)
      if (index < 0) return

      // The rows after the brand band are the ones that must move down. If the
      // shift is already in place, leave the recorded originals alone.
      const followers = rows.slice(index + 1)
      if (followers.length === 0) return
      if (followers.every((element) => shifted.has(element))) return

      release()
      for (const element of followers) {
        shifted.set(element, element.style.marginTop)
        element.style.marginTop = `${RESERVED_ROW_HEIGHT}px`
      }
    }

    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', apply)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', apply)
      release()
    }
  }, [])
}

/**
 * Render the update + restart controls.
 * @param props - composed slot props (runtime share + locale seat).
 * @returns the controls element.
 */
export function TopRowControls({ t }: TopRowControlsProps) {
  const controls = useControls()
  const geometry = useSidebarGeometry()
  useReservedRow()
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

  return (
    <div
      ref={root}
      className={css.root}
      data-collapsed={geometry.collapsed ? 'true' : 'false'}
      style={{ '--dsh-controls-sidebar-width': `${geometry.width}px` } as React.CSSProperties}
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
}

/** The update button's glyph, reflecting its phase. */
function UpdateGlyph({ update }: { readonly update: UpdateState }) {
  if (updateBusy(update)) return <IconLoadingOutlineRegular className={css.spinner} size={16} />
  if (update.phase === 'done') return <IconCheckOutlineRegular size={16} />
  if (update.unavailable !== undefined || update.error !== undefined) {
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
  // Zero updatable is only good news once something was actually checked.
  return checkedCount(update) === 0 ? t('updateChecking') : t('updateUpToDate')
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
