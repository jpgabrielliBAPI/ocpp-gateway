import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Socket } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config";
import { ChargerConnection } from "./connection";
import { RejectionLog, type SessionLease, SessionLimiter } from "./limits";
import { createLogger } from "./logger";
import type { RouteStore } from "./routes";
import { type SessionKey, SessionRegistry } from "./sessions";
import { HostnameTenantResolver, type TenantResolver, readSingleHeader } from "./tenants";
import type { TraceSink } from "./trace/writer";
import { OCPP_SUBPROTOCOLS } from "./types";
import { clientSource } from "./utils/ip";
import { redactUrl } from "./utils/url";

const log = createLogger("proxy");

/** Bytes a refused client may still send: its close frame (at most 131 bytes) and a ping or two. */
const REFUSED_MAX_BYTES = 1024;
/** How long a refused client has to answer the close before its socket is cut. */
const REFUSED_CLOSE_TIMEOUT_MS = 1000;

export interface ProxyOptions {
  /** Resolves the tenant from the dialled hostname. Default: hostnames from the routes file and `TENANT_BASE_DOMAIN`. */
  tenants?: TenantResolver;
  /** Where to archive every OCPP frame. Unset: archiving disabled. */
  traceSink?: TraceSink;
}

/**
 * Start the OCPP proxy server.
 *
 * Chargers connect via:
 *   ws(s)://proxy-host:port/<chargeBoxId>
 *
 * The tenant is resolved from the hostname the charger dialled (the `Host`
 * header, or `config.tenantHostHeader` behind a trusted reverse proxy). The
 * (tenant, chargeBoxId) pair — the chargeBoxId being the last path segment —
 * is resolved against the routing table to pick a primary CSMS and optional
 * read-only secondaries; the id is then appended to each upstream URL unless
 * that backend opts out.
 */
