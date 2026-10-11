/**
 * Reading the active profile.
 *
 * Every field here comes from the launcher's `profileContext` service, which is
 * outside this plugin's control: it is a plain object published by whatever
 * host is running, and a malformed one must not take the plugin down. The
 * governing rule the tests below encode is ALL-OR-NOTHING — a value that is
 * half-usable is discarded entirely rather than partially trusted, because a
 * half-read profile means update checks running against the wrong directory.
 */

import { describe, expect, it } from 'vitest'
import {
  argvProfile,
  gitCommitOfSpec,
  gitRefOfSpec,
  hasDshManifest,
  hostPackageManagerOf,
  isDshProfileName,
  isGitSpec,
  isInstalled,
  isLocalSpec,
  isNpmSpec,
  readBundlesFrom,
  readInstalledVersion,
  readManifest,
  resolveDshHome,
  resolveProfile,
} from '../../src/host/profile.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A profile directory on disk. */
function profileDir(manifest: Record<string, unknown>, installed: Record<string, Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile', private: true, ...manifest }))
  for (const [name, pkg] of Object.entries(installed)) {
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, ...pkg }))
  }
  return dir
}

describe('isDshProfileName', () => {
  it('accepts an ordinary profile name', () => {
    expect(isDshProfileName('desktop')).toBe(true)
    expect(isDshProfileName('web')).toBe(true)
  })

  it('rejects anything that could escape the profiles directory', () => {
    // The profile name is turned into a PATH, so traversal here would let a
    // malformed service redirect every update at an arbitrary directory.
    for (const name of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'node_modules', 'a\0b']) {
      expect(isDshProfileName(name), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('resolveDshHome', () => {
  it('prefers DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/dsh' } as NodeJS.ProcessEnv, '/home/u')).toBe('/custom/dsh')
  })

  it('falls back to ~/.dsh', () => {
    expect(resolveDshHome({} as NodeJS.ProcessEnv, '/home/u')).toBe('/home/u/.dsh')
  })

  it('ignores an empty DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '   ' } as NodeJS.ProcessEnv, '/home/u')).toBe('/home/u/.dsh')
  })
})

describe('argvProfile', () => {
  it('reads --profile <name>', () => {
    expect(argvProfile(['node', 'bin.js', 'web', '--profile', 'desktop'])).toBe('desktop')
  })

  it('returns null for the --profile=<name> form, which this counter does not read', () => {
    // Only the space-separated form is recognized. Asserted explicitly because
    // a caller that assumed `=` worked would silently fall through to the
    // default profile and run updates against the wrong directory.
    expect(argvProfile(['node', 'bin.js', 'web', '--profile=desktop'])).toBeNull()
  })

  it('ignores a flag followed by another flag', () => {
    expect(argvProfile(['node', 'bin.js', 'web', '--profile', '--verbose'])).toBeNull()
  })

  it('returns null when no profile is named', () => {
    expect(argvProfile(['node', 'bin.js', 'web'])).toBeNull()
  })
})

describe('resolveProfile', () => {
  it('uses the launcher context when it is complete', () => {
    const dir = profileDir({})
    const profile = resolveProfile({ name: 'desktop', dir, startedBundles: ['alpha'] })
    expect(profile).toMatchObject({ name: 'desktop', dir, origin: 'launcher profileContext' })
    expect(profile?.startedBundles).toEqual(['alpha'])
  })

  it('ignores a context with a name but no directory', () => {
    // Half a context is not a profile: fall back rather than run against
    // `undefined` as a directory.
    const profile = resolveProfile({ name: 'desktop' }, {} as NodeJS.ProcessEnv, ['node', 'bin.js', 'web'])
    expect(profile).toBeNull()
  })

  it('ignores a context whose name is not a usable profile name', () => {
    const profile = resolveProfile({ name: '../evil', dir: '/tmp/x' }, {} as NodeJS.ProcessEnv, ['node', 'bin.js', 'web'])
    expect(profile).toBeNull()
  })

  it('falls back to --profile when there is no usable context', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const dir = join(home, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    const profile = resolveProfile(null, { DSH_HOME: home } as NodeJS.ProcessEnv, ['node', 'bin.js', 'web', '--profile', 'desktop'])
    expect(profile).toMatchObject({ name: 'desktop', dir, origin: '--profile flag' })
  })

  it('falls back to a web profile under DSH_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    const profile = resolveProfile(null, { DSH_HOME: home } as NodeJS.ProcessEnv, ['node', 'bin.js', 'web'])
    expect(profile).toMatchObject({ name: 'web', dir, origin: 'DSH_HOME' })
  })

  it('returns null rather than guessing when nothing resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    expect(resolveProfile(null, { DSH_HOME: home } as NodeJS.ProcessEnv, ['node', 'bin.js', 'web'])).toBeNull()
  })

  it('rejects a path-traversing profile name from argv', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    expect(resolveProfile(null, { DSH_HOME: home } as NodeJS.ProcessEnv, ['node', 'bin.js', 'web', '--profile', '../../etc'])).toBeNull()
  })
})

