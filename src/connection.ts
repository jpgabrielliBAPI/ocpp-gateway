import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createLogger } from "./logger";
import { type Route, buildTargetUrl } from "./routes";
import { type SessionKey, formatSessionKey } from "./sessions";
import { type DeliveryTracker, SessionTracer } from "./trace/session-tracer";
import type { TraceSink } from "./trace/writer";
import { OCPP_SUBPROTOCOLS } from "./types";
import { BoundedQueue } from "./utils/bounded-queue";
import { redactUrl } from "./utils/url";
import { forwardPing, forwardPong, rawDataToString } from "./utils/websocket";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - Messages from the charger are forwarded to the primary and mirrored
 *   to all secondaries.
 * - Only the primary CSMS can send commands back to the charger.
 * - Every link (charger, primary, secondaries) rejects messages larger than
 *   `maxPayload`: `ws` closes it with 1009 before the message is seen here.
 * - Messages the charger sends while the primary is still connecting are
 *   held in a bounded queue and flushed in order once it opens.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link. Secondaries auto-reconnect, send
 *   periodic keepalive pings, and buffer a bounded queue of
 *   messages while reconnecting so brief blips don't lose data.
 * - Every queue is bounded by count and by total bytes, dropping the
 *   oldest messages first.
 * - With a trace sink, every received frame is archived once, at ingress,
 *   and each destination's delivery outcome is tracked (queued, submitted,
 *   written, failed, dropped) on that same record. Without one, forwarding
 *   is exactly as if tracing did not exist.
 */

export const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
/** Messages buffered per upstream link while it is not open; oldest dropped first. */
export const UPSTREAM_MAX_QUEUE = 100;
/**
 * Total bytes buffered per upstream link while it is not open; raised to the
 * session's `maxPayload` when larger, so a maximum-size message always fits.
 */
export const UPSTREAM_MAX_QUEUE_BYTES = 1024 * 1024;

/** A message waiting for its link to open, with its trace delivery when archiving. */
interface QueuedMessage {
  raw: string;
  delivery?: DeliveryTracker;
}

interface SecondaryState {
  /** Backend id, the secondary's name in traces. */
  id: string;
  url: string;
  /** `url` without credentials: the only form that may be logged. */
  logUrl: string;
  ws: WebSocket | null;
  queue: BoundedQueue<QueuedMessage>;
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  /** Unique per charger WebSocket connection: tells apart sessions of the same charger. */
  readonly sessionId = randomUUID();
  private readonly log;
  private primary: WebSocket | null = null;
  private readonly primaryQueue: BoundedQueue<QueuedMessage>;
  private secondaries: SecondaryState[] = [];
  private tracer: SessionTracer | undefined;
  private alive = true;

  constructor(
    private readonly charger: WebSocket,
    private readonly key: SessionKey,
    private readonly route: Route,
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly maxPayload: number,
    private readonly onEnd: () => void,
    private readonly traceSink?: TraceSink,
  ) {
    // Tag logs with the tenant too: two tenants may share a chargeBoxId.
    this.log = createLogger(formatSessionKey(key));
    this.primaryQueue = this.createQueue();
    this.setup();
  }

