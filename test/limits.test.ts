import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REJECTION_LOG_INTERVAL_MS, RejectionLog, SessionLimiter } from "../src/limits";

describe("SessionLimiter", () => {
  it("admits everything when no limit is set", () => {
    const limiter = new SessionLimiter({});
    for (let i = 0; i < 1000; i++) {
      expect(limiter.check("10.0.0.1")).toBeNull();
      limiter.acquire("10.0.0.1");
    }
    expect(limiter.sessions).toBe(1000);
  });

  it("caps live sessions globally, across sources", () => {
    const limiter = new SessionLimiter({ maxSessions: 2 });
    limiter.acquire("a");
    limiter.acquire("b");
    expect(limiter.check("c")).toBe("global");
  });

  it("caps sessions whose primary is still connecting, across sources", () => {
    const limiter = new SessionLimiter({ maxPendingSessions: 1 });
    const first = limiter.acquire("a");
    expect(limiter.check("b")).toBe("pending");

    first.primaryOpened();
    expect(limiter.check("b")).toBeNull();
    expect(limiter.sessions).toBe(1);
    expect(limiter.pendingSessions).toBe(0);
  });

  it("caps sessions per source, independently of other sources", () => {
    const limiter = new SessionLimiter({ maxSessionsPerSource: 1 });
    limiter.acquire("a");
    expect(limiter.check("a")).toBe("per-source");
    expect(limiter.check("b")).toBeNull();
  });

  it("reports the global cap first, then pending, then per-source", () => {
    const limiter = new SessionLimiter({
      maxSessions: 1,
      maxPendingSessions: 1,
      maxSessionsPerSource: 1,
    });
    limiter.acquire("a");
    expect(limiter.check("a")).toBe("global");

    const pendingFirst = new SessionLimiter({ maxPendingSessions: 1, maxSessionsPerSource: 1 });
    pendingFirst.acquire("a");
    expect(pendingFirst.check("a")).toBe("pending");
  });

  it("frees every counter on release, pending included when the primary never opened", () => {
    const limiter = new SessionLimiter({
      maxSessions: 1,
      maxPendingSessions: 1,
      maxSessionsPerSource: 1,
    });
    limiter.acquire("a").release();

    expect(limiter.sessions).toBe(0);
    expect(limiter.pendingSessions).toBe(0);
    expect(limiter.sessionsFrom("a")).toBe(0);
    expect(limiter.check("a")).toBeNull();
  });

  it("makes primaryOpened and release idempotent", () => {
    const limiter = new SessionLimiter({});
    const lease = limiter.acquire("a");
    limiter.acquire("a");

    lease.primaryOpened();
    lease.primaryOpened();
    expect(limiter.pendingSessions).toBe(1);

    lease.release();
    lease.release();
    lease.primaryOpened();
    expect(limiter.sessions).toBe(1);
    expect(limiter.pendingSessions).toBe(1);
    expect(limiter.sessionsFrom("a")).toBe(1);
  });

  it("counts the sessions a newcomer would replace as freed", () => {
    const limiter = new SessionLimiter({
      maxSessions: 1,
      maxPendingSessions: 1,
      maxSessionsPerSource: 1,
    });
    const stale = limiter.acquire("a");

    expect(limiter.check("a", [stale])).toBeNull();
    // Nothing is released by the check itself.
    expect(limiter.sessions).toBe(1);
  });

  it("frees a pending slot only for a replaced session still pending", () => {
    const limiter = new SessionLimiter({ maxPendingSessions: 1 });
    const open = limiter.acquire("a");
    open.primaryOpened();
    limiter.acquire("b");

    expect(limiter.check("a", [open])).toBe("pending");
  });

  it("frees a per-source slot only in the replaced session's source", () => {
    const limiter = new SessionLimiter({ maxSessionsPerSource: 1 });
    const stale = limiter.acquire("a");
    limiter.acquire("b");

    expect(limiter.check("b", [stale])).toBe("per-source");
    expect(limiter.check("a", [stale])).toBeNull();
  });

  it("ignores replaced sessions already released", () => {
    const limiter = new SessionLimiter({ maxSessions: 1 });
    const gone = limiter.acquire("a");
    gone.release();
    limiter.acquire("b");

    expect(limiter.check("c", [gone])).toBe("global");
  });

  it("forgets a source once its last session is released", () => {
    const limiter = new SessionLimiter({ maxSessionsPerSource: 5 });
    limiter.acquire("a").release();
    expect(limiter.trackedSources).toBe(0);
  });
});

describe("RejectionLog", () => {
  let warnings: { msg: string; extra: Record<string, unknown> }[];
  let log: RejectionLog;

  beforeEach(() => {
    vi.useFakeTimers();
    warnings = [];
    log = new RejectionLog({ warn: (msg, extra) => warnings.push({ msg, extra }) }, { maxKeys: 2 });
  });

  afterEach(() => {
    log.stop();
    vi.useRealTimers();
  });

  it("logs the first rejection of a source right away, then a count of the repeats", () => {
    log.record("per-source", "10.0.0.1");
    log.record("per-source", "10.0.0.1");
    log.record("per-source", "10.0.0.1");

    expect(warnings).toEqual([
      { msg: "connection rejected", extra: { reason: "per-source", source: "10.0.0.1" } },
    ]);

    vi.advanceTimersByTime(REJECTION_LOG_INTERVAL_MS);
    expect(warnings.slice(1)).toEqual([
      {
        msg: "connections rejected",
        extra: {
          reason: "per-source",
          source: "10.0.0.1",
          count: 2,
          intervalMs: REJECTION_LOG_INTERVAL_MS,
        },
      },
    ]);
  });

  it("keeps reasons of the same source apart", () => {
    log.record("global", "10.0.0.1");
    log.record("pending", "10.0.0.1");
    expect(warnings.map(({ extra }) => extra.reason)).toEqual(["global", "pending"]);
  });

  it("starts a fresh window after each interval", () => {
    log.record("global", "10.0.0.1");
    vi.advanceTimersByTime(REJECTION_LOG_INTERVAL_MS);
    log.record("global", "10.0.0.1");

    expect(warnings.map(({ msg }) => msg)).toEqual(["connection rejected", "connection rejected"]);
  });

  it("emits no summary when nothing was suppressed, and no timer stays armed", () => {
    log.record("global", "10.0.0.1");
    vi.advanceTimersByTime(REJECTION_LOG_INTERVAL_MS);
    expect(warnings).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the sources beyond its bound in one bucket per reason", () => {
    for (const source of ["a", "b", "c", "d", "d"]) log.record("per-source", source);
    log.record("client-ip-header", "e");
    expect(warnings).toHaveLength(2);

    vi.advanceTimersByTime(REJECTION_LOG_INTERVAL_MS);
    expect(warnings.slice(2)).toEqual([
      {
        msg: "connections rejected",
        extra: {
          reason: "per-source",
          source: null,
          otherSources: true,
          count: 3,
          intervalMs: REJECTION_LOG_INTERVAL_MS,
        },
      },
      {
        msg: "connections rejected",
        extra: {
          reason: "client-ip-header",
          source: null,
          otherSources: true,
          count: 1,
          intervalMs: REJECTION_LOG_INTERVAL_MS,
        },
      },
    ]);
  });

  it("flushes its pending counts and disarms its timer on stop", () => {
    log.record("global", "10.0.0.1");
    log.record("global", "10.0.0.1");
    log.stop();

    expect(warnings.at(-1)?.extra).toMatchObject({ reason: "global", count: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
