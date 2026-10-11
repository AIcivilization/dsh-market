/**
 * Profile resolution and reading.
 *
 * A DSH profile is a directory holding its own `package.json`, a
 * `node_modules` tree and a `cordis.patch.yml`. The launcher publishes a
 * `profileContext` service naming the one this process actually booted, and
 * that is the authority here: deriving the directory from `~/.dsh/profiles/
 * <name>` would disagree with every host that keeps profiles elsewhere (the
 * Electron desktop host passes an explicit directory for exactly this
 * reason), and a profile that is derivable-but-wrong means updates and
 * installs land in a profile the user is not looking at.
 *
 * Every field of the service is treated as untrusted. A host that publishes
 * a half-formed object must fall back to argv/environment discovery, never
 * be used with one field missing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Structural subset of the launcher's public `profileContext` service.
 *
 * `packageManager` is optional: a packaged host ships its own pnpm and names
 * it here instead of relying on a PATH executable. Read as `unknown` and
 * validated field by field, because the launcher owns the shape.
 */
export interface ProfileContextLike {
  readonly name?: unknown
  readonly dir?: unknown
  readonly patchPath?: unknown
  readonly installAnchor?: unknown
  readonly startedBundles?: unknown
  readonly cwd?: unknown
  readonly home?: unknown
  readonly packageManager?: unknown
}

