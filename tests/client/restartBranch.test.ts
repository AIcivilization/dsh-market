import { describe, expect, it } from 'vitest'
import { isWarning, warningKey } from '../../src/client/restartConfirm.ts'

/**
 * The restart confirmation's status branch.
 *
 * This decides whether the user is told that running work is about to die, so
 * every combination is pinned — especially "unknown", which must warn rather
 * than reassure.
 */
describe('warningKey', () => {
  it('says nothing definitive while still checking', () => {
    expect(warningKey({ known: true, activeTasks: true, scheduledTasks: false }, true))
      .toBe('restartCheckingTasks')
  })

  it('announces running tasks', () => {
    expect(warningKey({ known: true, activeTasks: true, scheduledTasks: false }, false))
      .toBe('restartTasksRunning')
  })

  it('states an idle host only when the host confirmed it', () => {
    expect(warningKey({ known: true, activeTasks: false, scheduledTasks: false }, false))
      .toBe('restartNoTasks')
  })

  it('warns, rather than reassures, when the host could not tell', () => {
    // The dangerous direction: `known: false` also carries activeTasks: false,
    // so a naive check on activeTasks alone would report a calm "no tasks".
    expect(warningKey({ known: false, activeTasks: false, scheduledTasks: false }, false))
      .toBe('restartTasksUnknown')
  })
})

describe('isWarning', () => {
  it('does not warn while the inspection is still in flight', () => {
    expect(isWarning({ known: false, activeTasks: false, scheduledTasks: false }, true)).toBe(false)
  })

  it('warns on running tasks', () => {
    expect(isWarning({ known: true, activeTasks: true, scheduledTasks: false }, false)).toBe(true)
  })

  it('warns when the host could not tell', () => {
    expect(isWarning({ known: false, activeTasks: false, scheduledTasks: false }, false)).toBe(true)
  })

  it('does not warn on a confirmed idle host', () => {
    expect(isWarning({ known: true, activeTasks: false, scheduledTasks: false }, false)).toBe(false)
  })
})
