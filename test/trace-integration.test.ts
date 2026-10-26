import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../src/config";
import { configureLogger } from "../src/logger";
import { startProxy } from "../src/proxy";
import { RouteStore } from "../src/routes";
import { PostgresTraceStore, TRACE_TABLE } from "../src/trace/postgres-store";
import type { TraceDocument } from "../src/trace/record";
import { SessionTracer } from "../src/trace/session-tracer";
import { BufferedTraceWriter, type DeliveryUpdate, type TraceStore } from "../src/trace/writer";
import {
  boot,
  connectWhenOpen,
  makeCsms,
  sleep,
  startGateway,
  waitFor,
  waitForClose,
} from "./helpers";
import { expectConforming } from "./trace/conformance";
import { MemoryTraceSink } from "./trace/memory-sink";
import { FakeStore } from "./trace/memory-store";

type Csms = ReturnType<typeof makeCsms>;

/** A CSMS answering every CALL with a CALLRESULT of the same id. */
const answering = (tag: string, options: Parameters<typeof makeCsms>[2] = {}) =>
  makeCsms(tag, 0, {
    reply: (message) => {
      const [type, id] = JSON.parse(message) as [number, string];
      return type === 2 ? JSON.stringify([3, id, { from: tag }]) : undefined;
    },
    ...options,
  });

