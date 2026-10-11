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
  unparsedFrame,
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

interface SessionTracerDeps {
  now(): Date;
  newId(): string;
}

/**
 * How a frame arrived: a text message, a binary one holding valid UTF-8, or a
 * binary one that is not (decoded with U+FFFD, so the text is not the frame).
 */
export type FrameEncoding = "text" | "binary" | "lossy-binary";

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

/** What is captured when a frame arrives; decoded into a document on commit. */
interface Reception {
  id: string;
  seq: number;
  receivedAt: Date;
  raw: string;
  encoding: FrameEncoding;
  routing: FrameRouting;
}

/**
 * Turns the frames of one charger session into trace documents, exactly one
 * per received frame, and correlates responses with their CALL. Pure
 * bookkeeping: all I/O goes through the non-blocking {@link TraceSink}.
 */
export class SessionTracer {
  private readonly correlator = new Correlator();
  private readonly ocppVersion: string | undefined;
  private readonly chargerRouting: FrameRouting;
  private readonly primaryRouting: FrameRouting;
  private readonly secondaryRoutings = new Map<string, FrameRouting>();
  private seq = 0;

  constructor(
    private readonly context: SessionTracerContext,
    private readonly sink: TraceSink,
    private readonly deps: SessionTracerDeps = { now: () => new Date(), newId: randomUUID },
  ) {
    const { chargePointId, primaryId, secondaryIds } = context;
    this.ocppVersion = ocppVersionOf(context.protocol);
    this.chargerRouting = {
      direction: "cp-to-csms",
      source: { type: "charge-point", id: chargePointId },
      destinations: [
        { target: primaryId, role: "primary" },
        ...secondaryIds.map((id): Destination => ({ target: id, role: "secondary" })),
      ],
      callConversations: [primaryId, ...secondaryIds],
      // The charger only ever answers CALLs it received: the primary's.
      responseConversation: primaryId,
    };
    this.primaryRouting = {
      direction: "csms-to-cp",
      source: { type: "csms", id: primaryId, role: "primary" },
      destinations: [{ target: chargePointId, role: "charge-point" }],
      callConversations: [primaryId],
      responseConversation: primaryId,
    };
  }

  /** A frame from the charger, routed to the primary then every secondary. */
  fromCharger(raw: string, encoding: FrameEncoding = "text"): ReceivedFrame {
    return this.receive(raw, encoding, this.chargerRouting);
  }

  /** A frame from the primary CSMS, routed to the charger. */
  fromPrimary(raw: string, encoding: FrameEncoding = "text"): ReceivedFrame {
    return this.receive(raw, encoding, this.primaryRouting);
  }

  /** A frame from a secondary CSMS: archived as ignored, never forwarded. */
  fromSecondary(id: string, raw: string, encoding: FrameEncoding = "text"): void {
    let routing = this.secondaryRoutings.get(id);
    if (!routing) {
      routing = {
        direction: "csms-to-cp",
        source: { type: "csms", id, role: "secondary" },
        destinations: [],
        ignored: true,
        // The charger never sees a secondary's CALLs, so nothing answers them.
        callConversations: [],
        responseConversation: id,
      };
      this.secondaryRoutings.set(id, routing);
    }
    this.receive(raw, encoding, routing).commit();
  }

  private receive(raw: string, encoding: FrameEncoding, routing: FrameRouting): ReceivedFrame {
    // Only what must be captured at reception happens here; decoding and
    // correlating wait for commit(), once the frame has been forwarded.
    return new PendingFrame(this, {
      id: this.deps.newId(),
      seq: ++this.seq,
      receivedAt: this.deps.now(),
      raw,
      encoding,
      routing,
    });
  }

  /** @internal Shared by the frames of this session. */
  now(): Date {
    return this.deps.now();
  }

  /** @internal Shared by the frames of this session. */
  insert(doc: TraceDocument): boolean {
    return this.sink.insert(doc);
  }

  /** @internal Shared by the frames of this session. */
  updateDelivery(id: string, index: number, delivery: Delivery): void {
    this.sink.updateDelivery(id, index, delivery);
  }

