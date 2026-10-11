# ocpp-gateway on Cloudflare (Worker + Container)

A minimal, working example of running the **unchanged** ocpp-gateway image in a [Cloudflare Container](https://developers.cloudflare.com/containers/), with tenants resolved from the hostname:

```text
Charge Point
    │  wss://tenant-a.ocpp.example.com/CP-001
    ▼
Cloudflare Worker      strips forged internal headers, sets x-forwarded-host
    │                  = the hostname Cloudflare routed (tenant-a.ocpp.example.com)
    ▼
Cloudflare Container   node dist/index.cjs (the repository's Dockerfile)
    │                  TENANT_HOST_HEADER=x-forwarded-host → tenant-a
    ▼                  routes.json → tenants["tenant-a"] → CP-001
CSMS A
```

The Worker holds no OCPP or tenant logic: the gateway resolves the tenant (see [Multi-tenant routing](../../README.md#multi-tenant-routing)), so the same configuration works outside Cloudflare.

| File                  | Role                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/forward.ts`      | The Worker → Container trust boundary (header stripping/injection). No `cloudflare:*` import; unit-tested |
| `src/index.ts`        | The Worker entrypoint and the `OcppGateway` Container class                                              |
| `wrangler.jsonc`      | Route, variables, container image (`../../Dockerfile`) and Durable Object binding                        |
| `test/forward.test.ts`| Boundary tests, run by the root `npm test`                                                              |
| `test/smoke.test.ts`  | End-to-end test against `npm run dev` (skipped by `npm test`), see [Smoke test](#smoke-test)            |

CI (`cloudflare` job in `.github/workflows/docker.yml`) runs `npm ci`, `npm run typecheck` (the Worker against the Workers/Containers types) and `npm run dry-run` (validates `wrangler.jsonc`, bundles the Worker and builds the container image — no Cloudflare credentials, nothing deployed). The `cloudflare-smoke` job then runs the [smoke test](#smoke-test) against `npm run dev` on the runner.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan: Containers are not available on the Free plan. One always-on `basic` instance (1/4 vCPU, 1 GiB, 4 GB disk) plus its Durable Object, which never hibernates while a charger is connected, costs roughly $12–25/month at [current prices](https://developers.cloudflare.com/containers/platform/pricing/), on top of the $5 plan.
- A zone on Cloudflare (here `example.com`) with a **proxied wildcard DNS record** `*.ocpp` (e.g. `AAAA *.ocpp 100::`). Workers [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) cannot be wildcards, hence the route.
- An **edge certificate covering `*.ocpp.example.com`**: Universal SSL only covers first-level subdomains (`*.example.com`), so use Advanced Certificate Manager / Total TLS, or put tenants directly under the zone (`*.example.com`).
- Docker (or a compatible engine) running locally: `wrangler` builds the image from the repository's `Dockerfile` (`linux/amd64`).
- Node 24 (see the repository's `mise.toml`).

## Configuration

| Name                 | Kind                | Description                                                                                          |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `TENANT_BASE_DOMAIN` | `vars`              | Tenants are subdomains of this domain: `tenant-a.ocpp.example.com` → `tenant-a`                       |
| `ROUTES_JSON`        | required secret     | The gateway's routing table (the `routes.json` content), written to `/tmp/routes.json` at start. Listed in `secrets.required`: `wrangler deploy` fails while it is unset |
| `LOG_LEVEL`          | `vars`              | Gateway log level (`debug`, `info`, `warn`, `error`)                                                 |
| `routes[].pattern`   | `wrangler.jsonc`    | `*.ocpp.example.com/*` on your zone                                                                   |

The Container class (`src/index.ts`) passes these to the gateway and also sets `TENANT_HOST_HEADER=x-forwarded-host`, `ROUTES_FILE=/tmp/routes.json` and `PORT=9000`. No other variable reaches the container: [trace archiving](../../README.md#trace-archiving-optional) (`TRACE_*`) stays disabled in this deployment. Replace every `example.com` with your own domain. `observability` is enabled so that the gateway's logs (the container's stdout) show in the dashboard.

## Deploy

```bash
cd deploy/cloudflare
npm install

# Routing table with a "tenants" map, see ../../routes.multi-tenant.example.json
cp ../../routes.multi-tenant.example.json routes.json   # edit with your CSMS URLs,
                                                        # drop the global "default" (see Security)

# First deployment: the Worker does not exist yet, so `wrangler secret put`
# cannot set ROUTES_JSON beforehand; pass it with the deployment instead.
jq -n --rawfile routes routes.json '{ROUTES_JSON: $routes}' > secrets.json
npx wrangler deploy --secrets-file secrets.json && rm secrets.json

# Later deployments
npm run deploy   # builds the image, pushes it and deploys the Worker
```

The first deployment can take a few minutes while the container is provisioned. Then point chargers at `wss://<tenant>.ocpp.example.com/<chargeBoxId>`.

**Changing the routes** (`npx wrangler secret put ROUTES_JSON < routes.json`) creates a new Worker version, which drops every connection, but a **running container keeps the routes it was started with**: `@cloudflare/containers` passes `envVars` only when it starts a container, and the file is written once at container start (hot reload does not apply). The new routes take effect when the container next starts. How to force that restart on Cloudflare has not been validated yet.

## Local development

```bash
cp .dev.vars.example .dev.vars   # routes to the smoke test's mock CSMS, see below
npm run dev                      # wrangler dev on http://localhost:8787, container in local Docker
```

`.dev.vars` is read when `npm run dev` starts, not on code reloads: restart it after editing the routes. The first request after a restart cold-starts the container (about 20 s locally).

`wrangler dev` rewrites every request URL to the host of the configured route, which would hide the tenant. `npm run dev` therefore runs with a copy of `wrangler.jsonc` without its `routes` line (`wrangler.local.jsonc`, gitignored), so the `Host` you send reaches the Worker:

```bash
# Two chargers with the same chargeBoxId, in two tenants:
npx wscat -s ocpp1.6 -H "Host: tenant-a.ocpp.example.com" -c ws://127.0.0.1:8787/CP-001
npx wscat -s ocpp1.6 -H "Host: tenant-b.ocpp.example.com" -c ws://127.0.0.1:8787/CP-001
```

From inside the local container, a CSMS running on your machine is reachable at `ws://host.docker.internal:<port>`. The gateway's logs are the container's stdout: `docker logs <container>`.

### Smoke test

`test/smoke.test.ts` drives the running Worker + Container end to end against mock CSMS on this machine (ports 9100–9102, the ones `.dev.vars.example` routes to). It is skipped unless `SMOKE_GATEWAY_URL` is set (CI runs it in the `cloudflare-smoke` job):

```bash
# from the repository root, with `npm run dev` running
SMOKE_GATEWAY_URL=http://127.0.0.1:8787 npx vitest run deploy/cloudflare/test/smoke.test.ts

# also boot against a real CSMS: add a tenant routed to it in .dev.vars, e.g.
# "steve": { "default": { "primary": "wss://csms.example.com/steve/websocket/CentralSystemService" } },
# and register the chargeBoxId there; set SMOKE_REAL_AUTHORIZATION to send an Authorization header
SMOKE_GATEWAY_URL=http://127.0.0.1:8787 SMOKE_REAL_TENANT=steve SMOKE_REAL_CHARGE_BOX_ID=CP-001 \
  npx vitest run deploy/cloudflare/test/smoke.test.ts -t "real CSMS"
```

To keep a charger connected for hours (a Heartbeat every minute; the replies are printed):

```bash
while sleep 60; do echo '[2,"hb","Heartbeat",{}]'; done |
  websocat -t --protocol ocpp1.6 wss://tenant-a.ocpp.example.com/CP-SOAK
```

`websocat` does not replace the `Host` header, so against `npm run dev` this charger names no tenant and uses the global routes.

## Security: the trust boundary

**Why a tenant header sent by the client is not trusted.** A charger controls every header it sends. If the gateway accepted `X-OCPP-Tenant`, `X-Forwarded-Host` or similar as-is, any charger could attach itself to another tenant's routes and CSMS, whatever hostname it dialled. The hostname a charger dials is also client-chosen, but it only decides which tenant's CSMS will authenticate the charger — it gives no extra power.

**Where the boundary is.** Behind the Container SDK the `Host` header reaching the gateway is not guaranteed to be the hostname the charger dialled, so the hostname travels in `x-forwarded-host`. The gateway trusts that header only because `TENANT_HOST_HEADER` names it, and it then ignores `Host` entirely. The boundary is therefore **the Worker**:

- a Container has no public ingress: it is only reachable through its Durable Object, i.e. through this Worker;
- the Worker **deletes** any client-supplied `x-forwarded-host` and **sets** it from `request.url` — the hostname Cloudflare actually routed;
- the Worker also deletes `cf-container-target-port`, which the Container SDK would otherwise use to let a client pick any port inside the container;
- the WebSocket handshake, the OCPP sub-protocol (`Sec-WebSocket-Protocol`) and `Authorization` pass through untouched; the CSMS still authenticates the charger.

These rules are covered by `test/forward.test.ts` (header overwrite, stripping, pass-through). On the gateway side the boundary fails closed: a request without `x-forwarded-host` (one that did not come through the Worker) or with it twice is rejected with 1008 before any upstream is dialled. Still, never run the gateway with `TENANT_HOST_HEADER` set where clients can reach it directly.

**Omit the global `default` from `ROUTES_JSON`.** The route `*.ocpp.example.com/*` also matches nested names (`*` matches any characters), and the gateway resolves `a.b.ocpp.example.com` to no tenant, i.e. to the global routes (checked with `npm run dev`). Behind this Worker every legitimate charger names a tenant, so global routes are only reachable through such names.

## Design choices

- **One container for all tenants** (`getContainer(env.OCPP_GATEWAY)`): sessions live in the gateway's memory, so a reconnecting charger must reach the instance that holds its previous session. A single instance guarantees that and keeps one routing table. Per-tenant instances (`getContainer(env.OCPP_GATEWAY, tenantId)`) would isolate tenants further, but require the Worker to resolve the tenant too — a later step.
- **`ROUTES_JSON` secret + entrypoint** rather than a routes file baked into a custom image: the image stays the repository's own, and no tenant configuration ends up in an image.
- **No Durable Object logic, no D1/R2**: the Durable Object is only the Container SDK's handle on the container.

## Known limitations

- **WebSocket ping/pong is not end to end.** The Container SDK relays WebSocket *messages* between the charger and the container through the Durable Object; the Workers runtime answers ping frames itself. OCPP traffic (CALL / CALLRESULT / CALLERROR) is unaffected, but the gateway's ping/pong forwarding between charger and primary does not apply. OCPP `Heartbeat` messages are still relayed.
- **Every deploy drops all connections** (Worker code updates restart the Durable Object); container image rollouts stop the container. Chargers reconnect on their own; plan deploys accordingly. Cloudflare may also restart hosts at any time. With `npm run dev`, a Worker reload closes chargers with 1006 while the container keeps running, and they reconnect to it at once; a container stop (SIGTERM) closes them with `1001 Server shutting down` (the gateway exits in well under a second).
- **Close codes 1005/1006 become 1000** across the relay: a crashed container closes chargers with `1000 WebSocket disconnected without sending Close frame`.
- **`req.socket.remoteAddress`** in the gateway logs is the relay's address, not the charger's.
- **The Durable Object stays active for as long as a charger is connected** (no WebSocket hibernation with the Container relay); check Cloudflare's pricing for long-lived connections.
- **Single instance** limits throughput to one container (`instance_type: basic`); scale it with a larger `instance_type`, or move to per-tenant instances.
- **Custom domains** (`hostnames` in the routes file) work in the gateway, but reaching the Worker on a customer's domain requires Cloudflare for SaaS custom hostnames, which is out of scope here.
