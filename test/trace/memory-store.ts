import { DELIVERY_STATUS_RANK, type TraceDocument } from "../../src/trace/record";
import type { DeliveryUpdate, TraceStore } from "../../src/trace/writer";

/** An in-memory store that applies the same guarded updates as MongoDB would. */
export class FakeStore implements TraceStore {
  readonly stored = new Map<string, TraceDocument>();
  readonly insertCalls: string[][] = [];
  readonly updateCalls: DeliveryUpdate[][] = [];
  /** Upcoming insertMany/updateDeliveries calls that fail (transiently). */
  failures = 0;
  readonly rejectIds = new Set<string>();
  /** When set, calls wait for this promise first. */
  gate: Promise<void> | null = null;

  async insertMany(docs: TraceDocument[]) {
    this.insertCalls.push(docs.map((d) => d.id));
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("connect ECONNREFUSED");
    }
    const rejected: { id: string; reason: string }[] = [];
    for (const doc of docs) {
      if (this.rejectIds.has(doc.id)) rejected.push({ id: doc.id, reason: "code 2" });
      else if (!this.stored.has(doc.id)) this.stored.set(doc.id, structuredClone(doc));
    }
    return { rejected };
  }

  async updateDeliveries(updates: DeliveryUpdate[]) {
    this.updateCalls.push(structuredClone(updates));
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("connect ECONNREFUSED");
    }
    for (const { id, index, delivery: next } of updates) {
      const current = this.stored.get(id)?.deliveries[index];
      if (current && DELIVERY_STATUS_RANK[current.status] < DELIVERY_STATUS_RANK[next.status]) {
        this.stored.get(id)!.deliveries[index] = next;
      }
    }
  }
}
