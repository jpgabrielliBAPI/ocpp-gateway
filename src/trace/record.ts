import type { TenantId } from "../tenants";
import type { UnparsedReason } from "./frame";

/** The Open OCPP Trace format version the records conform to. */
export const TRACE_SCHEMA_VERSION = "1.1";

/** Relative to the charge point / CSMS pair, whichever socket the frame came from. */
export type Direction = "cp-to-csms" | "csms-to-cp";

/** Who sent a frame to the gateway. Backend ids name a logical CSMS, never a URL. */
export type TraceSource =
  | { type: "charge-point"; id: string }
  | { type: "csms"; id: string; role: "primary" | "secondary" };

type DestinationRole = "primary" | "secondary" | "charge-point";

/** A peer the gateway routed a frame to, decided when the frame was received. */
export interface Destination {
  target: string;
  role: DestinationRole;
}

/**
 * Gateway extension of a trace record, under the spec's `meta` field. Fixed
 * once the frame is received: delivery outcomes, which keep changing, live
 * next to the record (see {@link TraceDocument.deliveries}), never in it.
 */
export interface GatewayMeta {
  /** Unique id of this record; correlations refer to it. */
  traceId: string;
  tenantId: TenantId | null;
  /** One gateway session = one charger WebSocket connection. */
  sessionId: string;
  /** Reception order within the session, from 1. */
  seq: number;
  source: TraceSource;
  /** Configured routing for this frame; see the document's deliveries for what happened. */
  destinations: Destination[];
  /** Set on frames the gateway never forwards (secondary CSMS traffic). */
  ignored?: true;
  /**
   * The CALL this response answers, within the conversation between the
   * charger and the CSMS on the other end of the response (`source` for a CSMS
   * response, the primary for a charger response).
   */
  correlation?: { callTraceId: string; action: string };
  /** The frame arrived as a binary WebSocket message (decoded as UTF-8 text). */
  binary?: true;
}

/** An Open OCPP Trace v1.1 record. */
export interface OcppTraceRecord {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  timestamp: string;
  ocppVersion?: string;
  transport: "json";
  chargePointId: string;
  connectorId?: number;
  direction: Direction;
  messageType: "CALL" | "CALLRESULT" | "CALLERROR";
  messageId: string;
  action?: string;
  payload?: unknown;
  raw: string;
  error?: { code: string; description: string; details?: unknown };
  meta: { gateway: GatewayMeta };
}

/**
 * A received frame that Open OCPP Trace v1.1 cannot represent (not OCPP-J,
 * numeric message id, OCPP 2.1 message type, …). Same shape as a trace record
 * minus the decomposed fields, so it never claims conformance.
 */
export interface UnparsedFrame {
  timestamp: string;
  ocppVersion?: string;
  chargePointId: string;
  direction: Direction;
  raw: string;
  /**
   * Besides the parser's reasons: `lossy-binary` for a binary frame that was
   * not valid UTF-8; set by the store for records it cannot hold (too large,
   * or not BSON-encodable).
   */
  reason: UnparsedReason | "lossy-binary" | "document-too-large" | "not-storable";
  meta: { gateway: GatewayMeta };
}

/** The raw-frame form of a received frame, for one that cannot be (stored as) a trace record. */
export function unparsedFrame(
  {
    timestamp,
    ocppVersion,
    chargePointId,
    direction,
    raw,
    meta,
  }: Pick<
    OcppTraceRecord,
    "timestamp" | "ocppVersion" | "chargePointId" | "direction" | "raw" | "meta"
  >,
  reason: UnparsedFrame["reason"],
): UnparsedFrame {
  return {
    timestamp,
    ...(ocppVersion !== undefined && { ocppVersion }),
    chargePointId,
    direction,
    raw,
    reason,
    meta,
  };
}

/**
 * - `queued`: held in the gateway while the link is not open;
 * - `submitted`: handed to the WebSocket;
 * - `written`: the WebSocket wrote it to the TCP socket. Not an acknowledgement
 *   from the peer: an OCPP response is the only proof of processing;
 * - `failed`: the WebSocket reported an error;
 * - `dropped`: discarded by the gateway (see `reason`).
 */
export type DeliveryStatus = "queued" | "submitted" | "written" | "failed" | "dropped";

export type DropReason = "queue-overflow" | "session-ended" | "link-not-open" | "not-forwarded";

/** Statuses only move forward: queued → submitted → a final status. */
export const DELIVERY_STATUS_RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  submitted: 1,
  written: 2,
  failed: 2,
  dropped: 2,
};

/** The latest known outcome of routing a frame to one destination. */
export interface Delivery extends Destination {
  status: DeliveryStatus;
  /** Why the frame was dropped or failed. */
  reason?: string;
  updatedAt: Date;
}

interface TraceDocumentBase {
  id: string;
  tenantId: TenantId | null;
  sessionId: string;
  chargePointId: string;
  seq: number;
  receivedAt: Date;
  /** One per destination, aligned with `meta.gateway.destinations`. */
  deliveries: Delivery[];
}

/** What the gateway archives for every received frame. */
export type TraceDocument = TraceDocumentBase &
  ({ kind: "trace"; trace: OcppTraceRecord } | { kind: "frame"; frame: UnparsedFrame });

/** `ocpp2.0.1` → `2.0.1`; nothing for an unknown or missing sub-protocol. */
export function ocppVersionOf(protocol: string): string | undefined {
  return protocol.startsWith("ocpp") && protocol.length > 4 ? protocol.slice(4) : undefined;
}
