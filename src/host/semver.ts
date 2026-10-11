/**
 * Semver comparison, implemented here rather than pulled from a dependency:
 * the host half must run inside a DSH profile that may have no packages of
 * its own installed, and update detection is the one place where a wrong
 * answer is destructive (it decides whether "更新" rewrites a working pin).
 *
 * Only the subset the update engine needs: three-part versions with optional
 * prerelease identifiers. Anything else is reported as "not comparable",
 * which every caller turns into "do not offer an update".
 */

/** A parsed `MAJOR.MINOR.PATCH[-prerelease][+build]`. */
export interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly pre: readonly string[]
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a plain semver version.
 * @returns the parsed parts, or null when `value` is not plain semver.
 */
export function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(value.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Semver precedence between two versions.
 *
 * Returns a negative number, zero, or a positive number the way a comparator
 * does, and null when either side is not plain semver — callers must treat
 * null as "cannot decide", never as "equal".
 *
 * Build metadata is ignored; a release outranks any prerelease of the same
 * core; numeric prerelease identifiers compare numerically, so `rc.10` sorts
 * above `rc.9` (a plain string compare gets that backwards).
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let i = 0; i < 3; i++) {
    const x = left.core[i]!
    const y = right.core[i]!
    if (x !== y) return x - y
  }
  // A version with no prerelease is higher than one with a prerelease.
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  const longest = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < longest; i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Whether `candidate` is strictly newer than `installed`.
 *
 * Forwards only, by construction: this is the single gate in front of every
 * "update available" claim, so a `latest` dist-tag that lags behind a pinned
 * install can never be presented as an upgrade. Unparseable input answers
 * false, because without a direction there is no promise the "update" is not
 * a downgrade.
 */
export function isUpgrade(installed: string | null, candidate: string | null): boolean {
  if (installed === null || candidate === null) return false
  const order = compareVersions(candidate, installed)
  return order !== null && order > 0
}

/**
 * Collapse an npm range/spec to a concrete version when that is possible
 * without a resolver, or return it unchanged.
 *
 * A profile manifest records SPECS (`^1.2.3`, `~1.2.3`, `1.2.3`), not the
 * resolved version, and the installed version of record is what
 * `node_modules/<name>/package.json` says. This exists for the case where
 * the package is not installed yet: a caret spec still tells us the version
 * line the user subscribed to.
 * @returns `{ version }` when the spec pinned one, otherwise `{ range: spec }`.
 */
export function specFloor(spec: string): { version: string | null; range: string | null } {
  const trimmed = spec.trim()
  if (parseVersion(trimmed) !== null) return { version: trimmed, range: null }
  const match = /^[~^<>=v\s]*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(trimmed)
  if (match !== null && match[1] !== undefined) return { version: match[1], range: trimmed }
  return { version: null, range: trimmed }
}
