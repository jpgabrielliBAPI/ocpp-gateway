import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MongoTraceStore } from "../src/trace/mongo-store";
import type { OcppTraceRecord, TraceDocument } from "../src/trace/record";
import { SessionTracer } from "../src/trace/session-tracer";
import { BufferedTraceWriter } from "../src/trace/writer";
import { connectWhenOpen, makeCsms, sleep, startGateway, waitFor, waitForClose } from "./helpers";
import {
  type SpecRecord,
  buildConsumerView,
  rawFidelityErrors,
  schemaErrors,
} from "./trace/conformance";
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

const BOOT = (id = "m1") =>
  JSON.stringify([2, id, "BootNotification", { chargePointVendor: "V", chargePointModel: "M" }]);

const traceOf = (doc: TraceDocument | undefined) => (doc?.kind === "trace" ? doc.trace : undefined);
const settled = (doc: TraceDocument) =>
  doc.deliveries.every((d) => d.status !== "queued" && d.status !== "submitted");

/**
 * Every record conforms, and our correlation is the spec's within each
 * conversation, for the records it is the home of: a CSMS's frames, and the
 * charger's frames for the primary (a charger response mirrored to a
 * secondary is correlated with the primary's CALL, never the secondary's).
 */
function expectConforming(docs: TraceDocument[], backendIds: string[]) {
  const records = docs.flatMap((d) => (d.kind === "trace" ? [d.trace] : []));
  for (const record of records) {
    expect(schemaErrors(record)).toEqual([]);
    expect(rawFidelityErrors(record as unknown as SpecRecord)).toEqual([]);
  }
  for (const backendId of backendIds) {
    const view = records
      .filter(({ meta: { gateway } }) =>
        gateway.source.type === "csms"
          ? gateway.source.id === backendId
          : gateway.destinations.some((d) => d.target === backendId),
      )
      .sort((a, b) => a.meta.gateway.seq - b.meta.gateway.seq);
    const consumer = buildConsumerView(view as unknown as SpecRecord[]);
    view.forEach((record: OcppTraceRecord, i) => {
      if (homeConversation(record) !== backendId) return;
      const expected = consumer.records[i].correlatesWith;
      expect(record.meta.gateway.correlation?.callTraceId).toBe(
        expected === undefined ? undefined : view[expected].meta.gateway.traceId,
      );
    });
  }
}

function homeConversation({ meta: { gateway } }: OcppTraceRecord) {
  return gateway.source.type === "csms"
    ? gateway.source.id
    : gateway.destinations.find((d) => d.role === "primary")?.target;
}

describe("trace archiving through the gateway", () => {
  it("archives a charger CALL and the primary's CALLRESULT, correlated", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const sink = new MemoryTraceSink();
    const { port } = await start(routes(primary), { traceSink: sink });
    const { charger, received } = await connect(port);

    charger.send(BOOT());
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
      raw: BOOT(),
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

    charger.send(BOOT());
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

    charger.send(BOOT());
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

  it("keeps forwarding while MongoDB is unreachable, dropping traces instead", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const store = MongoTraceStore.create(
      { mongodbUri: "mongodb://127.0.0.1:1", database: "ocpp_gateway", retentionDays: 1 },
      { serverSelectionTimeoutMS: 100 },
    );
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

    for (let i = 0; i < 5; i++) charger.send(BOOT(`m${i}`));
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

    for (let i = 0; i < 5; i++) charger.send(BOOT(`m${i}`));
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

    charger.send(BOOT());
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

    a.charger.send(BOOT());
    await waitFor(() => a.received.length === 1);
    b.charger.send(BOOT());
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
    first.charger.send(BOOT());
    await waitFor(() => sink.docs.length === 1);
    first.charger.close();
    await waitFor(
      () => primary.connections().length === 1 && sink.docs[0].deliveries[0].status === "written",
    );

    const second = await connect(port);
    second.charger.send(JSON.stringify([2, "m1", "Heartbeat", {}]));
    await waitFor(() => second.received.length === 1 && sink.docs.length === 3);

    const [boot, heartbeat, result] = sink.docs;
    expect(boot.sessionId).not.toBe(heartbeat.sessionId);
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

    charger.send(BOOT());
    await waitFor(() => received.length === 1);
    expect(primary.received()).toEqual([BOOT()]);
    expect(spy).not.toHaveBeenCalled();
  });
});
