# dsh-market

English | [中文](README.zh.md)

**Update and restart controls for DeepSeek Harness, in the row you already look at.**

Two buttons in the sidebar's top row — one checks every installed plugin for updates and installs them all in a click, one restarts DSH.

## What you get

- **One-click update check** — on load and on demand, every installed plugin in your DSH profile is compared against its real source of truth: the npm `latest` dist-tag for registry installs, the remote HEAD commit for git installs. A badge on the button shows how many are behind.
- **Update all, with live progress** — one click installs every updatable plugin. Each package reports its own state (pending / running / done / failed), and one failing package does not abort the rest: you get a per-package report rather than a single opaque error.
- **Honest about what it checked** — the button distinguishes "nothing to update" from "nothing was examined". A scan that could not run says so instead of quietly reporting you are up to date.
- **Restart DSH in place** — for terminal-launched `dsh web`, one click re-executes the exact invocation that booted your host and brings it back, reloading the page when the new process answers.
- **Knows when it must not restart itself** — under a process supervisor or the Electron desktop shell, restart is owned by something else. The button disables itself and says who owns it, rather than killing a process it cannot bring back.
- **No dependencies on other plugins.** The whole thing is self-contained: it reads your profile and drives your package manager itself.

## Install

```sh
dsh plugin --profile web add dsh-market
```

Restart `dsh web`, then reload the page. The two buttons appear in the top row of the sidebar.

<!-- INSTALL-TAIL -->

## Requirements

- DSH with the web UI, `0.2.0-rc.2` or newer.
- Node.js `^22.19.0 || >=24.0.0` for the host process (the version DSH itself requires).

## How it works

`dsh-market` is one package with two halves, the way every DSH plugin is:

**The host half** mounts into the DSH host process and serves a small JSON API under `/dsh-market/api/*`. It reads the active profile — its `package.json`, its `dsh.profile.bundles`, and its installed `node_modules` — to work out what is installed and at which version. Update detection is a pure comparison against the package's own upstream: the npm registry's `latest` dist-tag, or a git remote's advertised HEAD. Applying an update runs your profile's own package manager against the profile directory, then verifies the version on disk actually changed, because a package manager that exits 0 without changing anything is exactly the failure a naive updater reports as success.

**The browser half** registers into the frame's floating layer and draws the two buttons over the sidebar's top row, which the official sidebar owns exclusively and offers no slot for. The overlay is click-through apart from the buttons themselves, and it follows the sidebar's collapsed and expanded states.

Both buttons degrade to a disabled state with an explanation when the host cannot do the thing — never an enabled button that silently fails.

## Security

- The API is same-origin and loopback-only, and rejects requests carrying forwarding headers. It sits behind DSH's own browser session gate.
- Only packages already listed in your DSH profile are considered; the updater never installs anything new.
- Updates run your profile's package manager with your profile's own settings, so pnpm's build-script policy is unaffected and unchanged.

## Known limitations

- **Restart is unavailable under a supervisor or the desktop app.** This is deliberate: the process cannot reliably bring its own replacement up when something else owns the lifecycle. The button says so and names the owner.
- **Update check requires network access** to the npm registry (or the git remote, for git installs). Behind a restricted network the check reports failure rather than a false "up to date".
- **Only forward updates are offered.** A package whose channel points backwards — a prerelease pin that moved to stable — is reported but never auto-applied.

## HTTP contract

The browser half talks to the host half over a small same-origin JSON API under `/dsh-market/api/*`. It is not a public API and is versioned with the package.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ping` | Liveness plus a `bootId` that changes every process start |
| `GET` | `/api/capabilities` | Which features work here, and who owns restart |
| `GET` | `/api/updates/summary` | Which installed plugins are behind (`?force=1` skips the cache) |
| `POST` | `/api/updates` | Update one package |
| `POST` | `/api/updates/all` | Update every updatable package |
| `GET` | `/api/operations?id=` | Per-package progress for one operation |
| `POST` | `/api/restart` | Restart the host process, when it owns its own lifecycle |

Reads are loopback-only and same-origin; mutations additionally require a matching `Origin`. `checked` in the summary is the denominator and is the real number of plugins examined — a failed scan is an error, never `checked: 0`.

**Known wart:** in a `409` refusal body, `error` carries the user-facing sentence and `reason` carries a machine token (for example `desktop-host`). The names read backwards. This mirrors the host's internal `restartCapability` shape, where the field *named* `reason` is the user-facing string; the route remaps it into `error`. It is internally consistent, so it is documented rather than renamed. Clients must read `error` for display.

## Development

```sh
npm install
npm run build      # tsc + tsdown -> lib/ and client/
npm run verify     # asserts both emitted artifacts are loadable
npm test           # vitest
npm run check      # all of the above
```

See [docs/INSTALL.md](docs/INSTALL.md) for installing a local build into a profile.

## License

MIT
