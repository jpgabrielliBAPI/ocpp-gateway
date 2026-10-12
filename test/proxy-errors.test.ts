import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../src/config";
import { startProxy } from "../src/proxy";
import { RouteStore } from "../src/routes";
import { captureReports } from "./memory-reporter";

describe("gateway error reporting", () => {
  it("reports a server that cannot listen", async () => {
    const reports = captureReports();
    const taken = createServer().listen(0, "127.0.0.1");
    await once(taken, "listening");
    const { port } = taken.address() as AddressInfo;
    const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-test-"));
    const routesFile = join(dir, "routes.json");
    writeFileSync(routesFile, JSON.stringify({ default: { primary: "ws://127.0.0.1:1" } }));

    const gateway = startProxy(
      {
        port,
        listenHost: "127.0.0.1",
        routesFile,
        loggerConfig: { logLevel: "error" },
        maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
      },
      RouteStore.load(routesFile),
    );
    try {
      await once(gateway.server, "error");

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ tag: "proxy", message: "WebSocket server error" });
      expect((reports[0].error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    } finally {
      gateway.server.close();
      taken.close();
      rmSync(dir, { recursive: true });
    }
  });
});