/** A launcher-published, ready-to-run package-manager invocation. */
export interface HostPackageManager {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** The resolved profile this process is serving. */
export interface ResolvedProfile {
  readonly name: string
  readonly dir: string
  /** How the directory was found, for the capabilities payload. */
  readonly origin: 'launcher profileContext' | 'launcher explicit dir' | '--profile flag' | 'DSH_HOME' | 'default'
  /** The launcher's package manager, when it published a usable one. */
  readonly packageManager: HostPackageManager | null
  /** Bundle names the launcher reports as started, when it reports them. */
  readonly startedBundles: readonly string[] | null
}

/** Resolve the DSH home directory (`DSH_HOME`, else `~/.dsh`). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env['DSH_HOME']
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return join(home, '.dsh')
}

/**
 * Whether a profile name is usable as a single path segment.
 *
 * Refusing rather than sanitizing: a name that is not one segment is not a
 * profile this process should be reasoning about, and joining it into a path
 * would reach outside the profiles directory.
 */
export function isDshProfileName(name: string): boolean {
  return name !== ''
    && name !== '.'
    && name !== '..'
    && name !== 'node_modules'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

/** The `--profile <name>` flag on this process's own argv, if any. */
export function argvProfile(argv: readonly string[] = process.argv): string | null {
  const flag = argv.indexOf('--profile')
  if (flag === -1 || flag + 1 >= argv.length) return null
  const value = argv[flag + 1]!
  if (value.startsWith('-')) return null
  return value
}

/**
 * Validate the launcher's published package manager.
 *
 * All-or-nothing on purpose: a command without its args, or with an env that
 * is not a string map, is a tool this process still cannot run, and using
 * the half that parsed would be a subtler failure than not using it at all.
 * Non-string env values are dropped (the child environment is
 * `Record<string, string>`), but a malformed env object discards the whole
 * invocation.
 */
export function hostPackageManagerOf(context: ProfileContextLike | null | undefined): HostPackageManager | null {
  if (context === null || context === undefined) return null
  const published = context.packageManager
  if (published === null || typeof published !== 'object' || Array.isArray(published)) return null
  const { command, args, env } = published as { command?: unknown; args?: unknown; env?: unknown }
  if (typeof command !== 'string' || command.trim() === '') return null
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return null
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) return null
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries((env ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') merged[key] = value
  }
  return { command: command.trim(), args: [...(args as string[])], env: merged }
}

/**
 * Resolve the profile from the launcher's service, falling back to argv and
 * the default location.
 *
 * @param context - the host's `profileContext` service, if it publishes one.
 * @param env - environment used for the fallback path.
 * @param argv - argv used for the `--profile` fallback.
 * @returns the resolved profile, or null when nothing usable could be found.
 */
export function resolveProfile(
  context: ProfileContextLike | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ResolvedProfile | null {
  const packageManager = hostPackageManagerOf(context)
  const startedBundles = readStartedBundles(context)
  const name = typeof context?.name === 'string' ? context.name.trim() : ''
  const dir = typeof context?.dir === 'string' ? context.dir.trim() : ''
  if (isDshProfileName(name) && dir !== '') {
    return { name, dir, origin: 'launcher profileContext', packageManager, startedBundles }
  }
  const flagged = argvProfile(argv)
  if (flagged !== null && isDshProfileName(flagged)) {
    return {
      name: flagged,
      dir: join(resolveDshHome(env), 'profiles', flagged),
      origin: '--profile flag',
      packageManager,
      startedBundles,
    }
  }
  const home = resolveDshHome(env)
  const fallback = join(home, 'profiles', 'web')
  if (existsSync(fallback)) {
    return { name: 'web', dir: fallback, origin: 'DSH_HOME', packageManager, startedBundles }
  }
  return null
}

/** The launcher's `startedBundles`, or null when it does not carry a string array. */
function readStartedBundles(context: ProfileContextLike | null | undefined): readonly string[] | null {
  const value = context?.startedBundles
  if (!Array.isArray(value)) return null
  if (value.some(entry => typeof entry !== 'string')) return null
  return value as string[]
}

/** The profile manifest as far as this plugin cares about it. */
export interface ProfileManifest {
  readonly dependencies: Readonly<Record<string, string>>
  readonly bundles: readonly string[]
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * Read `<dir>/package.json`.
 *
 * Both halves matter and they are not interchangeable: `dependencies` holds
 * the SPECS an install is driven from (`^1.2.3`, `github:owner/repo`), while
 * `dsh.profile.bundles` names the plugin layers that are actually composed.
 * The launcher's `startedBundles` is preferred for the latter when present,
 * because it reflects what booted rather than what the file currently says.
 */
export function readManifest(dir: string): ProfileManifest {
  const parsed = readJsonFile(join(dir, 'package.json'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dependencies: {}, bundles: [] }
  }
  const manifest = parsed as { dependencies?: unknown; dsh?: unknown }
  const dependencies: Record<string, string> = {}
  if (manifest.dependencies !== null && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)) {
    for (const [key, value] of Object.entries(manifest.dependencies as Record<string, unknown>)) {
      if (typeof value === 'string') dependencies[key] = value
    }
  }
  return { dependencies, bundles: readBundlesFrom(manifest.dsh) }
}

/** The `dsh.profile.bundles` array of a manifest's `dsh` field. */
export function readBundlesFrom(dsh: unknown): readonly string[] {
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return []
  const profile = (dsh as { profile?: unknown }).profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const bundles = (profile as { bundles?: unknown }).bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The bundles a directory's profile composes: the launcher's answer when it
 * has one, otherwise `dsh.profile.bundles`.
 */
export function resolvedBundles(dir: string, startedBundles: readonly string[] | null): ReadonlySet<string> {
  if (startedBundles !== null && startedBundles.length > 0) return new Set(startedBundles)
  return new Set(readManifest(dir).bundles)
}

/** The `version` in an installed package's own manifest, or null. */
export function readInstalledVersion(dir: string, name: string): string | null {
  const parsed = readJsonFile(join(dir, 'node_modules', name, 'package.json'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : null
}

/** Whether an installed package declares a `dsh` field of its own. */
export function hasDshManifest(dir: string, name: string): boolean {
  const parsed = readJsonFile(join(dir, 'node_modules', name, 'package.json'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return (parsed as { dsh?: unknown }).dsh !== undefined
}

/** Whether the package is installed on disk at all. */
export function isInstalled(dir: string, name: string): boolean {
  return existsSync(join(dir, 'node_modules', name, 'package.json'))
}

/** A dependency spec that points at a local path rather than a release. */
export function isLocalSpec(spec: string): boolean {
  const lower = spec.trim().toLowerCase()
  return lower.startsWith('link:') || lower.startsWith('file:') || lower.startsWith('workspace:')
}

/**
 * A `github:owner/repo` / `owner/repo` / git-URL spec.
 *
 * Detected positively so the npm branch can never be reached with a git
 * spec: asking the registry about a package name that a git install merely
 * shares would offer an unrelated package as an "update" and then install it
 * over the git source.
 */
export function isGitSpec(spec: string): boolean {
  const trimmed = spec.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('github:')) return true
  if (lower.startsWith('git+') || lower.startsWith('git:')) return true
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(trimmed) && !trimmed.startsWith('@')) return true
  return false
}

/** A dependency spec that names a registry release (a range or dist-tag). */
export function isNpmSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === '') return false
  if (isLocalSpec(trimmed)) return false
  if (isGitSpec(trimmed)) return false
  if (/^https?:/.test(trimmed)) return false
  return true
}

/**
 * A `#ref` fragment of a git spec, when it carries one.
 * @returns the ref, or null for a spec with no fragment or a bare commit.
 */
export function gitRefOfSpec(spec: string): string | null {
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const ref = spec.slice(hash + 1).split('&')[0]!.trim()
  if (ref === '') return null
  // A 7-40 hex-character fragment is a commit pin, not a ref to follow.
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return null
  return ref
}

/** A commit pinned directly in a git spec (`#<sha>`), when present. */
export function gitCommitOfSpec(spec: string): string | null {
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const ref = spec.slice(hash + 1).split('&')[0]!.trim()
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase()
  return null
}
