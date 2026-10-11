import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLogger } from "../../src/logger";
import type { Delivery, DeliveryStatus, TraceDocument } from "../../src/trace/record";
import { BufferedTraceWriter, type TraceWriterOptions } from "../../src/trace/writer";
import { FakeStore } from "./memory-store";

const AT = new Date("2026-10-11T10:00:00.000Z");

function delivery(status: DeliveryStatus, reason?: string): Delivery {
  return { target: "csms", role: "primary", status, ...(reason && { reason }), updatedAt: AT };
}

function makeDoc(id: string, raw = '[2,"m1","Heartbeat",{}]'): TraceDocument {
  return {
    id,
    kind: "frame",
    tenantId: null,
    sessionId: "s",
    chargePointId: "CP-001",
    seq: 1,
    receivedAt: AT,
    deliveries: [delivery("submitted")],
    frame: {
      timestamp: AT.toISOString(),
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      raw,
      reason: "invalid-json",
      meta: {
        gateway: {
          traceId: id,
          tenantId: null,
          sessionId: "s",
          seq: 1,
          source: { type: "charge-point", id: "CP-001" },
          destinations: [{ target: "csms", role: "primary" }],
        },
      },
    },
  };
}

const OPTIONS: TraceWriterOptions = {
  maxQueue: 100,
  maxQueueBytes: 1024 * 1024,
  batchSize: 10,
  flushIntervalMs: 250,
  maxAttempts: 3,
  retryDelayMs: 100,
  statsIntervalMs: 60_000,
};

function setup(options: Partial<TraceWriterOptions> = {}) {
  const store = new FakeStore();
  const writer = new BufferedTraceWriter(store, { ...OPTIONS, ...options });
  return { store, writer };
}

let logs: Record<string, unknown>[];

beforeEach(() => {
  vi.useFakeTimers();
  logs = [];
  const sink = (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>);
  configureLogger({ logLevel: "info", sink: { stdout: sink, stderr: sink } });
});

afterEach(() => {
  vi.useRealTimers();
});

const messages = () => logs.map((l) => l.msg);