export function startProxy(config: Config, routes: RouteStore, options: ProxyOptions = {}) {
  // Traces name each CSMS by its backend id: every route must have them.
  if (options.traceSink && !routes.requiresBackendIds) {
    throw new Error("trace archiving needs a route store loaded with requireBackendIds");
  }
  const tenants =
    options.tenants ??
    new HostnameTenantResolver({
      baseDomain: config.tenantBaseDomain,
      lookupHostname: (hostname) => routes.findTenantByHostname(hostname),
    });
  const sessions = new SessionRegistry<ChargerConnection>();
  const limiter = new SessionLimiter(config);
  /** Each live session's hold on the limiter's counters. */
  const leases = new WeakMap<ChargerConnection, SessionLease>();
  const rejections = new RejectionLog(log);

  const server = createServer((req, res) => {
    if (handleHttp(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ocpp-gateway is running.\nConnect your charge point via WebSocket.\n");
  });

  const wss = new WebSocketServer({
    server,
    autoPong: false,
    maxPayload: config.maxMessageBytes,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) {
        if (protocols.has(p)) return p;
      }
      return false;
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const chargePointId = extractChargePointId(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url,
      });
      refuse(ws, req.socket, 1002, "Charge point ID required in URL path");
      return;
    }

    // Fail closed: a missing or duplicated host header (or trusted header) is
    // ambiguous, so it must never fall back to the global routes.
    const hostHeader = config.tenantHostHeader ?? "host";
    const host = readSingleHeader(req.rawHeaders, hostHeader);
    if (host === null) {
      log.warn("rejected connection: missing or duplicated host header", {
        header: hostHeader,
        chargePointId,
        ip: req.socket.remoteAddress,
      });
      refuse(ws, req.socket, 1008, "Missing or ambiguous host");
      return;
    }
    const tenantId = tenants.resolve(host);
    const route = routes.resolve(tenantId, chargePointId);
    if (!route) {
      log.warn("rejected connection: no route", {
        tenantId,
        host,
        chargePointId,
        ip: req.socket.remoteAddress,
      });
      refuse(ws, req.socket, 1008, "No route for this charge point");
      return;
    }

    // Fail closed too: a client IP that is missing, duplicated or not a bare
    // address must never land chargers in a shared bucket, nor in one per
    // connection.
    const address = config.clientIpHeader
      ? readSingleHeader(req.rawHeaders, config.clientIpHeader)
      : req.socket.remoteAddress;
    const source = address ? clientSource(address) : null;
    if (source === null) {
      rejections.record("client-ip-header", req.socket.remoteAddress ?? "unknown");
      refuse(ws, req.socket, 1008, "Missing or ambiguous client IP");
      return;
    }

    const key: SessionKey = { tenantId, chargeBoxId: chargePointId };
    const protocol = ws.protocol;
    const authHeader = req.headers.authorization;

    // Replace this charger's stale session, if any: some CSMS reject a new
    // connection while the old one is still open, forcing a reconnect loop.
    // Only sessions opened with the same credentials are replaced (see
    // SessionRegistry). The limits are checked as if they were gone, and they
    // are only torn down once the newcomer is admitted: a refused newcomer
    // must leave a healthy session alone.
    const stale = sessions.replaceable(key, authHeader).sessions;
    const refused = limiter.check(
      source,
      stale.map((session) => leases.get(session)!),
    );
    if (refused) {
      // Nothing else is logged for a refused connection: a flood stays one line.
      rejections.record(refused, source);
      refuse(ws, req.socket, 1013, "Too many sessions, try again later");
      return;
    }

    const { replaced, kept } = sessions.evict(key, authHeader);
    log.info("charger connected", {
      tenantId,
      chargePointId,
      protocol: protocol || "none",
      ip: address,
      primary: redactUrl(route.primary.url),
      secondaries: route.secondaries.map((backend) => redactUrl(backend.url)),
    });
    if (replaced > 0) log.info("replaced existing session", { tenantId, chargePointId, replaced });
    if (kept > 0) {
      log.warn("existing session kept: new connection has different credentials", {
        tenantId,
        chargePointId,
        kept,
        ip: address,
      });
    }

    const lease = limiter.acquire(source);
    const conn = new ChargerConnection(
      ws,
      key,
      route,
      protocol,
      authHeader,
      config.maxMessageBytes,
      () => {
        sessions.remove(key, conn);
        lease.release();
      },
      options.traceSink,
      () => lease.primaryOpened(),
    );
    leases.set(conn, lease);
    sessions.add(key, authHeader, conn);
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  server.listen(config.port, config.listenHost, () => {
    log.info("proxy listening", {
      port: config.port,
      listenHost: config.listenHost,
      routesFile: config.routesFile,
      tenantBaseDomain: config.tenantBaseDomain,
      tenantHostHeader: config.tenantHostHeader ?? "host",
      maxMessageBytes: config.maxMessageBytes,
      maxSessions: config.maxSessions,
      maxPendingSessions: config.maxPendingSessions,
      maxSessionsPerSource: config.maxSessionsPerSource,
      clientIpHeader: config.clientIpHeader ?? "none (socket address)",
      traceArchiving: options.traceSink !== undefined,
    });
  });

  /**
   * Close every charger session, then stop accepting connections. Sessions
   * are torn down right away (not when each charger's close handshake ends),
   * so their last trace outcomes are reported before this returns.
   */
  const close = () =>
    new Promise<void>((resolve) => {
      for (const ws of wss.clients) ws.close(1001, "Server shutting down");
      sessions.teardownAll();
      rejections.stop();
      wss.close();
      server.close(() => resolve());
    });

  return { server, close };
}

/**
 * Close a connection that never becomes a session. Until the client answers
 * the close, ws still reads what it sends: a malformed frame emits an `error`
 * that would crash the gateway without a listener, and a large one would be
 * buffered, bypassing the session limits. So the socket is cut as soon as the
 * client sends more than a close frame, or does not answer in time.
 */
function refuse(ws: WebSocket, socket: Socket, code: number, reason: string) {
  ws.on("error", (err) => log.debug("refused connection error", { error: err.message }));
  let received = 0;
  const onData = (chunk: Buffer) => {
    received += chunk.length;
    if (received > REFUSED_MAX_BYTES) ws.terminate();
  };
  socket.on("data", onData);
  const timer = setTimeout(() => ws.terminate(), REFUSED_CLOSE_TIMEOUT_MS);
  timer.unref();
  ws.once("close", () => {
    clearTimeout(timer);
    socket.off("data", onData);
  });
  ws.close(code, reason);
}

/** Handle plain-HTTP endpoints. Returns true if the request was served. */
function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return true;
  }
  return false;
}

function extractChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const segments = url.split("?")[0].split("/").filter(Boolean);
  // Accept /ocpp/<id>, /ws/<id>, or just /<id>
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
