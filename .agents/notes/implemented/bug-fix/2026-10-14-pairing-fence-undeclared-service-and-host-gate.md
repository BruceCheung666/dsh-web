# Agent Note: pairing fence service lookup and host gate

Status: implemented

## Problem

Any non-loopback authority broke every gated family route: the skill center, git graph, and usage panels answered a bare `400` with an empty body, and the skill center rendered "Failed to load: HTTP 400" (the browser client maps a body that is not its error envelope to `HTTP <status>`). The authority is legitimate in these deployments — it is declared in the host's `trustedHosts` (`--trusted-host`), and the host's own `/api` serves the same browser normally.

Two independent defects produce that state. First, `isPairedOrLoopbackAllowed` fell through to the plain `ctx.remoteWebUiPairing` property read whenever `ctx.get` returned no service. A real cordis context exposes `ctx.get` and throws on a property it never injected ("cannot get property ... without inject"), so the throw escaped the route handler's `guard()` — before the handler's own `try`/`catch` — and `dsh-host-webserver` converts an unhandled route rejection into `res.writeHead(400); res.end()`. The designed refusal never reached the client, and the failure looked like a malformed request rather than a refused one. Upstream carries this as issue #1814 (with #1780 closed earlier as a form mistake); both are closed and no branch holds a fix.

Second, even with the throw removed the fence knew only loopback and the remote-web-ui paired-device cookie. An explicitly trusted non-loopback authority therefore got `403 forbidden: loopback-only` on every family route, while the host's `/api` gate admitted the same request — and no published package in this SDK cohort provides `remoteWebUiPairing`, so the pairing allow path cannot be exercised here at all.

## Decision

`shared/host/pair-access.ts` confines the direct property read to contexts that expose no `ctx.get` (the bare spec harness): a production context resolves `remoteWebUiPairing` only through `ctx.get('remoteWebUiPairing', false)`, which answers `undefined` instead of throwing.

The fence then falls back to the host's own gate, read per request as `ctx.get('connection')` and called as `connection.requestRejection(request)`. `undefined` means the host would admit this request — its Host/Origin fence passed and the browser is logged in — while `403` (untrusted authority) and `401` (logged-out browser) keep the refusal. This mirrors `dsh-market`, which reads the same service per request because `HostConnectionService` is constructed after async init. The plugin declares no dependency on the connection service: when it is absent the fence stays loopback-only.

Refusal semantics are unchanged: loopback passes, a live paired-device cookie passes, a harness context without `ctx.get` keeps its property fallback, and everything else is refused. The generated copies in `dsh-git-graph`, `dsh-skill-explorer`, and `dsh-usage` come from `node scripts/sync-shared.mjs`; the drift gate (`pnpm sync-shared:check`) holds them in step.

## Testing

- `shared/tests/pair-access.spec.ts` carries the canonical cases: the five pre-existing ones plus a context proxy that throws on undeclared property reads (the fence must not throw and must refuse), a gate that admits, a gate answering `403`, a gate answering `401`, and a connection service without a gate. Ten tests in the shared suite (98 total), plus the consumer suites: `dsh-skill-explorer` 176, `dsh-git-graph` 183, `dsh-usage` 173.
- `node scripts/sync-shared.mjs --check` reports every consumer copy in sync; the shared package typechecks standalone (`tsc --noEmit`).

## Alternatives considered

- Wrapping the property read in `try`/`catch`: preserves the harness fallback in one expression, but a real context then throws and swallows an Error on every non-loopback request of every gated route. Confining the read to contexts without `ctx.get` reaches the same behavior with no exception on the production path.
- Validating the `Host` header against the configured trusted authorities inside the plugin: duplicates the host's authority table in three packages and accepts a spoofed `Host` from anything that can reach the listener (this deployment binds `0.0.0.0`). `connection.requestRejection` additionally requires the browser's session cookie for that authority.
- A local reverse proxy that rewrites `Host` and `Origin` for the gated paths: needs no plugin change, but adds a component to run and supervise, replaces the loopback boundary with "whoever can reach the proxy", and leaves every other loopback-only family route broken.
- Waiting for an upstream fix: #1814 and #1780 are both closed and neither `main` nor `dev` carries a change to the fence, so the panel stays unusable behind a trusted non-loopback authority.

## Consequences

- A deployment reached through an authority declared in `trustedHosts` now serves the skill center, git graph, and usage routes to a logged-in browser, without pairing and without a proxy. The accepted risk is exactly the host gate's: the authority is trusted by configuration, and the browser must hold its session cookie.
- A LAN-exposed `dsh web` without that cookie still receives `401`/`403`; an untrusted authority still receives `403`.
- The fence's decision remains one shared source with generated, drift-checked copies; no consumer package changed its call sites or its own gate.
