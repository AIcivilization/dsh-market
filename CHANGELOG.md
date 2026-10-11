# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
