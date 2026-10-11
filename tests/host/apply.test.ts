/**
 * Applying an update: which package manager runs, and what counts as success.
 *
 * The two things worth testing here are the ones that have burned real
 * installs: choosing the wrong manager (or the wrong arguments) for a profile,
 * and believing a package manager that exited 0 without actually delivering
 * the version that was asked for.
 */

import { describe, expect, it } from 'vitest'
import {
  addArgs,
  deliveredUpdate,
  hasLoadableEntry,
  resolvePackageManager,
  verifyAppliedVersion,
  workspaceArgs,
  type UpdatePlan,
} from '../../src/host/apply.js'
import { createRoutes } from '../../src/host/routes.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A scratch directory. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-market-apply-'))
}

/** Write a package.json at `<dir>/<name>/package.json`. */
function installPackage(dir: string, name: string, manifest: Record<string, unknown>): void {
  const target = join(dir, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
}

describe('resolvePackageManager', () => {
  it('uses the host-managed manager exclusively when one is published', () => {
    const invocation = resolvePackageManager({
      command: 'corepack',
      args: ['pnpm'],
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    })
    expect(invocation).toEqual({
      command: 'corepack',
      args: ['pnpm'],
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      origin: 'host',
    })
  })

  it('falls back to pnpm on PATH when NOTHING was published', () => {
    // The regression guard for a real crash: `createRoutes` called with
    // `packageManager` omitted entirely. `undefined` slipped past the original
    // `!== null` test and the very next line dereferenced it, so the throw
    // happened inside the plugin's activation — both buttons would vanish with
    // only a stack trace in the host log. Omitting the field is a legal call
    // (it is optional on RouteDeps), which is exactly why it must not throw.
    expect(() => createRoutes({
      profileDir: scratch(),
      profileName: 'desktop',
      startedBundles: [],
      desktopService: false,
    } as never)).not.toThrow()
  })

  it('treats undefined and null identically', () => {
    const fromUndefined = resolvePackageManager(undefined)
    const fromNull = resolvePackageManager(null)
    expect(fromUndefined).toEqual(fromNull)
    expect(fromUndefined).toEqual({ command: 'pnpm', args: [], env: {}, origin: 'path' })
  })

  it('mounts the full route table with packageManager omitted', () => {
    // 8 since the task probe joined: ping, capabilities, updates/summary,
    // updates, updates/all, operations, tasks, restart.
    const routes = createRoutes({
      profileDir: scratch(),
      profileName: 'desktop',
      startedBundles: [],
      desktopService: false,
    } as never)
    expect(routes).toHaveLength(8)
  })
})

describe('workspaceArgs', () => {
  it('injects -w when the profile is a pnpm workspace', () => {
    // pnpm 9 refuses to add at a workspace root without it.
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    expect(workspaceArgs(dir, ['add', 'alpha@latest'])).toEqual(['add', '-w', 'alpha@latest'])
  })

  it('omits -w when the profile is not a workspace', () => {
    // Every pnpm major refuses -w outside a workspace, so this is not cosmetic.
    const dir = scratch()
    expect(workspaceArgs(dir, ['add', 'alpha@latest'])).toEqual(['add', 'alpha@latest'])
  })

  it('injects -w at the documented position for remove as well', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    expect(workspaceArgs(dir, ['remove', 'alpha'])).toEqual(['remove', '-w', 'alpha'])
  })
})

describe('addArgs', () => {
  it('builds an append-only add at the authoritative target', () => {
    const dir = scratch()
    const args = addArgs('alpha', '1.2.3', dir)
    expect(args).toEqual(['add', 'alpha@1.2.3', '--reporter', 'append-only'])
  })

  it('injects -w for a workspace profile', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    expect(addArgs('alpha', 'latest', dir)).toContain('-w')
  })
})

