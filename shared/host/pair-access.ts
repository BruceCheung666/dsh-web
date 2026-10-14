/**
 * Pairing trust fence shared by plugins that expose host routes: loopback
 * (the desktop) always passes; a live paired-device cookie from remote-web-ui
 * and a request the host's own gate admits (an explicitly trusted non-loopback
 * authority plus a logged-in browser) are additional allow paths. The consuming
 * plugin never depends on those providers — without them the fence stays
 * loopback-only.
 *
 * Per-package wrappers (access.ts) call this with their own name so each
 * plugin keeps a self-describing export; the security decision lives only
 * here.
 */
import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest } from './loopback.ts'

/** Structural pairing lookup (no package dependency on remote-web-ui). */
interface PairingAccess {
  isPairedDevice(request: IncomingMessage): boolean
}

/**
 * Structural host gate (no package dependency on dsh-client-connection): the
 * host's own Host/Origin fence plus browser login, published as
 * `connection.requestRejection`. It answers 403 for an authority the host does
 * not trust, 401 for a browser that is not logged in, and undefined only when
 * the host itself would admit the request.
 */
interface HostGate {
  requestRejection?(request: IncomingMessage): number | undefined
}

/**
 * Structural host-context shape: shared sources carry no @deepseek-ai
 * dependency (the shared package must typecheck standalone), so the fence
 * reads only the two members it needs; cordis Context satisfies this.
 * ctx.get is optional on the test harness; production Context always has it.
 */
interface LookupCtx {
  get?(name: string, strict?: boolean): unknown
  remoteWebUiPairing?: PairingAccess
}

/**
 * Whether this request may enter the plugin's host routes.
 * @param ctx - host context; may expose remoteWebUiPairing and connection.
 * @param request - the incoming HTTP request.
 * @returns true for loopback, a live paired-device cookie, or a request the
 * host's own gate admits.
 */
export function isPairedOrLoopbackAllowed(ctx: LookupCtx, request: IncomingMessage): boolean {
  if (isLoopbackRequest(request)) return true
  const fromGet = typeof ctx.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  // The direct property is the bare-harness fallback only. A real cordis context
  // exposes ctx.get and throws on a property it never injected, and
  // dsh-host-webserver turns that throw into a bare 400 with an empty body
  // before this route can answer its designed 403.
  const direct = typeof ctx.get === 'function' ? undefined : ctx.remoteWebUiPairing
  const pairing = isPairingAccess(fromGet) ? fromGet : (isPairingAccess(direct) ? direct : undefined)
  if (pairing?.isPairedDevice(request) === true) return true
  return admitsHostGatedRequest(ctx, request)
}

/**
 * Whether the host's own gate admits this request: the same Host/Origin fence
 * and browser login the host's /api runs, so an explicitly trusted non-loopback
 * authority (an ingress or tunnel declared in trustedHosts / --trusted-host)
 * reaches these routes while unpaired and unauthenticated clients stay refused.
 * Mirrors dsh-market, which reads connection.requestRejection per request
 * because that service is constructed after async init.
 * @param ctx - host context.
 * @param request - the incoming HTTP request.
 * @returns true when the host gate admits the request.
 */
function admitsHostGatedRequest(ctx: LookupCtx, request: IncomingMessage): boolean {
  if (typeof ctx.get !== 'function') return false
  const connection = ctx.get('connection')
  if (connection === undefined || connection === null) return false
  const gate = (connection as HostGate).requestRejection
  return typeof gate === 'function' && gate.call(connection, request) === undefined
}

function isPairingAccess(value: unknown): value is PairingAccess {
  return value !== undefined
    && value !== null
    && typeof (value as PairingAccess).isPairedDevice === 'function'
}
