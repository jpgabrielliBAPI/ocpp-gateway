import { loadConfig } from "./config";
import { type ErrorReporter, noopErrorReporter } from "./error-reporter";
import { configureLogger, createLogger } from "./logger";
import { startProxy } from "./proxy";
import { RouteStore } from "./routes";
import { TRACE_FLUSH_TIMEOUT_MS, type TraceArchive, openTraceArchive } from "./trace/archive";

const log = createLogger("proxy");

/** Hard stop if a graceful shutdown hangs (plus the trace flush, when archiving). */
const SHUTDOWN_TIMEOUT_MS = 5000;
/** How long exiting waits for pending error reports to be sent. */
const ERROR_REPORT_FLUSH_TIMEOUT_MS = 2000;

async function main() {
  const config = loadConfig();
  configureLogger(config.loggerConfig);

  // Opened first, so that startup failures are reported too. A failure in
  // loadConfig() cannot be: the DSN comes from it.
  let reporter: ErrorReporter = noopErrorReporter;
  if (config.sentry) {
    try {
      // Only loaded when enabled, like the PostgreSQL driver.
      const { openSentryReporter } = await import("./monitoring/sentry");
      reporter = openSentryReporter(config.sentry);
    } catch (err) {
      log.error("failed to start error reporting", undefined, { cause: err });
      process.exit(1);
    }
    configureLogger({ ...config.loggerConfig, reporter });
    log.info("error reporting enabled", {
      environment: config.sentry.environment,
      release: config.sentry.release,
    });
  }

  /** Exit once pending error reports are sent, waiting at most the flush budget. */
  const exit = async (code: number): Promise<never> => {
    // A guard in case the reporter does not honour its own bound.
    setTimeout(() => process.exit(code), ERROR_REPORT_FLUSH_TIMEOUT_MS + 500).unref();
    await reporter.close(ERROR_REPORT_FLUSH_TIMEOUT_MS);
    process.exit(code);
  };

  /** Log and report a startup failure, then exit. */
  const fail = (message: string, err: unknown, extra?: object): Promise<never> => {
    log.error(message, extra, { report: true, cause: err });
    return exit(1);
  };

  let routes: RouteStore;
  try {
    // Trace archiving names each CSMS by its backend id, never by its URL.
    routes = RouteStore.load(config.routesFile, { requireBackendIds: config.trace !== undefined });
  } catch (err) {
    return fail("failed to load routes file", err, { path: config.routesFile });
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
      return fail("failed to start trace archiving", err);
    }
  }

  const gateway = startProxy(config, routes, { traceSink: archive?.sink });
  // A gateway that cannot listen (port taken…) has nothing left to run: the
  // proxy has logged and reported the error, exit non-zero once it is sent.
  const exitOnListenError = () => void exit(1);
  gateway.server.once("error", exitOnListenError);
  gateway.server.once("listening", () => gateway.server.off("error", exitOnListenError));

  const shutdown = () => {
    log.info("shutting down…");
    routes.close();
    // A shutdown that hangs is forced, still sending pending error reports.
    setTimeout(
      () => void exit(1),
      SHUTDOWN_TIMEOUT_MS + (archive ? TRACE_FLUSH_TIMEOUT_MS : 0),
    ).unref();
    // close() ends every session synchronously, so their last trace outcomes
    // are already reported when the archive starts flushing. A repeated
    // signal waits for that same flush (archive.close() and reporter.close()
    // are idempotent). Errors reported while closing are sent last, even if
    // a close fails.
    const closing = gateway.close();
    void Promise.allSettled([closing, archive?.close()]).then(() => exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
