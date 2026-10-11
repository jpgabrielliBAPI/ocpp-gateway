import {
  type AnyBulkWriteOperation,
  BSON,
  type IndexDescription,
  MongoBulkWriteError,
  MongoClient,
  type MongoClientOptions,
} from "mongodb";
import type { TraceConfig } from "../config";
import { createLogger } from "../logger";
import { maskUserinfo } from "../utils/url";
import {
  DELIVERY_STATUS_RANK,
  type Delivery,
  type DeliveryStatus,
  type OcppTraceRecord,
  type TraceDocument,
  type UnparsedFrame,
} from "./record";
import type { DeliveryUpdate, TraceStore } from "./writer";

const log = createLogger("trace");

export const TRACE_COLLECTION = "ocpp_traces";

/**
 * MongoDB's document limit (16 MiB), minus headroom for the envelope and
 * the delivery updates applied later.
 */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024 - 64 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;
/** Between two attempts at creating the indexes, when MongoDB is unavailable. */
const INDEX_RETRY_MS = 30_000;

/**
 * - `expiresAt`: native TTL, MongoDB deletes expired traces in the background
 *   (about once a minute). Retention is applied per document at insert.
 * - charger history over time, and one session in reception order (also
 *   narrowing a `messageId` lookup to that session's few documents).
 */
export const TRACE_INDEXES: IndexDescription[] = [
  { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
  { key: { tenantId: 1, chargePointId: 1, receivedAt: 1 }, name: "tenant_chargePoint_receivedAt" },
  { key: { tenantId: 1, sessionId: 1, seq: 1 }, name: "tenant_session_seq" },
];

/** A trace document as stored: BSON-native envelope, JSON-compatible record. */
export interface MongoTraceDocument {
  _id: string;
  kind: "trace" | "frame";
  tenantId: string | null;
  sessionId: string;
  chargePointId: string;
  seq: number;
  receivedAt: Date;
  expiresAt: Date;
  deliveries: Delivery[];
  trace?: OcppTraceRecord;
  frame?: UnparsedFrame;
}

export function toMongoDocument(doc: TraceDocument, retentionDays: number): MongoTraceDocument {
  const { id, kind, tenantId, sessionId, chargePointId, seq, receivedAt, deliveries } = doc;
  return {
    _id: id,
    kind,
    tenantId,
    sessionId,
    chargePointId,
    seq,
    receivedAt,
    expiresAt: new Date(receivedAt.getTime() + retentionDays * DAY_MS),
    deliveries,
    ...(doc.kind === "trace" ? { trace: doc.trace } : { frame: doc.frame }),
  };
}

const bsonSize = (doc: MongoTraceDocument) =>
  BSON.calculateObjectSize(doc as unknown as BSON.Document, { ignoreUndefined: true });

/**
 * A document MongoDB can store. Parsed payloads can take several times their
 * JSON size in BSON (array indexes are stored as keys), so a record over the
 * limit is stored as its raw frame alone; null when even that does not fit.
 * Never truncates.
 */
export function fitDocumentLimit(
  doc: MongoTraceDocument,
  limit = MAX_DOCUMENT_BYTES,
): MongoTraceDocument | null {
  if (bsonSize(doc) <= limit) return doc;
  if (!doc.trace) return null;

  const { trace, ...envelope } = doc;
  const { timestamp, ocppVersion, chargePointId, direction, raw, meta } = trace;
  const frame: UnparsedFrame = {
    timestamp,
    ...(ocppVersion !== undefined && { ocppVersion }),
    chargePointId,
    direction,
    raw,
    reason: "document-too-large",
    meta,
  };
  const fallback: MongoTraceDocument = { ...envelope, kind: "frame", frame };
  return bsonSize(fallback) <= limit ? fallback : null;
}

/**
 * Driver defaults for archiving, each applied only when the connection string
 * does not set it (options given in code would override the URI's): fail a
 * write fast while MongoDB is down or a socket is stuck, so the writer retries
 * then drops instead of waiting forever.
 */
export function defaultClientOptions(uri: string): MongoClientOptions {
  const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
  const inUri = new Set([...new URLSearchParams(query).keys()].map((key) => key.toLowerCase()));
  const defaults: MongoClientOptions = {
    appName: "ocpp-gateway",
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 30_000,
  };
  return Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !inUri.has(key.toLowerCase())),
  );
}

