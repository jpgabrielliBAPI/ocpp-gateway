import type { Direction } from "./record";

/** Unanswered CALLs remembered per session, across all its conversations. */
export const DEFAULT_MAX_PENDING_CALLS = 1000;
/**
 * Characters those CALLs may hold (ids and actions): a hostile charger could
 * otherwise pin `DEFAULT_MAX_PENDING_CALLS` maximum-size message ids in memory.
 */
export const DEFAULT_MAX_PENDING_CHARS = 256 * 1024;

export interface CallRef {
  traceId: string;
  action: string;
}

interface PendingCall extends CallRef {
  key: string;
  chars: number;
}

/**
 * Applies the Open OCPP Trace correlation rule within each conversation of a
 * session: a response answers the most recent unanswered CALL with the same
 * messageId travelling the other way. A conversation is the exchange between
 * the charger and one CSMS, so a charger CALL mirrored to several CSMS can be
 * answered once in each, and never twice in the same one.
 *
 * Bounded by count and by size: past either bound, the oldest unanswered
 * CALLs are forgotten (their late responses then look like orphans), and a
 * CALL larger than the size bound on its own is never remembered.
 */
export class Correlator {
  /** Unanswered CALLs, oldest first (Set insertion order). */
  private readonly pending = new Set<PendingCall>();
  /** (conversation, CALL direction, messageId) → unanswered CALLs, oldest first. */
  private readonly byKey = new Map<string, PendingCall[]>();
  private chars = 0;

  constructor(
    private readonly maxPending = DEFAULT_MAX_PENDING_CALLS,
    private readonly maxChars = DEFAULT_MAX_PENDING_CHARS,
  ) {}

  call(conversation: string, direction: Direction, messageId: string, ref: CallRef): void {
    const key = JSON.stringify([conversation, direction, messageId]);
    const chars = key.length + ref.action.length + ref.traceId.length;
    if (chars > this.maxChars) return;

    const entry: PendingCall = { ...ref, key, chars };
    const stack = this.byKey.get(key);
    if (stack) stack.push(entry);
    else this.byKey.set(key, [entry]);
    this.pending.add(entry);
    this.chars += chars;

    while (this.pending.size > this.maxPending || this.chars > this.maxChars) {
      this.forget(this.pending.values().next().value!);
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
    this.chars -= entry.chars;
    const stack = this.byKey.get(entry.key)!;
    stack.splice(stack.indexOf(entry), 1);
    if (stack.length === 0) this.byKey.delete(entry.key);
  }
}
