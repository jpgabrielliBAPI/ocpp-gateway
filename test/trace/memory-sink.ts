import type { Delivery, TraceDocument } from "../../src/trace/record";
import type { TraceSink } from "../../src/trace/writer";

/**
 * In-memory TraceSink for tests: keeps a snapshot of every accepted document
 * and applies delivery updates to it, so `docs` always shows the latest state.
 */
export class MemoryTraceSink implements TraceSink {
  readonly docs: TraceDocument[] = [];
  readonly updates: { id: string; index: number; delivery: Delivery }[] = [];
  /** Set to false to make `insert` reject documents, like a full writer queue. */
  accept = true;

  insert(doc: TraceDocument): boolean {
    if (!this.accept) return false;
    this.docs.push(structuredClone(doc));
    return true;
  }

  updateDelivery(id: string, index: number, delivery: Delivery): void {
    this.updates.push({ id, index, delivery: structuredClone(delivery) });
    const doc = this.docs.find((d) => d.id === id);
    if (doc) doc.deliveries[index] = structuredClone(delivery);
  }

  /** The documents that carry a standard trace record, in insertion order. */
  traces() {
    return this.docs.flatMap((d) => (d.kind === "trace" ? [d.trace] : []));
  }
}
