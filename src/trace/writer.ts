import { createLogger } from "../logger";
import { maskUserinfo } from "../utils/url";
import { DELIVERY_STATUS_RANK, type Delivery, type TraceDocument } from "./record";

const log = createLogger("trace");

/**
 * Where sessions hand their trace documents. Called on the forwarding path,
 * so implementations must return immediately and never throw.
 */
export interface TraceSink {
  /** Take ownership of `doc`; false when it was not accepted (it will never be stored). */
  insert(doc: TraceDocument): boolean;
  /** Record a newer delivery state for `deliveries[index]` of an accepted document. */
  updateDelivery(id: string, index: number, delivery: Delivery): void;
}

export interface DeliveryUpdate {
  id: string;
  index: number;
  delivery: Delivery;
}

/** Persistence port of the writer (MongoDB in production). */
export interface TraceStore {
  /**
   * Insert idempotently: a document already stored counts as inserted, so a
   * retried batch is safe. Documents refused for good (never worth retrying)
   * are returned; throws on a transient failure.
   */
  insertMany(docs: TraceDocument[]): Promise<{ rejected: { id: string; reason: string }[] }>;
  /** Apply updates, never moving a delivery back to an earlier status. Throws on failure. */
  updateDeliveries(updates: DeliveryUpdate[]): Promise<void>;
}

export interface TraceWriterOptions {
  /** Documents held in memory (waiting or being written); more are dropped. */
  maxQueue: number;
  /** Estimated bytes held in memory; more documents are dropped. */
  maxQueueBytes: number;
  batchSize: number;
  flushIntervalMs: number;
  /** Attempts per batch before it is dropped. */
  maxAttempts: number;
  /** First retry delay, doubled at each attempt. */
  retryDelayMs: number;
  statsIntervalMs: number;
}

export const DEFAULT_TRACE_WRITER_OPTIONS: Omit<TraceWriterOptions, "maxQueue"> = {
  maxQueueBytes: 64 * 1024 * 1024,
  batchSize: 500,
  flushIntervalMs: 250,
  maxAttempts: 3,
  retryDelayMs: 500,
  statsIntervalMs: 60_000,
};

export interface TraceWriterStats {
  accepted: number;
  persisted: number;
  /** Failed write attempts (each may be retried). */
  writeFailures: number;
  /** Documents held in memory now. */
  queued: number;
  queuedBytes: number;
  /** Documents that will never be stored, by cause. */
  dropped: { queueFull: number; writeFailed: number; rejected: number; shutdown: number };
  deliveryUpdates: { applied: number; dropped: number; failed: number };
}

interface Entry {
  doc: TraceDocument;
  bytes: number;
}

/** Bytes per character of raw text: the UTF-16 string, plus its parsed values. */
const BYTES_PER_CHAR = 8;
/** Heap cost of one parsed object or array (a hostile frame may hold many empty ones). */
const BYTES_PER_CONTAINER = 64;
const DOCUMENT_OVERHEAD_BYTES = 1024;

/**
 * Upper estimate of the memory a document holds until written: the raw frame,
 * its parsed payload (every `{` or `[` may become an object), the envelope.
 */
function estimateBytes(doc: TraceDocument): number {
  const raw = doc.kind === "trace" ? doc.trace.raw : doc.frame.raw;
  let containers = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x7b || c === 0x5b) containers++;
  }
  return raw.length * BYTES_PER_CHAR + containers * BYTES_PER_CONTAINER + DOCUMENT_OVERHEAD_BYTES;
}

/**
 * The non-blocking, bounded {@link TraceSink}: documents wait in memory and
 * are written by batches in the background, one batch at a time, so MongoDB
 * never slows down or breaks forwarding.
 *
 * - A full queue (by count or bytes) refuses new documents: memory stays
 *   bounded (above the byte bound only by one document, when it is alone).
 * - Failed writes are retried with backoff, then the batch is dropped.
 * - A delivery update for a document still waiting is merged into it (one
 *   write per frame in the common case); others are written after the
 *   inserts, deduplicated per delivery, never moving a status backwards.
 * - Nothing here throws into the caller; every loss is counted and logged.
 */
