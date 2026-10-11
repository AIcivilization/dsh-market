# Installing dsh-market

`dsh-market` is a **standalone** DSH plugin: it lives outside the
`deepseek-harness` workspace and ships prebuilt, so installing it needs no
monorepo checkout and no build step on the target machine.

## Requirements

- DeepSeek Harness (`dsh`) already installed and working.
- Node.js `^22.19.0 || >=24.0.0`.
- `pnpm` on `PATH` — `dsh plugin` is a thin pnpm forwarder for the profile's
  dependency directory. Without pnpm it exits with
  `pnpm not found on PATH — install pnpm to manage profile plugins`.

## Which profile can I install into?

This matters, so it comes first. `dsh plugin` **refuses the `desktop` profile**:

```
$ dsh plugin --profile desktop add dsh-market
error: profile "desktop" is managed exclusively by the Electron application
```

That guard is hardcoded by profile *name* (`rejectElectronProfile` in the `dsh`
launcher), not by mode — it fires for every `dsh plugin` subcommand. The DSH
Desktop app owns its own profile's dependency lifecycle, and it does not expose a
renderer-reachable install channel, so a plugin cannot install itself into a
running desktop profile either.

So there are two supported install paths:

| Target | Path |
| --- | --- |
| A CLI-managed profile (`web`, `tui`, or your own) | `dsh plugin --profile <name> add dsh-market` — the normal path below |
| The DSH Desktop app's `desktop` profile | `pnpm` directly in the profile, then add the bundle layer by hand — see [Desktop profile](#desktop-profile) |

## Install into a CLI-managed profile

Pick the profile you want the plugin active in:

```bash
dsh plugin --profile desktop add dsh-market
```

From a checkout instead of the registry — note the spec must resolve relative to
the *profile directory*, not your shell, so use an absolute path or a
`file:`/`link:` spec:

```bash
dsh plugin --profile desktop add "file:/absolute/path/to/dsh-market"
```

### What happens next

`dsh plugin --profile <p> add <spec>` does three things:

1. **Initializes the profile on first use.** If the profile directory does not
   exist yet, it is created from the profile template.
2. **Forwards to pnpm** with `cwd` = the profile directory, so `<spec>` is
   installed as a profile dependency.
3. **Reconciles `dsh.profile.bundles`.** For each installed dependency it
   resolves the package manifest and, if that manifest declares
   `dsh.bundle.patch`, appends the package name to the profile's bundle layer
   list. That declaration is what turns a plain dependency into an active
   profile layer:

   ```json
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   ```

   A dependency with no `dsh.bundle` is installed but stays inert, and dsh warns:
   `warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`.

Because reconciliation is driven by the **installed** manifest, the true package
name is what lands in the layer list — a git, tarball, alias, or path spec all
reconcile to `dsh-market`.

### Restart to activate

Bundle layers are composed when a profile boots, so the plugin is not live in the
already-running process:

```bash
dsh --profile desktop
```

After restart the sidebar's top row shows the two controls, **更新** and
**重启 DSH**. The host half logs its mounted route prefix on boot:

```
dsh-market: serving /dsh-market/api/* for profile "desktop" (launcher profileContext) — runtime web, restart available
```

If it ends in `restart unavailable (desktop-host)` instead, the plugin loaded
correctly but something else owns the process lifecycle. The restart button then
renders **disabled** with the host's explanation in its tooltip — that is the
intended degradation, not a failure. The line below it repeats the reason in
full so the host log alone tells you what to do.

## Verify the install

Confirm the package resolves to a bundle-declaring manifest:

```bash
node -e "console.log(require.resolve('dsh-market/package.json', { paths: ['<profile-dir>'] }))"
```

and that the profile layer list contains `dsh-market`:

```bash
node -e "console.log(JSON.stringify(require('<profile-dir>/package.json').dsh.profile.bundles, null, 2))"
```

