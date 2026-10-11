import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { type Config, DEFAULT_MAX_MESSAGE_BYTES } from "../src/config";
import { type ProxyOptions, startProxy } from "../src/proxy";
import { RouteStore } from "../src/routes";
import { OCPP_SUBPROTOCOLS } from "../src/types";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start the gateway on an ephemeral port of 127.0.0.1 (the address the tests
 * dial) with the given routing table and resolve once it is listening. Call
 * `close()` to shut it down.
 */
export async function startGateway(
  table: object,
  overrides: Partial<Config> = {},
  options: ProxyOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-test-"));
  const routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify(table));
  const routes = RouteStore.load(routesFile, {
    requireBackendIds: options.traceSink !== undefined,
  });
  rmSync(dir, { recursive: true });

  const gateway = startProxy(
    {
      port: 0,
      listenHost: "127.0.0.1",
      routesFile,
      loggerConfig: { logLevel: "error" },
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
      ...overrides,
    },
    routes,
    options,
  );
  await once(gateway.server, "listening");
  const { address, port } = gateway.server.address() as AddressInfo;
  return {
    address,
    port,
    close: gateway.close,
  };
}

/** A BootNotification CALL with a payload valid under OCPP 1.6. */
export const boot = (id: string) =>
  JSON.stringify([2, id, "BootNotification", { chargePointVendor: "Test", chargePointModel: "X" }]);

/** One upstream connection a mock CSMS accepted. */
export interface CsmsConnection {
  ws: WebSocket;
  auth?: string;
  protocol: string;
  path?: string;
  host?: string;
}

/**
 * A mock CSMS that records what it receives and replies with a tagged result.
 * Listens on an ephemeral port unless `port` is given, on 127.0.0.1 unless
 * `host` is given. With `holdHandshakes`, every upgrade is parked until
 * `releaseHandshakes()`, so the gateway's link stays `CONNECTING`. `reply`
 * replaces the tagged result: it maps each received message to the frame to
 * answer with, if any.
 */
export function makeCsms(
  tag: string,
  port = 0,
  options: {
    holdHandshakes?: boolean;
    host?: string;
    reply?: (message: string) => string | undefined;
  } = {},
) {
  const reply = options.reply ?? (() => JSON.stringify([3, "reply", { from: tag }]));
  const received: string[] = [];
  const connections: CsmsConnection[] = [];
  const held: ((accept: boolean) => void)[] = [];
  const last = () => connections.at(-1);

  const wss = new WebSocketServer({
    port,
    host: options.host ?? "127.0.0.1",
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) if (protocols.has(p)) return p;
      return false;
    },
    ...(options.holdHandshakes && {
      verifyClient: (_info: unknown, callback: (accept: boolean) => void) => {
        held.push(callback);
      },
    }),
  });

  wss.on("connection", (ws, req) => {
    connections.push({
      ws,
      auth: req.headers.authorization,
      protocol: ws.protocol,
      path: req.url,
      host: req.headers.host,
    });
    ws.on("message", (data) => {
      received.push(data.toString());
      const answer = reply(data.toString());
      if (answer !== undefined) ws.send(answer);
    });
  });

  return {
    wss,
    received: () => received,
    /** Every connection accepted so far, oldest first. */
    connections: () => connections,
    connected: () => connections.length > 0,
    auth: () => last()?.auth,
    protocol: () => last()?.protocol,
    path: () => last()?.path,
    host: () => last()?.host,
    /** Upgrades parked by `holdHandshakes` and not yet released. */
    heldHandshakes: () => held.length,
    releaseHandshakes: () => {
      for (const accept of held.splice(0)) accept(true);
    },
    address: () => (wss.address() as AddressInfo).address,
    port: () => (wss.address() as AddressInfo).port,
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () => wss.close(),
  };
}

export async function waitFor(cond: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

export function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket timeout"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function waitForClose(
  socket: WebSocket,
  timeoutMs = 2000,
): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket close timeout"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve({ code, reason: Buffer.from(reason) });
    };
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

/** Open a charger socket; callers start the gateway (and await "listening") first. */
export async function connectWhenOpen(
  url: string,
  protocol: string,
  timeoutMs = 3000,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const socket = new WebSocket(url, protocol, { headers });
  await waitForOpen(socket, timeoutMs);
  return socket;
}