/** The statuses a delivery may still move forward from to reach `status`. */
function earlierStatuses(status: DeliveryStatus): DeliveryStatus[] {
  return (Object.keys(DELIVERY_STATUS_RANK) as DeliveryStatus[]).filter(
    (s) => DELIVERY_STATUS_RANK[s] < DELIVERY_STATUS_RANK[status],
  );
}

/** {@link TraceStore} on a MongoDB collection. Connects lazily; never logs the URI. */
export class MongoTraceStore implements TraceStore {
  private indexesReady = false;
  private lastIndexAttempt = Number.NEGATIVE_INFINITY;

  static create(
    config: Pick<TraceConfig, "mongodbUri" | "database" | "retentionDays">,
    options: MongoClientOptions = {},
  ): MongoTraceStore {
    // Parses the URI synchronously (throws when invalid); connects on first use.
    const client = new MongoClient(config.mongodbUri, {
      ...defaultClientOptions(config.mongodbUri),
      ...options,
    });
    return new MongoTraceStore(client, config.database, config.retentionDays);
  }

  constructor(
    private readonly client: MongoClient,
    private readonly database: string,
    private readonly retentionDays: number,
    private readonly collectionName = TRACE_COLLECTION,
  ) {}

  private collection() {
    return this.client
      .db(this.database, { ignoreUndefined: true })
      .collection<MongoTraceDocument>(this.collectionName);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection().createIndexes(TRACE_INDEXES);
    this.indexesReady = true;
  }

  async insertMany(docs: TraceDocument[]): Promise<{ rejected: { id: string; reason: string }[] }> {
    await this.ensureIndexesOnce();

    const rejected: { id: string; reason: string }[] = [];
    const mongoDocs: MongoTraceDocument[] = [];
    for (const doc of docs) {
      const fitted = fitDocumentLimit(toMongoDocument(doc, this.retentionDays));
      if (fitted) mongoDocs.push(fitted);
      else rejected.push({ id: doc.id, reason: "document-too-large" });
    }
    if (mongoDocs.length === 0) return { rejected };

    try {
      // Unordered: one refused document does not stop the others.
      await this.collection().insertMany(mongoDocs, { ordered: false });
    } catch (err) {
      // Per-document errors are final (a duplicate key means already stored,
      // by an earlier attempt); anything else, or a write concern error, is
      // transient and the whole batch is retried.
      if (!(err instanceof MongoBulkWriteError) || err.result.getWriteConcernError()) throw err;
      const writeErrors = [err.writeErrors].flat();
      if (writeErrors.length === 0) throw err;
      for (const writeError of writeErrors) {
        if (writeError.code === DUPLICATE_KEY) continue;
        rejected.push({ id: mongoDocs[writeError.index]._id, reason: `code ${writeError.code}` });
      }
    }
    return { rejected };
  }

  async updateDeliveries(updates: DeliveryUpdate[]): Promise<void> {
    const operations: AnyBulkWriteOperation<MongoTraceDocument>[] = updates.map(
      ({ id, index, delivery }) => ({
        updateOne: {
          // Only from an earlier status: idempotent, and never backwards.
          filter: {
            _id: id,
            [`deliveries.${index}.status`]: { $in: earlierStatuses(delivery.status) },
          },
          update: { $set: { [`deliveries.${index}`]: delivery } },
        },
      }),
    );
    if (operations.length > 0) await this.collection().bulkWrite(operations, { ordered: false });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Indexes are created before the first write, retried while they fail; never blocking writes. */
  private async ensureIndexesOnce(): Promise<void> {
    if (this.indexesReady || Date.now() - this.lastIndexAttempt < INDEX_RETRY_MS) return;
    this.lastIndexAttempt = Date.now();
    try {
      await this.ensureIndexes();
    } catch (err) {
      log.error("trace index creation failed", {
        error: maskUserinfo(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}
