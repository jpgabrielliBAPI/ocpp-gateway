/**
 * Admission control for charger sessions: how many may be live at once,
 * globally, while their primary link is still connecting (where the memory
 * goes: each holds a replay queue), and per client source. Every limit is
 * optional; unset means unlimited.
 *
 * A source is whatever identifies the client (its IP address, read from the
 * socket or from a header set by a trusted proxy): sources are attacker
 * influenced, so nothing is kept for a source without a live session.
 */

/** Which limit refused a session. */
export type LimitReason = "global" | "pending" | "per-source";

/** Why a connection was refused before a session was started. */
export type RejectionReason = LimitReason | "client-ip-header";

export interface SessionLimits {
  /** Live charger sessions. */
  maxSessions?: number;
  /** Sessions whose primary link is still connecting. */
  maxPendingSessions?: number;
  /** Live sessions per client source. */
  maxSessionsPerSource?: number;
}

/** One admitted session's hold on the counters. Both methods are idempotent. */
export interface SessionLease {
  /** The source the session counts against. */
  readonly source: string;
  /** Whether the session still holds its slots. */
  readonly live: boolean;
  /** Whether the session still counts as pending. */
  readonly pending: boolean;
  /** The primary link opened: the session no longer counts as pending. */
  primaryOpened(): void;
  /** The session ended: free all its counters. */
  release(): void;
}

export class SessionLimiter {
  private live = 0;
  private pending = 0;
  private readonly perSource = new Map<string, number>();

  constructor(private readonly limits: SessionLimits) {}

  get sessions(): number {
    return this.live;
  }

  get pendingSessions(): number {
    return this.pending;
  }

  /** Sources that currently hold at least one session. */
  get trackedSources(): number {
    return this.perSource.size;
  }

  sessionsFrom(source: string): number {
    return this.perSource.get(source) ?? 0;
  }

  /**
   * The first limit a new session from `source` would exceed, or `null` if it
   * may start. The sessions it would `replace` count as freed, so a
   * replacement can be checked before anything is torn down.
   */
  check(source: string, replace: readonly SessionLease[] = []): LimitReason | null {
    const { maxSessions, maxPendingSessions, maxSessionsPerSource } = this.limits;
    const freed = replace.filter((lease) => lease.live);
    const live = this.live - freed.length;
    const pending = this.pending - freed.filter((lease) => lease.pending).length;
    const fromSource =
      this.sessionsFrom(source) - freed.filter((lease) => lease.source === source).length;
    if (maxSessions !== undefined && live >= maxSessions) return "global";
    if (maxPendingSessions !== undefined && pending >= maxPendingSessions) return "pending";
    if (maxSessionsPerSource !== undefined && fromSource >= maxSessionsPerSource) {
      return "per-source";
    }
    return null;
  }

  /** Count a new session from `source`, pending until its primary opens. Does not check the limits. */
  acquire(source: string): SessionLease {
    this.live += 1;
    this.pending += 1;
    this.perSource.set(source, this.sessionsFrom(source) + 1);

    let pending = true;
    let live = true;
    const settlePending = () => {
      if (!pending) return;
      pending = false;
      this.pending -= 1;
    };
    return {
      source,
      get live() {
        return live;
      },
      get pending() {
        return pending;
      },
      // After release, pending is already settled: nothing left to do.
      primaryOpened: settlePending,
      release: () => {
        if (!live) return;
        live = false;
        settlePending();
        this.live -= 1;
        const count = this.sessionsFrom(source) - 1;
        if (count === 0) this.perSource.delete(source);
        else this.perSource.set(source, count);
      },
    };
  }
}

/** How long repeated rejections of one (reason, source) are counted before being summarised. */
export const REJECTION_LOG_INTERVAL_MS = 60_000;
/** Distinct (reason, source) pairs tracked per interval; the others share one bucket per reason. */
const DEFAULT_REJECTION_LOG_MAX_KEYS = 1000;

interface RejectionLogger {
  warn(msg: string, extra: Record<string, unknown>): void;
}

interface RejectionEntry {
  reason: RejectionReason;
  source: string;
  /** Rejections after the first one, which was logged right away. */
  suppressed: number;
}

/**
 * Logs connection rejections without letting a flood of them flood the logs:
 * the first rejection of a (reason, source) in an interval is logged right
 * away, the following ones are counted and summarised in one line when the
 * interval ends. Memory is bounded: past `maxKeys` pairs, rejections are only
 * counted per reason.
 */
export class RejectionLog {
  private readonly entries = new Map<string, RejectionEntry>();
  private readonly overflow = new Map<RejectionReason, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxKeys: number;

  constructor(
    private readonly logger: RejectionLogger,
    { maxKeys = DEFAULT_REJECTION_LOG_MAX_KEYS }: { maxKeys?: number } = {},
  ) {
    this.maxKeys = maxKeys;
  }

  record(reason: RejectionReason, source: string): void {
    this.arm();
    const key = JSON.stringify([reason, source]);
    const entry = this.entries.get(key);
    if (entry) {
      entry.suppressed += 1;
    } else if (this.entries.size < this.maxKeys) {
      this.entries.set(key, { reason, source, suppressed: 0 });
      this.logger.warn("connection rejected", { reason, source });
    } else {
      this.overflow.set(reason, (this.overflow.get(reason) ?? 0) + 1);
    }
  }

  /** Log what is still counted and disarm the timer (gateway shutdown). */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Armed only while something is counted, so an idle gateway keeps no timer. */
  private arm() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, REJECTION_LOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  private flush() {
    const intervalMs = REJECTION_LOG_INTERVAL_MS;
    for (const { reason, source, suppressed } of this.entries.values()) {
      if (suppressed > 0) {
        this.logger.warn("connections rejected", { reason, source, count: suppressed, intervalMs });
      }
    }
    for (const [reason, count] of this.overflow) {
      this.logger.warn("connections rejected", {
        reason,
        source: null,
        otherSources: true,
        count,
        intervalMs,
      });
    }
    this.entries.clear();
    this.overflow.clear();
  }
}
