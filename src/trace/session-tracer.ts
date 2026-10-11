import { randomUUID } from "node:crypto";
import type { TenantId } from "../tenants";
import { Correlator } from "./correlator";
import { connectorIdOf, parseOcppFrame } from "./frame";
import {
  DELIVERY_STATUS_RANK,
  type Delivery,
  type DeliveryStatus,
  type Destination,
  type Direction,
  type DropReason,
  type GatewayMeta,
  type OcppTraceRecord,
  TRACE_SCHEMA_VERSION,
  type TraceDocument,
  type TraceSource,
  ocppVersionOf,
} from "./record";
import type { TraceSink } from "./writer";

/** What a tracer knows about its session; fixed for the session's lifetime. */
export interface SessionTracerContext {
  sessionId: string;
  tenantId: TenantId | null;
  chargePointId: string;
  /** Negotiated WebSocket sub-protocol (`ocpp1.6`, …), or `""`. */
  protocol: string;
  /** Backend id of the primary CSMS. */
  primaryId: string;
  /** Backend ids of the connected secondaries, in forwarding order. */
  secondaryIds: readonly string[];
}

export interface SessionTracerDeps {
  now(): Date;
  newId(): string;
}

/** Reports what happened to a frame on its way to one destination. Monotonic. */
export interface DeliveryTracker {
  queued(): void;
  submitted(): void;
  /** Outcome of a WebSocket send: written, or failed with the error. */
  settled(error: Error | null | undefined): void;
  dropped(reason: DropReason): void;
  failed(reason: string): void;
}

/**
 * A frame being forwarded. Report each destination's outcome through
 * `delivery(i)` (indexes follow the frame's destinations), then `commit()`
 * once the frame has been routed: the document is archived with the states
 * reached so far, and later ones are sent as updates.
 */
export interface ReceivedFrame {
  delivery(index: number): DeliveryTracker;
  commit(): void;
}

/** How a received frame is routed, and where its CALLs and responses belong. */
interface FrameRouting {
  direction: Direction;
  source: TraceSource;
  destinations: Destination[];
  ignored?: true;
  /** Conversations (CSMS ids) in which a CALL of this frame awaits a response. */
  callConversations: string[];
  /** Conversation in which a response of this frame answers a CALL. */
  responseConversation: string;
}

/**
 * Turns the frames of one charger session into trace documents, exactly one
 * per received frame, and correlates responses with their CALL. Pure
 * bookkeeping: all I/O goes through the non-blocking {@link TraceSink}.
 */
export class SessionTracer {
  private readonly correlator = new Correlator();
  private readonly ocppVersion: string | undefined;
  private seq = 0;

  constructor(
    private readonly context: SessionTracerContext,
    private readonly sink: TraceSink,
    private readonly deps: SessionTracerDeps = { now: () => new Date(), newId: randomUUID },
  ) {
    this.ocppVersion = ocppVersionOf(context.protocol);
  }

  /** A frame from the charger, routed to the primary then every secondary. */
  fromCharger(raw: string, binary = false): ReceivedFrame {
    const { chargePointId, primaryId, secondaryIds } = this.context;
    return this.receive(raw, binary, {
      direction: "cp-to-csms",
      source: { type: "charge-point", id: chargePointId },
      destinations: [
        { target: primaryId, role: "primary" },
        ...secondaryIds.map((id): Destination => ({ target: id, role: "secondary" })),
      ],
      callConversations: [primaryId, ...secondaryIds],
      // The charger only ever answers CALLs it received: the primary's.
      responseConversation: primaryId,
    });
  }

  /** A frame from the primary CSMS, routed to the charger. */
  fromPrimary(raw: string, binary = false): ReceivedFrame {
    const { chargePointId, primaryId } = this.context;
    return this.receive(raw, binary, {
      direction: "csms-to-cp",
      source: { type: "csms", id: primaryId, role: "primary" },
      destinations: [{ target: chargePointId, role: "charge-point" }],
      callConversations: [primaryId],
      responseConversation: primaryId,
    });
  }

  /** A frame from a secondary CSMS: archived as ignored, never forwarded. */
  fromSecondary(id: string, raw: string, binary = false): void {
    this.receive(raw, binary, {
      direction: "csms-to-cp",
      source: { type: "csms", id, role: "secondary" },
      destinations: [],
      ignored: true,
      // The charger never sees a secondary's CALLs, so nothing answers them.
      callConversations: [],
      responseConversation: id,
    }).commit();
  }

