/**
 * Long-running update operations, as the client polls them.
 *
 * An update spawns a package manager and can take minutes, so the request
 * that starts it cannot be the request that reports its result. The route
 * answers 202 immediately with an id and the client polls.
 *
 * Two properties the UI depends on:
 *
 *  - SINGLE-FLIGHT. Two concurrent `pnpm add` runs against one profile
 *    corrupt it, so starting an operation while another runs is refused
 *    rather than queued. The client shows a conflict instead of a spinner
 *    that never resolves.
 *
 *  - RETAINED FOR THE PROCESS LIFETIME. A finished operation is kept
 *    forever, not evicted on a timer: a poll that arrives after a slow client
 *    reconnects must still find the result, and the number of operations is
 *    bounded by how many times a human clicked a button. Across a restart the
 *    ids are simply gone, which is correct — the process that would have
 *    reported them is the one that was replaced.
 */

import { randomUUID } from 'node:crypto'

/** The state of one package inside an operation. */
export type PackageState = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

/** The state of the operation as a whole. */
export type OperationState = 'running' | 'success' | 'partial' | 'failed'

/** One package's progress within an operation. */
export interface OperationPackage {
  readonly name: string
  readonly from: string | null
  to: string | null
  state: PackageState
  error?: string
}

/** A pollable update operation. */
export interface Operation {
  readonly operationId: string
  state: OperationState
  readonly startedAt: number
  finishedAt: number | null
  /** True when a restart is what makes the new bytes take effect. */
  restartRequired: boolean
  readonly packages: OperationPackage[]
}

/** The public JSON shape of an operation. */
export interface OperationView {
  readonly operationId: string
  readonly state: OperationState
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly restartRequired: boolean
  readonly packages: readonly OperationPackage[]
}

/**
 * Tracks operations for this process.
 *
 * Deliberately not persisted: an operation describes work being done by the
 * process that started it, and a record surviving that process would describe
 * work nobody is doing.
 */
export class OperationStore {
  readonly #operations = new Map<string, Operation>()
  #active: string | null = null

  /** The id of the operation currently running, if any. */
  get activeId(): string | null {
    return this.#active
  }

  /** Whether an operation is running right now. */
  get busy(): boolean {
    return this.#active !== null
  }

  /**
   * Create an operation for `names`, or return null when one is already
   * running (the caller answers 409).
   */
  start(names: readonly string[], from: ReadonlyMap<string, string | null>): Operation | null {
    if (this.#active !== null) return null
    const operationId = randomUUID()
    const operation: Operation = {
      operationId,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      restartRequired: false,
      packages: names.map(name => ({ name, from: from.get(name) ?? null, to: null, state: 'pending' })),
    }
    this.#operations.set(operationId, operation)
    this.#active = operationId
    return operation
  }

  /** Look up an operation. Never evicts — see the class note. */
  get(operationId: string): Operation | undefined {
    return this.#operations.get(operationId)
  }

  /** Mark one package as running. */
  markRunning(operationId: string, name: string): void {
    this.#patch(operationId, name, entry => { entry.state = 'running' })
  }

  /** Mark one package as finished, with the version it landed on. */
  markResult(operationId: string, name: string, ok: boolean, to: string | null, error: string | null): void {
    this.#patch(operationId, name, entry => {
      entry.state = ok ? 'success' : 'failed'
      entry.to = to
      if (error !== null) entry.error = error
      else delete entry.error
    })
  }

  /** Mark one package as not attempted. */
  markSkipped(operationId: string, name: string, reason: string): void {
    this.#patch(operationId, name, entry => {
      entry.state = 'skipped'
      entry.error = reason
    })
  }

  /** Settle the operation, deriving its overall state from its packages. */
  finish(operationId: string, restartRequired: boolean): Operation | undefined {
    const operation = this.#operations.get(operationId)
    if (operation === undefined) return undefined
    const failed = operation.packages.filter(entry => entry.state === 'failed').length
    const succeeded = operation.packages.filter(entry => entry.state === 'success').length
    operation.state = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
    operation.finishedAt = Date.now()
    operation.restartRequired = restartRequired
    if (this.#active === operationId) this.#active = null
    return operation
  }

  /** Release the single-flight slot without settling (an unexpected throw). */
  release(operationId: string): void {
    if (this.#active === operationId) this.#active = null
  }

  /** The public view of an operation. */
  view(operationId: string): OperationView | undefined {
    const operation = this.#operations.get(operationId)
    if (operation === undefined) return undefined
    return {
      operationId: operation.operationId,
      state: operation.state,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      restartRequired: operation.restartRequired,
      packages: operation.packages.map(entry => ({
        name: entry.name,
        from: entry.from,
        to: entry.to,
        state: entry.state,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
    }
  }

  /** How many operations this process has run. */
  get size(): number {
    return this.#operations.size
  }

  #patch(operationId: string, name: string, mutate: (entry: OperationPackage) => void): void {
    const operation = this.#operations.get(operationId)
    if (operation === undefined) return
    const entry = operation.packages.find(candidate => candidate.name === name)
    if (entry === undefined) return
    mutate(entry)
  }
}
