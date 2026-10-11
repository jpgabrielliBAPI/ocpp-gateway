# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional trace archiving to MongoDB (`TRACE_ENABLED`, `TRACE_MONGODB_URI`,
  `TRACE_MONGODB_DATABASE`, `TRACE_RETENTION_DAYS`, `TRACE_QUEUE_MAX`). Every
  OCPP frame received from a charger, the primary or a secondary CSMS is
  stored once as an [Open OCPP Trace](https://github.com/open-ocpp-trace/specification)
  v1.1 record, with its tenant, gateway session, source, each destination's
  delivery outcome (queued, submitted, written, failed, dropped) and the CALL
  it answers. Traces expire through a MongoDB TTL index. Archiving never
  delays forwarding: writes are batched in the background, bounded in memory,
  and dropped (counted and logged) when MongoDB is unavailable. Disabled by
  default; the MongoDB driver is not even loaded then.
- Backends accept a stable `id` (`{ "id": "csms-a", "url": "…" }`), naming the
  logical CSMS in traces instead of its URL. Required on every backend when
  trace archiving is enabled; validated whenever present (format, unique within
  a route, one URL per id within the global routes or a tenant).
- `docker-compose.mongo.yml`, a Compose overlay running a local MongoDB for
  trace archiving.

### Changed

- On shutdown, charger sessions are torn down immediately instead of after
  each charger's close handshake, so upstream links close sooner.

## [0.1.0] - 2026-10-06

First release of **ocpp-gateway**, a fork of
[joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT). The
defining change is per-chargeBoxId routing in place of the upstream's single
global primary/secondary configuration. The image is published as
`ghcr.io/juherr/ocpp-gateway:0.1.0`.

### Added

- Multi-tenant routing: an optional `tenants` map in the routes file gives each
  tenant its own `default`/`chargers` routes. The tenant is resolved from the
  hostname the charger dialled — a subdomain of `TENANT_BASE_DOMAIN`
  (`acme.ocpp.example.com` → `acme`) or an explicit per-tenant `hostnames`
  entry (custom domains). Sessions are keyed by `(tenantId, chargeBoxId)`, so
  two tenants can each have a `CP-001`. A tenant never falls back to the global
  routes; unknown tenants and unmatched chargers are closed with `1008`. Without
  `TENANT_BASE_DOMAIN`, routes files without `tenants` behave as before.
- `TENANT_HOST_HEADER` to read the dialled hostname from a header set by a
  trusted reverse proxy (e.g. `x-forwarded-host`) instead of `Host`; any other
  forwarded-host header is ignored.
- Connections whose host header (`Host`, or the trusted header) is missing or
  sent more than once are closed with `1008` before any upstream is dialled
  (fail closed): they never reach the global routes with the charger's
  credentials.
- Cloudflare deployment example (`deploy/cloudflare/`): a minimal Worker in
  front of a Cloudflare Container running the unchanged image, which strips
  client-supplied internal headers and injects the trusted hostname.
  `wrangler deploy` fails while the `ROUTES_JSON` secret is unset, the
  gateway's logs reach the Cloudflare dashboard (observability), and an
  end-to-end smoke test runs against the Worker + Container under
  `wrangler dev`, in CI too (`cloudflare-smoke` job).
- Per-chargeBoxId routing table loaded from a JSON file (`ROUTES_FILE`, default
  `./routes.json`): a required `default` route and optional exact-match
  `chargers` overrides, each with one `primary` and any number of read-only
  `secondaries`. The gateway **fails to start** if the file is missing or
  invalid.
- Hot reload of the routing table: the file is watched and reloaded on change;
  a failed reload keeps the previous table in effect. Existing charger sessions
  keep the route they connected with.
- `GET /healthz` health-check endpoint returning `200 ok`.
- Structured route logging on connect (chargeBoxId, resolved primary and
  secondaries).
- Per-backend `appendChargeBoxId` option in the routing table: a `primary` or
  `secondary` may be written as `{ "url": "...", "appendChargeBoxId": false }`
  to connect to a fixed CSMS endpoint URL as-is. A bare URL string keeps
  appending the chargeBoxId. This is the fork's counterpart to upstream's
  `PRIMARY_CSMS_APPEND_CHARGE_POINT_ID` / `SECONDARY_CSMS_APPEND_CHARGE_POINT_ID`.
- `LISTEN_HOST` to bind the gateway to one address or hostname (e.g.
  `127.0.0.1` behind a local reverse proxy). Unset, it listens on all
  interfaces as before.
- OCPP frame debug logging (from upstream): at `LOG_LEVEL=debug`, frames are
  logged as `[OCPP CALL|RESULT|ERROR] (<id>): <payload>`, truncated to
  `LOG_DEBUG_MESSAGE_MAX_LENGTH` characters (default `120`; set it empty to
  disable truncation).
- Multi-arch Docker image (`linux/amd64`, `linux/arm64`) published to GitHub
  Container Registry, with semver-pinned tags (never `latest`).
- Dependabot configuration for npm, GitHub Actions, and Docker dependencies.
- Conventional-commit linting (commitlint) and Git hooks (husky + lint-staged):
  format and lint staged files on commit, validate the commit message, and run
  the test suite on push.
- This changelog.

### Changed

- The default `docker-compose.yml` no longer publishes port `9000` on the host,
  so it can be used behind Coolify's proxy without reserving a host port. For
  local access, start the gateway with
  `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`.
- Replaced the upstream global `PRIMARY_CSMS_URL` / `SECONDARY_CSMS_URLS`
  environment configuration with the per-chargeBoxId routing table. Each
  upstream target URL is built as `<baseUrl>/<chargeBoxId>` (query parameters
  are kept), unless the backend opts out with `appendChargeBoxId: false`.
- Backend URLs in the routing table are validated when the table loads: they
  must parse and use `ws:`, `wss:`, `http:` or `https:`.
- Stricter environment parsing (from upstream): an invalid `PORT`, `LOG_LEVEL`
  or `LOG_DEBUG_MESSAGE_MAX_LENGTH` now stops the gateway at startup with a
  message naming the variable, instead of silently falling back.
- Synced with upstream `joulo-ocpp-proxy` up to `7750259` (merged, not
  rebased; later syncs are `git merge upstream/main`). CI commit linting only
  checks the fork's own first-parent commits.
- Renamed the project from `joulo-ocpp-proxy` to `ocpp-gateway`.
- Switched the toolchain to Vite+ (Oxlint + Oxfmt for lint/format, `vp pack`
  for bundling to `dist/index.cjs`); `tsc --noEmit` is kept as a separate
  type-check gate.
- Pinned the Node version with mise (`mise.toml`, Node 24 LTS) as the single
  source of truth for local dev, CI (`jdx/mise-action`), and the Docker images.

### Fixed

- Charger messages sent before the gateway's link to the primary CSMS is open
  (typically the `BootNotification` sent right after the handshake) are no
  longer silently dropped: they are queued (bounded, oldest dropped first,
  with a warning) and delivered in order once the link opens. Chargers no
  longer wait for a call timeout to boot after every (re)connect.

- A backend URL the WebSocket client refuses to dial (e.g. a typo such as
  `htps://`, or a `#fragment`) no longer crashes the whole gateway on the first
  charger connection: such a secondary is skipped (and logged), and such a
  primary closes the charger session like an unreachable CSMS.

- Charger reconnect loop caused by a stale session (from upstream): when a
  charger reconnects with an id that still has a live session, the old session
  and its upstream links are torn down first, since some CSMS reject a second
  connection for the same charge point. Unlike upstream, the old session is
  only replaced when the new connection sends the same `Authorization` header,
  so knowing a chargeBoxId is not enough to disconnect a live charger.
- Duplicate pongs (from upstream): `autoPong` is disabled on the charger server
  and the primary socket, so ping/pong frames are only forwarded end-to-end.
- Failed sends to a secondary are now logged as warnings instead of being
  silently ignored (from upstream).

### Security

- WebSocket messages are capped at `MAX_MESSAGE_BYTES` (default 1 MiB, instead
  of the `ws` default of 100 MiB), on the charger side and on every upstream
  CSMS link. An oversized message closes that connection with `1009` and is
  never forwarded nor queued: a charger is disconnected, a primary ends the
  session, a secondary reconnects. Values outside `1`–`2147483647` (the range
  `ws` can enforce) stop the gateway at startup. 1 MiB is a security default,
  not an OCPP limit: raise it for large vendor-specific `DataTransfer` payloads.
- Upstream replay queues (primary while connecting, each secondary while
  disconnected) are bounded by total size as well as count: 1 MiB or
  `MAX_MESSAGE_BYTES`, whichever is larger, instead of up to 100 maximum-size
  messages (~100 MiB) per queue. The oldest messages are dropped first, with a
  warning; a single maximum-size message is always queued.
- Backend URLs are redacted wherever the gateway logs them or echoes them in a
  routes file error: userinfo, query parameter values and the fragment are
  masked, so credentials in a CSMS URL never reach the logs (now collected by
  Cloudflare observability in the Cloudflare example).

### Preserved

- OCPP 1.6 / 2.0.1 sub-protocol negotiation, with the negotiated sub-protocol
  propagated to every upstream.
- Bidirectional primary link; read-only secondary mirrors whose responses are
  never returned to the charger.
- HTTP Basic Auth (`Authorization` header) forwarded as-is to all upstreams.
- Secondary resilience: auto-reconnect, keepalive ping with pong-timeout
  detection, and a bounded per-secondary replay queue.
- MIT license and upstream attribution.

[Unreleased]: https://github.com/juherr/ocpp-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/juherr/ocpp-gateway/releases/tag/v0.1.0
