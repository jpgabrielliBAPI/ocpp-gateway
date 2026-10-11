import { randomUUID } from "node:crypto";
import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MongoTraceStore,
  TRACE_COLLECTION,
  type MongoTraceDocument,
  defaultClientOptions,
  fitDocumentLimit,
  toMongoDocument,
} from "../../src/trace/mongo-store";
import type { TraceDocument } from "../../src/trace/record";
import { SessionTracer } from "../../src/trace/session-tracer";
import { MemoryTraceSink } from "./memory-sink";

/** Set to run against a real MongoDB, e.g. `mongodb://127.0.0.1:27017`. */
const MONGODB_URI = process.env.TRACE_TEST_MONGODB_URI;

const AT = new Date("2026-10-11T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Real trace documents, built the way the gateway builds them. */
function traceDocs(...frames: [source: "charger" | "primary", raw: string][]): TraceDocument[] {
  const sink = new MemoryTraceSink();
  const tracer = new SessionTracer(
    {
      sessionId: randomUUID(),
      tenantId: "operator-a",
      chargePointId: "CP-001",
      protocol: "ocpp1.6",
      primaryId: "csms-main",
      secondaryIds: [],
    },
    sink,
    { now: () => AT, newId: randomUUID },
  );
  for (const [source, raw] of frames) {
    const frame = source === "charger" ? tracer.fromCharger(raw) : tracer.fromPrimary(raw);
    frame.delivery(0).submitted();
    frame.commit();
  }
  return sink.docs;
}

const BOOT = '[2,"m1","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]';

describe("toMongoDocument", () => {
  it("maps the id to _id and adds the expiry date", () => {
    const [doc] = traceDocs(["charger", BOOT]);
    const mongo = toMongoDocument(doc, 30);
    const { id, ...rest } = doc;
    expect(mongo).toEqual({ _id: id, ...rest, expiresAt: new Date(AT.getTime() + 30 * DAY_MS) });
    expect(Object.keys(mongo).slice(0, 8)).toEqual([
      "_id",
      "kind",
      "tenantId",
      "sessionId",
      "chargePointId",
      "seq",
      "receivedAt",
      "expiresAt",
    ]);
  });
});

describe("fitDocumentLimit", () => {
  it("keeps a document under the limit untouched", () => {
    const mongo = toMongoDocument(traceDocs(["charger", BOOT])[0], 30);
    expect(fitDocumentLimit(mongo)).toBe(mongo);
  });

  it("stores an oversized record as its raw frame alone, never truncated", () => {
    const raw = `[2,"m1","DataTransfer",{"vendorId":"V","data":[${Array(2000).fill(1).join(",")}]}]`;
    const mongo = toMongoDocument(traceDocs(["charger", raw])[0], 30);
    const fitted = fitDocumentLimit(mongo, 8_000)!;
    expect(fitted.kind).toBe("frame");
    expect(fitted.frame).toEqual({
      timestamp: AT.toISOString(),
      ocppVersion: "1.6",
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      raw,
      reason: "document-too-large",
      meta: mongo.trace!.meta,
    });
    expect(fitted).not.toHaveProperty("trace");
    expect(fitted._id).toBe(mongo._id);
  });

  it("gives up when even the raw frame does not fit", () => {
    const raw = `[2,"m1","DataTransfer",{"data":"${"x".repeat(10_000)}"}]`;
    const mongo = toMongoDocument(traceDocs(["charger", raw])[0], 30);
    expect(fitDocumentLimit(mongo, 8_000)).toBeNull();
  });
});

describe("defaultClientOptions", () => {
  it("bounds how long a write may wait for MongoDB", () => {
    expect(defaultClientOptions("mongodb://db.example.com:27017/")).toEqual({
      appName: "ocpp-gateway",
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 30_000,
    });
  });

  it("lets the connection string override every default, whatever the case", () => {
    expect(
      defaultClientOptions(
        "mongodb+srv://u:p@cluster.example.com/db?appname=x&serverSelectionTimeoutMS=1000&SOCKETTIMEOUTMS=0",
      ),
    ).toEqual({});
  });
});

describe("MongoTraceStore without a reachable server", () => {
  it("fails the write so the writer can retry, without hanging", async () => {
    const store = MongoTraceStore.create(
      { mongodbUri: "mongodb://127.0.0.1:1", database: "ocpp_gateway", retentionDays: 30 },
      { serverSelectionTimeoutMS: 200 },
    );
    try {
      await expect(store.insertMany(traceDocs(["charger", BOOT]))).rejects.toThrow();
    } finally {
      await store.close();
    }
  });

  it("rejects an invalid URI at creation", () => {
    expect(() =>
      MongoTraceStore.create({
        mongodbUri: "mongodb://host:notaport",
        database: "ocpp_gateway",
        retentionDays: 30,
      }),
    ).toThrow();
  });
});

describe.skipIf(!MONGODB_URI)("MongoTraceStore against MongoDB", { timeout: 30_000 }, () => {
  const database = `ocpp_gateway_test_${randomUUID().slice(0, 8)}`;
  let client: MongoClient;
  let db: Db;
  let store: MongoTraceStore;
  const collection = () => db.collection<MongoTraceDocument>(TRACE_COLLECTION);

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI!);
    db = client.db(database);
    store = MongoTraceStore.create({ mongodbUri: MONGODB_URI!, database, retentionDays: 7 });
    await store.ensureIndexes();
  });

  afterAll(async () => {
    await store?.close();
    await db?.dropDatabase();
    await client?.close();
  });

  it("creates the TTL index and the query indexes", async () => {
    const indexes = await collection().indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));
    expect(byName.expiresAt_ttl).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    expect(byName.tenant_chargePoint_receivedAt).toMatchObject({
      key: { tenantId: 1, chargePointId: 1, receivedAt: 1 },
    });
    expect(byName.tenant_session_seq).toMatchObject({ key: { tenantId: 1, sessionId: 1, seq: 1 } });
    expect(indexes).toHaveLength(4); // with _id
  });

  it("is idempotent when creating indexes again", async () => {
    await expect(store.ensureIndexes()).resolves.toBeUndefined();
  });

  it("writes trace documents with BSON dates and the trace record intact", async () => {
    const docs = traceDocs(["charger", BOOT], ["primary", '[3,"m1",{"status":"Accepted"}]']);
    await expect(store.insertMany(docs)).resolves.toEqual({ rejected: [] });

    const stored = await collection().findOne({ _id: docs[1].id });
    expect(stored?.receivedAt).toBeInstanceOf(Date);
    expect(stored?.expiresAt).toEqual(new Date(AT.getTime() + 7 * DAY_MS));
    expect(stored?.deliveries[0].updatedAt).toBeInstanceOf(Date);
    // The nested record round-trips as plain JSON.
    const original = docs[1].kind === "trace" ? docs[1].trace : null;
    expect(JSON.parse(JSON.stringify(stored?.trace))).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it("treats a document already stored as inserted (safe retries)", async () => {
    const docs = traceDocs(["charger", BOOT]);
    await store.insertMany(docs);
    await expect(store.insertMany(docs)).resolves.toEqual({ rejected: [] });
    expect(await collection().countDocuments({ _id: docs[0].id })).toBe(1);
  });

  it("stores an oversized frame as raw, without truncating it", async () => {
    // BSON stores array indexes as keys: this 4 MiB frame needs over 16 MiB parsed.
    const raw = `[2,"m1","DataTransfer",{"vendorId":"V","data":[${Array(2 * 1024 * 1024)
      .fill(1)
      .join(",")}]}]`;
    const docs = traceDocs(["charger", raw]);
    await expect(store.insertMany(docs)).resolves.toEqual({ rejected: [] });
    const stored = await collection().findOne({ _id: docs[0].id });
    expect(stored?.kind).toBe("frame");
    expect(stored?.frame?.reason).toBe("document-too-large");
    expect(stored?.frame?.raw).toBe(raw);
  });

  it("reports the documents the server refuses, and stores the others", async () => {
    const name = `${TRACE_COLLECTION}_validated`;
    await db.createCollection(name, {
      validator: { chargePointId: { $ne: "REJECT-ME" } },
      validationAction: "error",
    });
    const validated = new MongoTraceStore(client, database, 7, name);
    const [good] = traceDocs(["charger", BOOT]);
    const bad = { ...traceDocs(["charger", BOOT])[0], chargePointId: "REJECT-ME" };

    const result = await validated.insertMany([bad, good]);
    expect(result.rejected).toEqual([{ id: bad.id, reason: "code 121" }]);
    expect(await db.collection(name).countDocuments({ _id: good.id as never })).toBe(1);
  });

  it("applies delivery updates, never moving a status backwards", async () => {
    const [doc] = traceDocs(["charger", BOOT]);
    doc.deliveries[0] = { ...doc.deliveries[0], status: "queued" };
    await store.insertMany([doc]);
    const update = (status: "submitted" | "written") => ({
      id: doc.id,
      index: 0,
      delivery: { target: "csms-main", role: "primary" as const, status, updatedAt: AT },
    });

    await store.updateDeliveries([update("written")]);
    await store.updateDeliveries([update("submitted")]);
    await store.updateDeliveries([{ ...update("written"), id: "unknown" }]);

    const stored = await collection().findOne({ _id: doc.id });
    expect(stored?.deliveries[0].status).toBe("written");
    expect(stored?.trace?.raw).toBe(BOOT);
  });

  it("serves the expected queries from the indexes", async () => {
    const plan = async (cursor: { explain(): Promise<unknown> }) =>
      JSON.stringify(await cursor.explain());
    const byCharger = await plan(
      collection().find({
        tenantId: "operator-a",
        chargePointId: "CP-001",
        receivedAt: { $gte: AT },
      }),
    );
    expect(byCharger).toContain("tenant_chargePoint_receivedAt");
    const bySession = await plan(
      collection()
        .find({ tenantId: "operator-a", sessionId: "s", "trace.messageId": "m1" })
        .sort({ seq: 1 }),
    );
    expect(bySession).toContain("tenant_session_seq");
  });
});
