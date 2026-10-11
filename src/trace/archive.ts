import type { TraceConfig } from "../config";
import { createLogger } from "../logger";
import { maskUserinfo } from "../utils/url";
import { BufferedTraceWriter, type TraceSink } from "./writer";

const log = createLogger("trace");

/** How long shutdown waits for pending traces to be written. */
export const TRACE_FLUSH_TIMEOUT_MS = 3_000;

export interface TraceArchive {
  sink: TraceSink;
  /** Write what is pending (bounded by {@link TRACE_FLUSH_TIMEOUT_MS}), then disconnect. */
  close(): Promise<void>;
}

/**
 * Wire trace archiving to MongoDB. The driver is only loaded here, so a
 * gateway with archiving disabled never loads it. Does not wait for MongoDB:
 * the gateway starts (and keeps forwarding) while it is unavailable.
 * Throws on an invalid connection string.
 */
export async function openTraceArchive(config: TraceConfig): Promise<TraceArchive> {
  const { MongoTraceStore, TRACE_COLLECTION } = await import("./mongo-store");
  let store: InstanceType<typeof MongoTraceStore>;
  try {
    store = MongoTraceStore.create(config);
  } catch (err) {
    throw new Error(`invalid TRACE_MONGODB_URI: ${maskUserinfo((err as Error).message)}`);
  }
  const writer = new BufferedTraceWriter(store, { maxQueue: config.queueMax });
  log.info("trace archiving enabled", {
    database: config.database,
    collection: TRACE_COLLECTION,
    retentionDays: config.retentionDays,
    queueMax: config.queueMax,
  });

  return {
    sink: writer,
    close: async () => {
      await writer.close(TRACE_FLUSH_TIMEOUT_MS);
      await store.close().catch((err: unknown) => {
        log.warn("trace store close failed", {
          error: maskUserinfo(err instanceof Error ? err.message : String(err)),
        });
      });
    },
  };
}
