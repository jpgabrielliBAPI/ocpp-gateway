import { describe, expect, it } from "vitest";
import type { OcppTraceRecord, TraceDocument } from "../../src/trace/record";
import { SessionTracer, type SessionTracerContext } from "../../src/trace/session-tracer";
import {
  type SpecRecord,
  buildConsumerView,
  loadFixtures,
  rawFidelityErrors,
  schemaErrors,
} from "./conformance";
import { MemoryTraceSink } from "./memory-sink";

const T0 = new Date("2026-10-11T10:00:00.000Z");

function setup(context: Partial<SessionTracerContext> = {}, start = T0) {
  const sink = new MemoryTraceSink();
  let now = start.getTime();
  let ids = 0;
  const tracer = new SessionTracer(
    {
      sessionId: "session-1",
      tenantId: "operator-a",
      chargePointId: "CP-001",
      protocol: "ocpp1.6",
      primaryId: "csms-main",
      secondaryIds: ["mirror-1", "mirror-2"],
      ...context,
    },
    sink,
    { now: () => new Date(now++), newId: () => `trace-${++ids}` },
  );
  return { sink, tracer };
}

/** Records of the conversation between the charger and the CSMS `backendId`, in order. */
function conversationView(docs: TraceDocument[], backendId: string): OcppTraceRecord[] {
  return docs
    .flatMap((d) => (d.kind === "trace" ? [d.trace] : []))
    .filter(({ meta: { gateway } }) =>
      gateway.source.type === "csms"
        ? gateway.source.id === backendId
        : gateway.destinations.some((d) => d.target === backendId),
    )
    .sort((a, b) => a.meta.gateway.seq - b.meta.gateway.seq);
}

/** Every record conforms to the spec, and our correlation agrees with the reference consumer's. */
function expectConformingView(records: OcppTraceRecord[]) {
  for (const record of records) {
    expect(schemaErrors(record)).toEqual([]);
    expect(rawFidelityErrors(record as unknown as SpecRecord)).toEqual([]);
  }
  const view = buildConsumerView(records as unknown as SpecRecord[]);
  records.forEach((record, i) => {
    const expected = view.records[i].correlatesWith;
    const ours = record.meta.gateway.correlation;
    expect(ours?.callTraceId).toBe(
      expected === undefined ? undefined : records[expected].meta.gateway.traceId,
    );
    if (ours) expect(ours.action).toBe(view.records[i].action);
  });
}

const BOOT = '[2,"m1","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]';

