#!/usr/bin/env node
/**
 * Release gate for the standalone DSH plugin package.
 *
 * This script exists to keep releases honest: it inspects the ACTUAL emitted
 * bytes and FAILS LOUDLY if either half is not installable by a DSH profile.
 * Every check below is structural (parse the artifact, evaluate the factory,
 * call the exports) rather than a grep for a hopeful substring, because a
 * substring check cannot tell a working bundle from a malformed one.
 *
 * Checks, in order:
 *   A. package.json activation contract  — `dsh.bundle.patch` exists and points
 *      at a real file, so `dsh plugin add` will reconcile it into the profile.
 *   B. Host half (`lib/index.js`)        — importable as ESM and exports
 *      `name`, `inject`, `apply` with the right shapes.
 *   C. Client half (`client/client.js`)  — is a single
 *      `window.__ModuleLoader__.load({id, factory})` wrapper with the CORRECT id,
 *      whose factory survives `new Function` parsing, registers `module.exports`
 *      consistently, requires ONLY specifiers the browser module table can answer,
 *      and contains no leftover .css import and no unresolved bare @deepseek-ai
 *      import.
 *   D. Publish payload                   — every `files` entry that must ship
 *      exists on disk, and the two build outputs are not accidentally excluded.
 *
 * Exits non-zero and prints an actionable report on the first class of failure.
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Collected failures; the process exits non-zero if this is non-empty. */
const failures = []
/** Human-readable confirmations of what actually passed. */
const checks = []

/**
 * Record a check outcome.
 * @param ok - whether the check passed.
 * @param label - what was checked.
 * @param detail - extra context printed either way.
 */
function check(ok, label, detail = '') {
  if (ok) {
    checks.push(detail === '' ? label : `${label} — ${detail}`)
  } else {
    failures.push(detail === '' ? label : `${label} — ${detail}`)
  }
}

/**
 * Read and JSON.parse a file, recording a failure instead of throwing.
 * @param path - absolute path.
 * @param label - label used in the report.
 * @returns the parsed value, or undefined when unreadable/unparseable.
 */
async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    check(false, label, `unreadable or invalid JSON: ${error.message}`)
    return undefined
  }
}

/**
 * Strip a trailing `/client` the way the loader's `stripClientSuffix` does.
 * @param id - raw bundle id.
 * @returns the normalized id.
 */
function stripClientSuffix(id) {
  return id.endsWith('/client') ? id.slice(0, -'/client'.length) : id
}

/**
 * Specifiers the browser module table can answer.
 * Mirrors `@deepseek-ai/dsh-client-web`'s PLATFORM_MODULES plus the parser-preloaded
 * dynamic external and the plugin's own declared requests from package.json.
 */
function answerableSpecifiers(manifest) {
  const platform = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const preloaded = ['@deepseek-ai/dsh-client-runtime/client']
  const declared = Array.isArray(manifest?.dsh?.client?.inject) ? manifest.dsh.client.inject : []
  const external = Array.isArray(manifest?.dsh?.client?.external) ? manifest.dsh.client.external : []
  return new Set([...platform, ...preloaded, ...declared, ...external])
}

/** ------------------------------------------------------------------ A. package.json */

const manifest = await readJson(join(ROOT, 'package.json'), 'package.json parses')
if (manifest === undefined) {
  report()
  process.exit(1)
}

const patchRel = manifest?.dsh?.bundle?.patch
check(
  typeof patchRel === 'string' && patchRel.length > 0,
  'dsh.bundle.patch is declared',
  typeof patchRel === 'string' ? patchRel : 'missing — `dsh plugin add` would install this as a plain dependency, not a profile layer',
)
if (typeof patchRel === 'string') {
  const patchPath = join(ROOT, patchRel)
  check(existsSync(patchPath), 'bundle patch file exists on disk', patchRel)
  if (existsSync(patchPath)) {
    const body = await readFile(patchPath, 'utf8')
    check(
      /^\s*-\s*insert:/m.test(body),
      'bundle patch contains an `insert:` row',
      'a patch with no insert contributes no layer',
    )
    check(
      body.includes(String(manifest.name)),
      'bundle patch names this package',
      `expected to find "${manifest.name}" in ${patchRel}`,
    )
  }
}

