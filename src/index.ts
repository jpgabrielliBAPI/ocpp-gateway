import { loadConfig } from "./config";
import { configureLogger, createLogger } from "./logger";
import { startProxy } from "./proxy";
import { RouteStore } from "./routes";
import { TRACE_FLUSH_TIMEOUT_MS, type TraceArchive, openTraceArchive } from "./trace/archive";

const log = createLogger("proxy");

/** Hard stop if a graceful shutdown hangs (plus the trace flush, when archiving). */
const SHUTDOWN_TIMEOUT_MS = 5000;

async function main() {
  const config = loadConfig();
  configureLogger(config.loggerConfig);

  let routes: RouteStore;
  try {
    // Trace archiving names each CSMS by its backend id, never by its URL.
    routes = RouteStore.load(config.routesFile, { requireBackendIds: config.trace !== undefined });
  } catch (err) {
    log.error("failed to load routes file", {
      path: config.routesFile,
      error: (err as Error).message,
    });
    process.exit(1);
  }

  // Nice-to-have: hot-reload the routing table on file change. Existing charger
  // sessions keep the route they were opened with; only new connections see the
  // updated table.
  routes.watch();

  let archive: TraceArchive | undefined;
  if (config.trace) {
    try {
      archive = await openTraceArchive(config.trace);
    } catch (err) {
      log.error("failed to start trace archiving", { error: (err as Error).message });
      process.exit(1);
    }
  }

  const gateway = startProxy(config, routes, { traceSink: archive?.sink });

  const shutdown = () => {
    log.info("shutting down…");
    routes.close();
    setTimeout(
      () => process.exit(1),
      SHUTDOWN_TIMEOUT_MS + (archive ? TRACE_FLUSH_TIMEOUT_MS : 0),
    ).unref();
    // close() ends every session synchronously, so their last trace outcomes
    // are already reported when the archive starts flushing. A repeated
    // signal waits for that same flush (archive.close() is idempotent).
    const closing = gateway.close();
    void Promise.all([closing, archive?.close()]).then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
