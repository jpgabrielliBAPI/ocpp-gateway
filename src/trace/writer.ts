import type { Delivery, TraceDocument } from "./record";

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
