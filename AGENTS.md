# AGENTS.md

Generic guidance for AI agents working in this repository. (Claude Code reads this via `@AGENTS.md` from `CLAUDE.md`.)

## What this is

A lightweight OCPP WebSocket gateway (Node.js + TypeScript) that routes each charge point **by its (tenant, chargeBoxId)** (via a JSON routing table; the tenant comes from the dialled hostname) to its own bidirectional **primary CSMS** and any number of read-only **secondary** mirrors. Supports OCPP 1.6 and 2.0.1. Optionally archives every OCPP frame in MongoDB as Open OCPP Trace records (`TRACE_ENABLED`). Runtime dependencies: `ws`, and `mongodb` (loaded only when trace archiving is enabled).

This is a fork of [joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT); the fork's defining change is replacing the original's global `PRIMARY_CSMS_URL`/`SECONDARY_CSMS_URLS` env config with the per-chargeBoxId routing table. Preserve the MIT license and upstream attribution.

## Commands

The Node version is pinned in `mise.toml` (Node 24 LTS). With [mise](https://mise.jdx.dev) installed, run `mise install` once to get the right Node; CI and Docker use the same version.

```bash
npm run lint       # vp lint && vp fmt --check (Vite+: Oxlint + Oxfmt)
npm run format     # vp fmt --write && vp lint --fix (auto-fix)
npm run typecheck  # tsc --noEmit (Vite+ bundling strips types, so type-check separately)
npm run build      # vp pack → dist/index.cjs (Rolldown/tsdown bundle, ws external)
npm test           # vitest run (unit + integration)
npm run test:watch # vitest watch
npm start          # node dist/index.cjs (requires built dist/ + a routes file)
npm run dev        # vp pack --watch + node --watch dist/index.cjs

# Run locally
cp routes.example.json routes.json
ROUTES_FILE=./routes.json npm start
```

`npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` are the verification gates — run all after changes. Type safety comes from `npm run typecheck` (`tsc --noEmit` under `strict: true`), not from the bundle step. Tests live in `test/` (not part of the bundle, which only takes `src/index.ts` and its imports).

CI validates every PR and push to `main`:

- `.github/workflows/commitlint.yml` — lints commit messages against Conventional Commits (the CI counterpart to the local `commit-msg` hook, which `--no-verify` can bypass).
- `.github/workflows/docker.yml` — a `test` job (lint + typecheck + build + `npm test`, with a `mongo` service so the real-MongoDB trace tests run), a `cloudflare` job (`deploy/cloudflare`: `npm ci`, `npm run typecheck`, `npm run dry-run` — validates `wrangler.jsonc` and builds the container image, no credentials needed), a `cloudflare-smoke` job (runs the Worker + gateway container under `wrangler dev` with the runner's Docker and drives them with `deploy/cloudflare/test/smoke.test.ts`), and, only if all three pass, a `build` job publishing a multi-arch image to `ghcr.io/juherr/ocpp-gateway`. Image tags are **semver-pinned** (`flavor: latest=false` — never publish `latest`).

Both workflows install Node via `jdx/mise-action`, which reads the version from `mise.toml` — the single source of truth shared with local dev and the Docker images (Node 24, the current LTS). GitHub Actions are pinned to commit SHAs with a `# vX.Y.Z` comment; Dependabot (`.github/dependabot.yml`) keeps npm, actions, and Docker deps current.

## Architecture

Modules in `src/`, bundled by `vp pack` into CommonJS `dist/index.cjs` (entry `src/index.ts`; `ws`, `mongodb` and Node built-ins stay external; the dynamically imported `trace/mongo-store.ts` becomes its own chunk in `dist/`):

- **`index.ts`** — entrypoint: load config → set log level → load the route table (**fail-fast** if missing/invalid; backend ids required when archiving) → start watching it for hot reload → open the trace archive when enabled → start the gateway → wire `SIGINT`/`SIGTERM` to a graceful shutdown (`gateway.close()`, which tears sessions down synchronously, then the archive's bounded flush).
- **`config.ts`** — reads env vars (`PORT`, optional `LISTEN_HOST` (unset: all interfaces), `ROUTES_FILE` default `./routes.json`, `LOG_LEVEL`, `LOG_DEBUG_MESSAGE_MAX_LENGTH`, `MAX_MESSAGE_BYTES` default 1 MiB, optional `TENANT_BASE_DOMAIN` and `TENANT_HOST_HEADER`, and `TRACE_*` → `config.trace`, undefined when archiving is disabled). Throws on invalid values (never echoing `TRACE_MONGODB_URI`). No CSMS URLs live here anymore — those are in the routes file.
- **`routes.ts`** — the routing layer. Pure functions `parseRouteTable` (validates structure, throws on error), `resolveRoute(table, tenantId, id)` (`chargers[id] ?? default` within the tenant's scope, or the global scope for `null`; `null` when nothing matches; scopes use `Map`s), and `buildTargetUrl` (appends the url-encoded chargeBoxId to a backend URL, trims trailing slashes, keeps query params — unless the backend sets `appendChargeBoxId: false`). `RouteStore.load(path, { requireBackendIds })` loads the file (the option also applies to every reload), resolves routes and explicit tenant hostnames (`findTenantByHostname`, an index built at parse time), and optionally `watch()`es for hot reload (a failed reload keeps the previous table).
- **`proxy.ts`** — HTTP server (`GET /healthz` → 200) + `WebSocketServer`. Negotiates the OCPP sub-protocol, extracts the chargeBoxId from the **last path segment** of the request URL (URL-decoded), resolves the tenant from the host header (`Host`, or `TENANT_HOST_HEADER`; must be sent exactly once, otherwise the connection is closed with 1008 — **fail closed**, never routed globally) via a `TenantResolver`, resolves the route via the `RouteStore` (closing with 1008 when there is none), and spawns one `ChargerConnection`. Logs the resolved route on connect. `startProxy(config, routes, { tenants?, traceSink? })` returns `{ server, close() }`; it registers no process handlers, so tests can start and stop gateways freely (see `test/helpers.ts`).
- **`tenants.ts`** — the `TenantResolver` interface (`resolve(host) → TenantId | null`), `parseHostname` (strict, no port — config and routes file), `normalizeHostname` (`Host`-header value: strips the port), `readSingleHeader`, and `HostnameTenantResolver` (explicit hostnames from the routes file first, then `<label>.<TENANT_BASE_DOMAIN>`). Framework-free: nothing Cloudflare-specific lives in `src/`.
- **`sessions.ts`** — `SessionRegistry`: live sessions per `SessionKey` `{ tenantId, chargeBoxId }`, used by `proxy.ts` to replace a reconnecting charger's stale session (same credentials only), and to tear every session down on shutdown (`teardownAll`).
- **`connection.ts`** — the core. `ChargerConnection` takes a resolved `Route` and owns the full lifecycle of one charger session and all its upstream links. It has a `sessionId` (UUID) and, given a `TraceSink`, a `SessionTracer`.
- **`trace/`** — trace archiving, framework-free except `mongo-store.ts` (the only file importing `mongodb`):
  - `frame.ts` (`parseOcppFrame`: OCPP-J → Open OCPP Trace fields, or an unparsed reason), `record.ts` (record/document types, delivery statuses and their rank), `correlator.ts` (per-conversation CALL ↔ response pairing, bounded by count and size);
  - `session-tracer.ts` (`SessionTracer`: one document per received frame, `fromCharger`/`fromPrimary`/`fromSecondary`, monotonic `DeliveryTracker`s);
  - `writer.ts` (ports `TraceSink`/`TraceStore`; `BufferedTraceWriter`: bounded queue, background batches, retries, counters), `mongo-store.ts` (`MongoTraceStore`: mapping, TTL and query indexes, idempotent inserts, guarded delivery updates, BSON size fallback), `archive.ts` (`openTraceArchive`, lazy-loads the store).
- **`logger.ts`** — structured JSON logging to stdout (stderr for errors), filtered by level. Each connection logs under a tag = chargeBoxId (`tenantId/chargeBoxId` within a tenant); `debugOcppFrame` logs OCPP frames at debug level, truncated to `LOG_DEBUG_MESSAGE_MAX_LENGTH`. `configureLogger` accepts an injectable sink (tests silence it in `test/setup.ts`).
- **`utils/`** — `value-parsers.ts` (env parsing used by `config.ts`) and `websocket.ts` (`forwardPing`/`forwardPong`/`rawDataToString`), both from upstream; `bounded-queue.ts` (`BoundedQueue`, the upstream replay queues bounded by count and bytes; `push` returns the evicted messages); `url.ts` (`redactUrl`, `maskUserinfo`); `errors.ts` (`errorMessage`), `objects.ts` (`isPlainObject`).
- **`types.ts`** — OCPP message-type constants and the sub-protocol preference list (`ocpp2.0.1` > `ocpp2.0` > `ocpp1.6`).

### Routing model

A `routes.json` has a `default` route (required unless `tenants` is present) and an optional `chargers` map keyed by chargeBoxId. Each route = `{ primary: Backend, secondaries: Backend[] }`, where a backend is written as a URL string or `{ id?, url, appendChargeBoxId? }` and normalised to `{ id?, url, appendChargeBoxId }` (default `true`); URLs are validated at load time. `id` names the logical CSMS in traces (never the URL): unique within a route, one server (scheme, host, port) per id within a scope — paths may differ, required on every backend when trace archiving is enabled. Resolution is exact-match on the id, falling back to `default`. An optional `tenants` map (keyed by tenant id, a lowercase DNS label) holds per-tenant `{ hostnames?, default?, chargers? }`. A connection that resolves a tenant only ever uses that tenant's routes — **never the global ones** — and one that resolves none uses the global routes, so a file without `tenants` behaves as before as long as `TENANT_BASE_DOMAIN` is unset (once set, any `<label>.<base>` host names a tenant and an unknown one is rejected). Real `routes.json` is gitignored; `routes.example.json` and `routes.multi-tenant.example.json` are the committed templates.

### Tenancy and the trust boundary

The tenant is transport/routing context, never read from or written to OCPP frames. Sessions are keyed by `(tenantId, chargeBoxId)`, so the same chargeBoxId in two tenants never collides (no eviction across tenants). Never trust a tenant-selecting header from a charger: only the header named by `TENANT_HOST_HEADER` is read (instead of `Host`, no fallback), and it must be set by a proxy that strips client-supplied values. A missing or duplicated host header is rejected, never treated as "no tenant" — the global routes are for requests that unambiguously name no tenant. `deploy/cloudflare/` is that proxy for Cloudflare: a Worker (`src/forward.ts`, runtime-agnostic and tested by the root `npm test`) forwarding to a Container running the unchanged image. It has its own `package.json`/`tsconfig.json` (`npm run typecheck` and `npm run dry-run` there, run by the `cloudflare` CI job), not part of the root build.

### Connection model (the key invariant)

Per charger, the gateway holds one **primary** link and N **secondary** links:

- **Charger → upstream**: every message is forwarded to the primary AND mirrored to all secondaries.
- **Upstream → charger**: ONLY the primary's responses go back to the charger. Secondary responses are logged and discarded — secondaries are strictly one-way mirrors.
- **Primary failure tears down the whole session** (chargers expect exactly one CSMS). A **secondary failure must never affect the charger or the primary** — this is a hard rule; all secondary I/O is wrapped best-effort. Connection setup never throws: `new WebSocket()` rejects some URLs synchronously (bad scheme, `#fragment`), so a refused secondary is skipped and a refused primary closes the charger with 1011, like an unreachable one.

For each upstream the gateway builds `<baseUrl>/<chargeBoxId>` via `buildTargetUrl` (so different backends may use different base paths), or uses the URL unchanged when the backend sets `appendChargeBoxId: false`. When a charger reconnects with an id that already has a live session in the same tenant, `proxy.ts` tears the old session down first (some CSMS reject a second connection for the same id) — but only if the newcomer presents the **same `Authorization` header** (`SessionRegistry` in `sessions.ts`, constant-time comparison). The gateway does not authenticate chargers itself, so this stops anyone who knows a chargeBoxId from kicking the real charger; a mismatched newcomer runs alongside and the CSMS decides. `autoPong` is disabled on the charger server and the primary socket so pings/pongs are forwarded end-to-end instead of being answered locally. HTTP Basic Auth (`Authorization` header) is forwarded as-is to all upstreams. Messages the charger sends while the primary link is still `CONNECTING` (typically the first `BootNotification`) are held in a bounded queue (`UPSTREAM_MAX_QUEUE` messages and `max(UPSTREAM_MAX_QUEUE_BYTES, MAX_MESSAGE_BYTES)` bytes, shared with secondaries; oldest dropped first with a warning — `BoundedQueue` in `utils/bounded-queue.ts`) and flushed in order on `open`. A message arriving when the primary is neither `CONNECTING` nor `OPEN` is dropped with a warning. Every link (charger server, primary, secondaries) sets `maxPayload` to `MAX_MESSAGE_BYTES`, so `ws` closes a link with `1009` on an oversized message before it is forwarded or queued.

### Secondary resilience (in `connection.ts`)

Charger sessions live for days/weeks, so secondaries get extras tuned by the `SECONDARY_*` constants at the top of the file:

- **Auto-reconnect** after a fixed delay, retrying until the charger session ends.
- **Keepalive ping** on an interval to survive idle-connection timeouts.
- **Pong-timeout detection** — if no pong arrives within the timeout, the socket is force-closed to trigger reconnect.
- **Bounded replay queue** per secondary while disconnected, by count and bytes; oldest messages drop first when full.

WebSocket ping/pong frames are forwarded between charger and primary via the `forwardPing`/`forwardPong` helpers in `utils/websocket.ts`, which guard on `readyState === OPEN`.

### Trace archiving (in `connection.ts` and `trace/`)

Optional (`config.trace`). The invariants:

- **One document per received frame**, captured at ingress in the three `message` handlers, before forwarding; replays from a queue never create a document. The `trace` field is an Open OCPP Trace v1.1 record and is immutable; `raw` is the frame as received, never re-serialised. Frames v1.1 cannot represent are stored as `kind: "frame"` (never as `trace`).
- **Delivery outcomes** live in the document's `deliveries` (outside `trace`), one per destination, and only move forward (`queued` → `submitted` → `written` | `failed` | `dropped`). Queued messages carry their `DeliveryTracker`; evictions, teardown and closed links report `dropped`. `written` = `ws` send callback without error, not a peer acknowledgement.
- **Never interfere with forwarding:** the `TraceSink` is synchronous and non-throwing; a frame is sent before it is decoded for the archive (on `commit()`); MongoDB is only touched by `BufferedTraceWriter`'s background batches. `MongoTraceStore` masks credentials in every error it throws. Without a sink, `send()` calls `ws.send(raw)` exactly as before (no callback).
- **Correlation is per conversation** (session × CSMS), so secondary responses never answer the charger's CALL in the primary's conversation; responses carry `meta.gateway.correlation`, never a top-level `action`.
- Tests: `test/trace/` (unit, plus `mongo-store.test.ts` against a real MongoDB when `TRACE_TEST_MONGODB_URI` is set — CI runs a `mongo` service) and `test/trace-integration.test.ts` (gateway end to end with an in-memory sink). Records are checked against the vendored spec schema and fixtures (`test/fixtures/open-ocpp-trace/`, Apache-2.0, excluded from formatting) and the ported reference consumer (`test/trace/conformance.ts`).

## Conventions

- Runtime knobs are env vars (`config.ts`); CSMS topology is the routes file (`routes.ts`). Add env options in `config.ts` and surface them in `README.md`/`.env.example`; add routing fields in `routes.ts`'s validator and `routes.example.json`.
- Keep secondary-side code defensive: wrap sends/closes so a failing secondary can never throw into the charger or primary path. The same goes for trace archiving: never await it nor let it throw on the forwarding path, and keep its memory bounded.
- Log via `createLogger(tag)`, not `console.*`.
- Never put a real charger id, CSMS hostname, or other personal/infra reference in examples, docs, or tests — use generic placeholders (`CP-001`, `*.example.com`).
- Code and commit messages in English.

### Commits, hooks & changelog

- **Conventional Commits** are enforced by commitlint (`@commitlint/config-conventional`, config in `.commitlintrc.json`). Commit messages must look like `type(scope): subject` — e.g. `feat: add per-charger routing`, `fix(connection): guard secondary close`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Git hooks** are managed by [husky](https://typicode.github.io/husky/) (installed via the `prepare` script on `npm install`). Hook scripts live in `.husky/`:
  - `pre-commit` → `lint-staged`: runs `vp fmt --write` then `vp lint --fix` on staged `*.{ts,js,mjs,cjs}` files and re-stages them (config under `lint-staged` in `package.json`).
  - `commit-msg` → `commitlint`: validates the message.
  - `pre-push` → `npm test`: the full suite must pass before pushing.
- Update **`CHANGELOG.md`** ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) for any user-facing change: add entries under `## [Unreleased]` in the appropriate group (Added / Changed / Deprecated / Removed / Fixed / Security). On release, rename `[Unreleased]` to the new version with a date and update the comparison links at the bottom.