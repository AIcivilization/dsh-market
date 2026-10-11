/**
 * HTTP helpers shared by every host route: JSON writing, the same-origin
 * fence, and a size-capped JSON body reader.
 *
 * The fence is deliberately strict, and strict in a specific direction: the
 * two buttons this plugin adds can rewrite a profile and kill the host
 * process, so a request that did not come from the page itself must not
 * reach them. DNS rebinding is the attack that motivates the `Host` check —
 * a page served from an attacker's domain can resolve that name to
 * 127.0.0.1, so the peer address proves nothing on its own.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Largest JSON body any route here accepts. The payloads are tiny. */
export const MAX_BODY_BYTES = 4096

/** Write a JSON payload with no-store caching. */
export function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(payload))
}

/** Answer a request whose method this route does not implement. */
export function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { allow, 'cache-control': 'no-store' })
  response.end()
}

/**
 * Whether a `Host` header names a loopback authority.
 *
 * `localhost` is included because browsers and RFC 6761 pin it to loopback;
 * a name like `localhost.evil.com` deliberately does not match. The port is
 * dropped before comparing, since a loopback listener may be on any port.
 */
export function loopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(']') + 1)
    : lower.split(':')[0]!
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Whether the transport peer is a loopback address. */
export function loopbackPeer(request: Pick<IncomingMessage, 'socket'>): boolean {
  const address = request.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Whether the request carries any trace of being forwarded.
 *
 * A loopback PEER is not enough on its own: behind a reverse proxy every
 * request arrives from 127.0.0.1 regardless of who the real caller is. The
 * forwarding headers are how a proxy announces itself, so their presence
 * disqualifies the request from reaching a process-control route.
 */
export function hasForwardingHeaders(request: Pick<IncomingMessage, 'headers'>): boolean {
  return request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined
    || request.headers['x-forwarded-host'] !== undefined
}

/**
 * The fence every route runs, reads included.
 *
 * A same-origin page always sends a `Host` that names the loopback authority
 * it connected to, so requiring that costs a legitimate caller nothing.
 * `sec-fetch-site: cross-site` is refused because the browser states when it
 * considers a request cross-site — cheap, and it covers a cross-site request
 * whose `Origin` happens to match.
 *
 * @returns true when the request may be answered.
 */
export function sameOriginRead(request: IncomingMessage): boolean {
  if (!loopbackPeer(request)) return false
  if (hasForwardingHeaders(request)) return false
  if (!loopbackAuthority(request.headers.host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // An absent Origin is not a cross-site request: browsers send it on every
  // POST, same-origin included, so its absence means the caller is not a page.
  // A PRESENT but unparseable Origin (`null` from a sandboxed iframe) is
  // refused — that is a different statement from the header being absent.
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * The fence for mutating routes — reads plus a mandatory, matching `Origin`.
 *
 * Stricter than {@link sameOriginRead} in exactly one way: the `Origin`
 * header must be present and must match `Host`. Every browser sends `Origin`
 * on a POST, so its absence means the caller is not the page this API is
 * for.
 */
export function sameOriginMutation(request: IncomingMessage): boolean {
  if (!sameOriginRead(request)) return false
  const origin = request.headers.origin
  if (origin === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === request.headers.host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, rejecting anything over `maxBytes`. */
export async function readJsonBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text) as unknown
}

/** Read a request body that the caller expects to be a JSON object. */
export async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}
