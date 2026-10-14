import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./helpers";

/**
 * The production bundle as a process, with Sentry enabled against a local
 * ingest: what only a real process shows (exit codes, process handlers, the
 * flush before exiting). Built once here, so a stale dist/ is never tested.
 */

const ROOT = join(__dirname, "..");
const TIMEOUT_MS = 20_000;

interface SentEvent {
  exception?: { values?: { type?: string; value?: string }[] };
  message?: string;
  tags?: Record<string, string>;
}

/** A Sentry ingest endpoint recording every event it receives. */
async function startIngest() {
  const events: SentEvent[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      const [, ...items] = body.toString().split("\n");
      for (let i = 0; i + 1 < items.length; i += 2) {
        if ((JSON.parse(items[i]) as { type: string }).type === "event") {
          events.push(JSON.parse(items[i + 1]) as SentEvent);
        }
      }
      res.writeHead(200).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { events, dsn: `http://publickey@127.0.0.1:${port}/1`, server };
}

const exceptionValues = (events: SentEvent[]) =>
  events.flatMap((e) => (e.exception?.values ?? []).map((v) => v.value ?? ""));

async function freePort(): Promise<number> {
  const server = createTcpServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

let ingest: Awaited<ReturnType<typeof startIngest>>;
let dir: string;
let routesFile: string;
let child: ChildProcess | undefined;
let held: Server | undefined;

beforeAll(async () => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  ingest = await startIngest();
}, 60_000);

afterAll(() => {
  ingest.server.close();
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = undefined;
  held?.close();
  held = undefined;
  ingest.events.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** Start the bundle; `preload` is CommonJS run before it (`node -r`). */
function startGateway(env: Record<string, string>, preload?: string) {
  dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-process-"));
  routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify({ default: { primary: "ws://127.0.0.1:1/ocpp" } }));
  const args = ["--enable-source-maps"];
  if (preload !== undefined) {
    const file = join(dir, "preload.cjs");
    writeFileSync(file, preload);
    args.push("-r", file);
  }
  args.push(join(ROOT, "dist", "index.cjs"));

  // Logs: stdout, and stderr for errors.
  let output = "";
  const proc = spawn(process.execPath, args, {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      SENTRY_DSN: ingest.dsn,
      ROUTES_FILE: routesFile,
      LISTEN_HOST: "127.0.0.1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  proc.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = once(proc, "exit").then(([code]) => code as number | null);
  const logged = async (msg: string) => {
    while (!output.includes(`"msg":"${msg}"`)) {
      if (proc.exitCode !== null) throw new Error(`exited before logging "${msg}"`);
      await sleep(20);
    }
  };
  return { proc, exited, logged };
}

describe("gateway process with Sentry enabled", () => {
  it(
    "exits non-zero when its port is taken, after reporting it",
    async () => {
      held = createTcpServer().listen(0, "127.0.0.1");
      await once(held, "listening");
      const { port } = held.address() as AddressInfo;

      const { exited } = startGateway({ PORT: String(port) });

      expect(await exited).toBe(1);
      expect(exceptionValues(ingest.events).some((v) => v.includes("EADDRINUSE"))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "exits non-zero on an unreadable routes file, after reporting it",
    async () => {
      const { exited } = startGateway({
        PORT: String(await freePort()),
        ROUTES_FILE: "/nonexistent/routes.json",
      });

      expect(await exited).toBe(1);
      expect(
        exceptionValues(ingest.events).some((v) => v.includes("cannot read routes file")),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it.each([
    ["an uncaught exception", 'throw new Error("probe failure")'],
    ["an unhandled rejection", 'void Promise.reject(new Error("probe failure"))'],
  ])(
    "reports %s and still crashes",
    async (_, crash) => {
      const { proc, exited, logged } = startGateway(
        { PORT: String(await freePort()) },
        `process.on("SIGUSR2", () => { ${crash}; });`,
      );
      await logged("proxy listening");

      proc.kill("SIGUSR2");

      expect(await exited).toBe(1);
      expect(exceptionValues(ingest.events)).toContain("probe failure");
    },
    TIMEOUT_MS,
  );

  it(
    "still sends what is pending when a shutdown hangs and is forced",
    async () => {
      // A request whose headers never end keeps server.close() waiting, so
      // the shutdown is forced. The very timer that forces it first makes a
      // routes reload fail (through the watcher's own callback), so an error
      // is reported right before the exit.
      const preload = `
        const fs = require("node:fs");
        const http = require("node:http");
        const net = require("node:net");
        let reload = () => {};
        const watch = fs.watch;
        fs.watch = (path, options, listener) => {
          reload = listener;
          return watch(path, options, listener);
        };
        const createServer = http.createServer;
        http.createServer = (...args) => {
          const server = createServer(...args);
          server.once("listening", () => {
            const socket = net.connect(server.address().port, "127.0.0.1");
            socket.write("GET /healthz HTTP/1.1\\r\\nHost: x\\r\\n");
          });
          return server;
        };
        process.on("SIGTERM", () => {
          const schedule = globalThis.setTimeout;
          globalThis.setTimeout = (fn, ms, ...rest) =>
            schedule(
              ms >= 5_000
                ? () => {
                    fs.writeFileSync(process.env.ROUTES_FILE, "{ not json");
                    reload();
                    fn();
                  }
                : fn,
              ms,
              ...rest,
            );
        });
      `;
      const { proc, exited, logged } = startGateway({ PORT: String(await freePort()) }, preload);
      await logged("proxy listening");

      proc.kill("SIGTERM");

      expect(await exited).toBe(1);
      expect(ingest.events.map((e) => e.tags?.component)).toContain("routes");
    },
    TIMEOUT_MS,
  );

  it(
    "sends what is pending before a graceful shutdown exits",
    async () => {
      const { proc, exited, logged } = startGateway({ PORT: String(await freePort()) });
      await logged("proxy listening");

      writeFileSync(routesFile, "{ not json");
      await logged("routes reload failed, keeping previous table");
      proc.kill("SIGTERM");

      expect(await exited).toBe(0);
      expect(ingest.events.map((e) => e.tags?.component)).toContain("routes");
    },
    TIMEOUT_MS,
  );
});