  private receive(raw: string, binary: boolean, route: FrameRouting): ReceivedFrame {
    // Only what must be captured at reception happens here; decoding and
    // correlating wait for commit(), once the frame has been forwarded.
    const receivedAt = this.deps.now();
    const id = this.deps.newId();
    const seq = ++this.seq;
    return new PendingFrame(
      id,
      () => this.build(raw, binary, route, { id, seq, receivedAt }),
      route.destinations,
      this.sink,
      () => this.deps.now(),
    );
  }

  /** The document of a received frame; called once, in reception order. */
  private build(
    raw: string,
    binary: boolean,
    route: FrameRouting,
    { id, seq, receivedAt }: { id: string; seq: number; receivedAt: Date },
  ): TraceDocument {
    const { tenantId, sessionId, chargePointId } = this.context;
    const gateway: GatewayMeta = {
      traceId: id,
      tenantId,
      sessionId,
      seq,
      source: route.source,
      destinations: route.destinations,
      ...(route.ignored && { ignored: true }),
      ...(binary && { binary: true }),
    };
    const timestamp = receivedAt.toISOString();
    const ocppVersion = this.ocppVersion !== undefined ? { ocppVersion: this.ocppVersion } : {};
    const base = { id, tenantId, sessionId, chargePointId, seq, receivedAt, deliveries: [] };

    const parsed = parseOcppFrame(raw);
    if (!parsed.ok) {
      const frame = {
        timestamp,
        ...ocppVersion,
        chargePointId,
        direction: route.direction,
        raw,
        reason: parsed.reason,
        meta: { gateway },
      };
      return { ...base, kind: "frame", frame };
    }

    const f = parsed.frame;
    if (f.messageType === "CALL") {
      for (const conversation of route.callConversations) {
        this.correlator.call(conversation, route.direction, f.messageId, {
          traceId: id,
          action: f.action,
        });
      }
    } else {
      const call = this.correlator.answer(route.responseConversation, route.direction, f.messageId);
      if (call) gateway.correlation = { callTraceId: call.traceId, action: call.action };
    }

    const payload = f.messageType === "CALLERROR" ? undefined : f.payload;
    const connectorId = connectorIdOf(payload);
    const trace: OcppTraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      timestamp,
      ...ocppVersion,
      transport: "json",
      chargePointId,
      ...(connectorId !== undefined && { connectorId }),
      direction: route.direction,
      messageType: f.messageType,
      messageId: f.messageId,
      // Responses carry no action: consumers derive it from the correlated
      // CALL (see `meta.gateway.correlation`), so it is never guessed here.
      ...(f.messageType === "CALL" && { action: f.action }),
      ...(f.messageType !== "CALLERROR" && { payload }),
      raw,
      ...(f.messageType === "CALLERROR" && { error: f.error }),
      meta: { gateway },
    };
    return { ...base, kind: "trace", trace };
  }
}

class PendingFrame implements ReceivedFrame {
  /**
   * Released on commit: queued messages and pending sends keep their tracker
   * alive, and must not keep the raw frame nor its document with it.
   */
  private build: (() => TraceDocument) | null;
  private readonly states: (Delivery | undefined)[];
  private committed = false;
  private accepted = false;

  constructor(
    private readonly id: string,
    build: () => TraceDocument,
    private readonly destinations: Destination[],
    private readonly sink: TraceSink,
    private readonly now: () => Date,
  ) {
    this.build = build;
    this.states = destinations.map(() => undefined);
  }

  delivery(index: number): DeliveryTracker {
    return {
      queued: () => this.update(index, "queued"),
      submitted: () => this.update(index, "submitted"),
      settled: (error) =>
        error ? this.update(index, "failed", error.message) : this.update(index, "written"),
      dropped: (reason) => this.update(index, "dropped", reason),
      failed: (reason) => this.update(index, "failed", reason),
    };
  }

  commit(): void {
    if (this.committed) return;
    this.committed = true;
    // Every destination is accounted for, even one the caller skipped.
    this.states.forEach((state, index) => {
      if (state === undefined) this.update(index, "dropped", "not-forwarded");
    });
    const doc = this.build!();
    this.build = null;
    // A copy: the sink owns the document, the states stay ours.
    doc.deliveries = this.states.slice() as Delivery[];
    this.accepted = this.sink.insert(doc);
  }

  private update(index: number, status: DeliveryStatus, reason?: string): void {
    const destination = this.destinations[index];
    if (destination === undefined) return;
    const current = this.states[index];
    if (current && DELIVERY_STATUS_RANK[status] <= DELIVERY_STATUS_RANK[current.status]) return;

    const delivery: Delivery = {
      ...destination,
      status,
      ...(reason !== undefined && { reason }),
      updatedAt: this.now(),
    };
    this.states[index] = delivery;
    if (this.committed && this.accepted) this.sink.updateDelivery(this.id, index, delivery);
  }
}
