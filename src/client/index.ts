/**
 * dsh-market, browser half: two buttons (更新 / 重启 DSH) in the sidebar's
 * top row.
 *
 * The sidebar's logo row is rendered exclusively by ui-sidebar and declares no
 * seat an outside plugin can extend, so this plugin takes the additive route:
 * it registers into the frame-wide floating layer `shell.overlay` (declared by
 * ui-layout) and positions itself over that row. Nothing official is patched,
 * and the buttons disappear cleanly with the registration.
 *
 * The `slots.inject` wrapper makes the registration survive the overlay slot
 * being declared AFTER this plugin loads — injection re-runs on a later
 * declaration and tears the entry down with it, which matters because plugin
 * load order across a profile is not guaranteed.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TopRowControls } from './TopRowControls.tsx'
import { en, zh, type TopRowControlsLocaleKey } from './locales.ts'

export type { TopRowControlsProps } from './TopRowControls.tsx'
export type { TopRowControlsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Top-row update + restart control copy. */
    'dshMarket.topRow': TopRowControlsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'dshMarket.topRow'

/** Stable registration id inside the `shell.overlay` list slot. */
export const SLOT_ENTRY_ID = 'dsh-market.topRowControls'

/** Services this plugin needs before `apply` runs. */
export const inject = ['slots', 'locale']

/** Plugin name, as the loader reports it in diagnostics. */
export const name = 'dsh-market'

/**
 * Contribute the top-row controls.
 *
 * `order: -100` sorts the entry to the front of the overlay list, so its
 * absolutely-positioned box is not placed after other overlay entries that
 * might later be added to the same layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-market: dictionaries')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: SLOT_ENTRY_ID,
    order: -100,
    label: 'Update and restart',
    locale: NS,
    registrant: name,
  }, TopRowControls))
}
