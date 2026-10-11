/**
 * Update-status decisions.
 *
 * This is the module where a wrong answer is destructive: it decides what the
 * update button acts on, and applying an update rewrites the profile. The
 * cases below are therefore mostly about what is REJECTED — a check that
 * cannot reach its source, a version that will not parse, a downgrade dressed
 * up as a release.
 */

import { describe, expect, it } from 'vitest'
import { checkOne, checkUpdates, isUpdatablePlugin, type UpdateCheckDeps } from '../../src/host/updates.js'
import { accessSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A profile directory with the given manifest and installed versions. */
function makeProfile(manifest: {
  dependencies?: Record<string, string>
  bundles?: string[]
}, installed: Record<string, { version?: string; dsh?: unknown }> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-test-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: manifest.dependencies ?? {},
    ...(manifest.bundles === undefined ? {} : { dsh: { profile: { bundles: manifest.bundles } } }),
  }))
  for (const [name, pkg] of Object.entries(installed)) {
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({
      name,
      version: pkg.version ?? '1.0.0',
      ...(pkg.dsh === undefined ? {} : { dsh: pkg.dsh }),
    }))
  }
  return dir
}

/** Injectable deps that never touch the network. */
function deps(dir: string, options: {
  latest?: Record<string, string | null>
  git?: Record<string, string | null>
  lock?: string
} = {}): UpdateCheckDeps {
  return {
    npmLatest: async name => options.latest?.[name] ?? null,
    gitHead: async spec => options.git?.[spec] ?? null,
    readLock: () => options.lock ?? null,
    installed: name => {
      try {
        accessSync(join(dir, 'node_modules', name, 'package.json'))
        return true
      } catch {
        return false
      }
    },
    installedVersion: name => {
      try {
        const raw = readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')
        return (JSON.parse(raw) as { version?: string }).version ?? null
      } catch {
        return null
      }
    },
  }
}

const plugin = { isPlugin: true, lock: new Map<string, string>() }

describe('checkOne — npm sources', () => {
  it('offers an update when the registry is ahead', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.2.3' } })
    const row = await checkOne('alpha', '^1.2.3', deps(dir, { latest: { alpha: '1.3.0' } }), plugin)
    expect(row.updatable).toBe(true)
    expect(row.installedVersion).toBe('1.2.3')
    expect(row.latestVersion).toBe('1.3.0')
    expect(row.reason).toBeNull()
  })

  it('reports up-to-date when the versions match', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.2.3' } })
    const row = await checkOne('alpha', '^1.2.3', deps(dir, { latest: { alpha: '1.2.3' } }), plugin)
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('up-to-date')
  })

  it('NEVER offers a downgrade, even though latest is a valid release', async () => {
    // The pinned-install case: the profile holds 2.0.0 while `latest` is
    // 1.9.0. Every other consumer reads `updatable` as "a newer version
    // exists", so answering true here would install a downgrade on a click.
    const dir = makeProfile({}, { alpha: { version: '2.0.0' } })
    const row = await checkOne('alpha', '2.0.0', deps(dir, { latest: { alpha: '1.9.0' } }), plugin)
    expect(row.updatable).toBe(false)
    expect(row.latestVersion).toBe('1.9.0')
    expect(row.reason).toBe('up-to-date')
  })

  it('accepts a prerelease-to-release move', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.2.3-beta.1' } })
    const row = await checkOne('alpha', '^1.2.3', deps(dir, { latest: { alpha: '1.2.3' } }), plugin)
    expect(row.updatable).toBe(true)
  })

  it('treats an unreachable registry as check-failed, not up-to-date', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.0.0' } })
    const row = await checkOne('alpha', '^1.0.0', deps(dir, { latest: { alpha: null } }), plugin)
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('check-failed')
  })

  it('reports a non-plugin dependency with its own reason', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.0.0' } })
    const row = await checkOne('alpha', '^1.0.0', deps(dir, { latest: { alpha: '2.0.0' } }), { isPlugin: false, lock: new Map() })
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('not-a-plugin')
  })

  it('refuses a local source rather than replacing a working copy', async () => {
    const dir = makeProfile({}, { alpha: { version: '1.0.0' } })
    const row = await checkOne('alpha', 'link:../alpha', deps(dir, { latest: { alpha: '9.0.0' } }), plugin)
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('local-source')
    expect(row.source).toBe('local')
  })
})

