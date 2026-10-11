# Host API — `dsh-market`

The host half mounts a small JSON API under `/dsh-market/api/*` on DSH's own
web server. It is served on the loopback address the browser already reached,
and every route is a same-origin, loopback-only endpoint.

## Mounting

The plugin exports `name` and `apply`. It waits for `webServer` and `loader`,
reads the active profile from the host's `profileContext` service, and
registers its routes inside an effect — so unloading the plugin removes them
again. There is no `inject` export: activation is genuinely conditional (a
headless host with no browser carrier has nobody to serve), and a static
`inject` would turn that into an unconditional requirement.

An `apply(ctx, { registry })` config value points the update checks at a
registry mirror; it is applied as `DSH_MARKET_REGISTRY`.

The route table is also importable directly, which is what an embedding host
should do:

```js
import { createRoutes } from 'dsh-market'

const routes = createRoutes({
  profileDir: '/Users/me/.dsh/profiles/desktop', // required
  profileName: 'desktop',                        // required
  packageManager: null,   // the launcher's published invocation, or null/omitted
  startedBundles: null,   // the launcher's started bundle list, or null
  desktopService: false,  // true when the desktop shell owns this process
})
for (const route of routes) webServer.register(route)
```

`packageManager`, `startedBundles` and `desktopService` may be omitted; the
profile is read from `profileDir` alone.

## Endpoints