  private setup() {
    // `new WebSocket()` throws synchronously on URLs it refuses to dial (bad
    // scheme, fragment, …). Never let that escape into the server's connection
    // handler: it would crash the gateway for every charger.
    const primaryUrl = buildTargetUrl(this.route.primary, this.key.chargeBoxId);
    const primaryLogUrl = redactUrl(primaryUrl);
    try {
      this.primary = this.connectPrimary(primaryUrl, primaryLogUrl);
    } catch (err) {
      this.log.error("primary error", { url: primaryLogUrl, error: errorMessage(err) });
      // Fail like an unreachable primary, once the caller has registered us.
      queueMicrotask(() => {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      });
      return;
    }

    this.route.secondaries.forEach((backend, index) => {
      const url = buildTargetUrl(backend, this.key.chargeBoxId);
      const state: SecondaryState = {
        // Ids are required when archiving; the fallback only names a test's backend.
        id: backend.id ?? `secondary-${index + 1}`,
        url,
        logUrl: redactUrl(url),
        ws: null,
        queue: this.createQueue(),
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
      };
      try {
        state.ws = this.connectSecondary(state);
      } catch (err) {
        // A secondary must never affect the charger or the primary: skip it.
        this.log.error("secondary skipped", { url: state.logUrl, error: errorMessage(err) });
        return;
      }
      this.secondaries.push(state);
    });

    // Destinations are the secondaries actually set up, in forwarding order.
    if (this.traceSink) {
      this.tracer = new SessionTracer(
        {
          sessionId: this.sessionId,
          tenantId: this.key.tenantId,
          chargePointId: this.key.chargeBoxId,
          protocol: this.protocol,
          primaryId: this.route.primary.id ?? "primary",
          secondaryIds: this.secondaries.map((sec) => sec.id),
        },
        this.traceSink,
      );
    }

    this.charger.on("message", (data, isBinary) => {
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("charger → proxy", raw);
      // Archived once, here at ingress, however many links it goes to.
      const frame = this.tracer?.fromCharger(raw, isBinary);

      const primary = this.primary;
      const primaryDelivery = frame?.delivery(0);
      if (primary?.readyState === WebSocket.OPEN) {
        send(primary, raw, primaryDelivery);
      } else if (primary?.readyState === WebSocket.CONNECTING) {
        this.enqueue("primary", this.primaryQueue, { raw, delivery: primaryDelivery });
      } else {
        this.log.warn("primary not open, dropping message", { readyState: primary?.readyState });
        primaryDelivery?.dropped("link-not-open");
      }

      this.secondaries.forEach((sec, index) => {
        const delivery = frame?.delivery(index + 1);
        if (sec.ws?.readyState === WebSocket.OPEN) {
          try {
            send(sec.ws, raw, delivery);
          } catch (err) {
            this.log.warn("secondary send failed", { url: sec.logUrl, error: errorMessage(err) });
            delivery?.failed(errorMessage(err));
          }
        } else {
          this.enqueue("secondary", sec.queue, { raw, delivery }, { url: sec.logUrl });
        }
      });

      frame?.commit();
    });

    this.charger.on("close", (code, reason) => {
      this.log.info("charger disconnected", {
        code,
        reason: reason.toString(),
      });
      this.teardown();
    });

    this.charger.on("error", (err) => {
      this.log.error("charger connection error", { error: err.message });
    });

    this.charger.on("ping", (data) => {
      forwardPing(this.primary, data);
    });

    this.charger.on("pong", (data) => {
      forwardPong(this.primary, data);
    });

    this.log.info("session started", {
      primary: primaryLogUrl,
      secondaries: this.secondaries.map((secondary) => secondary.logUrl),
      protocol: this.protocol,
    });
  }

  /**
   * Connect to the primary CSMS. The primary is bidirectional: its
   * responses are forwarded back to the charger, and a primary failure
   * tears the whole session down (chargers expect to talk to exactly one
   * CSMS at a time).
   */
  private connectPrimary(url: string, logUrl: string): WebSocket {
    const ws = new WebSocket(url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers: this.buildHeaders(),
      handshakeTimeout: 10_000,
      autoPong: false,
      maxPayload: this.maxPayload,
    });

    ws.on("open", () => {
      this.log.info("primary connected", { url: logUrl });
      this.flushPrimaryQueue(ws);
    });

    ws.on("message", (data, isBinary) => {
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("primary → charger", raw);
      const frame = this.tracer?.fromPrimary(raw, isBinary);
      if (this.charger.readyState === WebSocket.OPEN) {
        send(this.charger, raw, frame?.delivery(0));
      } else {
        frame?.delivery(0).dropped("link-not-open");
      }
      frame?.commit();
    });

    ws.on("close", (code, reason) => {
      this.log.warn("primary disconnected", {
        url: logUrl,
        code,
        reason: reason.toString(),
      });
      this.charger.close(1001, "Primary CSMS disconnected");
      this.teardown();
    });

