import {
  type AnyBulkWriteOperation,
  BSON,
  type Collection,
  type CollectionInfo,
  type Db,
  type IndexDescription,
  MongoBulkWriteError,
  MongoClient,
  type MongoClientOptions,
  MongoServerError,
} from "mongodb";
import type { TraceConfig } from "../config";
import { createLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { maskUserinfo } from "../utils/url";
import {
  DELIVERY_STATUS_RANK,
  type Delivery,
  type DeliveryStatus,
  type OcppTraceRecord,
  type TraceDocument,
  type UnparsedFrame,
  unparsedFrame,
} from "./record";
import type { DeliveryUpdate, TraceStore } from "./writer";

export const TRACE_COLLECTION = "ocpp_traces";

const log = createLogger("trace");

/**
 * MongoDB's document limit (16 MiB), minus headroom for the envelope and
 * the delivery updates applied later.
 */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024 - 64 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;
const NAMESPACE_NOT_FOUND = 26;

/**
 * - `expiresAt`: native TTL, MongoDB deletes expired traces in the background
 *   (about once a minute). Retention is applied per document at insert.
 * - charger history over time, and one session in reception order (also
 *   narrowing a `messageId` lookup to that session's few documents).
 */
const TRACE_INDEXES: IndexDescription[] = [
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

/**
 * Why `doc` cannot be stored as is, if it cannot: over `limit` once encoded,
 * or not encodable at all, so that one bad document never fails the batch it
 * travels with. BSON refuses keys holding a NUL byte, which JSON can only
 * spell as `\u0000`: only then is the document test-encoded.
 */
function unstorableReason(
  doc: MongoTraceDocument,
  limit: number,
): "document-too-large" | "not-storable" | null {
  const options = { ignoreUndefined: true };
  if (BSON.calculateObjectSize(doc as unknown as BSON.Document, options) > limit) {
    return "document-too-large";
  }
  if (!(doc.trace ?? doc.frame)!.raw.includes("\\u0000")) return null;
  try {
    BSON.serialize(doc as unknown as BSON.Document, options);
    return null;
  } catch {
    return "not-storable";
  }
}

/**
 * A document MongoDB can store. A record that cannot be (parsed payloads can
 * take several times their JSON size in BSON, since array indexes are stored
 * as keys; some JSON keys are not valid BSON) is stored as its raw frame
 * alone; null when even that cannot be. Never truncates.
 */
export function fitDocumentLimit(
  doc: MongoTraceDocument,
  limit = MAX_DOCUMENT_BYTES,
): MongoTraceDocument | null {
  const reason = unstorableReason(doc, limit);
  if (reason === null) return doc;
  if (!doc.trace) return null;

  const { trace, ...envelope } = doc;
  const fallback: MongoTraceDocument = {
    ...envelope,
    kind: "frame",
    frame: unparsedFrame(trace, reason),
  };
  return unstorableReason(fallback, limit) === null ? fallback : null;
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

/**
 * Index options that do not change which documents an index covers: `v`
 * (format), `ns` (older servers), `collation` (inherited from a collection
 * default; dates and numbers ignore it). Any other one, such as
 * `partialFilterExpression`, `sparse` or `hidden`, may leave traces that never
 * expire.
 */
const NEUTRAL_INDEX_OPTIONS = new Set([
  "v",
  "ns",
  "key",
  "name",
  "expireAfterSeconds",
  "collation",
]);

/** Whether `existing` holds `wanted`, with no option narrowing what it covers. */
function includesIndex(existing: IndexDescription[], wanted: IndexDescription): boolean {
  return existing.some(
    (index) =>
      index.name === wanted.name &&
      JSON.stringify(index.key) === JSON.stringify(wanted.key) &&
      index.expireAfterSeconds === wanted.expireAfterSeconds &&
      Object.keys(index).every((option) => NEUTRAL_INDEX_OPTIONS.has(option)),
  );
}

const STATUSES = Object.keys(DELIVERY_STATUS_RANK) as DeliveryStatus[];
/** The statuses a delivery may still move forward from, to reach each status. */
const EARLIER_STATUSES = Object.fromEntries(
  STATUSES.map((status) => [
    status,
    STATUSES.filter((s) => DELIVERY_STATUS_RANK[s] < DELIVERY_STATUS_RANK[status]),
  ]),
) as Record<DeliveryStatus, DeliveryStatus[]>;

/** A driver error, rethrown without the credentials its message may quote. */
function masked(err: unknown): Error {
  return new Error(maskUserinfo(errorMessage(err)));
}

/**
 * {@link TraceStore} on a MongoDB collection. Connects lazily; never logs the
 * URI, and masks credentials in every error it throws.
 */
export class MongoTraceStore implements TraceStore {
  private readonly db: Db;
  private readonly collection: Collection<MongoTraceDocument>;
  private readonly requireCapped: boolean;
  /** `missing`: the indexes were there, then vanished (the collection was dropped). */
  private indexState: "unknown" | "ready" | "missing" = "unknown";

  static create(
    config: Pick<TraceConfig, "mongodbUri" | "database" | "retentionDays"> &
      Partial<Pick<TraceConfig, "requireCapped">>,
    options: MongoClientOptions = {},
  ): MongoTraceStore {
    let client: MongoClient;
    try {
      // Parses the URI synchronously (throws when invalid); connects on first use.
      client = new MongoClient(config.mongodbUri, {
        ...defaultClientOptions(config.mongodbUri),
        ...options,
      });
    } catch (err) {
      throw masked(err);
    }
    return new MongoTraceStore(client, config.database, config.retentionDays, {
      requireCapped: config.requireCapped,
    });
  }

  constructor(
    private readonly client: MongoClient,
    database: string,
    private readonly retentionDays: number,
    {
      collectionName = TRACE_COLLECTION,
      requireCapped = false,
    }: { collectionName?: string; requireCapped?: boolean } = {},
  ) {
    this.db = client.db(database, { ignoreUndefined: true });
    this.collection = this.db.collection<MongoTraceDocument>(collectionName);
    this.requireCapped = requireCapped;
  }

  /**
   * Run before every batch, so that traces get a TTL even when the collection
   * is dropped while the gateway runs (the insert would recreate it without
   * any index): check the indexes, TTL included, and create the missing ones.
   * A collection created by the operator (e.g. capped) is kept as is; with
   * `requireCapped`, it must exist and be capped, and is never created. Until
   * then every batch fails, so the writer retries then drops it.
   *
   * Not airtight: a drop between this check and the insert lets that batch
   * into a collection the insert recreates, uncapped and without indexes. By
   * default the next batch recreates the TTL index, which also expires those
   * documents; with `requireCapped`, the next batches fail until the operator
   * replaces that collection.
   */
  async ensureIndexes(): Promise<void> {
    if (this.requireCapped) await this.checkCapped();
    if (await this.hasIndexes()) {
      this.indexesReady();
      return;
    }
    if (this.indexState === "ready") {
      this.indexState = "missing";
      log.warn("trace indexes missing, recreating them", {
        collection: this.collection.collectionName,
      });
    }
    try {
      await this.collection.createIndexes(TRACE_INDEXES);
    } catch (err) {
      throw masked(err);
    }
    // Defensive: createIndexes accepts an existing index it deems equivalent.
    if (!(await this.hasIndexes())) {
      throw new Error(
        `indexes of ${this.collection.collectionName} have unexpected options; drop them to let the gateway recreate them`,
      );
    }
    this.indexesReady();
  }

  /** Whoever recreated them, the gateway or the operator. */
  private indexesReady(): void {
    if (this.indexState === "missing") {
      log.info("trace indexes recreated", { collection: this.collection.collectionName });
    }
    this.indexState = "ready";
  }

  private async checkCapped(): Promise<void> {
    const name = this.collection.collectionName;
    let info: CollectionInfo | undefined;
    try {
      [info] = await this.db.listCollections({ name }, { nameOnly: false }).toArray();
    } catch (err) {
      throw masked(err);
    }
    if (!info?.options?.capped) {
      throw new Error(
        `collection ${name} is ${info ? "not capped" : "missing"}: TRACE_REQUIRE_CAPPED needs a capped collection, created by the operator`,
      );
    }
  }

  private async hasIndexes(): Promise<boolean> {
    let existing: IndexDescription[];
    try {
      existing = await this.collection.indexes();
    } catch (err) {
      if (err instanceof MongoServerError && err.code === NAMESPACE_NOT_FOUND) return false;
      throw masked(err);
    }
    return TRACE_INDEXES.every((wanted) => includesIndex(existing, wanted));
  }

  async insertMany(docs: TraceDocument[]): Promise<{ rejected: { id: string; reason: string }[] }> {
    await this.ensureIndexes();

    const rejected: { id: string; reason: string }[] = [];
    const mongoDocs: MongoTraceDocument[] = [];
    for (const doc of docs) {
      const fitted = fitDocumentLimit(toMongoDocument(doc, this.retentionDays));
      if (fitted) mongoDocs.push(fitted);
      else rejected.push({ id: doc.id, reason: "not-storable" });
    }
    if (mongoDocs.length === 0) return { rejected };

    try {
      // Unordered: one refused document does not stop the others.
      await this.collection.insertMany(mongoDocs, { ordered: false });
    } catch (err) {
      // Per-document errors are final (a duplicate key means already stored,
      // by an earlier attempt); anything else, or a write concern error, is
      // transient and the whole batch is retried.
      if (!(err instanceof MongoBulkWriteError) || err.result.getWriteConcernError()) {
        throw masked(err);
      }
      const writeErrors = [err.writeErrors].flat();
      if (writeErrors.length === 0) throw masked(err);
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
            [`deliveries.${index}.status`]: { $in: EARLIER_STATUSES[delivery.status] },
          },
          update: { $set: { [`deliveries.${index}`]: delivery } },
        },
      }),
    );
    if (operations.length === 0) return;
    try {
      await this.collection.bulkWrite(operations, { ordered: false });
    } catch (err) {
      throw masked(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (err) {
      throw masked(err);
    }
  }
}
