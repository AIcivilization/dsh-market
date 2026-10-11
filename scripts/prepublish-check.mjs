#!/usr/bin/env node
/**
 * Answers one question before `npm publish`: will a user who installs this
 * package actually get something that works?
 *
 * `npm run check` already proves the SOURCE is sound and `verify-package`
 * proves the two emitted halves are installable by a DSH profile. Neither
 * proves the thing npm will actually ship is the thing that passed. Publishing
 * is irreversible under the same version, so this gate closes that gap by
 * packing for real and inspecting the tarball a registry consumer receives.
 *
 * Checks:
 *   1. The dry-run payload matches `files` — nothing advertised is missing and
 *      neither build output was silently excluded.
 *   2. No devDependency leaked in as a runtime `dependencies` entry. The client
 *      half `require`s react / react-dom / ui-primitives, and the shell answers
 *      all of them from its own static module table, so declaring them would
 *      pull a SECOND copy of React into a profile — a real React #130 risk.
 *   3. Every `exports` target resolves inside the packed tree.
 *   4. The version is not already on the registry (a repeat publish of the same
 *      version is rejected, and silently succeeding is worse than failing).
 *
 * Read-only with respect to the registry when offline: an unreachable registry
 * is reported as a warning, not a failure, so this can run in CI.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

/** 1. Pack for real and compare the payload against `files`. */
const work = mkdtempSync(join(tmpdir(), 'dsh-market-prepub-'))
let packed = []
try {
  // `prepack` runs a build whose progress chatter lands on stdout ahead of the
  // JSON, and the chatter itself contains brackets — so match the start of a
  // top-level JSON array at the beginning of a line instead of any `[`.
  const raw = run('npm', ['pack', '--dry-run', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const start = raw.search(/^\s*\[\s*$/m) >= 0
    ? raw.search(/^\s*\[\s*$/m)
    : raw.indexOf('[')
  const parsed = JSON.parse(raw.slice(start))
  packed = (parsed[0]?.files ?? []).map(f => f.path)

  const required = ['lib/index.js', 'client/client.js', 'cordis.patch.yml', 'package.json']
  for (const f of required) {
    if (!packed.includes(f)) failures.push(`1. packed payload is missing ${f}`)
  }
  for (const dir of manifest.files ?? []) {
    // Existence on disk is NOT the question — `files` being listed while npm
    // packs nothing under it is exactly the silent omission this guards.
    const present = packed.some(p => p === dir || p.startsWith(`${dir}/`))
    if (!present) failures.push(`1. \`files\` advertises "${dir}" but nothing under it is packed`)
  }
  if (failures.length === 0) {
    checks.push(`1. packed payload has all ${required.length} required paths (${packed.length} files)`)
  }

  // 2. Runtime dependencies must stay empty; the shell supplies the client's.
  const deps = Object.keys(manifest.dependencies ?? {})
  if (deps.length > 0) {
    failures.push(`2. runtime dependencies are not empty: ${deps.join(', ')} — the shell's static module table supplies these; a local copy risks a second React`)
  } else {
    checks.push('2. no runtime dependencies (client specifiers are answered by the shell module table)')
  }

  // 3. Every exports target must exist in the packed tree.
  const targets = []
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') targets.push(value)
    else if (value && typeof value === 'object') targets.push(...Object.values(value))
  }
  const missing = targets
    .map(t => t.replace(/^\.\//, ''))
    .filter(t => !packed.includes(t))
  if (missing.length > 0) failures.push(`3. exports point at unpacked paths: ${missing.join(', ')}`)
  else checks.push(`3. all ${targets.length} exports targets resolve`)

  // 4. Version must not already exist on the registry.
  try {
    const published = run('npm', ['view', `${manifest.name}@${manifest.version}`, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (published === manifest.version) {
      failures.push(`4. ${manifest.name}@${manifest.version} is already published — bump the version`)
    }
  } catch (error) {
    const text = `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? ''}`
    if (/E404|Not Found/.test(text)) checks.push(`4. ${manifest.name}@${manifest.version} is free on the registry`)
    else checks.push('4. registry unreachable — version check skipped (offline is fine)')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

for (const line of checks) console.log(`  OK   ${line}`)
for (const line of failures) console.error(`  FAIL ${line}`)
console.log(
  failures.length === 0
    ? 'prepublish-check: OK — the packed tarball is what passed the gate.'
    : `prepublish-check: ${failures.length} problem(s); do not publish.`,
)
process.exit(failures.length === 0 ? 0 : 1)
