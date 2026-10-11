/**
 * Vitest configuration for the host half.
 *
 * The host half's tests are pure Node: they exercise semver comparison,
 * update-status decisions, profile reading, the route guard, and the update
 * state machine. Nothing here opens a real port, spawns a real package
 * manager, or reaches the network — every external edge is injected, so the
 * suite is hermetic and safe to run on a machine that is serving DSH.
 *
 * The client half ships as a tsdown bundle and is not rendered here: its tests
 * cover the transport and state machines as pure Node units, with `fetch` and
 * the clock injected. Keeping them out of the DOM environment is what lets a
 * single `environment: 'node'` project collect both halves — and, more to the
 * point, it means the restart and capability logic is testable without a
 * browser, which is the only way it gets tested at all.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/host/**/*.test.ts', 'tests/client/**/*.test.ts'],
    environment: 'node',
    // Fail loudly on a stray `.only` rather than silently running one test.
    allowOnly: false,
    // A hung test here means a real bug (an unref'd child, a missing timeout),
    // not a slow machine: every test in this suite is sub-second.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ['default'],
  },
})
