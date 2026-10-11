/**
 * The translate seat this plugin's components consume.
 *
 * The framework synthesizes a typed `t` from the registration's `locale:`
 * option, but this plugin also renders nested components the slot renderer does
 * not touch (the popover rows), so both halves agree on one structural type
 * instead of threading `PropsLocale` through every leaf. It stays assignable to
 * the framework seat because the framework's key domain is a superset here.
 */
import type { TopRowControlsLocaleKey } from './locales.ts'

/**
 * Translate a key of this plugin's dictionary, with `{name}` template params.
 *
 * Declared structurally (not aliased to the framework's `TranslateNS`) so a
 * change in the framework's seat type does not break leaf components; the
 * framework seat remains assignable to it.
 */
export type Translate = (key: TopRowControlsLocaleKey, params?: Record<string, unknown>) => string
