/**
 * Network access for update checks.
 *
 * Two external sources are consulted, and both are treated as advisory: a
 * registry or a git remote that cannot be reached must produce "no update
 * known" rather than an error, since a failed check is not a failed update
 * and a user on a restricted network should still see the rest of the list.
 */

/** How long a single version lookup may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 10_000

/** How long a git ref advertisement may take. */
const GIT_TIMEOUT_MS = 6_000

/**
 * The npm registry update checks read, no trailing slash.
 *
 * Respects the conventional environment overrides so a machine pointed at a
 * mirror does not have to reach the public registry: `DSH_MARKET_REGISTRY`
 * first (this plugin's own switch), then the npm-standard `npm_config_
 * registry` / `NPM_CONFIG_REGISTRY`.
 */
export function resolveRegistry(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_MARKET_REGISTRY']
    ?? env['npm_config_registry']
    ?? env['NPM_CONFIG_REGISTRY']
  if (configured !== undefined && configured.trim() !== '') return configured.trim().replace(/\/+$/, '')
  return 'https://registry.npmjs.org'
}

/**
 * User agent sent on registry requests.
 *
 * `fetch` is used rather than a client library because the host half has no
 * dependencies; `AbortSignal.timeout` bounds every call.
 */
const USER_AGENT = 'dsh-market'

/** Fetch and parse JSON, or return null on any failure. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return await response.json() as unknown
  } catch {
    return null
  }
}

/**
 * The registry's `latest` dist-tag for a package.
 * @returns the version string, or null when unpublished or unreachable.
 */
