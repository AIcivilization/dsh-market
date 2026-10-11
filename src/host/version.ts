/**
 * The plugin's own version, read from `package.json` at runtime.
 *
 * Not baked in at build time and not imported as JSON: the package is
 * installed into a profile as plain files, and the manifest that ships beside
 * the built code is the one honest source. A read failure falls back to
 * `'unknown'` rather than throwing — a version string is diagnostics, and it
 * must never be the reason a route fails.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's package name, as published. */
export const PACKAGE_NAME = 'dsh-market'

let cached: string | null = null

/**
 * The version in this package's `package.json`.
 *
 * Resolved relative to this module, walking up from the built `lib/` layout
 * (`lib/host/version.js` → `../..`) and the source layout
 * (`src/host/version.ts` → `../..`) alike, since both sit two levels under the
 * manifest.
 */
export function version(): string {
  if (cached !== null) return cached
  const candidates: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(join(here, '..', '..', 'package.json'))
  } catch {
    // No module URL (unusual, but not worth failing over).
  }
  candidates.push(join(process.cwd(), 'package.json'))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown }
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string' && parsed.version !== '') {
        cached = parsed.version
        return cached
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = 'unknown'
  return cached
}

/** Test hook: clear the memoized version. */
export function resetVersionCache(): void {
  cached = null
}
