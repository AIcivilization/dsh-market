/**
 * The capabilities payload: what this host can actually do.
 *
 * Every externally observable feature is described here rather than left for
 * a client to discover by trying it. The buttons are rendered from this
 * document, so a host where restart is impossible shows a disabled button
 * with a reason instead of a control that answers 409 — the difference
 * between a product and a puzzle.
 */

import { version as packageVersion } from './version.js'
import {
  detectRuntime,
  restartCapability,
  type RestartCapability,
  type RestartDetection,
  type Runtime,
} from './runtime.js'

/** Feature bits. A client that reads only this object can render correctly. */
export interface Capabilities {
  /** Update checks can be performed. */
  readonly check: boolean
  /** Updates can be applied. */
  readonly update: boolean
  /** Restarting this host is possible. */
  readonly restart: boolean
  /** Update operations can be polled for progress. */
  readonly progress: boolean
}

/** The full capabilities document returned by `GET <prefix>/api/capabilities`. */
export interface CapabilitiesPayload {
  readonly version: string
  readonly profile: string
  readonly runtime: Runtime
  readonly features: Capabilities
  readonly restart: {
    readonly supported: boolean
    readonly managedBy: string
    readonly reason?: string
  }
}
/** Inputs the payload is built from. */
export interface CapabilitiesInput {
  readonly profile: string
  readonly desktopService?: boolean
  readonly marketplaceVersion?: string
  readonly restart?: RestartCapability
  /**
   * Host-identity inputs for the restart verdict. Supplied by tests so the
   * verdict does not depend on ambient environment; production omits it.
   */
  readonly detection?: RestartDetection
}

/**
 * Build the capabilities document.
 *
 * `update` and `check` are unconditional on a resolved profile: if this route
 * is answering at all, the plugin is mounted, and the profile it read is what
 * the checks run against. Restart is the one genuinely conditional feature,
 * and it carries its reason.
 */
export function buildCapabilities(input: CapabilitiesInput): CapabilitiesPayload {
  const restart = input.restart ?? restartCapability({
    desktopService: input.desktopService === true,
    ...(input.detection ?? {}),
  })
  // Derived from the SAME verdict the restart carries, not from a second
  // detection. An earlier version keyed `runtime` off `desktopService` alone
  // while the restart verdict went through the multi-signal threshold, so the
  // two could describe different hosts in one response: with
  // ELECTRON_RUN_AS_NODE inherited from the app (a real condition when the
  // suite is run from a terminal inside DSH Desktop) the signal count moved
  // and `runtime` said "desktop" while `restart.managedBy` said "market".
  // Reading it back from the verdict makes disagreement unrepresentable.
  const runtime: Runtime = restart.managedBy === 'desktop-host'
    ? 'desktop'
    : detectRuntime(process.argv, process.env, false)
  return {
    version: input.marketplaceVersion ?? packageVersion(),
    profile: input.profile,
    runtime,
    features: {
      check: true,
      update: true,
      restart: restart.supported,
      progress: true,
    },
    restart: {
      supported: restart.supported,
      managedBy: restart.managedBy,
      ...(restart.reason === null ? {} : { reason: restart.reason }),
    },
  }
}