All routes are registered `kind: 'exact'` and dispatched on pathname only, so a
query string never participates in matching.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-market/api/ping` | liveness, plus the boot id |
| `GET` | `/dsh-market/api/capabilities` | what this host can do |
| `GET` | `/dsh-market/api/updates/summary` | what is updatable (`?force=1` bypasses the cache) |
| `POST` | `/dsh-market/api/updates` | update one plugin |
| `POST` | `/dsh-market/api/updates/all` | update every updatable plugin |
| `GET` | `/dsh-market/api/operations` | progress of an update run (`?id=`) |
| `POST` | `/dsh-market/api/restart` | restart dsh |

### `GET /dsh-market/api/ping`

```json
{ "ok": true, "bootId": "3660-1758589920123", "uptimeMs": 41233 }
```

`bootId` is generated once per process start from the pid and start time. A
client can use "the boot id changed" as its restart-completed signal; it is
stable across requests within one process.

### `GET /dsh-market/api/capabilities`

```json
{
  "version": "0.1.0",
  "profile": "desktop",
  "runtime": "web",
  "features": { "check": true, "update": true, "restart": true, "progress": true },
  "restart": { "supported": true, "managedBy": "market" }
}
```

`runtime` is `web` or `desktop`. When restart is unavailable, `restart` carries
an actionable bilingual `reason` and `managedBy` names who owns it
(`desktop-host`, `supervisor` or `operator`).

### `GET /dsh-market/api/updates/summary`

```json
{
  "checked": 5,
  "updatable": 1,
  "checkFailed": 0,
  "packages": [
    { "name": "dsh-vpn", "source": "npm", "installedVersion": "0.1.6", "latestVersion": "0.1.7" }
  ],
  "skipped": [
    { "name": "dsh-model", "source": "npm", "installedVersion": "0.17.0", "latestVersion": "0.17.0", "reason": "up-to-date" }
  ]
}
```

- `checked` is the real number of installed plugins examined, **including ones
  already current**. It is the denominator: a client can distinguish "nothing to
  update" from "nothing was looked at".
- `checkFailed` is how many of those rows could not be queried at all — an
  unreachable registry, or a spec that cannot be resolved. **`checked` counts
  attempts, not successes**, so this field is the only way a client can tell
  "examined everything, nothing to install" from "the check could not run".
  Without it a network failure is indistinguishable from being up to date.
- `packages` lists only what can actually be updated.
- `skipped` is an extension listing everything else with a machine-readable
  `reason`: `up-to-date`, `check-failed`, `not-installed`, `local-source`,
  `not-a-plugin`, `unsupported-spec`, `no-version-known`.
- `source` is one of `npm`, `git`, `link`, `unknown`.
- A scan that cannot complete answers **non-2xx** with `{ "error": ... }`. It
  never answers `checked: 0`, which a client cannot tell apart from a healthy
  profile with nothing to update.

### `POST /dsh-market/api/updates` · `POST /dsh-market/api/updates/all`

Request body `{ "packageName": "dsh-vpn" }` for the single form; `{}` for
`/all`.

```
202 { "operationId": "op-1", "total": 1 }
```

- `409 { "error": ... }` when another operation is already running (updates are
  single-flight, so two runs cannot race over one profile).
- `400 { "error": ... }` for a name that is not an installed, updatable plugin,
  or when there is nothing to update.

### `GET /dsh-market/api/operations?id=<operationId>`

```json
{
  "operationId": "op-1",
  "state": "success",
  "startedAt": 1758589920123,
  "finishedAt": 1758589925123,
  "restartRequired": true,
  "packages": [
    { "name": "dsh-vpn", "from": "0.1.6", "to": "0.1.7", "state": "success" }
  ]
}
```

`state` is `running`, `success`, `partial` or `failed`; per-package `state` is
`pending`, `running`, `success`, `failed` or `skipped` (with `error`). An
unknown id answers `404`. `operationId` is accepted as an alias for `id`.
Finished operations are retained for the lifetime of the process.

### `POST /dsh-market/api/restart`

```
202 { "accepted": true }
```

```
409 { "error": "...", "reason": "desktop-host" }
```

`reason` is `desktop-host`, `supervisor`, `operator` (a debugger is attached),
or `update-in-progress`. On a plain web host the handler schedules a detached
helper that waits for the port to free, relaunches exactly the invocation that
booted this process, waits for the port to answer continuously for 8s, and only
then stops this process.

## Guard

Every route runs the same guard before doing anything:

- the peer `remoteAddress` must be loopback;
- `forwarded`, `x-forwarded-for`, `x-real-ip` and `x-forwarded-host` are
  rejected outright;
- the `Host` authority must be a loopback address (this is what stops a
  DNS-rebinding page from reaching the API through the user's own browser);
- reads are `GET`-only, mutations `POST`-only, and a mutation must additionally
  carry an `Origin` matching `Host`. A read has no `Origin` in a normal
  navigation, so requiring one there would break the read path rather than
  secure it.
- anything else answers `405` with an `Allow` header.

## Design notes

- The prefix is `/dsh-market`, deliberately **not** `/api/v1/*` — the installed
  `dshmarket` plugin owns that namespace, and colliding with it would route one
  product's request to the other's handler.
- The host half has **zero runtime dependencies**. It does not import the
  `dshmarket` plugin; semver comparison is implemented locally precisely
  because a DSH profile may have no packages of its own installed.
- Restart is gated on evidence, not a guess: the desktop verdict requires at
  least two independent signals to agree (argv path segment, a `DSH_DESKTOP_*`
  variable, `ELECTRON_RUN_AS_NODE`, an Electron parent process, or an
  application-bundle `execPath`), and reports which fired. A false negative here
  would kill the process under the desktop shell; a false positive would take
  the button away from every plain `dsh web` user.
- Update success is verified against disk, never taken from the package
  manager's exit code. A version that went backwards is `DOWNGRADE_DETECTED`, a
  version below the requested target is `RESOLVED_VERSION_MISMATCH`, and a
  version *above* target is accepted.

## Tests

`vitest run` covers the host half in `tests/host/`: version comparison, the
update-status decision (including the refusal to offer a downgrade), profile and
dependency reading, the update/verification engine, the guard and method rules,
and the query-string dispatch invariant. The desktop-detection fixtures are the
real argv, environment and parent command of a live `dsh-desktop-host` process.