export async function fetchNpmLatest(name: string, registry = resolveRegistry()): Promise<string | null> {
  const doc = await fetchJson(`${registry}/${encodeURIComponent(name)}/latest`)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const version = (doc as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : null
}

/**
 * The repository URL a package's latest manifest declares, when it does.
 *
 * Used only as a hint for reporting; an update is never offered on the
 * strength of it, because a package's `repository` field is author-supplied
 * and frequently wrong.
 */
export async function fetchNpmRepository(name: string, registry = resolveRegistry()): Promise<string | null> {
  const doc = await fetchJson(`${registry}/${encodeURIComponent(name)}/latest`)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const repository = (doc as { repository?: unknown }).repository
  const url = typeof repository === 'string'
    ? repository
    : (repository !== null && typeof repository === 'object' && !Array.isArray(repository)
      ? (repository as { url?: unknown }).url
      : undefined)
  return typeof url === 'string' && url !== '' ? url : null
}

/**
 * Turn a GitHub `owner/repo` shortcut or a git URL into the smart-HTTP
 * `info/refs` endpoint git itself uses.
 *
 * The ref advertisement is deliberately chosen over the REST API: the API
 * allows 60 unauthenticated requests an hour per IP, shared across every
 * plugin and every check, so a handful of git-installed plugins exhausts it
 * and updates silently stop being reported.
 *
 * @returns the URL, or null when the spec is not a git remote this can query.
 */
export function gitUploadPackUrl(spec: string): string | null {
  const trimmed = spec.trim().replace(/#.*$/, '')
  if (trimmed === '') return null
  // `github:owner/repo` is npm's shorthand, not a URL — normalize it to the
  // https form first so the URL path below can handle it uniformly.
  const shorthand = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(trimmed)
  if (shorthand !== null) {
    return `https://github.com/${shorthand[1]!}/${shorthand[2]!}.git/info/refs?service=git-upload-pack`
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git/info/refs?service=git-upload-pack`
  }
  const normalized = trimmed
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  if (path === '' || path.split('/').filter(Boolean).length < 2) return null
  url.pathname = `${path}.git/info/refs`
  url.search = 'service=git-upload-pack'
  url.hash = ''
  return url.toString()
}

/**
 * The commit a git remote's ref currently points at.
 *
 * Reads the same advertisement `git ls-remote` does. When `ref` is given the
 * named branch/tag is resolved; otherwise `HEAD` is. An annotated tag is
 * advertised twice — the tag object and the commit it peels to — and the
 * peeled ref has to win, because a lockfile records the commit, so resolving
 * the tag object would never equal it and the row would report an update
 * forever while applying it reinstalls the same commit.
 *
 * @returns the 40-character commit, or null when it cannot be resolved.
 */
export async function resolveGitRemoteHead(spec: string, ref?: string | null): Promise<string | null> {
  const url = gitUploadPackUrl(spec)
  if (url === null) return null
  let body: string
  try {
    const response = await fetch(url, {
      // `git`'s own user agent: some hosts vary their response on it.
      headers: { 'user-agent': 'git/2.40.0' },
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    })
    if (!response.ok) return null
    body = await response.text()
  } catch {
    return null
  }
  // Guard against a host answering with an HTML page (a login wall, a
  // captive portal) that happens to contain a 40-character hex run.
  if (!body.includes('# service=git-upload-pack')) return null
  const wanted = ref !== undefined && ref !== null && ref !== '' ? ref : null
  if (wanted === null) {
    const head = /([0-9a-f]{40}) HEAD\b/.exec(body)
    return head === null ? null : head[1]!.toLowerCase()
  }
  const quoted = wanted.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  for (const namespace of ['heads', 'tags']) {
    if (namespace === 'tags') {
      const peeled = new RegExp(String.raw`([0-9a-f]{40}) refs/tags/${quoted}\^\{\}`).exec(body)
      if (peeled !== null) return peeled[1]!.toLowerCase()
    }
    const found = new RegExp(String.raw`([0-9a-f]{40}) refs/${namespace}/${quoted}(?![^\s])`).exec(body)
    if (found !== null) return found[1]!.toLowerCase()
  }
  return null
}

/**
 * Commits recorded in a profile's `pnpm-lock.yaml`, keyed by repo.
 *
 * pnpm records a git install in more than one way depending on the host and
 * how the spec was written: a `commit:` inside a `resolution` block, and a
 * commit embedded in a codeload archive URL. Both shapes are read, and
 * `codeload.github.com` is normalized to `github.com` because codeload is
 * GitHub's download host rather than a repository host of its own.
 */
export function lockCommits(lockText: string): Map<string, string> {
  const commits = new Map<string, string>()
  for (const match of lockText.matchAll(
    /resolution:\s*\{([^}]*)\}/g,
  )) {
    const body = match[1]!
    const commit = /\bcommit:\s*([0-9a-f]{40})\b/i.exec(body)
    const repo = /\brepo:\s*([^\s,}]+)/.exec(body)
    if (commit === null || repo === null) continue
    commits.set(repo[1]!.toLowerCase(), commit[1]!.toLowerCase())
  }
  for (const match of lockText.matchAll(
    /https?:\/\/(codeload\.github\.com|[\w.-]+)\/([\w.-]+\/[\w.-]+)\/tar\.gz\/([0-9a-f]{40})/gi,
  )) {
    const host = match[1]!.toLowerCase() === 'codeload.github.com' ? 'github.com' : match[1]!.toLowerCase()
    commits.set(`${host}/${match[2]!.toLowerCase()}`, match[3]!.toLowerCase())
  }
  return commits
}

/** Normalize a git spec to a `host/owner/repo` key, or null. */
export function repoKeyOfSpec(spec: string): string | null {
  const trimmed = spec.trim().replace(/#.*$/, '')
  if (trimmed === '') return null
  // GitHub's own shorthand, `github:owner/repo` — deliberately handled before
  // the URL path, because it is not a URL and `new URL` would reject it. This
  // form is what `npm i github:owner/repo` writes into a manifest, so missing
  // it would leave every such install with no commit to compare against.
  const shorthand = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(trimmed)
  if (shorthand !== null) return `github.com/${shorthand[1]!.toLowerCase()}/${shorthand[2]!.toLowerCase()}`
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `github.com/${trimmed.toLowerCase()}`
  const url = gitUploadPackUrl(trimmed)
  if (url === null) return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase() === 'codeload.github.com' ? 'github.com' : parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/\.git\/info\/refs$/, '').replace(/^\/+/, '').toLowerCase()
    return path === '' ? null : `${host}/${path}`
  } catch {
    return null
  }
}
