/**
 * Version comparison.
 *
 * Every decision in the update path funnels through `compareVersions`, so an
 * error here is not a cosmetic bug: it decides whether a click installs a
 * downgrade. The cases below are chosen around the places a naive
 * implementation breaks — prerelease ordering, numeric prerelease segments,
 * build metadata, and versions that do not parse at all.
 */

import { describe, expect, it } from 'vitest'
import { compareVersions, isUpgrade, parseVersion, specFloor } from '../../src/host/semver.js'

describe('parseVersion', () => {
  it('parses a plain release into its core triple', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
  })

  it('parses a prerelease into segments', () => {
    expect(parseVersion('1.2.3-rc.1')?.pre).toEqual(['rc', '1'])
  })

  it('accepts surrounding whitespace', () => {
    expect(parseVersion(' 1.2.3 ')?.core).toEqual([1, 2, 3])
  })

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.99')?.pre).toEqual([])
  })

  it('rejects anything that is not plain semver', () => {
    // Note `v1.2.3` and `^1.2.3` are rejected here: this parses VERSIONS, and
    // deciding what a range means is `specFloor`'s job.
    for (const input of ['', 'latest', '^1.2.3', 'v1.2.3', '1.2', 'x.y.z', '1.2.3.4', '>=1.0.0']) {
      expect(parseVersion(input), input).toBeNull()
    }
  })
})

describe('compareVersions', () => {
  it('orders releases by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '2.1.0')).toBeLessThan(0)
    expect(compareVersions('2.1.0', '2.1.1')).toBeLessThan(0)
    expect(compareVersions('2.1.1', '2.1.1')).toBe(0)
    expect(compareVersions('2.1.2', '2.1.1')).toBeGreaterThan(0)
  })

  it('orders numerically, not as strings', () => {
    // The classic string-sort bug: '10' < '9' lexically.
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.17.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('ranks a release above its own prerelease', () => {
    expect(compareVersions('1.2.3', '1.2.3-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBeLessThan(0)
  })

  it('compares numeric prerelease segments numerically', () => {
    // `rc.10` must beat `rc.9`; a string compare gets this backwards and would
    // report the newer prerelease as older.
    expect(compareVersions('1.2.3-rc.10', '1.2.3-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBeLessThan(0)
  })

  it('ranks numeric prerelease segments below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('ranks a longer prerelease above a shorter prefix of it', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBeGreaterThan(0)
  })

  it('ignores build metadata entirely', () => {
    expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0)
    expect(compareVersions('1.2.3-rc.1+a', '1.2.3-rc.1+b')).toBe(0)
  })

  it('returns null when either side does not parse', () => {
    // Deliberately null rather than a number: callers must treat an
    // incomparable pair as "unknown", never as "no upgrade available".
    expect(compareVersions('latest', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', '^2')).toBeNull()
  })
})

describe('isUpgrade', () => {
  it('is true only for a strictly newer version', () => {
    expect(isUpgrade('1.0.0', '1.0.1')).toBe(true)
    expect(isUpgrade('1.0.1', '1.0.0')).toBe(false)
    expect(isUpgrade('1.0.0', '1.0.0')).toBe(false)
  })

  it('is false when the pair cannot be compared', () => {
    expect(isUpgrade('1.0.0', 'not-a-version')).toBe(false)
  })
})

describe('specFloor', () => {
  it('extracts the version a range is anchored at', () => {
    // Returns BOTH halves: the version to compare against, and the original
    // range so a caller can tell a bare pin from a range.
    expect(specFloor('^1.2.3')).toEqual({ version: '1.2.3', range: '^1.2.3' })
    expect(specFloor('~1.2.3')).toEqual({ version: '1.2.3', range: '~1.2.3' })
    expect(specFloor('>=1.2.3')).toEqual({ version: '1.2.3', range: '>=1.2.3' })
  })

  it('reports a bare pin as an exact version with no range', () => {
    expect(specFloor('1.2.3')).toEqual({ version: '1.2.3', range: null })
  })

  it('keeps the prerelease when the range carries one', () => {
    expect(specFloor('^0.2.0-rc.2').version).toBe('0.2.0-rc.2')
  })

  it('returns a null version for a spec with no version to anchor on', () => {
    // A dist-tag, a wildcard, or a URL tells us nothing about which version is
    // installed — but the range is echoed back so the caller can say what it
    // could not read.
    expect(specFloor('latest').version).toBeNull()
    expect(specFloor('*').version).toBeNull()
    expect(specFloor('github:owner/repo').version).toBeNull()
    expect(specFloor('link:../local').version).toBeNull()
  })
})