describe("BufferedTraceWriter", () => {
  it("writes accepted documents in one batch after the flush interval", async () => {
    const { store, writer } = setup();
    expect(writer.insert(makeDoc("a"))).toBe(true);
    expect(writer.insert(makeDoc("b"))).toBe(true);
    expect(store.insertCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(store.insertCalls).toEqual([["a", "b"]]);
    expect(writer.stats()).toMatchObject({ accepted: 2, persisted: 2, queued: 0, queuedBytes: 0 });
  });

  it("never writes from the caller's stack, even with a full batch", async () => {
    const { store, writer } = setup({ batchSize: 2 });
    writer.insert(makeDoc("a"));
    writer.insert(makeDoc("b"));
    writer.insert(makeDoc("c"));
    expect(store.insertCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(store.insertCalls).toEqual([["a", "b"], ["c"]]);
  });

  it("merges a delivery update into a document not written yet", async () => {
    const { store, writer } = setup();
    writer.insert(makeDoc("a"));
    writer.updateDelivery("a", 0, delivery("written"));

    await vi.advanceTimersByTimeAsync(250);
    expect(store.updateCalls).toEqual([]);
    expect(store.stored.get("a")?.deliveries[0].status).toBe("written");
  });

  it("updates written documents afterwards, keeping only the most advanced state", async () => {
    const { store, writer } = setup();
    const queued = makeDoc("a");
    queued.deliveries = [delivery("queued")];
    writer.insert(queued);
    await vi.advanceTimersByTimeAsync(250);

    writer.updateDelivery("a", 0, delivery("submitted"));
    writer.updateDelivery("a", 0, delivery("written"));
    writer.updateDelivery("a", 0, delivery("submitted"));
    await vi.advanceTimersByTimeAsync(250);

    expect(store.updateCalls).toEqual([[{ id: "a", index: 0, delivery: delivery("written") }]]);
    expect(store.stored.get("a")?.deliveries[0].status).toBe("written");
    expect(writer.stats().deliveryUpdates).toMatchObject({ applied: 1 });
  });

  it("applies an update received during the insert after that insert", async () => {
    const { store, writer } = setup();
    let open!: () => void;
    store.gate = new Promise((resolve) => (open = resolve));
    const queued = makeDoc("a");
    queued.deliveries = [delivery("queued")];
    writer.insert(queued);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.insertCalls).toEqual([["a"]]);

    writer.updateDelivery("a", 0, delivery("dropped", "queue-overflow"));
    store.gate = null;
    open();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.updateCalls).toHaveLength(1);
    expect(store.stored.get("a")?.deliveries[0]).toMatchObject({
      status: "dropped",
      reason: "queue-overflow",
    });
  });

  it("retries a failed write with backoff", async () => {
    const { store, writer } = setup();
    store.failures = 2;
    writer.insert(makeDoc("a"));

    await vi.advanceTimersByTimeAsync(250);
    expect(store.insertCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.insertCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.insertCalls).toHaveLength(3);
    expect(store.stored.has("a")).toBe(true);
    expect(writer.stats()).toMatchObject({ persisted: 1, writeFailures: 2 });
    expect(messages()).toEqual(["trace store unavailable", "trace store available again"]);
  });

  it("gives a batch up after the last attempt, and counts it dropped", async () => {
    const { store, writer } = setup();
    store.failures = 3;
    writer.insert(makeDoc("a"));
    writer.insert(makeDoc("b"));

    await vi.advanceTimersByTimeAsync(250 + 100 + 200);
    expect(store.insertCalls).toHaveLength(3);
    expect(writer.stats()).toMatchObject({
      persisted: 0,
      queued: 0,
      dropped: { writeFailed: 2 },
    });
    // No further attempt for that batch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.insertCalls).toHaveLength(3);
  });

  it("drops the documents the store rejects for good, without retrying the batch", async () => {
    const { store, writer } = setup();
    store.rejectIds.add("bad");
    writer.insert(makeDoc("ok"));
    writer.insert(makeDoc("bad"));

    await vi.advanceTimersByTimeAsync(250);
    expect(store.insertCalls).toEqual([["ok", "bad"]]);
    expect(writer.stats()).toMatchObject({ persisted: 1, dropped: { rejected: 1 } });
    expect(logs.find((l) => l.msg === "trace document rejected")).toMatchObject({
      id: "bad",
      reason: "code 2",
    });
  });

  it("treats a store that throws synchronously like a failed write", async () => {
    const { store, writer } = setup({ maxAttempts: 1 });
    store.insertMany = () => {
      throw new Error("boom");
    };
    writer.insert(makeDoc("a"));
    await vi.advanceTimersByTimeAsync(250);
    expect(writer.stats().dropped.writeFailed).toBe(1);
  });

  describe("bounds", () => {
    it("refuses new documents beyond the queue length, in flight included", async () => {
      const { store, writer } = setup({ maxQueue: 2 });
      store.gate = new Promise(() => {});
      writer.insert(makeDoc("a"));
      writer.insert(makeDoc("b"));
      await vi.advanceTimersByTimeAsync(250);
      expect(store.insertCalls).toEqual([["a", "b"]]);

      expect(writer.insert(makeDoc("c"))).toBe(false);
      expect(writer.stats()).toMatchObject({ queued: 2, dropped: { queueFull: 1 } });
      expect(messages()).toContain("trace queue full, dropping new traces");
    });

    it("refuses new documents beyond the queue bytes", () => {
      const { writer } = setup({ maxQueueBytes: 30_000 });
      expect(writer.insert(makeDoc("a", "x".repeat(2_000)))).toBe(true);
      expect(writer.insert(makeDoc("b", "x".repeat(2_000)))).toBe(false);
      expect(writer.stats().queuedBytes).toBeGreaterThan(2_000);
      expect(writer.stats().queuedBytes).toBeLessThanOrEqual(30_000);
    });

    it("counts the memory a parsed payload takes, not only the raw text", () => {
      const raw = (body: string) => `[2,"m1","DataTransfer",${body}]`;
      const flat = raw(`"${"x".repeat(3_000)}"`);
      const nested = raw(`[${Array(1_000).fill("{}").join(",")}]`);
      const { writer } = setup({ maxQueueBytes: 50_000 });
      expect(writer.insert(makeDoc("flat", flat))).toBe(true);
      // Same text length, but a thousand objects once parsed.
      expect(nested.length).toBeLessThan(flat.length);
      expect(writer.insert(makeDoc("nested", nested))).toBe(false);
    });

    it("always accepts a document when nothing else is held, however large", async () => {
      const { writer } = setup({ maxQueueBytes: 1_000 });
      expect(writer.insert(makeDoc("big", "x".repeat(10_000)))).toBe(true);
      expect(writer.insert(makeDoc("next"))).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      expect(writer.insert(makeDoc("after"))).toBe(true);
    });

    it("frees the room once written", async () => {
      const { writer } = setup({ maxQueue: 1 });
      writer.insert(makeDoc("a"));
      await vi.advanceTimersByTimeAsync(250);
      expect(writer.insert(makeDoc("b"))).toBe(true);
    });

    it("drops delivery updates beyond the queue length", async () => {
      const { writer } = setup({ maxQueue: 2 });
      writer.insert(makeDoc("a"));
      await vi.advanceTimersByTimeAsync(250);
      writer.updateDelivery("x", 0, delivery("written"));
      writer.updateDelivery("y", 0, delivery("written"));
      writer.updateDelivery("z", 0, delivery("written"));
      expect(writer.stats().deliveryUpdates.dropped).toBe(1);
    });
  });

  describe("close", () => {
    it("writes everything pending, then refuses new documents", async () => {
      const { store, writer } = setup();
      writer.insert(makeDoc("a"));
      const closed = writer.close(3_000);
      await vi.advanceTimersByTimeAsync(0);
      await closed;
      expect(store.stored.has("a")).toBe(true);

      expect(writer.insert(makeDoc("b"))).toBe(false);
      expect(writer.stats().dropped.shutdown).toBe(1);
    });

    it("counts delivery updates still being written at the timeout as dropped", async () => {
      const { store, writer } = setup();
      writer.insert(makeDoc("a"));
      await vi.advanceTimersByTimeAsync(250);
      store.gate = new Promise(() => {});
      writer.updateDelivery("a", 0, delivery("written"));
      await vi.advanceTimersByTimeAsync(250);
      expect(store.updateCalls).toHaveLength(1);

      const closed = writer.close(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await closed;
      expect(writer.stats().deliveryUpdates).toEqual({ applied: 0, dropped: 1, failed: 0 });
    });

    it("writes delivery updates reported while closing", async () => {
      const { store, writer } = setup();
      writer.insert(makeDoc("a"));
      await vi.advanceTimersByTimeAsync(250);
      const closed = writer.close(3_000);
      writer.updateDelivery("a", 0, delivery("dropped", "session-ended"));
      await vi.advanceTimersByTimeAsync(0);
      await closed;
      expect(store.stored.get("a")?.deliveries[0].status).toBe("dropped");
    });

    it("gives up after the timeout, counting what was left as dropped", async () => {
      const { store, writer } = setup({ batchSize: 1 });
      let release!: () => void;
      store.gate = new Promise((resolve) => (release = resolve));
      writer.insert(makeDoc("a"));
      writer.insert(makeDoc("b"));
      const closed = writer.close(3_000);
      let done = false;
      void closed.then(() => (done = true));

      await vi.advanceTimersByTimeAsync(2_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      // "a" is stuck in flight, "b" never left the queue: both are lost, and
      // nothing is held any more.
      const accounted = (stats: ReturnType<typeof writer.stats>) =>
        stats.persisted +
        Object.values(stats.dropped).reduce((sum, n) => sum + n, 0) +
        stats.queued;
      expect(writer.stats()).toMatchObject({
        accepted: 2,
        queued: 0,
        queuedBytes: 0,
        dropped: { shutdown: 2 },
      });
      expect(accounted(writer.stats())).toBe(2);
      expect(messages()).toContain("trace writer closed with pending traces");

      // The abandoned write finishing late changes nothing.
      store.gate = null;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(writer.stats()).toMatchObject({ persisted: 0, queued: 0, dropped: { shutdown: 2 } });
      expect(accounted(writer.stats())).toBe(2);
    });
  });

  it("logs its counters periodically while there is activity", async () => {
    const { writer } = setup({ statsIntervalMs: 1_000 });
    writer.insert(makeDoc("a"));
    await vi.advanceTimersByTimeAsync(1_000);
    const stats = logs.filter((l) => l.msg === "trace stats");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ accepted: 1, persisted: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(logs.filter((l) => l.msg === "trace stats")).toHaveLength(1);
    const closed = writer.close(0);
    await vi.advanceTimersByTimeAsync(0);
    await closed;
  });
});