    ws.on("error", (err) => {
      this.log.error("primary error", { url: logUrl, error: err.message });
      if (this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => {
      forwardPing(this.charger, data);
    });
    ws.on("pong", (data) => {
      forwardPong(this.charger, data);
    });

    return ws;
  }

  /**
   * Connect (or reconnect) a secondary CSMS. Secondaries are one-way
   * mirrors: their responses are logged and discarded. They auto-reconnect
   * on disconnect/error and send periodic keepalive pings so idle
   * connections aren't dropped by intermediaries.
   */
  private connectSecondary(state: SecondaryState): WebSocket {
    const ws = new WebSocket(state.url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers: this.buildHeaders(),
      handshakeTimeout: 10_000,
      maxPayload: this.maxPayload,
    });

    ws.on("open", () => {
      this.log.info("secondary connected", { url: state.logUrl });
      state.lastPongAt = Date.now();
      this.flushSecondaryQueue(state, ws);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data, isBinary) => {
      const raw = rawDataToString(data);
      // An application-level keepalive some CSMS send, not an OCPP frame: never archived.
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      this.log.debugOcppFrame("secondary response (ignored)", raw, { url: state.logUrl });
      this.tracer?.fromSecondary(state.id, raw, isBinary);
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      this.log.warn("secondary disconnected", {
        url: state.logUrl,
        code,
        reason: reason.toString(),
      });
      this.stopSecondaryKeepalive(state);
      this.scheduleSecondaryReconnect(state);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", {
        url: state.logUrl,
        error: err.message,
      });
    });

    return ws;
  }

  private createQueue(): BoundedQueue<QueuedMessage> {
    // Sized so a maximum-size message always fits; the queue also keeps any
    // single incoming message, as a safety net for frames that grow when
    // decoded (invalid UTF-8 becomes U+FFFD).
    return new BoundedQueue<QueuedMessage>(
      UPSTREAM_MAX_QUEUE,
      Math.max(UPSTREAM_MAX_QUEUE_BYTES, this.maxPayload),
    );
  }

  private enqueue(
    link: "primary" | "secondary",
    queue: BoundedQueue<QueuedMessage>,
    message: QueuedMessage,
    fields: Record<string, unknown> = {},
  ) {
    // A frame still arriving while the charger closes: nothing will flush it.
    if (!this.alive) {
      message.delivery?.dropped("session-ended");
      return;
    }
    message.delivery?.queued();
    const dropped = queue.push(message);
    for (const old of dropped) old.delivery?.dropped("queue-overflow");
    if (dropped.length > 0) {
      this.log.warn(`${link} queue full, dropping oldest message`, {
        ...fields,
        dropped: dropped.length,
        ...queueStats(queue),
      });
    }
  }

  /** Teardown empties the queue, so nothing reaches the primary of an ended session. */
  private flushPrimaryQueue(ws: WebSocket) {
    if (this.primaryQueue.length === 0) return;
    this.log.info("primary flushing queued messages", queueStats(this.primaryQueue));
    for (const msg of this.primaryQueue.drain()) send(ws, msg.raw, msg.delivery);
  }

  private flushSecondaryQueue(state: SecondaryState, ws: WebSocket) {
    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued messages", {
      url: state.logUrl,
      ...queueStats(state.queue),
    });
    for (const msg of state.queue.drain()) {
      try {
        send(ws, msg.raw, msg.delivery);
      } catch (err) {
        /* best-effort */
        msg.delivery?.failed(errorMessage(err));
      }
    }
  }

  private startSecondaryKeepalive(state: SecondaryState, ws: WebSocket) {
    this.stopSecondaryKeepalive(state);
    state.keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - state.lastPongAt > SECONDARY_PONG_TIMEOUT_MS) {
        this.log.warn("secondary pong timeout, forcing reconnect", {
          url: state.logUrl,
        });
        try {
          ws.close(4000, "pong timeout");
        } catch {
          /* */
        }
        return;
      }

      try {
        ws.ping();
      } catch {
        /* best-effort */
      }
    }, SECONDARY_KEEPALIVE_INTERVAL_MS);
  }

  private stopSecondaryKeepalive(state: SecondaryState) {
    if (state.keepalive !== null) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
  }

  private scheduleSecondaryReconnect(state: SecondaryState) {
    if (!this.alive) return;
    if (state.reconnectTimer !== null) return;

    this.log.info("secondary reconnecting", {
      url: state.logUrl,
      delayMs: SECONDARY_RECONNECT_DELAY_MS,
    });

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!this.alive) return;
      state.ws = this.connectSecondary(state);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;
    dropAll(this.primaryQueue);

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      dropAll(sec.queue);
    }

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    for (const sec of this.secondaries) close(sec.ws);
    close(this.charger);

    this.log.info("session ended");
    this.onEnd();
  }
}

/**
 * Send `raw`, reporting the outcome to `delivery` when archiving: `written`
 * once ws has written it to the socket, `failed` on error. Without a
 * delivery, a plain send as before archiving existed.
 */
function send(ws: WebSocket, raw: string, delivery: DeliveryTracker | undefined) {
  if (!delivery) {
    ws.send(raw);
    return;
  }
  delivery.submitted();
  ws.send(raw, (error) => delivery.settled(error));
}

/** Empty `queue` of a session that ended: its messages will never be sent. */
function dropAll(queue: BoundedQueue<QueuedMessage>) {
  for (const msg of queue.drain()) msg.delivery?.dropped("session-ended");
}

/** Log fields describing a queue's fill level and bounds. */
function queueStats(queue: BoundedQueue<QueuedMessage>) {
  return {
    count: queue.length,
    bytes: queue.bytes,
    maxCount: queue.maxCount,
    maxBytes: queue.maxBytes,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
