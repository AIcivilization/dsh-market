/**
 * Ambient stand-in for the `@deepseek-ai/dsh-client-ui-layout/client` specifier.
 *
 * Registrants pull a slot owner's `SlotMap` augmentation into their program
 * with a type-only import of that owner's `/client` entry (see any in-repo
 * registrant, e.g. ui-sidebar's `import type {} from '…dsh-client-locale/client'`).
 * `ui-layout` is the owner of `shell.overlay`, but it ships inside the DSH
 * shell and is not published as a standalone installable package, so that
 * specifier cannot resolve on its own out of repo.
 *
 * This file supplies just enough for the import to typecheck. The slot
 * contract itself is re-stated in `./slots.d.ts`, which augments the real
 * ui-slots package by declaration merging. Nothing here emits code.
 *
 * Because this is an ambient `declare module` for a specifier that does not
 * exist on disk, it is authoritative rather than additive — which is why the
 * slot shape is NOT declared here: it must merge with the real ui-slots
 * package's `SlotMap`, and only `slots.d.ts` does that.
 */

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  /** Marker export: the real module's augmentations are re-stated in `./slots.d.ts`. */
  export const LAYOUT_SLOT_OWNER: unique symbol
}