describe("SessionTracer", () => {
  it("records a charger CALL once, with every configured destination", () => {
    const { sink, tracer } = setup();
    const frame = tracer.fromCharger(BOOT);
    frame.delivery(0).submitted();
    frame.delivery(1).submitted();
    frame.delivery(2).queued();
    frame.commit();

    expect(sink.docs).toHaveLength(1);
    const [doc] = sink.docs;
    expect(doc).toMatchObject({
      id: "trace-1",
      kind: "trace",
      tenantId: "operator-a",
      sessionId: "session-1",
      chargePointId: "CP-001",
      seq: 1,
      receivedAt: T0,
    });
    expect(doc.deliveries).toEqual([
      { target: "csms-main", role: "primary", status: "submitted", updatedAt: expect.any(Date) },
      { target: "mirror-1", role: "secondary", status: "submitted", updatedAt: expect.any(Date) },
      { target: "mirror-2", role: "secondary", status: "queued", updatedAt: expect.any(Date) },
    ]);
    expect(doc.kind === "trace" && doc.trace).toEqual({
      schemaVersion: "1.1",
      timestamp: "2026-10-11T10:00:00.000Z",
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "m1",
      action: "BootNotification",
      payload: { chargePointVendor: "V", chargePointModel: "M" },
      raw: BOOT,
      meta: {
        gateway: {
          traceId: "trace-1",
          tenantId: "operator-a",
          sessionId: "session-1",
          seq: 1,
          source: { type: "charge-point", id: "CP-001" },
          destinations: [
            { target: "csms-main", role: "primary" },
            { target: "mirror-1", role: "secondary" },
            { target: "mirror-2", role: "secondary" },
          ],
        },
      },
    });
    expect(schemaErrors(sink.traces()[0])).toEqual([]);
  });

  it("keeps the raw frame byte for byte", () => {
    const { sink, tracer } = setup();
    const raw = '[2, "m1" ,"DataTransfer", {"vendorId":"\\u00e9", "data":"1.50"}]';
    tracer.fromCharger(raw).commit();
    const [trace] = sink.traces();
    expect(trace.raw).toBe(raw);
    expect(trace.payload).toEqual({ vendorId: "é", data: "1.50" });
    expect(rawFidelityErrors(trace as unknown as SpecRecord)).toEqual([]);
  });

  it("maps the negotiated sub-protocol to ocppVersion", () => {
    for (const [protocol, version] of [
      ["ocpp2.0.1", "2.0.1"],
      ["ocpp2.0", "2.0"],
      ["", undefined],
    ] as const) {
      const { sink, tracer } = setup({ protocol });
      tracer.fromCharger('[2,"m1","Heartbeat",{}]').commit();
      expect(sink.traces()[0].ocppVersion).toBe(version);
      expect(schemaErrors(sink.traces()[0])).toEqual([]);
    }
  });

  it("extracts connectorId from the payload", () => {
    const { sink, tracer } = setup({ protocol: "ocpp2.0.1" });
    tracer
      .fromCharger(
        '[2,"m1","StatusNotification",{"timestamp":"2026-10-11T10:00:00Z","connectorStatus":"Available","evseId":1,"connectorId":2}]',
      )
      .commit();
    expect(sink.traces()[0].connectorId).toBe(2);
  });

  it("records a primary frame as coming from the primary CSMS, towards the charger", () => {
    const { sink, tracer } = setup();
    const frame = tracer.fromPrimary('[2,"r1","Reset",{"type":"Soft"}]');
    frame.delivery(0).submitted();
    frame.commit();
    const [doc] = sink.docs;
    expect(doc.deliveries).toEqual([
      { target: "CP-001", role: "charge-point", status: "submitted", updatedAt: expect.any(Date) },
    ]);
    expect(doc.kind === "trace" && doc.trace).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALL",
      action: "Reset",
      meta: {
        gateway: {
          source: { type: "csms", id: "csms-main", role: "primary" },
          destinations: [{ target: "CP-001", role: "charge-point" }],
        },
      },
    });
  });

  it("records secondary frames as ignored, never forwarded", () => {
    const { sink, tracer } = setup();
    tracer.fromSecondary("mirror-2", '[2,"s1","Reset",{"type":"Hard"}]');
    const [doc] = sink.docs;
    expect(doc.deliveries).toEqual([]);
    expect(doc.kind === "trace" && doc.trace.meta.gateway).toMatchObject({
      source: { type: "csms", id: "mirror-2", role: "secondary" },
      destinations: [],
      ignored: true,
    });
  });

  it("correlates every CSMS's response within its own conversation", () => {
    const { sink, tracer } = setup();
    tracer.fromCharger(BOOT).commit();
    tracer.fromSecondary("mirror-1", '[3,"m1",{"status":"Rejected"}]');
    tracer.fromPrimary('[3,"m1",{"status":"Accepted"}]').commit();
    tracer.fromSecondary("mirror-1", '[3,"m1",{"status":"Rejected"}]');

    const [call, mirror, primary, duplicate] = sink.traces();
    const expected = { callTraceId: call.meta.gateway.traceId, action: "BootNotification" };
    expect(mirror.meta.gateway.correlation).toEqual(expected);
    expect(primary.meta.gateway.correlation).toEqual(expected);
    // The mirror's CALL was already answered in its conversation.
    expect(duplicate.meta.gateway.correlation).toBeUndefined();
    // The action is derived by consumers: never written on responses.
    expect(mirror.action).toBeUndefined();
    expect(primary.action).toBeUndefined();

    expectConformingView(conversationView(sink.docs, "csms-main"));
    expectConformingView(conversationView(sink.docs, "mirror-1"));
    expectConformingView(conversationView(sink.docs, "mirror-2"));
  });

  it("correlates a CALLERROR", () => {
    const { sink, tracer } = setup();
    tracer.fromCharger('[2,"m1","DataTransfer",{"vendorId":"x"}]').commit();
    tracer.fromPrimary('[4,"m1","NotImplemented","Unknown vendor",{}]').commit();
    const [call, error] = sink.traces();
    expect(error).toMatchObject({
      messageType: "CALLERROR",
      messageId: "m1",
      error: { code: "NotImplemented", description: "Unknown vendor", details: {} },
      meta: { gateway: { correlation: { callTraceId: call.meta.gateway.traceId } } },
    });
    expect(error.payload).toBeUndefined();
    expectConformingView(conversationView(sink.docs, "csms-main"));
  });

  it("correlates a charger response to a CALL from the primary", () => {
    const { sink, tracer } = setup();
    tracer.fromPrimary('[2,"r1","RemoteStartTransaction",{"idTag":"TAG"}]').commit();
    tracer.fromCharger('[3,"r1",{"status":"Accepted"}]').commit();
    const [call, result] = sink.traces();
    expect(result.direction).toBe("cp-to-csms");
    expect(result.meta.gateway.correlation).toEqual({
      callTraceId: call.meta.gateway.traceId,
      action: "RemoteStartTransaction",
    });
    expectConformingView(conversationView(sink.docs, "csms-main"));
  });

  it("leaves orphan responses uncorrelated", () => {
    const { sink, tracer } = setup();
    tracer.fromPrimary('[3,"never-sent",{}]').commit();
    expect(sink.traces()[0].meta.gateway.correlation).toBeUndefined();
  });

  it("never correlates across sessions, even for the same charger in another tenant", () => {
    const a = setup({ tenantId: "operator-a", sessionId: "s-a" });
    const b = setup({ tenantId: "operator-b", sessionId: "s-b" });
    a.tracer.fromCharger(BOOT).commit();
    b.tracer.fromPrimary('[3,"m1",{"status":"Accepted"}]').commit();
    expect(b.sink.traces()[0].meta.gateway).toMatchObject({ tenantId: "operator-b" });
    expect(b.sink.traces()[0].meta.gateway.correlation).toBeUndefined();
  });

  it("numbers frames in reception order across all sources", () => {
    const { sink, tracer } = setup();
    tracer.fromCharger(BOOT).commit();
    tracer.fromSecondary("mirror-1", '[3,"m1",{}]');
    tracer.fromPrimary('[3,"m1",{}]').commit();
    expect(sink.docs.map((d) => d.seq)).toEqual([1, 2, 3]);
  });

  it("flags binary frames", () => {
    const { sink, tracer } = setup();
    tracer.fromCharger('[2,"m1","Heartbeat",{}]', true).commit();
    expect(sink.traces()[0].meta.gateway.binary).toBe(true);
  });

  it("never claims a binary frame decoded with replacement characters is verbatim", () => {
    const { sink, tracer } = setup();
    // What ws hands over for a binary frame holding invalid UTF-8.
    const raw = Buffer.from([
      ...Buffer.from('[2,"m1","DataTransfer",{"data":"'),
      0xff,
      ...Buffer.from('"}]'),
    ]).toString();
    tracer.fromCharger(raw, true).commit();
    expect(sink.docs[0].kind === "frame" && sink.docs[0].frame).toMatchObject({
      raw,
      reason: "lossy-binary",
      meta: { gateway: { binary: true } },
    });
  });

  it("stores frames the spec cannot represent as raw frames, still tracking deliveries", () => {
    const { sink, tracer } = setup();
    const frame = tracer.fromCharger('[2,42,"Heartbeat",{}]');
    frame.delivery(0).submitted();
    frame.commit();
    const [doc] = sink.docs;
    expect(doc.kind).toBe("frame");
    expect(doc.kind === "frame" && doc.frame).toEqual({
      timestamp: "2026-10-11T10:00:00.000Z",
      ocppVersion: "1.6",
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      raw: '[2,42,"Heartbeat",{}]',
      reason: "invalid-message-id",
      meta: { gateway: expect.objectContaining({ traceId: "trace-1", seq: 1 }) },
    });
    expect(doc.deliveries[0].status).toBe("submitted");
    expect(sink.traces()).toEqual([]);
  });

  describe("deliveries", () => {
    it("keeps the latest state reached before commit, in the inserted document", () => {
      const { sink, tracer } = setup();
      const frame = tracer.fromCharger(BOOT);
      frame.delivery(0).submitted();
      frame.delivery(0).settled(null);
      frame.delivery(1).queued();
      frame.delivery(1).dropped("queue-overflow");
      frame.delivery(2).submitted();
      frame.delivery(2).settled(new Error("WebSocket is not open"));
      frame.commit();
      expect(sink.updates).toEqual([]);
      expect(sink.docs[0].deliveries.map(({ status, reason }) => ({ status, reason }))).toEqual([
        { status: "written", reason: undefined },
        { status: "dropped", reason: "queue-overflow" },
        { status: "failed", reason: "WebSocket is not open" },
      ]);
    });

    it("reports later transitions as updates of the same document", () => {
      const { sink, tracer } = setup();
      const frame = tracer.fromCharger(BOOT);
      const mirror = frame.delivery(1);
      mirror.queued();
      frame.commit();
      mirror.submitted();
      mirror.settled(null);
      expect(sink.docs).toHaveLength(1);
      expect(sink.updates.map((u) => [u.id, u.index, u.delivery.status])).toEqual([
        ["trace-1", 1, "submitted"],
        ["trace-1", 1, "written"],
      ]);
      expect(sink.docs[0].deliveries[1].status).toBe("written");
    });

    it("never moves backwards nor repeats a state", () => {
      const { sink, tracer } = setup();
      const frame = tracer.fromCharger(BOOT);
      const primary = frame.delivery(0);
      primary.submitted();
      frame.commit();
      primary.queued();
      primary.submitted();
      primary.dropped("session-ended");
      primary.settled(null);
      expect(sink.updates.map((u) => u.delivery.status)).toEqual(["dropped"]);
    });

    it("marks a destination nobody handled as dropped", () => {
      const { sink, tracer } = setup();
      tracer.fromCharger(BOOT).commit();
      expect(sink.docs[0].deliveries.map((d) => [d.status, d.reason])).toEqual([
        ["dropped", "not-forwarded"],
        ["dropped", "not-forwarded"],
        ["dropped", "not-forwarded"],
      ]);
    });

    it("sends no update for a document the sink rejected", () => {
      const { sink, tracer } = setup();
      sink.accept = false;
      const frame = tracer.fromCharger(BOOT);
      const primary = frame.delivery(0);
      primary.submitted();
      frame.commit();
      primary.settled(null);
      expect(sink.updates).toEqual([]);
    });
  });
});

describe("SessionTracer against the reference fixtures", () => {
  for (const fixture of loadFixtures()) {
    it(`reproduces ${fixture.name}`, () => {
      const first = fixture.records[0];
      let i = 0;
      const sink = new MemoryTraceSink();
      const tracer = new SessionTracer(
        {
          sessionId: "s",
          tenantId: null,
          chargePointId: first.chargePointId as string,
          protocol: `ocpp${first.ocppVersion as string}`,
          primaryId: "csms",
          secondaryIds: [],
        },
        sink,
        { now: () => new Date(fixture.records[i].timestamp as string), newId: () => `t${i}` },
      );
      for (; i < fixture.records.length; i++) {
        const { direction, raw } = fixture.records[i];
        const frame =
          direction === "cp-to-csms" ? tracer.fromCharger(raw!) : tracer.fromPrimary(raw!);
        frame.commit();
      }

      const traces = sink.traces();
      expect(traces.map(({ meta: _meta, ...standard }) => standard)).toEqual(fixture.records);
      expect(buildConsumerView(traces as unknown as SpecRecord[])).toEqual(fixture.expected);
      expectConformingView(traces);
    });
  }
});