describe('checkOne — git sources', () => {
  it('offers an update when the remote ref moved', async () => {
    const dir = makeProfile({}, { beta: { version: '0.0.0' } })
    const row = await checkOne(
      'beta',
      'github:owner/beta',
      deps(dir, { git: { 'github:owner/beta': 'b'.repeat(40) } }),
      { isPlugin: true, lock: new Map([['github.com/owner/beta', 'a'.repeat(40)]]) },
    )
    expect(row.source).toBe('git')
    expect(row.updatable).toBe(true)
    expect(row.installedCommit).toBe('a'.repeat(40))
    expect(row.latestCommit).toBe('b'.repeat(40))
    expect(row.latestVersion).toBe('bbbbbbb')
  })

  it('reports up-to-date when the recorded commit matches the remote', async () => {
    const dir = makeProfile({}, { beta: { version: '0.0.0' } })
    const commit = 'c'.repeat(40)
    const row = await checkOne(
      'beta',
      'github:owner/beta',
      deps(dir, { git: { 'github:owner/beta': commit } }),
      { isPlugin: true, lock: new Map([['github.com/owner/beta', commit]]) },
    )
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('up-to-date')
  })

  it('does not offer a git update when no recorded commit is known', async () => {
    // Without a local commit there is no comparison, and offering an update
    // would reinstall the same commit forever.
    const dir = makeProfile({}, { beta: { version: '0.0.0' } })
    const row = await checkOne(
      'beta',
      'github:owner/beta',
      deps(dir, { git: { 'github:owner/beta': 'd'.repeat(40) } }),
      { isPlugin: true, lock: new Map() },
    )
    expect(row.updatable).toBe(false)
    expect(row.reason).toBe('no-version-known')
  })
})

describe('checkUpdates', () => {
  it('reports the real denominator, including current plugins', async () => {
    const dir = makeProfile(
      { dependencies: { alpha: '^1.0.0', beta: '^2.0.0', gamma: '^3.0.0' }, bundles: ['alpha', 'beta', 'gamma'] },
      { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' }, gamma: { version: '3.0.0' } },
    )
    const summary = await checkUpdates(dir, deps(dir, {
      latest: { alpha: '1.1.0', beta: '2.0.0', gamma: '3.0.0' },
    }))
    // One updatable out of three examined: the count that lets a client tell
    // "nothing to update" from "nothing was looked at".
    expect(summary.checked).toBe(3)
    expect(summary.updatable).toBe(1)
    expect(summary.packages.map(row => row.name)).toEqual(['alpha'])
    expect(summary.all).toHaveLength(3)
  })

  it('keeps one failing package from taking down the list', async () => {
    const dir = makeProfile(
      { dependencies: { alpha: '^1.0.0', beta: '^2.0.0' }, bundles: ['alpha', 'beta'] },
      { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' } },
    )
    const summary = await checkUpdates(dir, deps(dir, { latest: { alpha: null, beta: '2.1.0' } }))
    expect(summary.packages.map(row => row.name)).toEqual(['beta'])
    expect(summary.all.find(row => row.name === 'alpha')?.reason).toBe('check-failed')
  })

  it('counts failed rows separately from examined rows', async () => {
    // `checked` counts attempts, so without `checkFailed` a client cannot tell
    // "nothing to install" from "could not reach the registry".
    const dir = makeProfile(
      { dependencies: { alpha: '^1.0.0', beta: '^2.0.0', gamma: '^3.0.0' }, bundles: ['alpha', 'beta', 'gamma'] },
      { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' }, gamma: { version: '3.0.0' } },
    )
    const summary = await checkUpdates(
      dir,
      deps(dir, { latest: { alpha: null, beta: null, gamma: '3.0.0' } }),
    )
    expect(summary.checked).toBe(3)
    expect(summary.updatable).toBe(0)
    expect(summary.checkFailed).toBe(2)
  })

  it('reports zero failures when every row was queried', async () => {
    const dir = makeProfile(
      { dependencies: { alpha: '^1.0.0' }, bundles: ['alpha'] },
      { alpha: { version: '1.0.0' } },
    )
    const summary = await checkUpdates(dir, deps(dir, { latest: { alpha: '1.0.0' } }))
    expect(summary.checked).toBe(1)
    expect(summary.checkFailed).toBe(0)
  })

  it('reports every row failed when the registry is entirely unreachable', async () => {
    const dir = makeProfile(
      { dependencies: { alpha: '^1.0.0', beta: '^2.0.0' }, bundles: ['alpha', 'beta'] },
      { alpha: { version: '1.0.0' }, beta: { version: '2.0.0' } },
    )
    const summary = await checkUpdates(dir, deps(dir, { latest: { alpha: null, beta: null } }))
    expect(summary.checkFailed).toBe(summary.checked)
  })
})

describe('isUpdatablePlugin', () => {
  it('accepts a package with its own dsh field', () => {
    const dir = makeProfile({}, { alpha: { dsh: { bundle: {} } } })
    expect(isUpdatablePlugin(dir, 'alpha', new Set())).toBe(true)
  })

  it('accepts a package named in bundles even without a dsh field', () => {
    const dir = makeProfile({}, { alpha: {} })
    expect(isUpdatablePlugin(dir, 'alpha', new Set(['alpha']))).toBe(true)
  })

  it('rejects a plain library that is neither', () => {
    const dir = makeProfile({}, { alpha: {} })
    expect(isUpdatablePlugin(dir, 'alpha', new Set())).toBe(false)
  })
})