The browser half is served at `/plugins/dsh-market/client.js` — the id in
`window.__ModuleLoader__.load({ id: ... })` must be exactly `dsh-market`, since
the loader keys the factory by that id and throws
`bundle <url> loaded without registering "dsh-market" via __ModuleLoader__.load`
on a mismatch.

## Update

```bash
dsh plugin --profile desktop update dsh-market
```

Then update the profile layer list the same way `add` does — re-running `add`
performs the full install + reconcile cycle and is the simplest correct update:

```bash
dsh plugin --profile desktop add dsh-market
```

## Desktop profile

Because `dsh plugin` refuses `desktop`, install with the app's own bundled pnpm
and register the layer yourself. This is the exact sequence verified on macOS
with DSH Desktop `0.2.0-rc.2`; the paths are the ones the app itself uses.

```bash
export DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs"
PROFILE="$HOME/.dsh/profiles/desktop"

cd "$PROFILE" && "$NODE" "$PNPM" add -w "file:/absolute/path/to/dsh-market-0.1.0.tgz"
```

`DSH_DESKTOP_NODE_EXECUTABLE` is required: the runtime's `bin/node` is a wrapper
that execs it with `ELECTRON_RUN_AS_NODE=1`, and without the variable it fails
with `exec: : not found`. The `-w` flag is required because the desktop profile
is a pnpm workspace root.

Then add the layer. `dsh plugin` does this for you; here it is manual:

```bash
node -e '
  const fs = require("fs");
  const file = process.env.HOME + "/.dsh/profiles/desktop/package.json";
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  const b = p.dsh.profile.bundles;
  if (!b.includes("dsh-market")) b.push("dsh-market");
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
'
```

Prefer a stable tarball path over `/tmp`: the profile records the literal
`file:` spec, so a tarball in a directory that gets cleaned up leaves a
dependency that cannot be reinstalled. If you keep one inside a checkout, note
that `.pack/` is gitignored for exactly this purpose.

Restart the **application** to activate (see below).

### Restarting DSH Desktop

Bundle layers are composed at boot, so the plugin is inert in the running
process. Under DSH Desktop you cannot do this from a terminal:

- The `desktop` profile is locked to the app (above).
- Killing the host child process does **not** work — the Electron parent owns and
  supervises it, and the browser session is bound to a secret minted per
  activation and held in memory, so a session does not survive a bare host
  restart either.

Use **重启应用与 Host / Restart App and Host** from the app's menu. This is also
exactly what the plugin's own restart button tells you to do in this
environment, which is why that button is disabled rather than failing.

## Uninstall

```bash
dsh plugin --profile <name> remove dsh-market
```

Removal is also reconciled: once the dependency is gone, `dsh-market` is dropped
from `dsh.profile.bundles`. In-box template bundles are never touched, so this
only ever affects dependency-managed layers like this one.

For the `desktop` profile, remove it the same way you installed it — with the
app's bundled pnpm (`"$NODE" "$PNPM" remove -w dsh-market`) — and drop
`"dsh-market"` from `dsh.profile.bundles` by hand.

Restart the profile to unload the running plugin instance.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pnpm not found on PATH` | pnpm missing | install pnpm, or run with `corepack enable` |
| `warning: ... declares no dsh.bundle` | the installed copy predates the bundle declaration | install a version that publishes `cordis.patch.yml` and declares it |
| Plugin loads, no buttons appear | bundle served but factory threw | open devtools; a bad module-table `require()` throws at boot |
| `loaded without registering "dsh-market"` | emitted bundle id ≠ package name | rebuild; `scripts/verify-package.mjs` catches this |
| `git-hosted plugins build on install` | pnpm ≥10 blocks `prepare` on git deps | approve the build, or install a prebuilt registry/tarball release |

## Publishing a release (maintainers)

The published artifacts are prebuilt. Before publishing, run the release gate —
it inspects the real emitted bytes and refuses to pass a malformed bundle:

```bash
pnpm install
pnpm run typecheck
pnpm run build
node scripts/verify-package.mjs
```

`lib/` and `client/` are gitignored but listed in `files`, so they are built
during `prepack` and still included in the npm tarball.