check(
  manifest?.dsh?.client?.platform === 'web',
  'dsh.client.platform is "web"',
  String(manifest?.dsh?.client?.platform),
)
check(
  manifest?.exports?.['./client'] !== undefined,
  'exports["./client"] is declared',
  'the loader resolves the served bundle through this export',
)

/** ------------------------------------------------------------------ B. host half */

const hostPath = join(ROOT, 'lib/index.js')
if (!existsSync(hostPath)) {
  check(false, 'host bundle emitted', 'lib/index.js is missing — run the build first')
} else {
  const hostStat = await stat(hostPath)
  check(hostStat.size > 0, 'host bundle is non-empty', `${hostStat.size} bytes`)
  let host
  try {
    host = await import(pathToFileURL(hostPath).href)
    check(true, 'host bundle imports as ESM')
  } catch (error) {
    check(false, 'host bundle imports as ESM', error.message)
  }
  if (host !== undefined) {
    check(typeof host.name === 'string' && host.name.length > 0, 'host exports a non-empty `name`', String(host.name))
    check(typeof host.apply === 'function', 'host exports `apply` as a function', typeof host.apply)

    // `inject` is OPTIONAL by contract, so its absence is NOT a failure. Cordis
    // validates a plugin with `isApplicable`: `object && typeof apply ===
    // 'function'` — `apply` is the entire validity test. Its inject normalizer
    // documents `null`/`undefined` as inputs that "add nothing". Requiring the
    // export would fail a provably-correct bundle and force a redundant second
    // source of truth for what `ctx.inject([...])` inside `apply` already
    // declares. It is enforced only when present: if present it must be a clean
    // array of non-empty strings, because a malformed entry makes the Loader
    // resolve a service that cannot exist.
    if (host.inject === undefined) {
      check(true, 'host `inject` is optional and absent (valid — `apply` is the validity test)', 'not exported')
    } else if (!Array.isArray(host.inject)) {
      check(false, 'host `inject`, when present, is an array', `got ${typeof host.inject}`)
    } else {
      const bad = host.inject.filter((entry) => typeof entry !== 'string' || entry.length === 0)
      check(
        bad.length === 0,
        'host `inject` is an array of non-empty strings',
        bad.length === 0 ? `${host.inject.length} entr(y/ies)` : `malformed: ${JSON.stringify(bad)}`,
      )
    }
  }
}

/** ------------------------------------------------------------------ C. client half */