export class BufferedTraceWriter implements TraceSink {
  private readonly options: TraceWriterOptions;
  /** Accepted documents not handed to the store yet, oldest first. */
  private readonly waiting = new Map<string, Entry>();
  /** Latest pending update per `id#index`. */
  private readonly updates = new Map<string, DeliveryUpdate>();
  private queued = 0;
  private queuedBytes = 0;
  private state: "open" | "closing" | "closed" = "open";
  private aborted = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private storeAvailable = true;
  private queueFull = false;
  private lastLoggedStats = "";
  private readonly counters: Omit<TraceWriterStats, "queued" | "queuedBytes"> = {
    accepted: 0,
    persisted: 0,
    writeFailures: 0,
    dropped: { queueFull: 0, writeFailed: 0, rejected: 0, shutdown: 0 },
    deliveryUpdates: { applied: 0, dropped: 0, failed: 0 },
  };

  constructor(
    private readonly store: TraceStore,
    options: Partial<TraceWriterOptions> & Pick<TraceWriterOptions, "maxQueue">,
  ) {
    this.options = { ...DEFAULT_TRACE_WRITER_OPTIONS, ...options };
    this.lastLoggedStats = JSON.stringify(this.counters);
    this.statsTimer = setInterval(() => this.logStats(), this.options.statsIntervalMs);
    this.statsTimer.unref();
  }

  insert(doc: TraceDocument): boolean {
    if (this.state !== "open") {
      this.counters.dropped.shutdown++;
      return false;
    }
    const bytes = estimateBytes(doc);
    // An empty queue takes any document, so the largest frame the gateway
    // accepts (MAX_MESSAGE_BYTES) can always be archived.
    if (
      this.queued >= this.options.maxQueue ||
      (this.queued > 0 && this.queuedBytes + bytes > this.options.maxQueueBytes)
    ) {
      this.counters.dropped.queueFull++;
      if (!this.queueFull) {
        this.queueFull = true;
        log.warn("trace queue full, dropping new traces", this.queueStats());
      }
      return false;
    }
    this.waiting.set(doc.id, { doc, bytes });
    this.queued++;
    this.queuedBytes += bytes;
    this.counters.accepted++;
    this.schedule();
    return true;
  }

  updateDelivery(id: string, index: number, delivery: Delivery): void {
    if (this.state === "closed") {
      this.counters.deliveryUpdates.dropped++;
      return;
    }
    const waiting = this.waiting.get(id);
    if (waiting) {
      const current = waiting.doc.deliveries[index];
      if (!current || isAfter(delivery, current)) waiting.doc.deliveries[index] = delivery;
      return;
    }
    const key = `${id}#${index}`;
    const pending = this.updates.get(key);
    if (pending) {
      if (isAfter(delivery, pending.delivery)) pending.delivery = delivery;
      return;
    }
    if (this.updates.size >= this.options.maxQueue) {
      this.counters.deliveryUpdates.dropped++;
      return;
    }
    this.updates.set(key, { id, index, delivery });
    this.schedule();
  }

  stats(): TraceWriterStats {
    return structuredClone({
      ...this.counters,
      queued: this.queued,
      queuedBytes: this.queuedBytes,
    });
  }