function routes(primary: Csms, ...secondaries: Csms[]) {
  return {
    default: {
      primary: { id: "csms-main", url: primary.url() },
      secondaries: secondaries.map((csms, i) => ({ id: `mirror-${i + 1}`, url: csms.url() })),
    },
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(
  table: object,
  options: Parameters<typeof startGateway>[2] = {},
  overrides = {},
) {
  const gateway = await startGateway(table, overrides, options);
  cleanups.push(() => gateway.close());
  return gateway;
}

async function connect(port: number, id = "CP-001", headers: Record<string, string> = {}) {
  const charger = await connectWhenOpen(`ws://127.0.0.1:${port}/${id}`, "ocpp1.6", 3000, headers);
  const received: string[] = [];
  charger.on("message", (data) => received.push(data.toString()));
  cleanups.push(() => charger.terminate());
  return { charger, received };
}

/** Wait for the mock CSMS to listen; they are closed after the test. */
async function csmsFor(...servers: Csms[]) {
  for (const csms of servers) cleanups.push(() => csms.close());
  await Promise.all(servers.map((csms) => once(csms.wss, "listening")));
  return servers;
}

const traceOf = (doc: TraceDocument | undefined) => (doc?.kind === "trace" ? doc.trace : undefined);
const settled = (doc: TraceDocument) =>
  doc.deliveries.every((d) => d.status !== "queued" && d.status !== "submitted");

describe("trace archiving through the gateway", () => {
  it("archives a charger CALL and the primary's CALLRESULT, correlated", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary), { traceSink: sink });
    const { charger, received } = await connect(port);

    charger.send(boot("m1"));
    await waitFor(() => received.length === 1);
    await waitFor(() => sink.docs.length === 2 && sink.docs.every(settled));

    const [call, result] = sink.docs;
    expect(call.deliveries).toMatchObject([
      { target: "csms-main", role: "primary", status: "written" },
    ]);
    expect(traceOf(call)).toMatchObject({
      direction: "cp-to-csms",
      messageType: "CALL",
      action: "BootNotification",
      chargePointId: "CP-001",
      ocppVersion: "1.6",
      raw: boot("m1"),
    });
    expect(result.deliveries).toMatchObject([
      { target: "CP-001", role: "charge-point", status: "written" },
    ]);
    expect(traceOf(result)).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      raw: received[0],
      meta: {
        gateway: {
          source: { type: "csms", id: "csms-main", role: "primary" },
          correlation: { callTraceId: call.id, action: "BootNotification" },
        },
      },
    });
    expect(call.sessionId).toBe(result.sessionId);
    expectConforming(sink.docs, ["csms-main"]);
  });

  it("archives a frame mirrored to secondaries once, and every secondary response as ignored", async () => {
    const [primary, mirror1, mirror2] = await csmsFor(
      answering("primary"),
      answering("mirror-1"),
      answering("mirror-2"),
    );
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary, mirror1, mirror2), { traceSink: sink });
    const { charger, received } = await connect(port);
    await waitFor(() => mirror1.connected() && mirror2.connected());

    charger.send(boot("m1"));
    await waitFor(() => sink.docs.length === 4 && sink.docs.every(settled));
    await sleep(100);

    // Only the primary's answer reaches the charger.
    expect(received).toEqual([JSON.stringify([3, "m1", { from: "primary" }])]);
    const calls = sink.docs.filter((d) => traceOf(d)?.messageType === "CALL");
    expect(calls).toHaveLength(1);
    expect(calls[0].deliveries.map((d) => [d.target, d.role, d.status])).toEqual([
      ["csms-main", "primary", "written"],
      ["mirror-1", "secondary", "written"],
      ["mirror-2", "secondary", "written"],
    ]);
    const ignored = sink.docs.filter((d) => traceOf(d)?.meta.gateway.ignored);
    expect(ignored.map((d) => traceOf(d)?.meta.gateway.source.id).sort()).toEqual([
      "mirror-1",
      "mirror-2",
    ]);
    for (const doc of ignored) {
      expect(doc.deliveries).toEqual([]);
      expect(traceOf(doc)?.meta.gateway.correlation?.callTraceId).toBe(calls[0].id);
    }
    expectConforming(sink.docs, ["csms-main", "mirror-1", "mirror-2"]);
  });

  it("correlates a CALLERROR from the primary", async () => {
    const [primary] = await csmsFor(
      makeCsms("primary", 0, {
        reply: (message) => {
          const [, id] = JSON.parse(message) as [number, string];
          return JSON.stringify([4, id, "NotImplemented", "Unknown action", {}]);
        },
      }),
    );
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary), { traceSink: sink });
    const { charger, received } = await connect(port);

    charger.send(JSON.stringify([2, "m1", "VendorSpecific", {}]));
    await waitFor(() => received.length === 1 && sink.docs.length === 2);
    expect(traceOf(sink.docs[1])).toMatchObject({
      messageType: "CALLERROR",
      error: { code: "NotImplemented", description: "Unknown action", details: {} },
      meta: {
        gateway: { correlation: { callTraceId: sink.docs[0].id, action: "VendorSpecific" } },
      },
    });
    expectConforming(sink.docs, ["csms-main"]);
  });

  it("archives an unsolicited primary CALL and correlates the charger's answer", async () => {
    const [primary, mirror] = await csmsFor(answering("primary"), answering("mirror-1"));
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary, mirror), { traceSink: sink });
    const { charger, received } = await connect(port);
    await waitFor(() => primary.connected() && mirror.connected());

    primary.connections()[0].ws.send(JSON.stringify([2, "r1", "Reset", { type: "Soft" }]));
    await waitFor(() => received.length === 1);
    charger.send(JSON.stringify([3, "r1", { status: "Accepted" }]));
    await waitFor(() => sink.docs.length === 2 && sink.docs.every(settled));

    const [reset, answer] = sink.docs;
    expect(traceOf(reset)?.meta.gateway.source).toEqual({
      type: "csms",
      id: "csms-main",
      role: "primary",
    });
    expect(answer.deliveries.map((d) => [d.target, d.status])).toEqual([
      ["csms-main", "written"],
      ["mirror-1", "written"],
    ]);
    expect(traceOf(answer)?.meta.gateway.correlation).toEqual({
      callTraceId: reset.id,
      action: "Reset",
    });
    expectConforming(sink.docs, ["csms-main", "mirror-1"]);
  });

  it("records what a primary disconnection did to the frames still queued", async () => {
    const [primary, mirror] = await csmsFor(
      answering("primary"),
      answering("mirror-1", { holdHandshakes: true }),
    );
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary, mirror), { traceSink: sink });
    const { charger } = await connect(port);
    await waitFor(() => primary.connected() && mirror.heldHandshakes() === 1);

    charger.send(boot("m1"));
    await waitFor(() => sink.docs.length >= 1 && sink.docs[0].deliveries[0].status === "written");
    const closed = waitForClose(charger);
    primary.connections()[0].ws.terminate();

    expect((await closed).code).toBe(1001);
    await waitFor(() => sink.docs[0].deliveries[1].status === "dropped");
    expect(sink.docs[0].deliveries[1]).toMatchObject({
      target: "mirror-1",
      reason: "session-ended",
    });
  });

  it("keeps forwarding while PostgreSQL is unreachable, dropping traces instead", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const store = PostgresTraceStore.create({
      postgresUrl: "postgresql://user:password@127.0.0.1:1/ocpp_gateway",
      retentionDays: 1,
    });
    const writer = new BufferedTraceWriter(store, {
      maxQueue: 100,
      flushIntervalMs: 10,
      maxAttempts: 2,
      retryDelayMs: 10,
    });
    cleanups.push(async () => {
      await writer.close(0);
      await store.close();
    });
    const { port } = await start(routes(primary), { traceSink: writer });
    const { charger, received } = await connect(port);

    for (let i = 0; i < 5; i++) charger.send(boot(`m${i}`));
    await waitFor(() => received.length === 5, 1000);
    await waitFor(() => writer.stats().dropped.writeFailed === 10, 5000);
    expect(writer.stats()).toMatchObject({ persisted: 0, queued: 0 });
  });

  it("keeps forwarding when the archive queue is full", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const store = new FakeStore();
    store.gate = new Promise(() => {});
    const writer = new BufferedTraceWriter(store, { maxQueue: 2, flushIntervalMs: 10 });
    const { port } = await start(routes(primary), { traceSink: writer });
    const { charger, received } = await connect(port);

    for (let i = 0; i < 5; i++) charger.send(boot(`m${i}`));
    await waitFor(() => received.length === 5);
    expect(writer.stats()).toMatchObject({ accepted: 2, queued: 2, dropped: { queueFull: 8 } });
  });

  it("writes pending traces on shutdown, with the outcome of frames left queued", async () => {
    const [primary, mirror] = await csmsFor(
      answering("primary"),
      answering("mirror-1", { holdHandshakes: true }),
    );
    const store = new FakeStore();
    const writer = new BufferedTraceWriter(store, { maxQueue: 100, flushIntervalMs: 60_000 });
    const gateway = await startGateway(routes(primary, mirror), {}, { traceSink: writer });
    const { charger, received } = await connect(gateway.port);
    await waitFor(() => primary.connected() && mirror.heldHandshakes() === 1);

    charger.send(boot("m1"));
    await waitFor(() => received.length === 1);
    expect(store.insertCalls).toEqual([]);

    await gateway.close();
    await writer.close(1000);

    const docs = [...store.stored.values()];
    expect(docs).toHaveLength(2);
    expect(docs[0].deliveries.map((d) => [d.target, d.status, d.reason])).toEqual([
      ["csms-main", "written", undefined],
      ["mirror-1", "dropped", "session-ended"],
    ]);
  });

  it("keeps tenants apart, even for the same chargePointId and messageId", async () => {
    const [acme, beta] = await csmsFor(answering("acme"), answering("beta"));
    const sink = new MemoryTraceSink();
    const { port } = await start(
      {
        tenants: {
          acme: { default: { primary: { id: "csms-main", url: acme.url() } } },
          beta: { default: { primary: { id: "csms-main", url: beta.url() } } },
        },
      },
      { traceSink: sink },
      { tenantBaseDomain: "ocpp.example.com" },
    );
    const a = await connect(port, "CP-001", { host: "acme.ocpp.example.com" });
    const b = await connect(port, "CP-001", { host: "beta.ocpp.example.com" });

    a.charger.send(boot("m1"));
    await waitFor(() => a.received.length === 1);
    b.charger.send(boot("m1"));
    await waitFor(() => b.received.length === 1 && sink.docs.length === 4);

    const byTenant = (tenant: string) => sink.docs.filter((d) => d.tenantId === tenant);
    for (const tenant of ["acme", "beta"]) {
      const [call, result] = byTenant(tenant);
      expect(call.sessionId).toBe(result.sessionId);
      expect(traceOf(result)?.meta.gateway).toMatchObject({
        tenantId: tenant,
        correlation: { callTraceId: call.id },
      });
    }
    expect(byTenant("acme")[0].sessionId).not.toBe(byTenant("beta")[0].sessionId);
  });

  it("never correlates a messageId reused by the next session of the same charger", async () => {
    const [primary] = await csmsFor(
      makeCsms("primary", 0, {
        // Answers only the second session's CALL.
        reply: (message) => {
          const [type, id, action] = JSON.parse(message) as [number, string, string];
          return type === 2 && action === "Heartbeat" ? JSON.stringify([3, id, {}]) : undefined;
        },
      }),
    );
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary), { traceSink: sink });

    const first = await connect(port);
    first.charger.send(boot("m1"));
    await waitFor(() => sink.docs.length === 1);
    first.charger.close();
    await waitFor(
      () => primary.connections().length === 1 && sink.docs[0].deliveries[0].status === "written",
    );

    const second = await connect(port);
    second.charger.send(JSON.stringify([2, "m1", "Heartbeat", {}]));
    await waitFor(() => second.received.length === 1 && sink.docs.length === 3);

    const [bootNotification, heartbeat, result] = sink.docs;
    expect(bootNotification.sessionId).not.toBe(heartbeat.sessionId);
    expect(traceOf(result)?.meta.gateway.correlation).toEqual({
      callTraceId: heartbeat.id,
      action: "Heartbeat",
    });
  });

  it("does no archiving work at all when disabled", async () => {
    const spy = vi.spyOn(SessionTracer.prototype, "fromCharger");
    cleanups.push(() => spy.mockRestore());
    const [primary] = await csmsFor(answering("primary"));
    const { port } = await start(routes(primary));
    const { charger, received } = await connect(port);

    charger.send(boot("m1"));
    await waitFor(() => received.length === 1);
    expect(primary.received()).toEqual([boot("m1")]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("trace selection per tenant", () => {
  const TENANTS = { tenantBaseDomain: "ocpp.example.com" };
  const hostOf = (tenant: string | null) => ({
    host: tenant === null ? "127.0.0.1" : `${tenant}.ocpp.example.com`,
  });

  /** Global routes plus tenants "tenant-a" and "demo", all on `csms`. */
  function scoped(csms: Csms, root: object = {}, demo: object = {}) {
    const route = { default: { primary: { id: "csms-main", url: csms.url() } } };
    return {
      ...route,
      ...root,
      tenants: { "tenant-a": route, demo: { ...route, ...demo } },
    };
  }

  /** Send a BootNotification as `tenant` and wait for the CSMS answer. */
  async function exchange(port: number, tenant: string | null, id = "m1") {
    const { charger, received } = await connect(port, "CP-001", hostOf(tenant));
    charger.send(boot(id));
    await waitFor(() => received.length === 1);
    expect(JSON.parse(received[0])).toEqual([3, id, { from: "primary" }]);
    return { charger, received };
  }

  const tenantsOf = (sink: MemoryTraceSink) => [...new Set(sink.docs.map((d) => d.tenantId))];

  it("relays an excluded tenant without archiving it, and archives a selected one", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port } = await start(
      scoped(primary, {}, { trace: false }),
      { traceSink: sink },
      TENANTS,
    );

    await exchange(port, "demo");
    await exchange(port, "tenant-a");
    await waitFor(() => sink.docs.length === 2);

    expect(tenantsOf(sink)).toEqual(["tenant-a"]);
    expect(sink.updates.every((u) => sink.docs.some((d) => d.id === u.id))).toBe(true);
  });

  it("archives every tenant and the global scope by default", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port } = await start(scoped(primary), { traceSink: sink }, TENANTS);

    for (const tenant of ["demo", "tenant-a", null]) await exchange(port, tenant);
    await waitFor(() => sink.docs.length === 6);

    expect(tenantsOf(sink)).toEqual(["demo", "tenant-a", null]);
  });

  it("excludes connections without a tenant with a root trace: false, tenants still archived", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port } = await start(scoped(primary, { trace: false }), { traceSink: sink }, TENANTS);

    await exchange(port, null);
    await exchange(port, "demo");
    await waitFor(() => sink.docs.length === 2);

    expect(tenantsOf(sink)).toEqual(["demo"]);
  });

  it("logs the excluded scopes at startup and whether each connection is archived", async () => {
    const logs: Record<string, unknown>[] = [];
    const capture = (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>);
    configureLogger({ logLevel: "info", sink: { stdout: capture, stderr: capture } });
    const [primary] = await csmsFor(answering("primary"));
    const { port } = await start(
      scoped(primary, { trace: false }, { trace: false }),
      { traceSink: new MemoryTraceSink() },
      TENANTS,
    );
    await exchange(port, "demo");
    await exchange(port, "tenant-a");

    expect(logs.find((l) => l.msg === "proxy listening")).toMatchObject({
      traceArchiving: true,
      untraced: [null, "demo"],
    });
    const connected = logs.filter((l) => l.msg === "charger connected");
    expect(connected.map(({ tenantId, traced }) => ({ tenantId, traced }))).toEqual([
      { tenantId: "demo", traced: false },
      { tenantId: "tenant-a", traced: true },
    ]);
  });

  /** A gateway whose routes file stays on disk, so the test can rewrite and reload it. */
  async function startReloadable(table: object, sink: MemoryTraceSink) {
    const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true }));
    const routesFile = join(dir, "routes.json");
    writeFileSync(routesFile, JSON.stringify(table));
    const store = RouteStore.load(routesFile, { requireBackendIds: true });
    const gateway = startProxy(
      {
        port: 0,
        listenHost: "127.0.0.1",
        routesFile,
        loggerConfig: { logLevel: "error" },
        maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
        ...TENANTS,
      },
      store,
      { traceSink: sink },
    );
    cleanups.push(() => gateway.close());
    await once(gateway.server, "listening");
    const { port } = gateway.server.address() as AddressInfo;
    const reload = (next: object) => {
      writeFileSync(routesFile, JSON.stringify(next));
      store.reload();
    };
    return { port, store, reload };
  }

  it("decides at connect time: excluding a tenant applies to new connections only", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port, store, reload } = await startReloadable(scoped(primary), sink);

    const before = await exchange(port, "demo");
    await waitFor(() => sink.docs.length === 2);

    reload(scoped(primary, {}, { trace: false }));
    expect(store.isTraced("demo")).toBe(false);

    // The open session keeps archiving…
    before.charger.send(boot("m2"));
    await waitFor(() => before.received.length === 2 && sink.docs.length === 4);
    // …a new one is not archived.
    await exchange(port, "demo", "m3");
    const ids = sink.traces().map((t) => t.messageId);
    expect(ids).toEqual(["m1", "m1", "m2", "m2"]);
  });

  it("decides at connect time: re-including a tenant applies to new connections only", async () => {
    const logs: Record<string, unknown>[] = [];
    const capture = (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>);
    configureLogger({ logLevel: "info", sink: { stdout: capture, stderr: capture } });
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port, store, reload } = await startReloadable(
      scoped(primary, { trace: false }, { trace: false }),
      sink,
    );

    const before = await exchange(port, "demo");
    reload(scoped(primary, { trace: false }));
    expect(store.isTraced("demo")).toBe(true);
    expect(logs.filter((l) => l.msg === "routes reloaded").map((l) => l.untraced)).toEqual([
      [null],
    ]);

    // The open session stays excluded…
    before.charger.send(boot("m2"));
    await waitFor(() => before.received.length === 2);
    expect(sink.docs).toEqual([]);
    // …a new one is archived.
    await exchange(port, "demo", "m3");
    await waitFor(() => sink.docs.length === 2);
    expect(tenantsOf(sink)).toEqual(["demo"]);
    expect(sink.traces().map((t) => t.messageId)).toEqual(["m3", "m3"]);
  });

  it("never runs the session tracer for an excluded tenant, primary nor secondary", async () => {
    const [primary, mirror] = await csmsFor(answering("primary"), answering("mirror"));
    const sink = new MemoryTraceSink();
    const route = {
      default: {
        primary: { id: "csms-main", url: primary.url() },
        secondaries: [{ id: "mirror-1", url: mirror.url() }],
      },
    };
    const { port } = await start(
      { tenants: { "tenant-a": route, demo: { ...route, trace: false } } },
      { traceSink: sink },
      TENANTS,
    );
    const traced = [
      vi.spyOn(SessionTracer.prototype, "fromCharger"),
      vi.spyOn(SessionTracer.prototype, "fromPrimary"),
      vi.spyOn(SessionTracer.prototype, "fromSecondary"),
    ];
    cleanups.push(() => vi.restoreAllMocks());
    const calls = () => traced.map((spy) => spy.mock.calls.length);

    const demo = await exchange(port, "demo");
    // The mirror received the CALL and answered it: the secondary path ran too.
    await waitFor(() => mirror.received().length === 1);
    await sleep(50);
    expect(demo.received).toHaveLength(1);
    expect(calls()).toEqual([0, 0, 0]);

    // The spies do see a traced tenant.
    await exchange(port, "tenant-a");
    await waitFor(() => calls().every((n) => n === 1));
  });
});

