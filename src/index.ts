/**
 * dsh-market host entry: adds two buttons' worth of host capability to the
 * DSH web UI — check and apply updates for the plugins in the active profile,
 * and restart the dsh process.
 *
 * Mounting follows the DSH plugin contract: wait for `webServer` (the browser
 * carrier) and `loader` (the service store), then register routes inside an
 * effect so unloading the plugin removes them.
 *
 * The profile is taken from the launcher's `profileContext` service, read
 * through the GLOBAL service store rather than the context property proxy: it
 * is an optional host value, and reading it as a property would make it a
 * declared requirement this plugin cannot satisfy on a host that does not
 * publish one.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRoutes, ROUTE_PREFIX, type HostRoute } from './host/routes.js'
import { resolveProfile, type ProfileContextLike } from './host/profile.js'
import { buildCapabilities } from './host/capabilities.js'

/** The plugin name, as the loader reports it. */
export const name = 'dsh-market'

/** Optional configuration from `cordis.yml`. */
export interface Config {
  /** Point the update checks at a registry mirror. */
  readonly registry?: string
}

/** The structural subset of the host's web server service this needs. */
interface WebServerLike {
  register(route: HostRoute): () => void
}

/**
 * Mount the routes.
 *
 * The `webServer`/`loader` injection is what makes this plugin's activation
 * conditional: on a headless host with no browser carrier, there is nobody to
 * serve, and the plugin simply does not activate.
 */
export function apply(ctx: Context, config?: Config): void {
  if (config?.registry !== undefined && config.registry.trim() !== '') {
    process.env['DSH_MARKET_REGISTRY'] = config.registry.trim()
  }
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
    const profile = resolveProfile(profileContext)
    // The desktop shell publishes this service; its presence is the third
    // structural marker that the shell — not this plugin — owns restart.
    const desktopService = ctx.get('desktopProfiles') !== undefined
    const routes = profile === null
      ? []
      : createRoutes({
        profileDir: profile.dir,
        profileName: profile.name,
        packageManager: profile.packageManager,
        startedBundles: profile.startedBundles,
        desktopService,
      })
    const webServer = hostCtx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    hostCtx.effect(() => {
      const disposers = routes.map(route => webServer.register(route))
      if (profile !== null) {
        const capability = buildCapabilities({ profile: profile.name, desktopService })
        console.info(
          `dsh-market: serving ${ROUTE_PREFIX}/api/* for profile "${profile.name}" (${profile.origin})`
          + ` — runtime ${capability.runtime}, restart ${capability.restart.supported ? 'available' : `unavailable (${capability.restart.managedBy})`}`,
        )
        if (!capability.restart.supported && capability.restart.reason !== undefined) {
          console.info(`dsh-market: ${capability.restart.reason}`)
        }
      } else {
        console.warn('dsh-market: no active profile could be resolved; the update endpoints are not mounted')
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-market: update and restart routes')
  })
}

/** The JSON documents this plugin serves, for documentation and tests. */
export const API = {
  ping: { method: 'GET', path: `${ROUTE_PREFIX}/api/ping` },
  capabilities: { method: 'GET', path: `${ROUTE_PREFIX}/api/capabilities` },
  updatesSummary: { method: 'GET', path: `${ROUTE_PREFIX}/api/updates/summary` },
  updates: { method: 'POST', path: `${ROUTE_PREFIX}/api/updates` },
  updatesAll: { method: 'POST', path: `${ROUTE_PREFIX}/api/updates/all` },
  operations: { method: 'GET', path: `${ROUTE_PREFIX}/api/operations` },
  restart: { method: 'POST', path: `${ROUTE_PREFIX}/api/restart` },
} as const

/** Re-exported for hosts that import the route table directly. */
export { createRoutes, ROUTE_PREFIX, buildCapabilities }
export type { HostRoute }
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
