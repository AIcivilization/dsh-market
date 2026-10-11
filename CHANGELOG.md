# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `scripts/prepublish-check.mjs` and `npm run release`: a publish gate that packs
  for real and inspects the tarball a registry consumer receives — required paths
  present, `files` entries actually packed, every `exports` target resolvable, no
  runtime dependency that would duplicate what the shell already supplies, and the
  version still free on the registry. `npm run check` proves the source is sound;
  this proves the shipped artifact is.
- `.github/workflows/publish.yml`: tag-gated release workflow running the full
  gate and publishing with npm provenance. Manual dispatch defaults to a dry run.

### Fixed

- `runtime` and `restart.managedBy` could describe different hosts in the same
  `/api/capabilities` response. `runtime` keyed off `desktopService` while the
  restart verdict went through a multi-signal threshold, and one of those
  signals reads `ELECTRON_RUN_AS_NODE` — which is inherited from the app when a
  terminal inside DSH Desktop runs the suite. The verdict is now read back from
  a single value, so the two cannot disagree.
- Two route tests asserted a restart verdict while leaving the host identity to
  ambient detection, so they passed or failed depending on where they ran. The
  route deps accept host-identity inputs, and both tests pin them.
- Restart no longer leaves the app closed. The relaunch fired as soon as the port
  went quiet, but macOS holds the single-instance lock until the old process is
  gone, so the replacement started, failed `requestSingleInstanceLock()`, and quit
  itself — `open -n` exiting 0 while nothing appeared. The helper now waits for the
  dying process to exit before launching.
- Writes from the desktop app were refused with 403. The shell's protocol handler
  deletes `origin` before forwarding a page request to the loopback host, so every
  desktop mutation arrived without the header the same-origin guard demanded.
- The two buttons had no visible border: three referenced CSS custom properties
  (`--dsw-alias-border-primary`, `-secondary`, `-bg-elevated`) are not defined by
  any shell stylesheet and were silently resolving to nothing.

## [0.1.0] - 2026-10-10

### Added

- Two top-row sidebar buttons for DeepSeek Harness: **更新** (check for and apply
  plugin updates) and **重启 DSH** (restart the running DSH process).
- Host half (`lib/index.js`): profile plugin discovery, registry/version
  resolution, and the restart/update HTTP endpoints the browser half calls.
- Client half (`client/client.js`): a `window.__ModuleLoader__.load({ id, factory })`
  lazy-CJS bundle contributing the buttons to the sidebar's top row.
- Standalone build toolchain (`tsdown.config.ts`) reproducing the monorepo's
  `clientBundle` preset from outside the workspace: host bundle to `lib/`, browser
  bundle to `client/client.js`, with inlined CSS Modules, `?inline` stylesheets and
  global CSS injection.
- `cordis.patch.yml` bundle patch, so `dsh plugin --profile <p> add dsh-market`
  activates the plugin as a profile layer.
- `scripts/verify-package.mjs`: a release gate asserting the emitted client bundle
  is a valid ModuleLoader artifact and the host bundle exports `name`/`inject`/`apply`.
- `docs/INSTALL.md` documenting the reproducible install path.

[Unreleased]: https://github.com/AIcivilization/dsh-market/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AIcivilization/dsh-market/releases/tag/v0.1.0
