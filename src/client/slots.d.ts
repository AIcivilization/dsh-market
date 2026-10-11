/**
 * Local re-statement of the `shell.overlay` slot contract this plugin uses.
 *
 * `shell.overlay` is DECLARED AT RUNTIME by `@deepseek-ai/dsh-client-ui-layout`.
 * That package ships inside the DSH shell and is not published as a standalone
 * installable package, so an out-of-repo plugin cannot import its types — yet
 * the slot genuinely exists (verified against the running app, and documented
 * upstream as a `list` slot, scope `root`, in a click-through frame-wide
 * layer). This file re-states exactly that contract so the registration
 * typechecks.
 *
 * Two rules keep this honest:
 *
 * 1. Merge, never replace. This file is a MODULE (it has a top-level import),
 *    so `declare module` below AUGMENTS the real package instead of shadowing
 *    it. If a future build does pull in ui-layout's own slot map, both
 *    declarations spell the same key/kind/scope and merge cleanly; an upstream
 *    shape change surfaces as a type error here rather than passing silently.
 * 2. Types only, no code. Nothing here is emitted, so it can neither bundle a
 *    second copy of anything nor patch official behaviour at runtime.
 *
 * `slots.inject` (see `src/client/index.ts`) is what makes this safe in
 * practice: the registration is retried whenever the slot is declared, so a
 * plugin that loads before ui-layout still ends up registered — and is torn
 * down cleanly with it.
 */
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. A `list` slot, so a fresh `id` is added beside the shipped
     * entries instead of replacing them. The layer itself is click-through;
     * entries opt back into pointer events.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

/**
 * Keys of `SlotMap` that this plugin touches, re-exported so a consumer can
 * see the contract this file is responsible for. (The `…ui-layout/client`
 * specifier this plugin also imports is stood in for by
 * `./ui-layout-client.d.ts`, which holds no slot shape so that this file stays
 * the single source of the contract.)
 */
export type KnownSlotKey = keyof SlotMap & string
