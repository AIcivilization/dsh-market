/**
 * Standalone tsdown config: the two halves of an out-of-monorepo DSH plugin.
 *
 * This repository is NOT inside the deepseek-harness workspace, so it cannot
 * import `packages/client/tsdown.client.ts`. This file reproduces that preset's
 * artifact contracts on its own. The contracts are:
 *
 * 1. HOST HALF (`lib/`): ESM, platform node, target es2024, `dts: false`. tsc
 *    owns the type half (`lib/types/**`), so the bundle must not emit .d.ts. The
 *    plugin's runtime dependencies are inlined; bare imports that a real install
 *    resolves stay imports.
 * 2. CLIENT HALF (`client/client.js`): a lazy-CJS closure factory wrapped in
 *    `window.__ModuleLoader__.load({ id, factory: (require) => { ... return
 *    module.exports } })`. It is served from `/plugins/<id>/client.js` and
 *    executed by a <script> tag, so it is `format: 'cjs'`, `platform: 'browser'`
 *    and reaches shared packages ONLY through the injected `require` — a
 *    require() the loader module table cannot answer is a guaranteed runtime
 *    throw, so anything not in the table MUST be inlined.
 * 3. CSS: `*.module.css` compiles to a hashed class map plus a tagged <style>
 *    injection, `*.css?inline` exports compiled text, plain `*.css` injects
 *    globally. All three are inlined into the factory; none may survive as an
 *    external import, because the browser cannot resolve a bare .css request.
 *
 * The id stamped into the handoff and the <style> tags must equal the package
 * name minus a trailing `/client` — the loader calls `stripClientSuffix` on it
 * and matches the row it serves.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Plugin id. Must match `package.json` `name` (the loader strips a `/client` suffix). */
const PLUGIN_ID = 'dsh-market'

/**
 * Module-table specifiers the browser shell shares into its frozen seed table.
 * Mirrors `@deepseek-ai/dsh-client-web`'s PLATFORM_MODULES plus the parser-preloaded
 * dynamic external. These stay `require(...)` calls in the emitted factory.
 */
const PLATFORM_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Client-bundle specifiers whose factories the HTML parser preloads before the shell starts. */
const PRELOADED_CLIENT_EXTERNALS: readonly string[] = [
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Package-specific module-table requests, mirroring `package.json`
 * `dsh.client.inject` / `dsh.client.external`. Adding a specifier here is a
 * promise that the loader table can answer it; if it cannot, the factory throws
 * at boot. Kept intentionally minimal — every entry is a runtime edge.
 */
const REQUESTED_EXTERNALS: readonly string[] = [
  // Locale service: consulted for zh/en copy. Inlining it would duplicate the
  // dictionary singleton and break live language switching.
  '@deepseek-ai/dsh-client-locale',
  // Theme store, owned by the theme plugin's browser half. Not in
  // PLATFORM_MODULES, so it is reachable only because `dsh.client.inject`
  // declares its plugin row. Inlining would fork the theme singleton.
  '@deepseek-ai/dsh-client-ui-theme',
]

const CLIENT_EXTERNALS: ReadonlySet<string> = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...REQUESTED_EXTERNALS,
])

/**
 * CSS Modules virtual-id prefixes. The suffix matters: tsdown's own CSS guard
 * matches ids ending in `.css`, so the virtual id must not, or tsdown claims the
 * module before this plugin's loader can.
 */
const CSS_MODULE_PREFIX = '\0dsh-css-module:'
const CSS_GLOBAL_PREFIX = '\0dsh-css-global:'
const CSS_INLINE_PREFIX = '\0dsh-css-inline:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/**
 * Resolve an asset request against the real file on disk.
 * @param source - import specifier as written in the source.
 * @param importer - absolute path of the importing module, if any.
 * @returns absolute path of the stylesheet.
 */
function stylesheetPath(source: string, importer: string | undefined): string {
  const clean = source.endsWith(INLINE_CSS_QUERY) ? source.slice(0, -INLINE_CSS_QUERY.length) : source
  return importer === undefined ? resolvePath(clean) : resolvePath(dirname(importer), clean)
}

/**
 * Emit the module that injects one stylesheet as a tagged <style> and optionally
 * exports its hashed class map. Injection is idempotent per tag id so a bundle
 * executed twice (HMR invalidate) does not duplicate style nodes.
 * @param fileId - absolute path of the stylesheet, used for the stable tag id.
 * @param css - compiled CSS text.
 * @param classMap - hashed class map for `.module.css`, omitted for global sheets.
 * @returns module source text.
 */
function styleInjectionModule(
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const tagId = `${PLUGIN_ID}/${basename(fileId)}`
  const lines = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ]
  return lines.join('\n')
}

/** Host-half bundle: the node artifact the profile Loader imports. */
const hostConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // tsc emits lib/types/**; a second declaration pipeline here would produce a
  // conflicting .d.ts layout for the same sources.
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    // Only the plugin's declared peer/production runtime edges stay imports.
    // Everything else (its own src tree) is inlined into the single bundle.
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
    alwaysBundle: (specifier: string) => !specifier.startsWith('node:') && !specifier.startsWith('@deepseek-ai/'),
  },
}

/** Client-half bundle: the ModuleLoader closure factory served to the browser. */
const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  // `clean` must stay off: the host half already wrote lib/ and an empty outDir
  // sweep here would race the tsc type output.
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    // Anything the loader table cannot answer must inline. A surviving require()
    // of an unanswerable specifier is a guaranteed runtime throw.
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
  },
  // Browser bundles inline deps that probe node-idiom environment globals
  // (process.env.NODE_ENV, import.meta.env). CJS output cannot carry a real
  // import.meta, so both must be substituted or the factory throws at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      // Bundle purity gate: the module table is the only legitimate cross-plugin
      // edge. A value import of anything else cannot be inlined safely (duplicate
      // singleton) and cannot be required (no table row), so it is a build error.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.has(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the browser module table (PLATFORM_MODULES + `
          + `PRELOADED_CLIENT_EXTERNALS) and not in this plugin's requests (${REQUESTED_EXTERNALS.join(', ')}). `
          + 'Cross-plugin value imports are forbidden: request a module-table row or collaborate through cordis '
          + 'services. Type-only imports are erased and never reach this gate.',
        )
      },
    },
    {
      // CSS Modules: hashed class map + tagged <style> injection.
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        return CSS_MODULE_PREFIX + stylesheetPath(source, importer) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_MODULE_PREFIX)) return null
        const fileId = virtualId.slice(CSS_MODULE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // Register the real sheet as a watch dependency; the virtual id hides it.
        this.addWatchFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: await readFile(fileId),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          classMap[local] = exp.name
        }
        return styleInjectionModule(fileId, code.toString(), classMap)
      },
    },
    {
      // `x.css?inline`: compiled text, injected by a plugin-owned lifecycle effect.
      name: 'dsh-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        return CSS_INLINE_PREFIX + stylesheetPath(source, importer) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_INLINE_PREFIX)) return null
        const fileId = virtualId.slice(CSS_INLINE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const { code } = transform({ filename: fileId, code: await readFile(fileId), minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    },
    {
      // Plain `x.css`: global injection at factory execution.
      name: 'dsh-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        return CSS_GLOBAL_PREFIX + stylesheetPath(source, importer) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_GLOBAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_GLOBAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const { code } = transform({ filename: fileId, code: await readFile(fileId), minify: true })
        return styleInjectionModule(fileId, code.toString())
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [hostConfig, clientConfig]
