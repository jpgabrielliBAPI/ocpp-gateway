import { describe, expect, it } from "vitest";
import { Correlator } from "../../src/trace/correlator";

const call = (traceId: string, action = "Heartbeat") => ({ traceId, action });

describe("Correlator", () => {
  it("answers a CALL with a response travelling the other way", () => {
    const c = new Correlator();
    c.call("csms-a", "cp-to-csms", "m1", call("t1"));
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toEqual(call("t1"));
  });

  it("answers each CALL at most once", () => {
    const c = new Correlator();
    c.call("csms-a", "cp-to-csms", "m1", call("t1"));
    c.answer("csms-a", "csms-to-cp", "m1");
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toBeUndefined();
  });

  it("ignores a response travelling the same way as the CALL", () => {
    const c = new Correlator();
    c.call("csms-a", "cp-to-csms", "m1", call("t1"));
    expect(c.answer("csms-a", "cp-to-csms", "m1")).toBeUndefined();
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toEqual(call("t1"));
  });

  it("returns undefined for an orphan response", () => {
    expect(new Correlator().answer("csms-a", "csms-to-cp", "nope")).toBeUndefined();
  });

  it("keeps conversations apart: one CALL can be answered once per conversation", () => {
    const c = new Correlator();
    c.call("primary", "cp-to-csms", "m1", call("t1"));
    c.call("mirror", "cp-to-csms", "m1", call("t1"));
    expect(c.answer("mirror", "csms-to-cp", "m1")).toEqual(call("t1"));
    expect(c.answer("mirror", "csms-to-cp", "m1")).toBeUndefined();
    expect(c.answer("primary", "csms-to-cp", "m1")).toEqual(call("t1"));
  });

  it("pairs a reused messageId with the most recent unanswered CALL", () => {
    const c = new Correlator();
    c.call("csms-a", "cp-to-csms", "m1", call("t1"));
    c.call("csms-a", "cp-to-csms", "m1", call("t2"));
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toEqual(call("t2"));
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toEqual(call("t1"));
  });

  it("tracks concurrent CALLs in both directions", () => {
    const c = new Correlator();
    c.call("csms-a", "cp-to-csms", "a", call("t1", "MeterValues"));
    c.call("csms-a", "csms-to-cp", "b", call("t2", "Reset"));
    c.call("csms-a", "cp-to-csms", "c", call("t3", "StatusNotification"));
    expect(c.answer("csms-a", "cp-to-csms", "b")).toEqual(call("t2", "Reset"));
    expect(c.answer("csms-a", "csms-to-cp", "c")).toEqual(call("t3", "StatusNotification"));
    expect(c.answer("csms-a", "csms-to-cp", "a")).toEqual(call("t1", "MeterValues"));
  });

  it("forgets the oldest unanswered CALLs beyond its bound", () => {
    const c = new Correlator(2);
    c.call("csms-a", "cp-to-csms", "m1", call("t1"));
    c.call("csms-a", "cp-to-csms", "m2", call("t2"));
    c.call("csms-a", "cp-to-csms", "m3", call("t3"));
    expect(c.answer("csms-a", "csms-to-cp", "m1")).toBeUndefined();
    expect(c.answer("csms-a", "csms-to-cp", "m2")).toEqual(call("t2"));
    expect(c.answer("csms-a", "csms-to-cp", "m3")).toEqual(call("t3"));
  });

  it("frees the bound when CALLs are answered", () => {
    const c = new Correlator(1);
    for (let i = 0; i < 5; i++) {
      c.call("csms-a", "cp-to-csms", `m${i}`, call(`t${i}`));
      expect(c.answer("csms-a", "csms-to-cp", `m${i}`)).toEqual(call(`t${i}`));
    }
  });

  it("bounds the memory held by unanswered CALLs, not only their number", () => {
    const c = new Correlator(1000, 100);
    c.call("csms-a", "cp-to-csms", "small", call("t1"));
    c.call("csms-a", "cp-to-csms", "x".repeat(200), call("t2"));
    // An oversized CALL is never kept, and does not evict the others.
    expect(c.answer("csms-a", "csms-to-cp", "x".repeat(200))).toBeUndefined();
    expect(c.answer("csms-a", "csms-to-cp", "small")).toEqual(call("t1"));
  });

  it("evicts the oldest CALLs to stay within its size bound", () => {
    const c = new Correlator(1000, 100);
    c.call("csms-a", "cp-to-csms", "a".repeat(30), call("t1"));
    c.call("csms-a", "cp-to-csms", "b".repeat(30), call("t2"));
    expect(c.answer("csms-a", "csms-to-cp", "a".repeat(30))).toBeUndefined();
    expect(c.answer("csms-a", "csms-to-cp", "b".repeat(30))).toEqual(call("t2"));
  });
});
