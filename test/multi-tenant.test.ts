import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "../src/config";
import {
  boot,
  connectWhenOpen,
  makeCsms,
  rawUpgradeCloseCode as rawUpgrade,
  sleep,
  startGateway,
  waitFor,
  waitForClose,
} from "./helpers";

const AUTH = "Basic dXNlcjpwYXNz";

type Csms = ReturnType<typeof makeCsms>;

let cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function csms(tag: string): Promise<Csms> {
  const server = makeCsms(tag);
  await once(server.wss, "listening");
  cleanup.push(() => server.close());
  return server;
}

async function gateway(table: object, overrides: Partial<Config> = {}) {
  const gw = await startGateway(table, { tenantBaseDomain: "ocpp.example.com", ...overrides });
  cleanup.push(() => gw.close());
  return gw;
}

/** Open a charger connection to the gateway as if it dialled `host`. */
async function charger(
  port: number,
  host: string,
  options: { id?: string; protocol?: string; headers?: Record<string, string> } = {},
) {
  const ws = await connectWhenOpen(
    `ws://127.0.0.1:${port}/ocpp/${options.id ?? "CP-001"}`,
    options.protocol ?? "ocpp1.6",
    3000,
    { host, Authorization: AUTH, ...options.headers },
  );
  cleanup.push(() => ws.close());
  const received: string[] = [];
  ws.on("message", (data) => received.push(data.toString()));
  return { ws, received };
}

describe("multi-tenant routing", () => {
  it("routes tenant-a/CP-001 and tenant-b/CP-001 to their own CSMS, side by side", async () => {
    const csmsA = await csms("csms-a");
    const csmsB = await csms("csms-b");
    const gw = await gateway({
      tenants: {
        "tenant-a": { chargers: { "CP-001": { primary: csmsA.url() } } },
        "tenant-b": { chargers: { "CP-001": { primary: csmsB.url() } } },
      },
    });

    // Same chargeBoxId, same credentials: only the tenant tells them apart.
    const a = await charger(gw.port, "tenant-a.ocpp.example.com");
    const b = await charger(gw.port, "tenant-b.ocpp.example.com");

    a.ws.send(boot("from-a"));
    b.ws.send(boot("from-b"));
    await waitFor(() => csmsA.received().length >= 1 && csmsB.received().length >= 1);
    await waitFor(() => a.received.length >= 1 && b.received.length >= 1);

    // Frames are forwarded untouched, each to its own tenant's CSMS only.
    expect(csmsA.received()).toEqual([boot("from-a")]);
    expect(csmsB.received()).toEqual([boot("from-b")]);
    expect(a.received.every((m) => m.includes('"from":"csms-a"'))).toBe(true);
    expect(b.received.every((m) => m.includes('"from":"csms-b"'))).toBe(true);

    // tenant-b's CP-001 did not evict tenant-a's CP-001.
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(csmsA.path()).toBe("/CP-001");
    expect(csmsB.path()).toBe("/CP-001");
  });

  it("still replaces a reconnecting charger within the same tenant", async () => {
    const csmsA = await csms("csms-a");
    const gw = await gateway({
      tenants: { "tenant-a": { default: { primary: csmsA.url() } } },
    });

    const first = await charger(gw.port, "tenant-a.ocpp.example.com");
    await waitFor(() => csmsA.connected());
    const firstClosed = waitForClose(first.ws);

    await charger(gw.port, "tenant-a.ocpp.example.com");

    expect((await firstClosed).code).toBe(1000);
  });

  it("resolves a tenant from an explicit hostname (custom domain)", async () => {
    const csmsA = await csms("csms-a");
    const gw = await gateway({
      tenants: {
        "tenant-a": {
          hostnames: ["ocpp.customer-a.example"],
          default: { primary: csmsA.url() },
        },
      },
    });

    await charger(gw.port, "OCPP.Customer-A.example:443");

    await waitFor(() => csmsA.connected());
  });

  it.each(["ocpp2.0.1", "ocpp2.0", "ocpp1.6"])(
    "keeps the %s subprotocol, Basic Auth and secondary mirroring within a tenant",
    async (protocol) => {
      const primary = await csms("primary");
      const secondary = await csms("secondary");
      const gw = await gateway({
        tenants: {
          "tenant-a": {
            default: {
              primary: primary.url(),
              secondaries: [secondary.url()],
            },
          },
        },
      });

      const a = await charger(gw.port, "tenant-a.ocpp.example.com", { protocol });
      a.ws.send(boot("m-1"));
      await waitFor(() => secondary.received().length >= 1 && a.received.length >= 1);
      await sleep(100);

      expect(a.ws.protocol).toBe(protocol);
      expect(primary.protocol()).toBe(protocol);
      expect(secondary.protocol()).toBe(protocol);
      expect(primary.auth()).toBe(AUTH);
      expect(secondary.auth()).toBe(AUTH);
      expect(secondary.received()).toEqual([boot("m-1")]);
      // Only the primary answers the charger; the tenant host is not leaked upstream.
      expect(a.received.every((m) => m.includes('"from":"primary"'))).toBe(true);
      expect(primary.host()).toBe(`127.0.0.1:${primary.port()}`);
    },
  );
});

