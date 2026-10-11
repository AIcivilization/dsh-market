/**
 * Update detection: what the active profile has, against the source of truth
 * for each dependency's spec.
 *
 * The decision is deliberately conservative in one direction only. An update
 * is offered when a NEWER version is positively known to exist; every
 * uncertainty — an unreachable registry, an unparseable version, a spec this
 * code does not understand — resolves to "no update". That is the right
 * trade because applying an update rewrites the profile: a missed update
 * costs a click later, while a wrong one can downgrade a working install
 * until the profile no longer boots.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUpgrade } from './semver.js'
import {
  gitCommitOfSpec,
  gitRefOfSpec,
  isGitSpec,
  isInstalled,
  isLocalSpec,
  isNpmSpec,
  readInstalledVersion,
  readManifest,
  resolvedBundles,
  type ProfileManifest,
} from './profile.js'
import {
  fetchNpmLatest,
  lockCommits,
  repoKeyOfSpec,
  resolveGitRemoteHead,
  resolveRegistry,
} from './registry.js'

/** How a dependency is installed, which decides how it can be updated. */
export type UpdateSource = 'npm' | 'git' | 'local' | 'unknown'

/** The verdict for one installed dependency. */
export interface UpdateStatus {
  readonly name: string
  readonly source: UpdateSource
  /** The version on disk (`node_modules/<name>/package.json`). */
  readonly installedVersion: string | null
  /** The version the registry's `latest` tag names, for npm sources. */
  readonly latestVersion: string | null
  /** The version line the manifest spec asks for, when it pins one. */
  readonly spec: string
  /** The commit on disk, for git sources. */
  readonly installedCommit: string | null
  /** The commit the remote ref names, for git sources. */
  readonly latestCommit: string | null
  /** True only when a strictly newer release is known. */
  readonly updatable: boolean
  /**
   * Why this row is not updatable, when it is not. Machine-readable so the
   * client can explain a row instead of showing a disabled button.
   */
  readonly reason: UpdateReason | null
}

/** Why a dependency cannot be offered for update. */
export type UpdateReason =
  | 'up-to-date'
  | 'check-failed'
  | 'not-installed'
  | 'local-source'
  | 'not-a-plugin'
  | 'unsupported-spec'
  | 'no-version-known'

/** Inputs the check needs, injectable so tests never touch the network. */
export interface UpdateCheckDeps {
  /** The registry `latest` version for a package name, or null. */
  readonly npmLatest: (name: string) => Promise<string | null>
  /** The commit a git remote's ref names, or null. */
  readonly gitHead: (spec: string, ref: string | null) => Promise<string | null>
  /** The lockfile text, for git commit resolution. */
  readonly readLock: () => string | null
  /** Whether the package is installed on disk. */
  readonly installed: (name: string) => boolean
  /** The version recorded in an installed package's own manifest, or null. */
  readonly installedVersion: (name: string) => string | null
}

/** The result of checking one profile. */
export interface UpdateSummary {
  /** How many dependencies were examined. */
  readonly checked: number
  /** How many of them can be updated. */
  readonly updatable: number
  /** Every updatable row, in manifest order. */
  readonly packages: readonly UpdatablePackage[]
  /** Every row, including the ones that cannot be updated. */
  readonly all: readonly UpdateStatus[]
}

/** One package the update button will act on. */
export interface UpdatablePackage {
  readonly name: string
  readonly source: UpdateSource
  readonly installedVersion: string | null
  readonly latestVersion: string | null
}

/** Build the real dependency set for a profile directory. */
export function realDeps(dir: string): UpdateCheckDeps {
  const registry = resolveRegistry()
  return {
    npmLatest: name => fetchNpmLatest(name, registry),
    gitHead: (spec, ref) => resolveGitRemoteHead(spec, ref),
    readLock: () => {
      const path = join(dir, 'pnpm-lock.yaml')
      if (!existsSync(path)) return null
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    installed: name => isInstalled(dir, name),
    installedVersion: name => readInstalledVersion(dir, name),
  }
}

/**
 * Whether a dependency looks like a plugin this channel can update.
 *
 * A profile's `dependencies` also hold plain libraries, and a newer release
 * of one is not an "update" the button should take: the apply step reinstalls
 * the package and lets the host recompose, which for a non-plugin either does
 * nothing or is refused. Three independent facts each count as "is a plugin",
 * and every uncertainty resolves TOWARD yes — this only ever removes an
 * offer, so being unsure has to leave the offer standing.
 */
export function isUpdatablePlugin(dir: string, name: string, bundles: ReadonlySet<string>): boolean {
  if (!isInstalled(dir, name)) return true
  const manifestPath = join(dir, 'node_modules', name, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: unknown }
    if (manifest.dsh !== undefined) return true
  } catch {
    return true
  }
  return bundles.has(name)
}

