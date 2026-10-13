import { once } from "node:events";
import { type Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "../src/config";
import { configureLogger } from "../src/logger";
import {
  makeCsms,
  rawUpgradeCloseCode,
  sleep,
  startGateway,
  waitFor,
  waitForClose,
  waitForOpen,
} from "./helpers";

type Csms = ReturnType<typeof makeCsms>;

let cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function csms(options: { holdHandshakes?: boolean } = {}): Promise<Csms> {
  const server = makeCsms("csms", 0, options);
  await once(server.wss, "listening");
  cleanup.push(() => server.close());
  return server;
}

async function gateway(upstream: Csms, overrides: Partial<Config> = {}) {
  const gw = await startGateway({ default: { primary: upstream.url() } }, overrides);
  cleanup.push(() => gw.close());
  return gw;
}

/** Connections the CSMS saw, accepted or parked: every upstream dial the gateway made. */
const upstreamAttempts = (upstream: Csms) =>
  upstream.heldHandshakes() + upstream.connections().length;

let credentials = 0;

/**
 * Dial the gateway as a charger. Each call presents its own `Authorization`
 * unless one is given, so session replacement never bounds anything.
 */
function dial(
  port: number,
  { id = "CP-001", auth, headers = {} }: { id?: string; auth?: string; headers?: object } = {},
) {
  credentials += 1;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${id}`, "ocpp1.6", {
    headers: { Authorization: auth ?? `Basic attempt-${credentials}`, ...headers },
  });
  cleanup.push(() => ws.terminate());
  return ws;
}

const closeCode = async (ws: WebSocket) => (await waitForClose(ws)).code;

/** The close code of a session refused by a limit: `1013` Try Again Later. */
const TRY_AGAIN_LATER = 1013;

describe("per-source session limit", () => {
  it("rejects the connection past the cap even when each one sends different credentials, without dialling upstream", async () => {
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream, { maxSessionsPerSource: 2 });

    await waitForOpen(dial(gw.port));
    await waitForOpen(dial(gw.port));
    await waitFor(() => upstream.heldHandshakes() === 2);

    const codes = await Promise.all([dial(gw.port), dial(gw.port), dial(gw.port)].map(closeCode));
    expect(codes).toEqual([TRY_AGAIN_LATER, TRY_AGAIN_LATER, TRY_AGAIN_LATER]);
    await sleep(100);
    expect(upstreamAttempts(upstream)).toBe(2);
  });

  it("buckets by socket address when CLIENT_IP_HEADER is unset, ignoring forwarded headers", async () => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1 });

    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } }));
    const second = dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } });

    expect(await closeCode(second)).toBe(TRY_AGAIN_LATER);
  });

  it("buckets by CLIENT_IP_HEADER when set, not by the proxy's address", async () => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1, clientIpHeader: "x-real-ip" });

    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } }));
    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } }));
    await waitFor(() => upstream.connections().length === 2);

    const again = dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } });
    expect(await closeCode(again)).toBe(TRY_AGAIN_LATER);
  });
});

describe("global and pending session limits", () => {
  it("caps live sessions across sources", async () => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessions: 2, clientIpHeader: "x-real-ip" });

    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } }));
    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } }));
    const third = dial(gw.port, { headers: { "x-real-ip": "198.51.100.3" } });

    expect(await closeCode(third)).toBe(TRY_AGAIN_LATER);
    await sleep(100);
    expect(upstreamAttempts(upstream)).toBe(2);
  });

  it("caps sessions still connecting to their primary across sources, and frees a slot once it opens", async () => {
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream, {
      maxSessions: 2,
      maxPendingSessions: 1,
      clientIpHeader: "x-real-ip",
    });

    const first = dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } });
    await waitForOpen(first);
    await waitFor(() => upstream.heldHandshakes() === 1);
    const refused = dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } });
    expect(await closeCode(refused)).toBe(TRY_AGAIN_LATER);

    // Queued while connecting, flushed by the gateway once the primary opened:
    // its arrival proves the gateway saw the open, not just the CSMS.
    first.send("queued");
    upstream.releaseHandshakes();
    await waitFor(() => upstream.received().length === 1);
    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } }));
    await waitFor(() => upstream.heldHandshakes() === 1);

    // The opened session no longer counts as pending, but still counts as live.
    const third = dial(gw.port, { headers: { "x-real-ip": "198.51.100.3" } });
    expect(await closeCode(third)).toBe(TRY_AGAIN_LATER);
    expect(upstreamAttempts(upstream)).toBe(2);
  });
});

describe("a session frees its slot on every exit path", () => {
  /** A gateway that admits a single session, and that session, connected upstream. */
  async function fullGateway(overrides: Partial<Config> = {}) {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessions: 1, ...overrides });
    const charger = dial(gw.port);
    await waitForOpen(charger);
    await waitFor(() => upstream.connections().length === 1);
    const primaryLink = upstream.connections()[0].ws;
    return { upstream, gw, charger, primaryLink };
  }

  /** A new session, with other credentials, gets through to the CSMS. */
  async function expectAdmitted(gw: { port: number }, upstream: Csms, upstreamCount: number) {
    await waitForOpen(dial(gw.port));
    await waitFor(() => upstream.connections().length === upstreamCount);
  }

  it("when the charger closes", async () => {
    const { upstream, gw, charger, primaryLink } = await fullGateway();
    const primaryClosed = once(primaryLink, "close");
    charger.close();
    await primaryClosed;

    await expectAdmitted(gw, upstream, 2);
  });

  it("when the charger sends an oversized message (1009)", async () => {
    const { upstream, gw, charger, primaryLink } = await fullGateway({ maxMessageBytes: 1024 });
    const primaryClosed = once(primaryLink, "close");
    charger.send("x".repeat(2048));
    expect(await closeCode(charger)).toBe(1009);
    await primaryClosed;

    await expectAdmitted(gw, upstream, 2);
  });

  it("when the primary closes", async () => {
    const { upstream, gw, charger, primaryLink } = await fullGateway();
    primaryLink.close();
    expect(await closeCode(charger)).toBe(1001);

    await expectAdmitted(gw, upstream, 2);
  });

  it("when the primary refuses the handshake", async () => {
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream, { maxSessions: 1, maxPendingSessions: 1 });
    const charger = dial(gw.port);
    await waitFor(() => upstream.heldHandshakes() === 1);

    upstream.rejectHandshakes();
    expect(await closeCode(charger)).toBe(1011);

    await waitForOpen(dial(gw.port));
    await waitFor(() => upstream.heldHandshakes() === 1);
  });

  it("when it is replaced: the replacement takes the freed slot", async () => {
    const auth = "Basic same-charger";
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessions: 1, maxSessionsPerSource: 1 });
    const stale = dial(gw.port, { auth });
    await waitForOpen(stale);

    const fresh = dial(gw.port, { auth });
    await waitForOpen(fresh);
    expect(await closeCode(stale)).toBe(1000);
    await waitFor(() => upstream.connections().length === 2);

    // The replacement holds the only slot: other credentials are refused.
    expect(await closeCode(dial(gw.port))).toBe(TRY_AGAIN_LATER);
    expect(fresh.readyState).toBe(WebSocket.OPEN);
  });
});

describe("CLIENT_IP_HEADER fails closed", () => {
  const AUTH = "Authorization: Basic dXNlcjpwYXNz";

  it.each([
    { description: "missing", lines: [] },
    { description: "duplicated", lines: ["X-Real-IP: 198.51.100.1", "X-Real-IP: 198.51.100.2"] },
    { description: "empty", lines: ["X-Real-IP: "] },
  ])("closes with 1008 when the header is $description, never counting it", async ({ lines }) => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessions: 1, clientIpHeader: "x-real-ip" });

    for (let i = 0; i < 3; i++) {
      expect(await rawUpgradeCloseCode(gw.port, ["Host: 127.0.0.1", AUTH, ...lines])).toBe(1008);
    }
    expect(upstreamAttempts(upstream)).toBe(0);

    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.1" } }));
    await waitFor(() => upstream.connections().length === 1);
  });

  it("is enforced even without a per-source limit", async () => {
    const upstream = await csms();
    const gw = await gateway(upstream, { clientIpHeader: "x-real-ip" });

    expect(await rawUpgradeCloseCode(gw.port, ["Host: 127.0.0.1", AUTH])).toBe(1008);
    expect(upstreamAttempts(upstream)).toBe(0);
  });
});

describe("unrouted charge points and session limits", () => {
  async function tenantGateway(upstream: Csms) {
    const gw = await startGateway(
      { tenants: { "tenant-a": { chargers: { "CP-001": { primary: upstream.url() } } } } },
      { tenantBaseDomain: "ocpp.example.com", maxSessionsPerSource: 1 },
    );
    cleanup.push(() => gw.close());
    return gw;
  }
  const host = { host: "tenant-a.ocpp.example.com" };

  it("closes them with 1008 without counting them, so they cannot lock a source out", async () => {
    const upstream = await csms();
    const gw = await tenantGateway(upstream);

    for (let i = 0; i < 5; i++) {
      expect(await closeCode(dial(gw.port, { id: `CP-9${i}`, headers: host }))).toBe(1008);
    }
    await waitForOpen(dial(gw.port, { headers: host }));
    await waitFor(() => upstream.connections().length === 1);
  });

  it("still closes them with 1008 once the source is full", async () => {
    const upstream = await csms();
    const gw = await tenantGateway(upstream);
    await waitForOpen(dial(gw.port, { headers: host }));

    expect(await closeCode(dial(gw.port, { id: "CP-999", headers: host }))).toBe(1008);
    expect(upstreamAttempts(upstream)).toBe(1);
  });
});

describe("rejection logs", () => {
  it("log a flood of rejections from one source once, not once per connection", async () => {
    // Only the admission path's lines: an earlier test's sessions may still be ending.
    const warnings: { tag: string; msg: string }[] = [];
    configureLogger({
      logLevel: "warn",
      sink: {
        stdout: (line) => {
          const entry = JSON.parse(line) as { tag: string; msg: string };
          if (entry.tag === "proxy") warnings.push(entry);
        },
        stderr: () => undefined,
      },
    });
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1 });
    await waitForOpen(dial(gw.port));

    for (let i = 0; i < 5; i++) expect(await closeCode(dial(gw.port))).toBe(TRY_AGAIN_LATER);

    expect(warnings).toEqual([
      expect.objectContaining({
        msg: "connection rejected",
        reason: "per-source",
        source: "127.0.0.1",
      }),
    ]);
  });
});

describe("without limits", () => {
  it("admits every session, as before", async () => {
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream);

    await Promise.all(Array.from({ length: 20 }, () => waitForOpen(dial(gw.port))));
    await waitFor(() => upstream.heldHandshakes() === 20);
  });
});

describe("a refused connection that misbehaves", () => {
  // Clients must mask their frames: ws errors on this socket after it is refused.
  const UNMASKED_TEXT_FRAME = Buffer.from([0x81, 0x01, 0x41]);

  it.each([
    { description: "over a limit (1013)", id: "CP-001", expected: TRY_AGAIN_LATER },
    { description: "unrouted (1008)", id: "CP-999", expected: 1008 },
  ])("never brings the gateway down when $description", async ({ id, expected }) => {
    const upstream = await csms();
    const gw = await startGateway(
      { tenants: { "tenant-a": { chargers: { "CP-001": { primary: upstream.url() } } } } },
      { tenantBaseDomain: "ocpp.example.com", maxSessions: 1 },
    );
    cleanup.push(() => gw.close());
    const host = { host: "tenant-a.ocpp.example.com" };
    const admitted = dial(gw.port, { headers: host });
    await waitForOpen(admitted);

    const code = await rawUpgradeCloseCode(
      gw.port,
      [`Host: ${host.host}`],
      `/${id}`,
      UNMASKED_TEXT_FRAME,
    );
    expect(code).toBe(expected);

    admitted.close();
    await waitFor(() => upstream.connections()[0]?.ws.readyState === WebSocket.CLOSED);
    await waitForOpen(dial(gw.port, { headers: host }));
    await waitFor(() => upstream.connections().length === 2);
  });
});

describe("client sources", () => {
  const ip = (value: string) => ({ headers: { "x-real-ip": value } });

  it.each([
    { description: "not an IP address", value: "not-an-ip" },
    { description: "a list a proxy appended to", value: "203.0.113.9, 198.51.100.7" },
    { description: "an address with a port", value: "198.51.100.7:5678" },
  ])("closes with 1008 when the client IP header is $description", async ({ value }) => {
    const upstream = await csms();
    const gw = await gateway(upstream, { clientIpHeader: "x-real-ip" });

    expect(await closeCode(dial(gw.port, ip(value)))).toBe(1008);
    expect(upstreamAttempts(upstream)).toBe(0);
  });

  it.each([
    { first: "2001:db8:1:2::1", second: "2001:db8:1:2:ffff::9", shared: "one IPv6 /64" },
    { first: "198.51.100.7", second: "::ffff:198.51.100.7", shared: "an IPv4 and its mapped form" },
  ])("counts $shared as one source", async ({ first, second }) => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1, clientIpHeader: "x-real-ip" });

    await waitForOpen(dial(gw.port, ip(first)));
    expect(await closeCode(dial(gw.port, ip(second)))).toBe(TRY_AGAIN_LATER);
  });

  it("counts other IPv6 /64 blocks apart", async () => {
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1, clientIpHeader: "x-real-ip" });

    await waitForOpen(dial(gw.port, ip("2001:db8:1:2::1")));
    await waitForOpen(dial(gw.port, ip("2001:db8:1:3::1")));
    await waitFor(() => upstream.connections().length === 2);
  });
});

describe("a replacement is checked against the limits it would exceed", () => {
  /** The original session still forwards both ways: its charger and its upstream link are open. */
  async function expectStillServing(charger: WebSocket, upstream: Csms, received: number) {
    await sleep(100);
    expect(charger.readyState).toBe(WebSocket.OPEN);
    expect(upstream.connections()[0].ws.readyState).toBe(WebSocket.OPEN);
    charger.send("still here");
    await waitFor(() => upstream.received().length === received + 1);
    expect(upstream.received().at(-1)).toBe("still here");
  }

  it("is refused when the pending cap is full, leaving the open session it would replace untouched", async () => {
    const auth = "Basic same-charger";
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream, { maxPendingSessions: 1 });

    const charger = dial(gw.port, { auth });
    await waitForOpen(charger);
    charger.send("queued");
    await waitFor(() => upstream.heldHandshakes() === 1);
    upstream.releaseHandshakes();
    await waitFor(() => upstream.received().length === 1);
    await waitForOpen(dial(gw.port));
    await waitFor(() => upstream.heldHandshakes() === 1);

    const reconnect = dial(gw.port, { auth });
    expect(await closeCode(reconnect)).toBe(TRY_AGAIN_LATER);
    expect(upstreamAttempts(upstream)).toBe(2);
    await expectStillServing(charger, upstream, 1);
  });

  it("is refused from another source whose bucket is full, leaving the session it would replace untouched", async () => {
    const auth = "Basic same-charger";
    const upstream = await csms();
    const gw = await gateway(upstream, { maxSessionsPerSource: 1, clientIpHeader: "x-real-ip" });

    const charger = dial(gw.port, { auth, headers: { "x-real-ip": "198.51.100.1" } });
    await waitForOpen(charger);
    await waitFor(() => upstream.connections().length === 1);
    await waitForOpen(dial(gw.port, { headers: { "x-real-ip": "198.51.100.2" } }));
    await waitFor(() => upstream.connections().length === 2);

    const moved = dial(gw.port, { auth, headers: { "x-real-ip": "198.51.100.2" } });
    expect(await closeCode(moved)).toBe(TRY_AGAIN_LATER);
    expect(upstream.connections()).toHaveLength(2);
    await expectStillServing(charger, upstream, 0);
  });

  it("reuses the pending slot of the session it replaces", async () => {
    const auth = "Basic same-charger";
    const upstream = await csms({ holdHandshakes: true });
    const gw = await gateway(upstream, { maxPendingSessions: 1 });

    const stale = dial(gw.port, { auth });
    await waitForOpen(stale);
    await waitFor(() => upstream.heldHandshakes() === 1);

    const fresh = dial(gw.port, { auth });
    await waitForOpen(fresh);
    expect(await closeCode(stale)).toBe(1000);
    await waitFor(() => upstream.heldHandshakes() === 2);
    expect(fresh.readyState).toBe(WebSocket.OPEN);
  });
});

describe("a refused connection is not kept around", () => {
  /** Upgrade on a raw socket and resolve once the gateway's close frame arrived. */
  async function refusedSocket(port: number, path: string): Promise<Socket> {
    const socket = connect(port, "127.0.0.1");
    cleanup.push(() => socket.destroy());
    socket.on("error", () => undefined);
    await once(socket, "connect");
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => (received = Buffer.concat([received, chunk])));
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        "Host: tenant-a.ocpp.example.com",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    await waitFor(() => {
      const end = received.indexOf("\r\n\r\n");
      return end !== -1 && received[end + 4] === 0x88;
    });
    return socket;
  }

  async function fullTenantGateway() {
    const upstream = await csms();
    const gw = await startGateway(
      { tenants: { "tenant-a": { chargers: { "CP-001": { primary: upstream.url() } } } } },
      { tenantBaseDomain: "ocpp.example.com", maxSessions: 1 },
    );
    cleanup.push(() => gw.close());
    await waitForOpen(dial(gw.port, { headers: { host: "tenant-a.ocpp.example.com" } }));
    return gw;
  }

  /** Resolve true if `socket` is closed within `ms`. */
  const closedWithin = (socket: Socket, ms: number) =>
    Promise.race([once(socket, "close").then(() => true), sleep(ms).then(() => false)]);

  it.each([
    { description: "over a limit", path: "/CP-001" },
    { description: "unrouted", path: "/CP-999" },
  ])("is cut as soon as it streams data after the close, when $description", async ({ path }) => {
    const gw = await fullTenantGateway();
    const socket = await refusedSocket(gw.port, path);

    // A masked binary frame announcing just under 1 MiB, then most of it.
    const header = Buffer.from([0x82, 0xfe, 0, 0, 1, 2, 3, 4]);
    header.writeUInt16BE(0xffff, 2);
    socket.write(header);
    socket.write(Buffer.alloc(60_000));

    expect(await closedWithin(socket, 500)).toBe(true);
  });

  it("is cut shortly after the close when the client never answers it", async () => {
    const gw = await fullTenantGateway();
    const socket = await refusedSocket(gw.port, "/CP-001");

    expect(await closedWithin(socket, 2000)).toBe(true);
  });
});
