import { describe, expect, it } from "vitest";
import { connectorIdOf, parseOcppFrame } from "../../src/trace/frame";

describe("parseOcppFrame", () => {
  it("parses a CALL", () => {
    expect(parseOcppFrame('[2,"m1","Heartbeat",{}]')).toEqual({
      ok: true,
      frame: { messageType: "CALL", messageId: "m1", action: "Heartbeat", payload: {} },
    });
  });

  it("parses a CALLRESULT", () => {
    expect(parseOcppFrame('[3,"m1",{"currentTime":"2024-01-15T10:00:00Z"}]')).toEqual({
      ok: true,
      frame: {
        messageType: "CALLRESULT",
        messageId: "m1",
        payload: { currentTime: "2024-01-15T10:00:00Z" },
      },
    });
  });

  it("parses a CALLERROR with details", () => {
    expect(parseOcppFrame('[4,"m1","NotImplemented","Unknown action",{"hint":1}]')).toEqual({
      ok: true,
      frame: {
        messageType: "CALLERROR",
        messageId: "m1",
        error: { code: "NotImplemented", description: "Unknown action", details: { hint: 1 } },
      },
    });
  });

  it("parses a CALLERROR without details", () => {
    expect(parseOcppFrame('[4,"m1","InternalError",""]')).toEqual({
      ok: true,
      frame: {
        messageType: "CALLERROR",
        messageId: "m1",
        error: { code: "InternalError", description: "" },
      },
    });
  });

  it("keeps any JSON payload, including non-objects", () => {
    const result = parseOcppFrame('[2,"m1","DataTransfer",[1,"a",null]]');
    expect(result.ok && result.frame.messageType === "CALL" && result.frame.payload).toEqual([
      1,
      "a",
      null,
    ]);
  });

  it.each([
    ["not JSON", "{oops", "invalid-json"],
    ["not an array", '{"a":1}', "not-an-array"],
    ["an empty array", "[]", "unsupported-message-type"],
    ["an unknown message type", '[7,"m1",{}]', "unsupported-message-type"],
    ["an OCPP 2.1 SEND", '[6,"m1","NotifyPeriodicEventStream",{}]', "unsupported-message-type"],
    ["a numeric message id", '[2,123,"Heartbeat",{}]', "invalid-message-id"],
    ["a CALL with a numeric action", '[2,"m1",42,{}]', "invalid-action"],
    ["a CALL without payload", '[2,"m1","Heartbeat"]', "invalid-arity"],
    ["a CALL with an extra element", '[2,"m1","Heartbeat",{},1]', "invalid-arity"],
    ["a CALLRESULT with an extra element", '[3,"m1",{},{}]', "invalid-arity"],
    ["a CALLERROR with a numeric code", '[4,"m1",500,"x",{}]', "invalid-error"],
    ["a CALLERROR without description", '[4,"m1","InternalError"]', "invalid-arity"],
  ])("rejects %s", (_name, raw, reason) => {
    expect(parseOcppFrame(raw)).toEqual({ ok: false, reason });
  });
});

describe("connectorIdOf", () => {
  it("reads a top-level non-negative integer connectorId", () => {
    expect(connectorIdOf({ connectorId: 0 })).toBe(0);
    expect(connectorIdOf({ connectorId: 2, evseId: 1 })).toBe(2);
  });

  it("ignores anything else", () => {
    expect(connectorIdOf({ connectorId: -1 })).toBeUndefined();
    expect(connectorIdOf({ connectorId: 1.5 })).toBeUndefined();
    expect(connectorIdOf({ connectorId: "1" })).toBeUndefined();
    expect(connectorIdOf({ evse: { connectorId: 1 } })).toBeUndefined();
    expect(connectorIdOf([1])).toBeUndefined();
    expect(connectorIdOf(null)).toBeUndefined();
  });
});
