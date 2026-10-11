/**
 * Update progress popover: the panel the update button opens.
 *
 * Kept separate from {@link TopRowControls} so the top row stays two buttons
 * (the user's requirement) while the detail lives in a floating panel anchored
 * under them. The panel is presentational — all state and actions arrive as
 * props from the parent, which owns the single set of state machines.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OperationPackage } from './api.ts'
import type { UpdateRow, UpdateState } from './state.ts'
import { progressOf } from './state.ts'
import type { Translate } from './translate.ts'
import css from './TopRowControls.module.css'

/** Props for {@link UpdatePanel}. */
export interface UpdatePanelProps {
  /** Live update state (summary + operation + errors). */
  readonly state: UpdateState
  /** Namespace-bound translate. */
  readonly t: Translate
  /** Close the panel. */
  readonly onClose: () => void
}

/** Map one package state onto its locale key. */
function stateKey(state: OperationPackage['state']): 'statusPending' | 'statusRunning' | 'statusDone' | 'statusFailed' | 'statusSkipped' {
  switch (state) {
    case 'running': return 'statusRunning'
    case 'success': return 'statusDone'
    case 'failed': return 'statusFailed'
    case 'skipped': return 'statusSkipped'
    default: return 'statusPending'
  }
}

/**
 * Render one package row.
 * @param props - row data plus translate.
 * @returns the row element.
 */
function Row({ row, t }: { readonly row: UpdateRow; readonly t: Translate }) {
  return (
    <li className={css.row} data-state={row.state}>
      <span className={css.rowName} title={row.name}>{row.name}</span>
      <span className={css.rowVersion}>
        {row.from === row.to || row.to === ''
          ? row.from
          : t('versionArrow', { from: row.from, to: row.to })}
      </span>
      <span className={css.rowStatus}>{t(stateKey(row.state))}</span>
      {row.error !== undefined && (
        <span className={css.rowError} title={row.error}>{row.error}</span>
      )}
    </li>
  )
}

/**
 * Render the update popover.
 * @param props - see {@link UpdatePanelProps}.
 * @returns the panel element.
 */
export function UpdatePanel({ state, t, onClose }: UpdatePanelProps) {
  const panel = useRef<HTMLDivElement>(null)

  // Move focus into the panel when it opens so keyboard users land on it,
  // and let Escape close it from anywhere inside.
  useEffect(() => {
    panel.current?.focus()
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  const rows = state.operation !== undefined
    ? state.operation.packages.map(entry => ({
      name: entry.name, from: entry.from, to: entry.to, state: entry.state, error: entry.error,
    }))
    : (state.summary?.packages ?? []).map(entry => ({
      name: entry.name,
      from: entry.installedVersion,
      to: entry.latestVersion,
      state: 'pending' as const,
      error: undefined,
    }))

  const progress = state.operation === undefined ? undefined : progressOf(state.operation)

  return (
    <div
      ref={panel}
      className={css.panel}
      role="dialog"
      aria-label={t('panelTitle')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className={css.panelHeader}>
        <h2 className={css.panelTitle}>{t('panelTitle')}</h2>
        <button type="button" className={css.panelClose} aria-label={t('dismiss')} onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </header>

      {/* One live region for the whole panel: the header line already tracks
          the same facts the rows do, so announcing both would double-speak. */}
      <div className={css.panelStatus} role="status" aria-live="polite">
        {state.phase === 'checking' && t('panelChecking')}
        {state.phase === 'starting' && t('updateStarting')}
        {state.phase === 'running' && progress !== undefined
          && t('updateRunning', { done: progress.done, total: progress.total })}
        {state.phase === 'idle' && state.error !== undefined && t('panelFailed')}
        {state.phase === 'idle' && state.error === undefined
          && (rows.length === 0 ? t('panelNoPlugins') : t('panelUpToDate'))}
        {state.phase === 'done' && state.operation?.state === 'failed' && t('updateFailed')}
        {state.phase === 'done' && state.operation?.state !== 'failed' && progress !== undefined
          && (progress.failed > 0
            ? t('updatePartial', { ok: progress.done - progress.failed, failed: progress.failed })
            : t('updateDone', { count: progress.done }))}
      </div>

      {state.error !== undefined && state.phase !== 'running' && (
        <p className={css.panelError}>{state.error}</p>
      )}

      {rows.length > 0 && (
        <>
          <div className={css.columnHeader} aria-hidden="true">
            <span>{t('packageColumn')}</span>
            <span>{t('versionColumn')}</span>
            <span>{t('statusColumn')}</span>
          </div>
          <ul className={css.rows}>
            {rows.map(row => <Row key={row.name} row={row} t={t} />)}
          </ul>
        </>
      )}

      {state.operation?.restartRequired === true && (
        <p className={css.panelNote}>{t('updateRestartRequired')}</p>
      )}
    </div>
  )
}
