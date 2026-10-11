import { OCPP_MSG_CALL, OCPP_MSG_CALLERROR, OCPP_MSG_CALLRESULT } from "../types";
import { isPlainObject } from "../utils/objects";

/** An OCPP-J frame decomposed into the fields of an Open OCPP Trace record. */
type ParsedFrame =
  | { messageType: "CALL"; messageId: string; action: string; payload: unknown }
  | { messageType: "CALLRESULT"; messageId: string; payload: unknown }
  | {
      messageType: "CALLERROR";
      messageId: string;
      error: { code: string; description: string; details?: unknown };
    };

/**
 * Why a frame cannot become an Open OCPP Trace v1.1 record. Such frames are
 * still forwarded untouched; they are archived as raw frames instead.
 */
export type UnparsedReason =
  | "invalid-json"
  | "not-an-array"
  | "unsupported-message-type"
  | "invalid-message-id"
  | "invalid-action"
  | "invalid-arity"
  | "invalid-error";

type FrameParseResult = { ok: true; frame: ParsedFrame } | { ok: false; reason: UnparsedReason };

const fail = (reason: UnparsedReason): FrameParseResult => ({ ok: false, reason });

/**
 * Decompose a raw OCPP-J frame. Only frames whose `raw` text decodes back to
 * the exact record are accepted (the spec's raw-fidelity rule): a numeric
 * message id, for instance, would be stringified in the record and contradict
 * `raw`, so it is reported as unparsed rather than silently normalised.
 */
export function parseOcppFrame(raw: string): FrameParseResult {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return fail("invalid-json");
  }
  if (!Array.isArray(frame)) return fail("not-an-array");

  const [type, messageId] = frame;
  if (type !== OCPP_MSG_CALL && type !== OCPP_MSG_CALLRESULT && type !== OCPP_MSG_CALLERROR) {
    return fail("unsupported-message-type");
  }
  if (typeof messageId !== "string") return fail("invalid-message-id");

  if (type === OCPP_MSG_CALL) {
    if (frame.length !== 4) return fail("invalid-arity");
    const [, , action, payload] = frame;
    if (typeof action !== "string") return fail("invalid-action");
    return { ok: true, frame: { messageType: "CALL", messageId, action, payload } };
  }
  if (type === OCPP_MSG_CALLRESULT) {
    if (frame.length !== 3) return fail("invalid-arity");
    return { ok: true, frame: { messageType: "CALLRESULT", messageId, payload: frame[2] } };
  }
  if (frame.length !== 4 && frame.length !== 5) return fail("invalid-arity");
  const [, , code, description, details] = frame;
  if (typeof code !== "string" || typeof description !== "string") return fail("invalid-error");
  const error = frame.length === 5 ? { code, description, details } : { code, description };
  return { ok: true, frame: { messageType: "CALLERROR", messageId, error } };
}

/** The payload's top-level `connectorId`, when it is a non-negative integer. */
export function connectorIdOf(payload: unknown): number | undefined {
  if (!isPlainObject(payload)) return undefined;
  const value = payload.connectorId;
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}