const clientPath = join(ROOT, 'client/client.js')
if (!existsSync(clientPath)) {
  check(false, 'client bundle emitted', 'client/client.js is missing — run the build first')
} else {
  const clientSource = await readFile(clientPath, 'utf8')
  const clientStat = await stat(clientPath)
  check(clientStat.size > 0, 'client bundle is non-empty', `${clientStat.size} bytes`)

  // C1. Exactly one ModuleLoader handoff, and it is the first statement.
  const loadMatches = clientSource.match(/window\.__ModuleLoader__\.load\(/g) ?? []
  check(
    loadMatches.length === 1,
    'exactly one __ModuleLoader__.load call',
    `found ${loadMatches.length}`,
  )
  check(
    clientSource.startsWith('window.__ModuleLoader__.load({'),
    'bundle STARTS with the ModuleLoader wrapper',
    `first 60 chars: ${JSON.stringify(clientSource.slice(0, 60))}`,
  )

  // C2. Parse the wrapper's id and prove it matches the package name. The loader
  // keys factories by this id and throws on an unregistered bundle, so a wrong
  // id is a silent boot failure.
  const headerMatch = clientSource.match(
    /^window\.__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")\s*,\s*factory:\s*\(require\)\s*=>\s*\{/,
  )
  if (headerMatch === null) {
    check(false, 'wrapper is `load({ id, factory: (require) => {`', `header: ${JSON.stringify(clientSource.slice(0, 160))}`)
  } else {
    const declaredId = JSON.parse(headerMatch[1])
    check(true, 'wrapper parses as load({ id, factory: (require) => {', `id=${JSON.stringify(declaredId)}`)
    check(
      stripClientSuffix(declaredId) === manifest.name,
      'bundle id matches package name (after stripClientSuffix)',
      `id=${JSON.stringify(declaredId)} package=${JSON.stringify(manifest.name)}`,
    )
  }

  // C3. The footer must close the factory by returning module.exports; a factory
  // that returns undefined makes every require() of this plugin yield nothing.
  // A trailing `//# sourceMappingURL=` comment legitimately follows the footer,
  // so the footer is matched as the last code line rather than the last byte.
  const codeWithoutMapComment = clientSource.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '')
  check(
    /return module\.exports;?\s*\}\s*\}\);?\s*$/.test(codeWithoutMapComment),
    'bundle closes with `return module.exports; } });`',
    `tail: ${JSON.stringify(codeWithoutMapComment.slice(-60))}`,
  )

  // C4. Evaluate the factory for real. Byte offsets are used to slice the exact
  // factory body, so this cannot be fooled by a same-looking string literal.
  if (headerMatch !== null) {
    const bodyStart = headerMatch[0].length
    const footerMatch = codeWithoutMapComment.match(/return module\.exports;?\s*\}\s*\}\);?\s*$/)
    const bodyEnd = footerMatch === null
      ? codeWithoutMapComment.length
      : codeWithoutMapComment.length - footerMatch[0].length
    // Specifiers the module table can answer, computed once for C5 and C6.
    const answerable = answerableSpecifiers(manifest)
    let factory
    try {
      factory = new Function('require', `${codeWithoutMapComment.slice(bodyStart, bodyEnd)}\nreturn module.exports;`)
      check(true, 'factory body compiles as a function')
    } catch (error) {
      check(false, 'factory body compiles as a function', error.message)
    }

    if (factory !== undefined) {
      // C5. Execute against a recording require that throws on unknown
      // specifiers — exactly the loader's behaviour for an unanswered row. This
      // catches both an unanswerable require() and a factory that throws at boot.
      let factoryExports
      try {
        factoryExports = factory((specifier) => {
          if (!answerable.has(specifier) && !answerable.has(stripClientSuffix(specifier))) {
            throw new Error(`loader module table cannot answer "${specifier}"`)
          }
          // A structural stand-in: empty namespace, enough for the factory to
          // finish its top-level wiring without a real DOM.
          return new Proxy({}, {
            get: (target, key) => (key === '__esModule' ? true : key === 'default' ? {} : () => undefined),
            has: () => true,
          })
        })
        check(true, 'factory executes without throwing')
      } catch (error) {
        check(false, 'factory executes without throwing', error.message)
      }
      check(
        factoryExports !== null && typeof factoryExports === 'object',
        'factory returns module.exports (an object)',
        typeof factoryExports,
      )
    }

    // C6. Every top-level require() must be answerable by the module table.
    // Static scan in addition to C5, because a require() on a dead branch never
    // runs but still ships a broken edge.
    const requireCalls = [...clientSource.matchAll(/\brequire\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)].map((m) => JSON.parse(m[1]))
    const unanswerable = [...new Set(requireCalls)].filter(
      (specifier) => !answerable.has(specifier) && !answerable.has(stripClientSuffix(specifier)),
    )
    check(
      unanswerable.length === 0,
      'every require() specifier is answerable by the browser module table',
      unanswerable.length === 0
        ? `${new Set(requireCalls).size} distinct specifier(s): ${[...new Set(requireCalls)].join(', ') || '(none)'}`
        : `UNANSWERABLE: ${unanswerable.join(', ')}`,
    )
    // A relative or absolute-path require in a browser bundle is always wrong:
    // the loader is not a filesystem resolver.
    const pathRequires = requireCalls.filter((specifier) => specifier.startsWith('.') || specifier.startsWith('/'))
    check(
      pathRequires.length === 0,
      'no relative/path require() survived bundling',
      pathRequires.length === 0 ? '' : `found: ${[...new Set(pathRequires)].join(', ')}`,
    )
  }

  // C7. No stylesheet may survive as an import/require: the browser has no .css
  // resolver, so a leaked sheet is a guaranteed runtime failure. The CSS is
  // supposed to be inlined as a string by the build's lightningcss loaders.
  const leakedCss = [
    ...clientSource.matchAll(/require\(\s*("(?:[^"\\]|\\.)*\.css(?:\?inline)?")\s*\)/g),
    ...clientSource.matchAll(/^\s*import\s+[^;]*?\.css(?:\?inline)?["']/gm),
  ].map((m) => m[1] ?? m[0].trim())
  check(
    leakedCss.length === 0,
    'no .css import/require leaked into the bundle',
    leakedCss.length === 0 ? '' : `found: ${leakedCss.join(', ')}`,
  )

  // C8. Sourcemap, when present, must be a real map with sources; a stale or
  // truncated map silently breaks browser frame attribution.
  const mapPath = `${clientPath}.map`
  if (existsSync(mapPath)) {
    const map = await readJson(mapPath, 'client sourcemap parses')
    if (map !== undefined) {
      check(
        Array.isArray(map.sources) && map.sources.length > 0,
        'client sourcemap lists sources',
        `${Array.isArray(map.sources) ? map.sources.length : 0} source(s)`,
      )
      check(
        typeof map.mappings === 'string' && map.mappings.length > 0,
        'client sourcemap has mappings',
      )
    }
    check(
      /sourceMappingURL=client\.js\.map/.test(clientSource),
      'client bundle references its sourcemap',
      'the browser only fetches the map when this comment is present',
    )
  } else {
    check(false, 'client sourcemap emitted', 'client/client.js.map is missing')
  }

  // C9. The bundle must NOT be an ESM module: the loader parses it as a classic
  // script. A surviving top-level `export`/`import` is a syntax error in that
  // context.
  const topLevelEsm = /^\s*(?:export\s|import\s)/m.test(clientSource)
  check(!topLevelEsm, 'bundle contains no top-level ESM syntax', topLevelEsm ? 'found top-level export/import' : '')
}

/** ------------------------------------------------------------------ D. publish payload */

const requiredShip = ['cordis.patch.yml', 'LICENSE']
const files = Array.isArray(manifest?.files) ? manifest.files : []
check(files.length > 0, 'package.json `files` is non-empty', JSON.stringify(files))
for (const entry of requiredShip) {
  check(files.includes(entry), `\`files\` ships ${entry}`, files.includes(entry) ? '' : 'missing from `files`')
}
// `package.json` is NOT required in `files`: npm always includes it (verified
// with `npm pack --dry-run` — a manifest with `files: ["lib","LICENSE"]` still
// packed package.json). Asserting otherwise would fail a correct package.
// What matters is that the loader can READ it at install time, which the
// exports/dsh checks above already exercise.
check(true, 'package.json ships automatically (npm always includes the manifest)')
// The two build outputs are gitignored, so this is the only guard that they
// actually reach the tarball. Without them an install is a no-op.
check(files.includes('lib'), '`files` ships the host build output (lib)', 'gitignored, so `files` is the only thing that publishes it')
check(files.includes('client'), '`files` ships the client build output (client)', 'gitignored, so `files` is the only thing that publishes it')

/** ------------------------------------------------------------------ report */

function report() {
  const line = '-'.repeat(72)
  process.stdout.write(`\n${line}\nDSH plugin package verification — ${manifest?.name ?? 'unknown'}@${manifest?.version ?? '?'}\n${line}\n`)
  for (const entry of checks) process.stdout.write(`  PASS  ${entry}\n`)
  for (const entry of failures) process.stdout.write(`  FAIL  ${entry}\n`)
  process.stdout.write(`${line}\n${checks.length} passed, ${failures.length} failed\n\n`)
  if (failures.length > 0) {
    process.stdout.write('verify-package: FAILED — this package must not be published or installed.\n')
    process.stdout.write('A DSH profile would fail to activate it. Fix the build and re-run.\n\n')
  } else {
    process.stdout.write('verify-package: OK — host + client halves are installable by a DSH profile.\n\n')
  }
}

report()
process.exit(failures.length === 0 ? 0 : 1)
