import type { TraceConfig } from "../config";
import { createLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { PostgresTraceStore } from "./postgres-store";
import { BufferedTraceWriter, type TraceSink } from "./writer";

const log = createLogger("trace");

/** How long shutdown waits for pending traces to be written. */
export const TRACE_FLUSH_TIMEOUT_MS = 3_000;

export interface TraceArchive {
  sink: TraceSink;
  /**
   * Write what is pending (bounded by {@link TRACE_FLUSH_TIMEOUT_MS}), then
   * disconnect; calling it again returns the same close.
   */
  close(): Promise<void>;
}

/**
 * Wire trace archiving to PostgreSQL. The driver is only loaded here, so a
 * gateway with archiving disabled never loads it. Does not wait for PostgreSQL:
 * the gateway starts (and keeps forwarding) while it is unavailable.
 * Throws on an invalid connection URL.
 */
export async function openTraceArchive(config: TraceConfig): Promise<TraceArchive> {
  const postgres = await import("./postgres-store");
  let store: PostgresTraceStore;
  try {
    store = postgres.PostgresTraceStore.create(config);
  } catch (err) {
    throw new Error(`invalid TRACE_POSTGRES_URL: ${errorMessage(err)}`);
  }
  const writer = new BufferedTraceWriter(store, { maxQueue: config.queueMax });
  log.info("trace archiving enabled", {
    table: postgres.TRACE_TABLE,
    retentionDays: config.retentionDays,
    queueMax: config.queueMax,
  });

  let closing: Promise<void> | undefined;
  return {
    sink: writer,
    close: () => {
      closing ??= (async () => {
        await writer.close(TRACE_FLUSH_TIMEOUT_MS);
        await store.close().catch((err: unknown) => {
          log.warn("trace store close failed", { error: errorMessage(err) });
        });
      })();
      return closing;
    },
  };
}