describe("multi-tenant rejection and fallback", () => {
  it("closes the connection with 1008 for an unknown tenant", async () => {
    const csmsA = await csms("csms-a");
    const gw = await gateway({
      default: { primary: csmsA.url() },
      tenants: { "tenant-a": { default: { primary: csmsA.url() } } },
    });

    const ghost = await charger(gw.port, "ghost.ocpp.example.com");
    const closed = await waitForClose(ghost.ws);

    expect(closed.code).toBe(1008);
    // An unknown tenant never falls back to the global routes.
    await sleep(50);
    expect(csmsA.connected()).toBe(false);
  });

  it("closes with 1008 when the tenant has no route for the charger", async () => {
    const csmsA = await csms("csms-a");
    const gw = await gateway({
      tenants: {
        "tenant-a": { chargers: { "CP-001": { primary: csmsA.url() } } },
      },
    });

    const other = await charger(gw.port, "tenant-a.ocpp.example.com", { id: "CP-999" });

    expect((await waitForClose(other.ws)).code).toBe(1008);
  });

  it("uses the global routes for a host that names no tenant", async () => {
    const globalCsms = await csms("global");
    const gw = await gateway({
      default: { primary: globalCsms.url() },
      tenants: { "tenant-a": { default: { primary: "ws://127.0.0.1:1" } } },
    });

    await charger(gw.port, `127.0.0.1:${gw.port}`);

    await waitFor(() => globalCsms.connected());
  });

  it("closes with 1008 for a host that names no tenant when there are no global routes", async () => {
    const csmsA = await csms("csms-a");
    const gw = await gateway({
      tenants: { "tenant-a": { default: { primary: csmsA.url() } } },
    });

    const stranger = await charger(gw.port, "ocpp.example.com");

    expect((await waitForClose(stranger.ws)).code).toBe(1008);
  });
});

/** A raw upgrade of `/CP-001` with the charger's credentials (see `rawUpgrade`). */
const rawUpgradeCloseCode = (port: number, headerLines: string[]) =>
  rawUpgrade(port, [...headerLines, `Authorization: ${AUTH}`]);

