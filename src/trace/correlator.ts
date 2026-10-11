import type { Direction } from "./record";

/** Unanswered CALLs remembered per session, across all its conversations. */
export const DEFAULT_MAX_PENDING_CALLS = 1000;

export interface CallRef {
  traceId: string;
  action: string;
}

interface PendingCall extends CallRef {
  key: string;
}

/**
 * Applies the Open OCPP Trace correlation rule within each conversation of a
 * session: a response answers the most recent unanswered CALL with the same
 * messageId travelling the other way. A conversation is the exchange between
 * the charger and one CSMS, so a charger CALL mirrored to several CSMS can be
 * answered once in each, and never twice in the same one.
 *
 * Bounded: past `maxPending` unanswered CALLs, the oldest are forgotten (their
 * late responses then look like orphans).
 */
export class Correlator {
  /** Unanswered CALLs, oldest first (Set insertion order). */
  private readonly pending = new Set<PendingCall>();
  /** (conversation, CALL direction, messageId) → unanswered CALLs, oldest first. */
  private readonly byKey = new Map<string, PendingCall[]>();

  constructor(private readonly maxPending = DEFAULT_MAX_PENDING_CALLS) {}

  call(conversation: string, direction: Direction, messageId: string, ref: CallRef): void {
    const key = JSON.stringify([conversation, direction, messageId]);
    const entry: PendingCall = { ...ref, key };
    const stack = this.byKey.get(key);
    if (stack) stack.push(entry);
    else this.byKey.set(key, [entry]);
    this.pending.add(entry);

    if (this.pending.size > this.maxPending) {
      const oldest = this.pending.values().next().value!;
      this.forget(oldest);
    }
  }

  /** Consume and return the CALL a response travelling `direction` answers, if any. */
  answer(conversation: string, direction: Direction, messageId: string): CallRef | undefined {
    const callDirection: Direction = direction === "cp-to-csms" ? "csms-to-cp" : "cp-to-csms";
    const stack = this.byKey.get(JSON.stringify([conversation, callDirection, messageId]));
    const entry = stack?.at(-1);
    if (!entry) return undefined;
    this.forget(entry);
    return { traceId: entry.traceId, action: entry.action };
  }

  private forget(entry: PendingCall): void {
    this.pending.delete(entry);
    const stack = this.byKey.get(entry.key)!;
    stack.splice(stack.indexOf(entry), 1);
    if (stack.length === 0) this.byKey.delete(entry.key);
  }
}
