# ocpp-gateway

A lightweight **OCPP WebSocket gateway** that sits between your EV chargers and one or more CSMS backends. Each charge point is routed by its **chargeBoxId** to its own **primary CSMS** (full bidirectional control) and, optionally, to one or more **secondary backends** that receive a read-only mirror of the charger's traffic — perfect for monitoring, analytics, or migrating between platforms without reconfiguring your chargers.

A single endpoint serves every charger: the gateway reads the chargeBoxId from the connection URL and looks it up in a routing table. Built with Node.js and TypeScript. Supports OCPP 1.6 and 2.0.1. Optionally, every OCPP frame can be archived in MongoDB as [Open OCPP Trace](https://github.com/open-ocpp-trace/specification) records — see [Trace archiving](#trace-archiving-optional).

> Forked from [joulo-nl/joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT). The original uses a single global primary/secondary configuration for all chargers; this fork replaces it with a **per-chargeBoxId routing table**.

## How it works

```mermaid
graph LR
    Charger["⚡ Charger"]
    Proxy["OCPP Gateway"]
    Primary["Primary CSMS"]
    S1["Secondary CSMS 1"]
    S2["Secondary CSMS 2"]
    SN["Secondary CSMS N"]

    Charger <-->|"OCPP (WS)"| Proxy
    Proxy <-->|"full bidirectional"| Primary
    Proxy -->|"mirror"| S1
    Proxy -->|"mirror"| S2
    Proxy -.->|"mirror"| SN
```

For each charge point the gateway resolves a **route** (one primary + N secondaries):

| Direction      | Primary CSMS | Secondary CSMS (×N) |
| -------------- | ------------ | ------------------- |
| Charger → CSMS | ✅ Forwarded | ✅ Mirrored         |
| CSMS → Charger | ✅ Forwarded | ❌ Ignored          |

The **primary CSMS** has full control — it can send commands like `RemoteStartTransaction` back to the charger. **Secondary** backends receive a read-only copy of the charger's messages; their responses are never sent back to the charger. Secondary connections are best-effort — if one fails, it never affects the charger or the primary link.

### Secondary reliability

Because charger sessions can stay open for days or weeks, secondaries get a few extras so a brief network blip doesn't silently break your mirror for the rest of the session:

- **Auto-reconnect** — if a secondary disconnects, the gateway reconnects after 10s and keeps retrying until the charger session ends.
- **Keepalive ping** — the gateway pings each secondary every 30s so idle connections aren't dropped by load balancers or CSMS timeouts, and force-reconnects if no pong is seen within 90s.
- **Bounded queue** — while a secondary is reconnecting, up to 100 messages and 1 MiB (or `MAX_MESSAGE_BYTES`, whichever is larger) per secondary are buffered and replayed once it's back. Older messages are dropped first if the buffer fills.

Messages a charger sends while the gateway is still connecting to its **primary** (usually the `BootNotification` right after the handshake) are buffered within the same bounds and delivered in order once the link is open. If the **primary** disconnects, the charger connection is closed (a charger expects exactly one controlling CSMS). A secondary failure never affects the charger or the primary link.

## Routing configuration

Routing is driven by a JSON file (path from `ROUTES_FILE`, default `./routes.json`). The gateway **fails to start** if the file is missing or invalid.

```json
{
  "default": {
    "primary": "wss://csms.example.com/ocpp",
    "secondaries": []
  },
  "chargers": {
    "CP-001": {
      "primary": "wss://primary-csms.example.com/ocpp",
      "secondaries": ["wss://analytics.example.com/ocpp"]
    },
    "CP-002": {
      "primary": { "url": "wss://fixed-csms.example.com/XXXXXXXX", "appendChargeBoxId": false },
      "secondaries": []
    }
  }
}
```

- **`default`** (required, unless the file defines [`tenants`](#multi-tenant-routing)) — route used for any chargeBoxId not listed under `chargers`.
- **`chargers`** (optional) — exact-match overrides keyed by chargeBoxId.
- Each route has a `primary` backend (required) and `secondaries` (array of backends, optional).
- A backend is either a URL string or an object `{ "id": "...", "url": "...", "appendChargeBoxId": false }`. `appendChargeBoxId` defaults to `true`; a bare string is shorthand for `{ "url": "...", "appendChargeBoxId": true }`.
- `id` (optional, **required with [trace archiving](#trace-archiving-optional)**) is a stable name for the logical CSMS, used instead of its URL (which may carry credentials) wherever the gateway records it: 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. Within a route, ids are unique; within a scope (the global routes, or one tenant), the same id always names the same server — scheme, host and port — while paths, queries and credentials may differ (e.g. per-charger endpoints with `appendChargeBoxId: false`). Different tenants may reuse an id. [`routes.example.json`](routes.example.json) gives every backend an id.

**Resolution:** for a charger with id `X`, the gateway uses `chargers["X"]` if present, otherwise `default`.

**Target URL:** for every upstream (primary and each secondary), the gateway appends the url-encoded chargeBoxId as a path segment: `<baseUrl>/<chargeBoxId>` (query parameters are kept). Different backends may therefore use entirely different base paths. For CSMS endpoints that use a fixed URL per charger, set `appendChargeBoxId: false` and the URL is used as-is. Credentials in a backend URL (userinfo, query parameter values, fragment) are masked wherever the URL is logged. In the example above:

- `CP-001` → primary `wss://primary-csms.example.com/ocpp/CP-001`, secondary `wss://analytics.example.com/ocpp/CP-001`
- `CP-002` → primary `wss://fixed-csms.example.com/XXXXXXXX` (unchanged), no secondary
- every other charger → `wss://csms.example.com/ocpp/<chargeBoxId>` only

### Hot reload

The gateway watches the routes file and reloads it on change. Existing charger sessions keep the route they connected with; only new connections pick up the change. If a reload fails validation, the error is logged and the previous table stays in effect.

## Multi-tenant routing

One gateway can serve several **tenants**, each with its own routes. The tenant is resolved from the **hostname the charger dialled**, so two tenants may both have a charger called `CP-001` without any collision: sessions and routes are keyed by `(tenantId, chargeBoxId)`. Nothing in the OCPP frames is read or changed — the tenant is a transport/routing concept only.

```
wss://tenant-a.ocpp.example.com/CP-001  →  tenantId = tenant-a, chargeBoxId = CP-001  →  CSMS A
wss://tenant-b.ocpp.example.com/CP-001  →  tenantId = tenant-b, chargeBoxId = CP-001  →  CSMS B
```

Add a `tenants` map to the routes file (see [`routes.multi-tenant.example.json`](routes.multi-tenant.example.json)):

```json
{
  "default": { "primary": "wss://csms.example.com/ocpp" },
  "tenants": {
    "tenant-a": {
      "default": { "primary": "wss://csms-a.example.com/ocpp" },
      "chargers": { "CP-001": { "primary": "wss://csms-a.example.com/ocpp", "secondaries": ["wss://analytics.example.com/ocpp"] } }
    },
    "tenant-b": {
      "hostnames": ["ocpp.customer-b.example"],
      "chargers": { "CP-001": { "primary": "wss://csms-b.example.com/ocpp" } }
    }
  }
}
```

- A **tenant id** is a lowercase DNS label (`a-z`, `0-9`, `-`).
- A tenant has its own `default` and/or `chargers` (at least one of them). A tenant **never falls back** to the global routes: a charger with no match in its tenant is rejected.
- `hostnames` (optional) lists custom domains that select the tenant, e.g. `ocpp.customer-b.example`. A hostname may belong to one tenant only.
- With `tenants`, the global `default` becomes optional.
- `trace: false` (optional) keeps the tenant's frames out of the trace archive; see [Choosing what is archived](#choosing-what-is-archived).

**Tenant resolution**, from the connection's hostname (lowercased, port and trailing dot ignored):

1. a hostname listed in some tenant's `hostnames` → that tenant;
2. otherwise, with `TENANT_BASE_DOMAIN=ocpp.example.com`, a hostname `<label>.ocpp.example.com` → tenant `<label>`. Only one label is accepted: `a.b.ocpp.example.com`, `ocpp.example.com` itself or look-alikes such as `evilocpp.example.com` resolve no tenant;
3. otherwise → **no tenant**.

| Outcome                                                         | Behaviour                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| Tenant resolved and known, route found                          | Connected to that tenant's primary/secondaries                  |
| Tenant resolved but not in `tenants`, or no route in the tenant | WebSocket closed with **1008** (`No route for this charge point`) |
| No tenant (IP address, unrelated or malformed host)             | Global `default`/`chargers`; closed with **1008** if there are none |
| Host header missing or sent twice (or the trusted header, see below) | Closed with **1008**, never routed — not even to the global routes |

**Backward compatibility:** without `TENANT_BASE_DOMAIN`, a routes file without `tenants` behaves exactly as before, whatever the `Host` header: every connection resolves no tenant and uses the global routes. Once `TENANT_BASE_DOMAIN` is set, a one-label subdomain of it always names a tenant — an unknown one is rejected, never sent to the global routes — so add the `tenants` before setting it. Nested names (`a.b.ocpp.example.com`) name no tenant and use the global routes. Omit the global `default` to reject every connection that does not name a known tenant.

### Running it locally

```bash
cp routes.multi-tenant.example.json routes.json   # edit with your CSMS URLs
TENANT_BASE_DOMAIN=ocpp.example.com ROUTES_FILE=./routes.json npm start
```

Point `*.ocpp.example.com` at the gateway (DNS, or `/etc/hosts` entries such as `127.0.0.1 tenant-a.ocpp.example.com` for a quick test), then connect chargers to `ws://tenant-a.ocpp.example.com:9000/CP-001`.

### Behind a reverse proxy: the trusted host header

The gateway reads the hostname from the `Host` header by default. When a reverse proxy in front of it rewrites `Host` (as the Cloudflare Container runtime may), set `TENANT_HOST_HEADER` (e.g. `x-forwarded-host`) and have the proxy put the original hostname there.

**Security:** never trust a tenant chosen by the charger. The hostname a charger dials is already under its control, which is fine: it only selects *which* tenant's CSMS will authenticate it (the gateway forwards `Authorization`, the CSMS validates it). But a header such as `X-OCPP-Tenant` or `X-Forwarded-Host` sent by a client must never be accepted blindly:

- `X-Forwarded-Host` (or any other header) is **ignored** unless named by `TENANT_HOST_HEADER`;
- once it is named, the gateway trusts it **instead of** `Host` (no fallback), so it must only be reachable through a proxy that **deletes any client-supplied value and sets its own**. That proxy is the trust boundary; never expose such a gateway directly;
- **fail closed:** a request missing that header (e.g. one that bypassed the proxy) or carrying it — or `Host` — more than once is rejected with 1008 before any upstream is dialled, so the charger's `Authorization` is never forwarded, not even to the global routes.

The [Cloudflare example](deploy/cloudflare/README.md) implements this boundary.

## Quick start

### Using Docker (recommended)

A pre-built, multi-arch image is published to GitHub Container Registry. Pin a release tag (`0.1.0`, or `0.1` for the latest patch release); the `main` and `sha-*` tags follow the `main` branch. No `latest` tag is published.

```bash
cp routes.example.json routes.json   # edit with your CSMS URLs

docker run -d \
  -p 9000:9000 \
  -v "$(pwd)/routes.json:/app/routes.json:ro" \
  ghcr.io/juherr/ocpp-gateway:0.1.0
```

### On Cloudflare (Worker + Container)

[`deploy/cloudflare/`](deploy/cloudflare/README.md) runs the same image in a Cloudflare Container behind a minimal Worker, with tenants resolved from `*.ocpp.example.com`.

### On Coolify

Coolify can build the gateway from this repository using the existing [`docker-compose.yml`](docker-compose.yml):

1. Create a Docker Compose resource for this repository, select branch `main`, and use `/docker-compose.yml`.
2. Enable automatic deployments for pushes to `main`.
3. Create `routes.json` on the Coolify server and set `ROUTES_HOST_PATH` to its absolute host path. The file must already exist and be readable by the container's `node` user. It is mounted read-only at `/app/routes.json`; keep it out of Git. Without this variable, Compose uses `./routes.json` for local development.
4. Set `LOG_LEVEL` and `LOG_DEBUG_MESSAGE_MAX_LENGTH` if needed. Compose enforces `PORT=9000`, `LISTEN_HOST=0.0.0.0`, and `ROUTES_FILE=/app/routes.json` regardless of values in `.env`.
5. Add the public domain in Coolify, targeting container port `9000`. Connect charge points to `wss://<your-domain>/<chargeBoxId>`.

The routes file must contain a valid routing table. For the default route, set its primary backend to your SteVe WebSocket base URL; the gateway appends the URL-encoded charge-box ID. Coolify should report the service healthy when `GET /healthz` returns `200`. The health check uses Node.js, which is present in the runtime image.

The Coolify Compose file exposes only the container's internal port `9000`; it does not reserve a host port. Redeployments stop the running gateway and its active OCPP sessions. Charge points must reconnect after the new container starts.

### Using Docker Compose

```bash
git clone https://github.com/juherr/ocpp-gateway.git
cd ocpp-gateway
cp routes.example.json routes.json
# Edit routes.json with your CSMS URLs
cp .env.example .env   # optional overrides (LOG_LEVEL, …)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

### From source

```bash
git clone https://github.com/juherr/ocpp-gateway.git
cd ocpp-gateway
mise install   # installs the pinned Node version (mise.toml); optional but recommended
npm install
npm run build
cp routes.example.json routes.json
ROUTES_FILE=./routes.json npm start
```

## Configuration

All configuration is done through environment variables:

| Variable                       | Required | Default         | Description                                                                         |
| ------------------------------ | -------- | --------------- | ----------------------------------------------------------------------------------- |
| `PORT`                         | No       | `9000`          | Port the gateway listens on                                                         |
| `LISTEN_HOST`                  | No       | — (all)         | Address or hostname to listen on (e.g. `127.0.0.1` behind a local reverse proxy)    |
| `ROUTES_FILE`                  | No       | `./routes.json` | Path to the JSON routing table                                                      |
| `LOG_LEVEL`                    | No       | `info`          | `debug`, `info`, `warn`, or `error`                                                 |
| `LOG_DEBUG_MESSAGE_MAX_LENGTH` | No       | `120`           | Max char length for debug payload summaries. Leave empty to disable truncation      |
| `TENANT_BASE_DOMAIN`           | No       | —               | Tenants are subdomains of this domain (`acme.<domain>` → `acme`). See [Multi-tenant routing](#multi-tenant-routing) |
| `TENANT_HOST_HEADER`           | No       | — (`Host`)      | Header holding the dialled hostname, set by a **trusted** reverse proxy (e.g. `x-forwarded-host`) |
| `MAX_MESSAGE_BYTES`            | No       | `1048576`       | Largest WebSocket message (bytes, `1`–`2147483647`) accepted from a charger or a CSMS; a bigger one closes that connection with `1009`. See [Message size limit](#message-size-limit). At most `15728640` (15 MiB) with trace archiving |
| `MAX_SESSIONS`                 | No       | — (unlimited)   | Live charger sessions; more are closed with `1013`. See [Session limits](#session-limits) |
| `MAX_PENDING_SESSIONS`         | No       | — (unlimited)   | Sessions whose primary CSMS link is still connecting; more are closed with `1013` |
| `MAX_SESSIONS_PER_SOURCE`      | No       | — (unlimited)   | Live charger sessions per client source (IP address); more are closed with `1013` |
| `CLIENT_IP_HEADER`             | No       | — (socket address) | Header holding the client's IP address, set by a **trusted** reverse proxy (e.g. `cf-connecting-ip`, `x-real-ip`). A connection without exactly one value that is a bare IP address is closed with `1008` |
| `TRACE_ENABLED`                | No       | `false`         | Archive every OCPP frame in MongoDB. See [Trace archiving](#trace-archiving-optional) |
| `TRACE_MONGODB_URI`            | With `TRACE_ENABLED` | —   | `mongodb://` or `mongodb+srv://` connection string. May carry credentials; never logged |
| `TRACE_MONGODB_DATABASE`       | No       | `ocpp_gateway`  | Database holding the `ocpp_traces` collection                                       |
| `TRACE_RETENTION_DAYS`         | No       | `30`            | Days each trace is kept (`1`–`36500`), through a MongoDB TTL index                  |
| `TRACE_QUEUE_MAX`              | No       | `10000`         | Traces held in memory while waiting for MongoDB (`1`–`1000000`); more are dropped   |
| `TRACE_REQUIRE_CAPPED`         | No       | `false`         | Only write into an existing **capped** `ocpp_traces` collection; never create it. See [Trace archiving](#trace-archiving-optional) |
| `SENTRY_DSN`                   | No       | — (disabled)    | Report crashes and internal anomalies to Sentry. See [Error reporting](#error-reporting-optional) |
| `SENTRY_ENVIRONMENT`           | No       | —               | Sentry environment (e.g. `production`, `staging`)                                   |
| `SENTRY_RELEASE`               | No       | `ocpp-gateway@<version>` | Sentry release                                                             |

### Message size limit

`MAX_MESSAGE_BYTES` (default 1 MiB) caps every WebSocket message, on the charger side and on each upstream CSMS link. It is a **security default, not a protocol limit**: the gateway does not authenticate chargers, so without a cap anyone able to open a WebSocket could make it buffer huge messages. Typical OCPP frames are a few KiB, but OCPP does not bound message size — notably OCPP 1.6 `DataTransfer.data` has no maximum length. If your chargers or CSMS exchange large vendor-specific payloads, raise `MAX_MESSAGE_BYTES` accordingly.

A message over the limit closes the link it arrived on with `1009` and is never forwarded nor queued: a charger is disconnected, a primary ends the session (the charger is closed with `1011`), a secondary reconnects without affecting the charger or the primary.

Messages waiting for an upstream link (the primary while it connects, a secondary while it reconnects) are buffered per link up to 100 messages and 1 MiB or `MAX_MESSAGE_BYTES`, whichever is larger — oldest dropped first — so raising `MAX_MESSAGE_BYTES` does not multiply the memory a session can hold by 100.

### Session limits

By default the gateway accepts any number of charger sessions. Each routed session dials its primary CSMS at once, and until that link opens (up to its 10 s handshake timeout) it buffers what the charger sends, up to 1 MiB or `MAX_MESSAGE_BYTES`. Anyone who knows one routed chargeBoxId — anyone at all with a `default` route — can therefore open sessions until the gateway runs out of memory: presenting different credentials each time keeps every session alive, since only a reconnection with the **same** `Authorization` replaces a session. Three optional limits bound this; each is unlimited when unset:

- `MAX_SESSIONS` caps live sessions, whatever their source;
- `MAX_PENDING_SESSIONS` caps sessions whose primary link is still connecting — where the memory goes;
- `MAX_SESSIONS_PER_SOURCE` caps live sessions per client source.

Size them from the fleet and the memory budget: each pending session may buffer up to 1 MiB or `MAX_MESSAGE_BYTES`, so `MAX_PENDING_SESSIONS` × that bounds the memory held by sessions still connecting; `MAX_SESSIONS` and `MAX_SESSIONS_PER_SOURCE` must leave room for every charger (and for all the chargers behind one NAT or one IPv6 /64).

A connection over a limit is accepted then closed with **`1013` (Try Again Later)** before any upstream connection is attempted or any buffer allocated. A session counts from the moment it is admitted until it ends, however it ends; it stops counting as pending as soon as its primary link opens. Limits are checked after routing: an unrouted chargeBoxId is still closed with `1008` and never counts, so a flood of unrouted ids cannot lock a source out of its chargers. A reconnection that replaces a session (same `Authorization`) is checked as if that session were gone, so a charger reconnecting from the same source is never refused because of its own stale session. The old session is only torn down once the reconnection is admitted: a reconnection refused because every pending slot is taken, or because it comes from another source whose bucket is full, leaves it running.

A refused connection is cut as soon as the client sends more than a close frame, or one second after the close if it does not answer: it never buffers a message, whatever `MAX_MESSAGE_BYTES` allows.

The source is the socket's remote address. Behind a reverse proxy that address is the proxy's, which would put the whole fleet in one bucket: set `CLIENT_IP_HEADER` to the header the proxy puts the client's address in (e.g. `cf-connecting-ip`, `x-real-ip`), and make sure the proxy overwrites any value a client sends and that the gateway is only reachable through it — a client that can reach the gateway directly can pick its own source. Once set, that header is required: a connection where it is missing, duplicated or not a bare IP address (a list such as `203.0.113.9, 198.51.100.7`, an address with a port…) is closed with `1008`, never counted under a shared key nor under a key of its own. An IPv4-mapped IPv6 address counts as its IPv4 address, and IPv6 clients are counted per `/64`, the block a single subscriber usually holds.

Rejections are logged as `warn` lines with their `reason` (`global`, `pending`, `per-source`, `client-ip-header`) and `source`, throttled so a flood cannot flood the logs: the first rejection of a source for a reason is logged right away, the following ones are summed into one `connections rejected` line per minute.

## Charger setup

Point your charger's OCPP backend URL to the gateway instead of the CSMS directly:

```
Before:  wss://your-csms.example.com/ocpp/CP-001
After:   ws://gateway-host:9000/CP-001
```

The gateway extracts the **last path segment** of the incoming URL (URL-decoded) as the chargeBoxId. These URL patterns are all accepted:

```
ws://gateway:9000/CP-001
ws://gateway:9000/ocpp/CP-001
ws://gateway:9000/ws/CP-001
```

### Authentication

If the charger sends HTTP Basic Auth credentials, the gateway forwards the `Authorization` header to all upstream CSMS backends (primary and secondaries) as-is.

The gateway does not validate credentials itself — the CSMS does. When a charger reconnects while its previous session is still open, the gateway closes the stale session first (some CSMS reject a second connection for the same id), but only if the new connection sends the same `Authorization` header. A connection with different credentials cannot disconnect a live charger; it runs alongside and the CSMS accepts or rejects it. Chargers that connect without credentials get no such protection.

### Sub-protocol negotiation

The gateway negotiates OCPP sub-protocols (`ocpp1.6`, `ocpp2.0`, `ocpp2.0.1`) with the charger and propagates the negotiated sub-protocol to every upstream backend.

### Health check

`GET /healthz` returns `200 ok` while the service is running.

## Logging

Logs are structured JSON written to stdout/stderr. Each charger session logs under a tag equal to its chargeBoxId (`<tenantId>/<chargeBoxId>` for a tenant), and the resolved tenant and route (primary + secondaries) are logged on connect:

```json lines
{"time":"2026-06-17T10:00:00.000Z","level":"info","tag":"proxy","msg":"proxy listening","port":9000,"routesFile":"./routes.json","tenantHostHeader":"host"}
{"time":"2026-06-17T10:00:01.000Z","level":"info","tag":"proxy","msg":"charger connected","tenantId":null,"chargePointId":"CP-001","protocol":"ocpp1.6","primary":"wss://primary-csms.example.com/ocpp","secondaries":["wss://analytics.example.com/ocpp"]}
{"time":"2026-06-17T10:00:01.500Z","level":"debug","tag":"CP-001","msg":"charger → proxy","message":"[OCPP CALL] (abc123): [2, \"abc123\", \"BootNotification\", {\"chargePointVendor\":\"Acme\"}]"}
```

Set `LOG_LEVEL=debug` for OCPP payload summaries (including message-type-prefixed payloads for troubleshooting).
Set `LOG_DEBUG_MESSAGE_MAX_LENGTH` to a positive integer to cap logged `message` values in debug output.
Debug output contains raw OCPP payloads (idTags, meter values…), so keep `LOG_LEVEL=debug` for troubleshooting rather than normal operation.
Leave it unset for the default, or set it empty to disable truncation.

## Error reporting (optional)

Set `SENTRY_DSN` to send the gateway's own failures to [Sentry](https://sentry.io) (or any Sentry-compatible service). Unset, the Sentry SDK is not even loaded. Everything reported is still logged as before.

Reported:

- uncaught exceptions and unhandled promise rejections (the gateway still exits, as without Sentry);
- startup failures once the configuration is read: an unreadable or invalid routes file, a trace archive that cannot start;
- a routes file hot reload that fails (the previous table is kept);
- an error of the WebSocket server (e.g. the port is already in use);
- trace archiving outages: the MongoDB store becoming unavailable, and traces lost because of it — once per outage, however many batches are dropped.

Not reported: charger and CSMS connection errors (resets, timeouts, an unreachable secondary…), which are expected in the field and stay in the logs.

Only errors are sent: no performance tracing, no logs, no sessions, no HTTP breadcrumbs. Request headers (chargers' `Authorization`), cookies, bodies, query strings and local variables are never collected, and credentials in URLs are masked before an event leaves the gateway. Events carry the reporting component as the `component` tag. Stack traces point to the TypeScript sources: the image runs Node with `--enable-source-maps`.

Limitations:

- an invalid environment variable is not reported (the DSN is read from that same configuration); the gateway exits with the error on stderr;
- the [Cloudflare deployment](deploy/cloudflare/) does not pass `SENTRY_*` variables to the gateway.

## Trace archiving (optional)

With `TRACE_ENABLED=true`, the gateway stores **every OCPP frame it receives** — from the charger, from the primary CSMS, and from each secondary CSMS — in the MongoDB collection `ocpp_traces`, as [Open OCPP Trace](https://github.com/open-ocpp-trace/specification) v1.1 records. Archiving is off by default; when off, no MongoDB connection is made, the driver is not even loaded, and forwarding is unchanged.

```bash
TRACE_ENABLED=true \
TRACE_MONGODB_URI='mongodb://user:password@mongo.internal:27017/?authSource=admin' \
TRACE_RETENTION_DAYS=30 \
ROUTES_FILE=./routes.json npm start
```

To try it locally, `docker compose -f docker-compose.yml -f docker-compose.mongo.yml up --build` runs the gateway with a MongoDB reachable only from the Compose network.

**Backend ids are required.** A trace names each CSMS by its backend `id` (see [Routing configuration](#routing-configuration)), never by its URL. With archiving enabled, the gateway refuses to start if a backend has no `id`, and a hot reload that removes one is rejected (the previous table stays in effect). A session keeps the ids of the route it connected with.

### Choosing what is archived

Every scope is archived by default. Set `"trace": false` on a tenant to relay its chargers exactly as before but keep their frames out of the archive — e.g. a public demo tenant, where anyone can connect a charger and so controls the write volume:

```json
{
  "default": { "primary": { "id": "csms", "url": "wss://csms.example.com/ocpp" } },
  "tenants": {
    "tenant-a": { "default": { "primary": { "id": "csms-a", "url": "wss://csms-a.example.com/ocpp" } } },
    "demo": { "trace": false, "default": { "primary": { "id": "csms-demo", "url": "wss://demo.example.com/ocpp" } } }
  }
}
```

- At the root of the routes file, `"trace": false` excludes the **global scope only** — connections that resolve no tenant. It never applies to the tenants, which keep their own setting (default `true`).
- The choice is made when a charger connects, like its route: an excluded session does no archiving work at all (its frames are not even parsed). A change of the routes file applies to new connections; a session already open keeps archiving, or not, until it reconnects — restart the gateway to apply it at once.
- Backend ids are still required in every scope while `TRACE_ENABLED=true`, so a reload can re-enable a scope at any time.
- Without `TRACE_ENABLED=true`, `trace` has no effect.
- The `proxy listening` and `routes reloaded` log lines list the excluded scopes in `untraced` (`null` for the global scope), and `charger connected` tells whether that session is archived (`traced`).

### What is stored

One document per received frame — never one per destination, and a frame replayed after a secondary reconnects is not stored again:

```json
{
  "_id": "6f1c0d0e-…",
  "kind": "trace",
  "tenantId": "tenant-a",
  "sessionId": "b2a4…",
  "chargePointId": "CP-001",
  "seq": 12,
  "receivedAt": { "$date": "2026-10-11T10:00:00.000Z" },
  "expiresAt": { "$date": "2026-11-10T10:00:00.000Z" },
  "deliveries": [
    { "target": "csms-a", "role": "primary", "status": "written", "updatedAt": { "$date": "…" } },
    { "target": "analytics", "role": "secondary", "status": "queued", "updatedAt": { "$date": "…" } }
  ],
  "trace": {
    "schemaVersion": "1.1",
    "timestamp": "2026-10-11T10:00:00.000Z",
    "ocppVersion": "1.6",
    "transport": "json",
    "chargePointId": "CP-001",
    "connectorId": 1,
    "direction": "cp-to-csms",
    "messageType": "CALL",
    "messageId": "19223201",
    "action": "StatusNotification",
    "payload": { "connectorId": 1, "status": "Charging", "errorCode": "NoError" },
    "raw": "[2,\"19223201\",\"StatusNotification\",{\"connectorId\":1,\"status\":\"Charging\",\"errorCode\":\"NoError\"}]",
    "meta": {
      "gateway": {
        "traceId": "6f1c0d0e-…",
        "tenantId": "tenant-a",
        "sessionId": "b2a4…",
        "seq": 12,
        "source": { "type": "charge-point", "id": "CP-001" },
        "destinations": [
          { "target": "csms-a", "role": "primary" },
          { "target": "analytics", "role": "secondary" }
        ]
      }
    }
  }
}
```

- **`trace`** is a standard Open OCPP Trace record, valid against the spec's JSON Schema, and never modified once written. `raw` is the frame exactly as received (never re-serialised); `payload` is its parsed form. `direction` is relative to the charge point / CSMS pair. Gateway extensions live under `meta.gateway`, the spec's extension point:
  - `tenantId` (`null` without tenant), `sessionId` (one per charger WebSocket connection, so two connections of the same charger never mix), `seq` (reception order within the session), `traceId` (the document `_id`);
  - `source`: `{ "type": "charge-point", "id": <chargeBoxId> }` or `{ "type": "csms", "id": <backend id>, "role": "primary" | "secondary" }`;
  - `destinations`: where the routing sent the frame, fixed at reception (the primary then each secondary for a charger frame, the charger for a primary frame, none for a secondary frame);
  - `ignored: true` on secondary CSMS frames, which are archived but never forwarded;
  - `correlation: { callTraceId, action }` on a CALLRESULT or CALLERROR that answers a known CALL (see below);
  - `binary: true` when the frame arrived as a binary WebSocket message.
- **`deliveries`** (in the document, not in `trace`, because it keeps changing after the frame is received) has one entry per destination, in the same order, with the latest known outcome:

| Status      | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `queued`    | Held by the gateway while the link is not open (primary connecting, secondary reconnecting)  |
| `submitted` | Handed to the WebSocket                                                                       |
| `written`   | The WebSocket wrote it to the TCP connection. **Not** a proof the peer received or processed it: only an OCPP response is |
| `failed`    | The WebSocket reported an error (`reason` holds it)                                           |
| `dropped`   | Discarded by the gateway — `reason`: `queue-overflow` (oldest message evicted from a full queue), `session-ended` (still queued when the session ended), `link-not-open` (the link was closing or closed) |

  Statuses only move forward (`queued` → `submitted` → a final status), so a late or repeated update never overwrites a newer one. Usually a frame is written once, with its final outcome already known.
- **`kind: "frame"`** documents hold frames that Open OCPP Trace v1.1 cannot represent, so that no record falsely claims conformance: invalid JSON, not an OCPP-J array, wrong length, a numeric message id (OCPP requires a string, and the record would contradict `raw`), OCPP 2.1 message types (`SEND`, `CALLRESULTERROR`), non-string `action` or error code/description, a binary frame that is not valid UTF-8. They carry `frame: { timestamp, ocppVersion, chargePointId, direction, raw, reason, meta }` instead of `trace`. A record too large for a MongoDB document once parsed (BSON can take several times the JSON size) is also stored this way, with `reason: "document-too-large"`: `raw` is kept whole, never truncated. The gateway's own `__pong__` keepalive text from some CSMS is not OCPP and is not archived.
- **Indexes:** `{ expiresAt: 1 }` (TTL), `{ tenantId: 1, chargePointId: 1, receivedAt: 1 }` (a charger's history) and `{ tenantId: 1, sessionId: 1, seq: 1 }` (one session in order; a `messageId` lookup within a session only scans that session's documents). They are checked before every write, and the missing ones are created, also when the collection is dropped while the gateway runs (`trace indexes missing, recreating them`, then `trace indexes recreated`, are logged once). An index with the expected name but other options (no expiry, `partialFilterExpression`, `sparse`, `hidden`…) does not count. A collection created beforehand, for example capped, is kept as is: only its missing indexes are added. If they cannot be created (e.g. a MongoDB user allowed to insert but not to create indexes, or a conflicting existing index), every batch fails, is retried, then dropped and counted, and `trace store unavailable` logs the cause. Forwarding is unaffected. The MongoDB user needs `insert`, `update`, `listCollections`, `listIndexes` and `createIndex` on the collection (all in the built-in `readWrite` role).
- **Capped collection (`TRACE_REQUIRE_CAPPED=true`):** to bound the archive's disk usage as well as its age, create `ocpp_traces` yourself as a capped collection (e.g. `db.createCollection("ocpp_traces", { capped: true, size: 5 * 1024 ** 3 })`) before enabling archiving. The gateway then only writes into that collection, adding its missing indexes, and never creates it: while it is missing or not capped (for example dropped and not yet recreated), every batch fails as above and the cause is logged. Off by default, and then a dropped collection is recreated uncapped by the next write. **Required in any deployment whose disk usage is bounded by that cap** (for example when a public tenant can write continuously): without it, a drop silently lifts the bound. The gateway only checks that the collection is capped, not its size: check the size in your own monitoring (`db.ocpp_traces.stats().maxSize`).
- **Limit:** the check runs just before each batch, not atomically with it. A drop landing between the two lets that one batch into a collection MongoDB recreates on insert, uncapped and without indexes: at most 500 traces per drop, since the writer sends one batch of at most 500 documents at a time and checks again before the next. By default the next batch, or the first one after a restart, recreates the TTL index, which then expires those traces too. With `TRACE_REQUIRE_CAPPED`, the next batches fail until you drop that uncapped collection and recreate it capped.

### Requests, responses, primary and secondaries

A response is correlated with its CALL using the Open OCPP Trace rule — same `messageId`, opposite direction, most recent CALL not yet answered — applied **per conversation**: the exchange between the charger and one CSMS within one session. A charger CALL mirrored to the primary and to secondaries can therefore be answered once in each conversation, and a secondary's response never counts as the answer to the charger. Responses get no `action` field (consumers derive it from the CALL); `meta.gateway.correlation` names the CALL and its action. An orphan response (no matching CALL, e.g. after a reconnect) has no `correlation`; an unanswered CALL simply has no response pointing to it. A response never points to a CALL whose trace the gateway refused (full queue); but a CALL accepted and then lost before reaching MongoDB (failed writes, shutdown timeout — both counted in `trace stats`) leaves its responses pointing to a missing document: persistence is asynchronous by design.

To export one conversation as a standard trace (e.g. JSONL for Open OCPP Trace tools), select the session's documents where `meta.gateway.source.id` is that CSMS, or the source is the charger and that CSMS is among `meta.gateway.destinations`, sort by `seq`, and emit `trace`. The primary's conversation is the authoritative one, the one the charger took part in. Merge `deliveries` into `meta.gateway.deliveries` if the outcomes are wanted too.

### Retention

Each document expires `TRACE_RETENTION_DAYS` after it was received: `expiresAt` is set at insert and MongoDB's TTL monitor deletes expired documents in the background, about once a minute, so deletion is not instantaneous. Changing the setting only affects new traces. Retention is global; per-tenant retention is not supported yet. Backups of the database keep traces beyond their expiry: apply the same retention to them.

### Failure behaviour

Archiving never delays nor breaks forwarding. Frames are queued in memory and written by batches in the background; MongoDB is never awaited on the forwarding path.

- MongoDB down or slow: each batch is retried twice with backoff, then dropped. The gateway starts and keeps forwarding while MongoDB is unreachable. A write fails after `serverSelectionTimeoutMS=5000` without a reachable server, or `socketTimeoutMS=30000` on a stuck connection; set either (or any other driver option, e.g. TLS) in `TRACE_MONGODB_URI` to override it.
- The in-memory queue is bounded (`TRACE_QUEUE_MAX` traces and 64 MiB estimated): when full, new traces are dropped. Memory stays bounded during an outage.
- On shutdown (`SIGTERM`/`SIGINT`), sessions end first (queued frames are recorded as `dropped`, `session-ended`), then pending traces are written for up to 3 seconds; whatever is left is dropped.
- Every loss is counted: the `trace stats` log line (every minute, when something changed) reports `accepted`, `persisted`, `writeFailures`, `dropped` (`queueFull`, `writeFailed`, `rejected`, `shutdown`), `deliveryUpdates` and the queue size; `trace store unavailable` / `trace store available again` mark outages.

### Data sensitivity

Traces contain whole OCPP payloads: RFID tags (`idTag`), transaction and meter data, firmware and vendor-specific data — personal data in many jurisdictions. Treat the database accordingly: never expose MongoDB publicly (keep it on a private network, enable authentication and TLS), restrict who can read it, and set the shortest retention that serves your purpose. The gateway never stores `Authorization` headers or CSMS URLs, and never logs the MongoDB URI.

### Known limitations

- `written` means written to the socket, not received by the peer.
- `meta.gateway.correlation.callTraceId` may name a CALL whose trace was lost after being queued (see [Requests, responses, primary and secondaries](#requests-responses-primary-and-secondaries)).
- Binary WebSocket frames are archived as the text the gateway forwards (decoded as UTF-8), flagged `binary: true`; one that is not valid UTF-8 (decoded with replacement characters) is stored as a raw frame with `reason: "lossy-binary"`, since `raw` would not be the bytes received.
- A CALL to the secondaries is correlated per secondary, but the gateway does not track the secondaries' own CALLs (the charger never sees them).
- The [Cloudflare deployment](deploy/cloudflare/) does not pass `TRACE_*` variables to the gateway.

## Development

```bash
npm install
npm run lint       # Vite+ (Oxlint + Oxfmt): lint + format check
npm run format     # Vite+ auto-fix (format + lint)
npm run typecheck  # tsc --noEmit (type check)
npm run build      # bundle with Vite+ (vp pack / Rolldown) → dist/index.cjs
npm test           # run unit + integration tests (Vitest)
npm run dev        # watch-bundle and run
```

The trace archiving tests that need a real MongoDB are skipped unless `TRACE_TEST_MONGODB_URI` is set (CI runs them with a MongoDB service):

```bash
docker run -d --rm --name ocpp-gateway-mongo -p 127.0.0.1:27017:27017 mongo:8.0
TRACE_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
```

Trace records are validated against the official Open OCPP Trace schema and reference fixtures, vendored under [`test/fixtures/open-ocpp-trace/`](test/fixtures/open-ocpp-trace/) (Apache-2.0).

Tests cover route resolution (`chargers[id]` vs `default`, per-tenant routes, target-URL construction), tenant resolution from the hostname, session isolation per `(tenantId, chargeBoxId)`, the Cloudflare Worker header boundary (`deploy/cloudflare/test/`), and end-to-end integration scenarios with mock primary/secondary CSMS servers verifying that the primary is bidirectional, secondary responses never reach the charger, and `Authorization` + sub-protocol are propagated.

### Commits & Git hooks

`npm install` sets up [husky](https://typicode.github.io/husky/) Git hooks automatically:

- **pre-commit** — `lint-staged` formats and lints the staged files (`vp fmt --write`, `vp lint --fix`).
- **commit-msg** — [commitlint](https://commitlint.js.org/) enforces [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat: …`, `fix(connection): …`).
- **pre-push** — runs the full test suite (`npm test`).

User-facing changes go in [`CHANGELOG.md`](CHANGELOG.md) under `## [Unreleased]`, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Building the Docker image

```bash
docker build -t ocpp-gateway .
```

The image uses a multi-stage build and runs as a non-root user (`node`).

## Credits

This project is a fork of [joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) by [Joulo](https://joulo.nl), extended with per-chargeBoxId routing.

## License

[MIT](LICENSE) — use it however you like.