  /**
   * Stop accepting documents and write what is pending, giving up after
   * `timeoutMs`: whatever is left then is counted as dropped.
   */
  async close(timeoutMs: number): Promise<void> {
    if (this.state !== "open") return;
    this.state = "closing";
    clearInterval(this.statsTimer);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(true), timeoutMs);
    });
    const flushed = (async () => {
      // Let I/O callbacks already due (send outcomes) report first; sessions
      // may keep reporting while this runs.
      do {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await this.drain();
      } while (this.hasWork() && !this.aborted);
      return false;
    })();
    const timeout = await Promise.race([flushed, timedOut]);
    clearTimeout(deadline);

    this.state = "closed";
    if (timeout) this.aborted = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const left = this.waiting.size + this.updates.size;
    this.counters.dropped.shutdown += this.waiting.size;
    this.counters.deliveryUpdates.dropped += this.updates.size;
    this.waiting.clear();
    this.updates.clear();
    if (left > 0 || timeout) {
      log.warn("trace writer closed with pending traces", { ...this.stats(), timedOut: timeout });
    } else {
      log.info("trace writer closed", this.stats());
    }
  }

  private hasWork(): boolean {
    return this.waiting.size > 0 || this.updates.size > 0;
  }

  /** Run a write cycle soon (sooner once a batch is full), outside the caller's stack. */
  private schedule(): void {
    if (this.running || this.state === "closed") return;
    const urgent = this.waiting.size >= this.options.batchSize || this.state === "closing";
    if (this.timer && !urgent) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.drain();
      },
      urgent ? 0 : this.options.flushIntervalMs,
    );
    this.timer.unref();
  }

  /** Write until nothing is pending; one cycle at a time. */
  private drain(): Promise<void> {
    this.running ??= this.writeAll().finally(() => {
      this.running = null;
      if (this.hasWork()) this.schedule();
    });
    return this.running;
  }

  private async writeAll(): Promise<void> {
    while (!this.aborted && this.hasWork()) {
      if (this.waiting.size > 0) await this.writeBatch(this.takeBatch());
      // Updates go after the inserts they may refer to.
      if (!this.aborted && this.updates.size > 0) {
        const updates = [...this.updates.values()];
        this.updates.clear();
        await this.writeUpdates(updates);
      }
    }
  }

  private takeBatch(): Entry[] {
    const batch: Entry[] = [];
    for (const [id, entry] of this.waiting) {
      if (batch.length === this.options.batchSize) break;
      this.waiting.delete(id);
      batch.push(entry);
    }
    return batch;
  }

  private async writeBatch(batch: Entry[]): Promise<void> {
    const docs = batch.map((entry) => entry.doc);
    try {
      const result = await this.attempt(() => this.store.insertMany(docs));
      if (result) {
        this.counters.persisted += docs.length - result.rejected.length;
        this.counters.dropped.rejected += result.rejected.length;
        for (const { id, reason } of result.rejected) {
          log.warn("trace document rejected", { id, reason });
        }
      } else {
        this.counters.dropped.writeFailed += docs.length;
        log.error("trace batch dropped after failed writes", { count: docs.length });
      }
    } finally {
      this.queued -= batch.length;
      this.queuedBytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0);
      if (this.queueFull && this.queued < this.options.maxQueue) this.queueFull = false;
    }
  }

  private async writeUpdates(updates: DeliveryUpdate[]): Promise<void> {
    const done = await this.attempt(() => this.store.updateDeliveries(updates).then(() => true));
    if (done) {
      this.counters.deliveryUpdates.applied += updates.length;
    } else {
      this.counters.deliveryUpdates.failed += updates.length;
      log.error("trace delivery updates dropped after failed writes", { count: updates.length });
    }
  }

  /** Run `write` up to `maxAttempts` times; undefined when every attempt failed. */
  private async attempt<T>(write: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await write();
        if (!this.storeAvailable) {
          this.storeAvailable = true;
          log.info("trace store available again", this.queueStats());
        }
        return result;
      } catch (err) {
        this.counters.writeFailures++;
        if (this.storeAvailable) {
          this.storeAvailable = false;
          log.error("trace store unavailable", {
            error: maskUserinfo(err instanceof Error ? err.message : String(err)),
            ...this.queueStats(),
          });
        }
        if (attempt >= this.options.maxAttempts || this.aborted) return undefined;
        await sleep(this.options.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private queueStats() {
    return {
      queued: this.queued,
      queuedBytes: this.queuedBytes,
      maxQueue: this.options.maxQueue,
      maxQueueBytes: this.options.maxQueueBytes,
    };
  }

  private logStats(): void {
    const snapshot = JSON.stringify(this.counters);
    if (snapshot === this.lastLoggedStats) return;
    this.lastLoggedStats = snapshot;
    log.info("trace stats", this.stats());
  }
}

function isAfter(next: Delivery, current: Delivery): boolean {
  return DELIVERY_STATUS_RANK[next.status] > DELIVERY_STATUS_RANK[current.status];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