/** A short commit form for display. */
function shortCommit(commit: string | null): string | null {
  return commit === null ? null : commit.slice(0, 7)
}

/**
 * Check one dependency.
 *
 * @param name - the dependency key, which is also the install directory name.
 * @param spec - the manifest spec, e.g. `^1.2.3` or `github:owner/repo#main`.
 * @param deps - the (injectable) network and filesystem inputs.
 * @param options - profile-level context the decision needs.
 */
export async function checkOne(
  name: string,
  spec: string,
  deps: UpdateCheckDeps,
  options: { readonly isPlugin: boolean; readonly lock: Map<string, string> },
): Promise<UpdateStatus> {
  const installed = deps.installed(name)
  const installedVersion = installed ? deps.installedVersion(name) : null
  const base = {
    name,
    spec,
    installedVersion,
    latestVersion: null,
    installedCommit: null,
    latestCommit: null,
    updatable: false,
  }

  if (!options.isPlugin) {
    return { ...base, source: 'npm', reason: 'not-a-plugin' }
  }
  if (!installed) {
    return { ...base, source: isGitSpec(spec) ? 'git' : 'npm', reason: 'not-installed' }
  }

  if (isLocalSpec(spec)) {
    // A `link:`/`file:` install is somebody's working copy. There is no
    // upstream to compare against, and rewriting the spec would replace a
    // development checkout with a release.
    return { ...base, source: 'local', reason: 'local-source' }
  }

  if (isGitSpec(spec)) {
    const repo = repoKeyOfSpec(spec)
    const installedCommit = gitCommitOfSpec(spec)
      ?? (repo === null ? null : options.lock.get(repo) ?? null)
    const latestCommit = await deps.gitHead(spec, gitRefOfSpec(spec))
    if (latestCommit === null) {
      return { ...base, source: 'git', installedCommit, reason: 'check-failed' }
    }
    // A git row is updatable when the remote's commit differs from the one on
    // disk. There is no "downgrade" to protect against here: the remote ref
    // is the branch the spec names, so a difference means the branch moved.
    const updatable = installedCommit !== null && installedCommit !== latestCommit
    return {
      ...base,
      source: 'git',
      installedCommit,
      latestCommit,
      latestVersion: shortCommit(latestCommit),
      installedVersion: installedVersion ?? shortCommit(installedCommit),
      updatable,
      reason: updatable ? null : installedCommit === null ? 'no-version-known' : 'up-to-date',
    }
  }

  if (!isNpmSpec(spec)) {
    return { ...base, source: 'unknown', reason: 'unsupported-spec' }
  }

  const latest = await deps.npmLatest(name)
  if (latest === null) {
    return { ...base, source: 'npm', reason: 'check-failed' }
  }
  if (installedVersion === null) {
    return { ...base, source: 'npm', latestVersion: latest, reason: 'no-version-known' }
  }
  const updatable = isUpgrade(installedVersion, latest)
  return {
    ...base,
    source: 'npm',
    latestVersion: latest,
    updatable,
    reason: updatable ? null : 'up-to-date',
  }
}

/**
 * Check every dependency of a profile.
 *
 * Order follows the manifest so a listing is stable between calls, and each
 * row is checked independently — one unreachable package must not take the
 * whole list down, which is why `checkOne` never throws.
 *
 * @param dir - the profile directory.
 * @param deps - injectable inputs; defaults to the real network.
 * @param startedBundles - the launcher's bundle list, when it publishes one.
 */
export async function checkUpdates(
  dir: string,
  deps: UpdateCheckDeps = realDeps(dir),
  startedBundles: readonly string[] | null = null,
): Promise<UpdateSummary> {
  const manifest: ProfileManifest = readManifest(dir)
  const bundles = resolvedBundles(dir, startedBundles)
  const lock = lockCommits(deps.readLock() ?? '')
  const entries = Object.entries(manifest.dependencies)
  // Each row is independent, so run them concurrently: a profile with ten
  // plugins should not take ten registry round-trips in series.
  const all = await Promise.all(entries.map(([name, spec]) => checkOne(name, spec, deps, {
    isPlugin: isUpdatablePlugin(dir, name, bundles),
    lock,
  })))
  const packages = all
    .filter(row => row.updatable)
    .map(row => ({
      name: row.name,
      source: row.source,
      installedVersion: row.installedVersion,
      latestVersion: row.latestVersion,
    }))
  return { checked: all.length, updatable: packages.length, packages, all }
}