  /** @internal The document of a received frame; called once per frame, in reception order. */
  build({ id, seq, receivedAt, raw, encoding, routing }: Reception): TraceDocument {
    const { tenantId, sessionId, chargePointId } = this.context;
    const gateway: GatewayMeta = {
      traceId: id,
      tenantId,
      sessionId,
      seq,
      source: routing.source,
      destinations: routing.destinations,
      ...(routing.ignored && { ignored: true }),
      ...(encoding !== "text" && { binary: true }),
    };
    const common = {
      timestamp: receivedAt.toISOString(),
      ...(this.ocppVersion !== undefined && { ocppVersion: this.ocppVersion }),
      chargePointId,
      direction: routing.direction,
      raw,
      meta: { gateway },
    };
    const base = { id, tenantId, sessionId, chargePointId, seq, receivedAt, deliveries: [] };

    // A lossily decoded frame is not the frame received: never a trace record.
    const parsed =
      encoding === "lossy-binary"
        ? ({ ok: false, reason: "lossy-binary" } as const)
        : parseOcppFrame(raw);
    if (!parsed.ok) return { ...base, kind: "frame", frame: unparsedFrame(common, parsed.reason) };

    const f = parsed.frame;
    if (f.messageType === "CALL") {
      for (const conversation of routing.callConversations) {
        this.correlator.call(conversation, routing.direction, f.messageId, {
          traceId: id,
          action: f.action,
        });
      }
    } else {
      const call = this.correlator.answer(
        routing.responseConversation,
        routing.direction,
        f.messageId,
      );
      if (call) gateway.correlation = { callTraceId: call.traceId, action: call.action };
    }

    const payload = f.messageType === "CALLERROR" ? undefined : f.payload;
    const connectorId = connectorIdOf(payload);
    const trace: OcppTraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      timestamp: common.timestamp,
      ...(this.ocppVersion !== undefined && { ocppVersion: this.ocppVersion }),
      transport: "json",
      chargePointId,
      ...(connectorId !== undefined && { connectorId }),
      direction: routing.direction,
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
  private readonly id: string;
  private readonly destinations: Destination[];
  /**
   * Released on commit: queued messages and pending sends keep their tracker
   * alive, and must not keep the raw frame nor its document with it.
   */
  private reception: Reception | null;
  private readonly states: (Delivery | undefined)[];
  private committed = false;
  private accepted = false;

  constructor(
    private readonly tracer: SessionTracer,
    reception: Reception,
  ) {
    this.id = reception.id;
    this.destinations = reception.routing.destinations;
    this.reception = reception;
    this.states = this.destinations.map(() => undefined);
  }

  delivery(index: number): DeliveryTracker {
    return new FrameDelivery(this, index);
  }

  commit(): void {
    if (this.committed) return;
    this.committed = true;
    // Every destination is accounted for, even one the caller skipped.
    this.states.forEach((state, index) => {
      if (state === undefined) this.update(index, "dropped", "not-forwarded");
    });
    const doc = this.tracer.build(this.reception!);
    this.reception = null;
    // A copy: the sink owns the document, the states stay ours.
    doc.deliveries = this.states.slice() as Delivery[];
    this.accepted = this.tracer.insert(doc);
  }

  update(index: number, status: DeliveryStatus, reason?: string): void {
    const destination = this.destinations[index];
    if (destination === undefined) return;
    const current = this.states[index];
    if (current && DELIVERY_STATUS_RANK[status] <= DELIVERY_STATUS_RANK[current.status]) return;

    const delivery: Delivery = {
      ...destination,
      status,
      ...(reason !== undefined && { reason }),
      updatedAt: this.tracer.now(),
    };
    this.states[index] = delivery;
    if (this.committed && this.accepted) this.tracer.updateDelivery(this.id, index, delivery);
  }
}

class FrameDelivery implements DeliveryTracker {
  constructor(
    private readonly frame: PendingFrame,
    private readonly index: number,
  ) {}

  queued(): void {
    this.frame.update(this.index, "queued");
  }

  submitted(): void {
    this.frame.update(this.index, "submitted");
  }

  settled(error: Error | null | undefined): void {
    if (error) this.frame.update(this.index, "failed", error.message);
    else this.frame.update(this.index, "written");
  }

  dropped(reason: DropReason): void {
    this.frame.update(this.index, "dropped", reason);
  }

  failed(reason: string): void {
    this.frame.update(this.index, "failed", reason);
  }
}