describe("ambiguous host header fails closed", () => {
  // A global default is present in every case: an ambiguous host must be
  // rejected, never routed (with the charger's Authorization) to the global CSMS.
  async function setup(overrides: Partial<Config> = {}) {
    const csmsA = await csms("csms-a");
    const globalCsms = await csms("global");
    const gw = await gateway(
      {
        default: { primary: globalCsms.url() },
        tenants: { "tenant-a": { default: { primary: csmsA.url() } } },
      },
      overrides,
    );
    const reachedNoUpstream = async () => {
      await sleep(100);
      expect({ global: globalCsms.connected(), tenantA: csmsA.connected() }).toEqual({
        global: false,
        tenantA: false,
      });
    };
    return { gw, reachedNoUpstream };
  }

  it("rejects a request carrying two Host headers", async () => {
    const { gw, reachedNoUpstream } = await setup();

    const code = await rawUpgradeCloseCode(gw.port, [
      "Host: tenant-a.ocpp.example.com",
      "Host: tenant-a.ocpp.example.com",
    ]);

    await reachedNoUpstream();
    expect(code).toBe(1008);
  });

  it("rejects a request without a Host header", async () => {
    const { gw, reachedNoUpstream } = await setup();

    const code = await rawUpgradeCloseCode(gw.port, []);

    await reachedNoUpstream();
    expect(code).toBe(1008);
  });

  it("rejects a request missing the trusted host header", async () => {
    const { gw, reachedNoUpstream } = await setup({ tenantHostHeader: "x-forwarded-host" });

    const code = await rawUpgradeCloseCode(gw.port, ["Host: tenant-a.ocpp.example.com"]);

    await reachedNoUpstream();
    expect(code).toBe(1008);
  });

  it("rejects a request carrying the trusted host header twice", async () => {
    const { gw, reachedNoUpstream } = await setup({ tenantHostHeader: "x-forwarded-host" });

    const code = await rawUpgradeCloseCode(gw.port, [
      "Host: container.internal",
      "X-Forwarded-Host: tenant-a.ocpp.example.com",
      "X-Forwarded-Host: tenant-a.ocpp.example.com",
    ]);

    await reachedNoUpstream();
    expect(code).toBe(1008);
  });
});

describe("backward compatibility without TENANT_BASE_DOMAIN", () => {
  it("routes a legacy table by chargeBoxId only, whatever the Host header", async () => {
    const globalCsms = await csms("global");
    const gw = await gateway(
      { default: { primary: globalCsms.url() } },
      { tenantBaseDomain: undefined },
    );

    await charger(gw.port, "tenant-a.ocpp.example.com");

    await waitFor(() => globalCsms.connected());
  });

  it("rejects a subdomain once TENANT_BASE_DOMAIN is set but the tenant is not declared", async () => {
    const globalCsms = await csms("global");
    const gw = await gateway({ default: { primary: globalCsms.url() } });

    const legacy = await charger(gw.port, "tenant-a.ocpp.example.com");

    expect((await waitForClose(legacy.ws)).code).toBe(1008);
    expect(globalCsms.connected()).toBe(false);
  });
});

describe("trusted host header (reverse proxy boundary)", () => {
  async function setupTrusted(overrides: Partial<Config>) {
    const csmsA = await csms("csms-a");
    const globalCsms = await csms("global");
    const gw = await gateway(
      {
        default: { primary: globalCsms.url() },
        tenants: { "tenant-a": { default: { primary: csmsA.url() } } },
      },
      overrides,
    );
    return { csmsA, globalCsms, gw };
  }

  it("ignores X-Forwarded-Host unless it is configured as the trusted header", async () => {
    const { csmsA, globalCsms, gw } = await setupTrusted({});

    await charger(gw.port, `127.0.0.1:${gw.port}`, {
      headers: { "X-Forwarded-Host": "tenant-a.ocpp.example.com" },
    });

    await waitFor(() => globalCsms.connected());
    expect(csmsA.connected()).toBe(false);
  });

  it("resolves the tenant from the trusted header, not from Host", async () => {
    const { csmsA, globalCsms, gw } = await setupTrusted({ tenantHostHeader: "x-forwarded-host" });

    await charger(gw.port, "container.internal", {
      headers: { "X-Forwarded-Host": "tenant-a.ocpp.example.com" },
    });

    await waitFor(() => csmsA.connected());
    expect(globalCsms.connected()).toBe(false);
  });
});