describe('hostPackageManagerOf — all or nothing', () => {
  it('accepts a complete published invocation', () => {
    expect(hostPackageManagerOf({
      packageManager: { command: 'corepack', args: ['pnpm'], env: { A: '1' } },
    })).toEqual({ command: 'corepack', args: ['pnpm'], env: { A: '1' } })
  })

  it('discards a malformed invocation ENTIRELY rather than using part of it', () => {
    // Half-using a published invocation is a subtler failure than ignoring it:
    // running the real manager with the wrong args is worse than running pnpm.
    expect(hostPackageManagerOf({ packageManager: { command: '', args: ['pnpm'] } })).toBeNull()
    expect(hostPackageManagerOf({ packageManager: { command: 'corepack' } })).toBeNull()
    expect(hostPackageManagerOf({ packageManager: { command: 'corepack', args: [1, 2] } })).toBeNull()
    expect(hostPackageManagerOf({ packageManager: { command: 'corepack', args: ['pnpm'], env: [] } })).toBeNull()
  })

  it('returns null for a missing context', () => {
    expect(hostPackageManagerOf(null)).toBeNull()
    expect(hostPackageManagerOf(undefined)).toBeNull()
    expect(hostPackageManagerOf({})).toBeNull()
  })

  it('keeps only the string env entries', () => {
    expect(hostPackageManagerOf({
      packageManager: { command: 'pnpm', args: [], env: { GOOD: 'yes', BAD: 7 } },
    })).toEqual({ command: 'pnpm', args: [], env: { GOOD: 'yes' } })
  })
})

describe('readManifest and bundle reading', () => {
  it('reads dependencies and the dsh block', () => {
    const dir = profileDir({ dependencies: { alpha: '^1.0.0' }, dsh: { profile: { bundles: ['alpha'] } } })
    const manifest = readManifest(dir)
    expect(manifest.dependencies).toEqual({ alpha: '^1.0.0' })
    expect(readBundlesFrom({ profile: { bundles: ['alpha'] } })).toEqual(['alpha'])
  })

  it('survives a manifest that is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
    writeFileSync(join(dir, 'package.json'), '{ not json')
    // Degrades to an empty manifest rather than throwing inside a request.
    expect(readManifest(dir).dependencies).toEqual({})
  })

  it('returns no bundles for a malformed dsh block', () => {
    expect(readBundlesFrom(null)).toEqual([])
    expect(readBundlesFrom({ profile: { bundles: 'alpha' } })).toEqual([])
    expect(readBundlesFrom({ profile: { bundles: [1, 2] } })).toEqual([])
  })

  it('filters non-string bundle entries', () => {
    expect(readBundlesFrom({ profile: { bundles: ['alpha', 2, null, 'beta'] } })).toEqual(['alpha', 'beta'])
  })
})

describe('installed packages', () => {
  it('reads the installed version', () => {
    const dir = profileDir({}, { alpha: { version: '1.2.3' } })
    expect(readInstalledVersion(dir, 'alpha')).toBe('1.2.3')
    expect(isInstalled(dir, 'alpha')).toBe(true)
  })

  it('returns null for a package that is not installed', () => {
    const dir = profileDir({})
    expect(readInstalledVersion(dir, 'alpha')).toBeNull()
    expect(isInstalled(dir, 'alpha')).toBe(false)
  })

  it('detects a DSH manifest on the package', () => {
    const dir = profileDir({}, { alpha: { version: '1.0.0', dsh: { bundle: {} } } })
    expect(hasDshManifest(dir, 'alpha')).toBe(true)
  })

  it('does not read a DSH manifest on a plain library', () => {
    const dir = profileDir({}, { alpha: { version: '1.0.0' } })
    expect(hasDshManifest(dir, 'alpha')).toBe(false)
  })
})

describe('spec classification', () => {
  it('recognizes local specs', () => {
    for (const spec of ['link:../a', 'file:./a', 'workspace:*']) {
      expect(isLocalSpec(spec), spec).toBe(true)
    }
    expect(isLocalSpec('^1.0.0')).toBe(false)
    // `portal:` is deliberately NOT local: it is not a spec this engine can
    // reinstall, so classification must not claim it is.
    expect(isLocalSpec('portal:../a')).toBe(false)
  })

  it('recognizes git specs', () => {
    for (const spec of ['github:owner/repo', 'owner/repo', 'git+https://github.com/o/r.git', 'git://github.com/o/r.git']) {
      expect(isGitSpec(spec), spec).toBe(true)
    }
    expect(isGitSpec('^1.0.0')).toBe(false)
    expect(isGitSpec('link:../a')).toBe(false)
  })

  it('recognizes npm specs', () => {
    expect(isNpmSpec('^1.0.0')).toBe(true)
    expect(isNpmSpec('latest')).toBe(true)
    expect(isNpmSpec('1.2.3')).toBe(true)
    expect(isNpmSpec('github:owner/repo')).toBe(false)
    expect(isNpmSpec('link:../a')).toBe(false)
  })

  it('extracts a git ref from a spec', () => {
    expect(gitRefOfSpec('github:owner/repo#v1.2.3')).toBe('v1.2.3')
    expect(gitRefOfSpec('github:owner/repo')).toBeNull()
    // A hex fragment is a commit pin, not a ref to follow.
    expect(gitRefOfSpec(`github:owner/repo#${'a'.repeat(40)}`)).toBeNull()
  })

  it('reads a commit only when the spec pins a FULL sha', () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12'
    expect(gitCommitOfSpec(`github:owner/repo#${sha}`)).toBe(sha)
    // A short hash is a ref to resolve, not a commit of record.
    expect(gitCommitOfSpec('github:owner/repo#abcdef1')).toBeNull()
    expect(gitCommitOfSpec('github:owner/repo#v1.2.3')).toBeNull()
    expect(gitCommitOfSpec('github:owner/repo')).toBeNull()
  })
})
