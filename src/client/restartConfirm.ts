/**
 * The restart confirmation's decision logic.
 *
 * Kept apart from the component on purpose: importing the component pulls in
 * the UI primitives (and their own runtime deps), while this module is pure and
 * therefore directly testable — and it is the part that decides whether a
 * running task is actually announced before the process is killed.
 */
import type { TaskSnapshot } from './api.ts'
import type { TopRowControlsLocaleKey } from './locales.ts'

/**
 * Whether the confirmation must warn rather than merely state.
 *
 * Unknown counts as a warning: if the host could not tell us, the user needs to
 * check, and a calm "no tasks" sentence would read as a clean bill of health.
 *
 * @param tasks - the snapshot shown.
 * @param checking - whether the inspection is still in flight.
 * @returns true when the dialog should carry warning styling.
 */
export function isWarning(tasks: TaskSnapshot, checking: boolean): boolean {
  if (checking) return false
  return !tasks.known || tasks.activeTasks
}

/**
 * The locale key for the dialog's status sentence.
 *
 * Split out from the component so the four-way branch — the part that decides
 * whether a running task is actually announced — is unit-testable without a
 * rendering harness this repo does not have.
 *
 * @param tasks - the snapshot shown.
 * @param checking - whether the inspection is still in flight.
 * @returns the locale key to translate.
 */
export function warningKey(tasks: TaskSnapshot, checking: boolean): TopRowControlsLocaleKey {
  if (checking) return 'restartCheckingTasks'
  if (!tasks.known) return 'restartTasksUnknown'
  return tasks.activeTasks ? 'restartTasksRunning' : 'restartNoTasks'
}