describe('verifyAppliedVersion', () => {
  it('accepts an exact match', () => {
    expect(verifyAppliedVersion('1.2.3', '1.2.3', '1.2.3', 'npm')).toBeNull()
  })

  it('accepts a version ABOVE the requested target', () => {
    // The registry can hand back something newer than the dist-tag when it
    // moved mid-install. Refusing that would report a successful update as a
    // failure and invite the user to retry forever.
    expect(verifyAppliedVersion('1.2.3', '1.3.0', '1.2.3', 'npm')).toBeNull()
  })

  it('rejects a DOWNGRADE as fatal', () => {
    // The install went backwards: the profile now has an older version than
    // the one it was already running.
    expect(verifyAppliedVersion('1.2.3', '1.0.0', '1.2.3', 'npm')).toBe('DOWNGRADE_DETECTED')
  })

  it('rejects a version below the requested target when nothing was installed before', () => {
    expect(verifyAppliedVersion(null, '1.1.0', '1.2.3', 'npm')).toBe('RESOLVED_VERSION_MISMATCH')
  })

  it('does not mistake a prerelease of the target for a downgrade', () => {
    // 1.2.3-rc.1 is below 1.2.3 in semver terms, so with no prior version this
    // is caught by the mismatch rule rather than reported as a downgrade.
    expect(verifyAppliedVersion(null, '1.2.3-rc.1', '1.2.3', 'npm')).toBe('RESOLVED_VERSION_MISMATCH')
  })

  it('prefers the downgrade verdict when the install went backwards', () => {
    // Both rules apply; the direction is the more serious finding, because it
    // means the profile now has an older version than it started with.
    expect(verifyAppliedVersion('2.0.0', '1.0.0', '1.5.0', 'npm')).toBe('DOWNGRADE_DETECTED')
  })

  it('reports a missing version as an entry problem, not a version problem', () => {
    expect(verifyAppliedVersion('1.2.3', null, '1.2.3', 'npm')).toBe('ENTRY_MISSING')
  })

  it('does not version-check a non-npm source', () => {
    // A git or local install has no registry version to compare against, so a
    // numeric check there would invent failures.
    expect(verifyAppliedVersion('1.0.0', '0.5.0', '1.2.3', 'git')).toBeNull()
    expect(verifyAppliedVersion('1.0.0', null, '1.2.3', 'git')).toBeNull()
  })

  it('accepts any version when no target was pinned', () => {
    expect(verifyAppliedVersion('1.2.3', '1.2.4', null, 'npm')).toBeNull()
  })
})

describe('deliveredUpdate', () => {
  const plan = (over: Partial<UpdatePlan>): UpdatePlan => ({
    name: 'alpha',
    source: 'npm',
    target: '1.2.0',
    beforeVersion: '1.0.0',
    beforeCommit: null,
    installed: true,
    ...over,
  })

  it('is true when the version moved to the target', () => {
    expect(deliveredUpdate(plan({}), '1.2.0', null)).toBe(true)
  })

  it('is false when the version did not move and the target was not reached', () => {
    // The stale-mirror / pnpm fresh-release-hold case: the run exited 0, the
    // on-disk version is unchanged, and it is NOT the version that was asked
    // for. Reporting success here is worse than reporting failure, because the
    // user stops looking.
    expect(deliveredUpdate(plan({ target: '1.2.0' }), '1.0.0', null)).toBe(false)
  })

  it('is true when the unchanged version IS the requested target', () => {
    // The package was already at the target: nothing moved, but what the user
    // asked for is on disk, so this is a success rather than a silent no-op.
    expect(deliveredUpdate(plan({ target: '1.0.0' }), '1.0.0', null)).toBe(true)
  })

  it('is false when nothing was reported installed', () => {
    expect(deliveredUpdate(plan({}), null, null)).toBe(false)
  })

  it('treats a moved commit as delivery for a git source', () => {
    const git = plan({ source: 'git', target: null, beforeCommit: 'a'.repeat(40) })
    expect(deliveredUpdate(git, null, 'b'.repeat(40))).toBe(true)
    expect(deliveredUpdate(git, null, 'a'.repeat(40))).toBe(false)
  })

  it('gives a git source the benefit of the doubt when a commit is unknown', () => {
    const git = plan({ source: 'git', target: null, beforeCommit: null })
    expect(deliveredUpdate(git, null, 'b'.repeat(40))).toBe(true)
  })
})

describe('hasLoadableEntry', () => {
  it('accepts a package whose declared main entry exists', () => {
    const dir = scratch()
    installPackage(dir, 'alpha', { name: 'alpha', version: '1.0.0', main: 'index.js' })
    writeFileSync(join(dir, 'node_modules', 'alpha', 'index.js'), 'export {}\n')
    expect(hasLoadableEntry(dir, 'alpha')).toBe(true)
  })

  it('rejects a package whose declared main entry is MISSING', () => {
    // The reported failure this catches: a source-only tarball from a mirror.
    // The manifest promises an entry point and the file is not there, so the
    // next boot would fail to load the plugin.
    const dir = scratch()
    installPackage(dir, 'alpha', { name: 'alpha', version: '1.0.0', main: 'index.js' })
    expect(hasLoadableEntry(dir, 'alpha')).toBe(false)
  })

  it('accepts a package that declares no main entry', () => {
    // Nothing is promised, so there is nothing to verify here.
    const dir = scratch()
    installPackage(dir, 'alpha', { name: 'alpha', version: '1.0.0' })
    expect(hasLoadableEntry(dir, 'alpha')).toBe(true)
  })

  it('rejects a package that is not installed', () => {
    const dir = scratch()
    expect(hasLoadableEntry(dir, 'alpha')).toBe(false)
  })
})