const POSTGRES_URL = process.env.TRACE_TEST_POSTGRES_URL;

class HeldInsertsStore implements TraceStore {
  held = true;
  ids: string[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly store: TraceStore) {}

  async insertMany(docs: TraceDocument[]) {
    this.ids.push(...docs.map((doc) => doc.id));
    if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return this.store.insertMany(docs);
  }

  updateDeliveries(updates: DeliveryUpdate[]) {
    return this.store.updateDeliveries(updates);
  }

  release() {
    this.held = false;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

describe.skipIf(!POSTGRES_URL)("trace archiving to PostgreSQL, end to end", () => {
  it("persists a replayed secondary frame once, with its final delivery outcome", async () => {
    const admin = new Pool({ connectionString: POSTGRES_URL! });
    const postgres = PostgresTraceStore.create({ postgresUrl: POSTGRES_URL!, retentionDays: 1 });
    const store = new HeldInsertsStore(postgres);
    const writer = new BufferedTraceWriter(store, { maxQueue: 100, flushIntervalMs: 10 });
    cleanups.push(async () => {
      await writer.close(1000);
      if (store.ids.length) {
        await admin.query(`DELETE FROM ${TRACE_TABLE} WHERE id = ANY($1::text[])`, [store.ids]);
      }
      await admin.end();
      await postgres.close();
    });

    const [primary, mirror] = await csmsFor(
      answering("primary"),
      answering("mirror-1", { holdHandshakes: true }),
    );
    const gateway = await startGateway(routes(primary, mirror), {}, { traceSink: writer });
    cleanups.push(() => gateway.close());
    const { charger, received } = await connect(gateway.port);
    await waitFor(() => primary.connected() && mirror.heldHandshakes() === 1);

    charger.send(boot("m1"));
    await waitFor(() => received.length === 1 && store.ids.length > 0);
    mirror.releaseHandshakes();
    await waitFor(() => mirror.received().includes(boot("m1")));
    await sleep(50);
    store.release();
    await writer.close(5_000);

    const result = await admin.query<{ document: TraceDocument }>(
      `SELECT document FROM ${TRACE_TABLE} WHERE id = ANY($1::text[])`,
      [store.ids],
    );
    const calls = result.rows.filter(({ document }) => traceOf(document)?.messageType === "CALL");
    expect(calls).toHaveLength(1);
    expect(
      calls[0].document.deliveries.map((delivery) => [delivery.target, delivery.status]),
    ).toEqual([
      ["csms-main", "written"],
      ["mirror-1", "written"],
    ]);
    expect(result.rows).toHaveLength(3);
    expect(writer.stats()).toMatchObject({ accepted: 3, persisted: 3, queued: 0 });
  });
});
