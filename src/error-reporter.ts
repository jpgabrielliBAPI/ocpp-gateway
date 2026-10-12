/** An error worth an alert: a crash or an internal anomaly of the gateway. */
export interface ErrorReport {
  /** Logger tag of the reporting component (`proxy`, `trace`, `routes`, …). */
  tag: string;
  message: string;
  /** What was thrown, when there is one: an `Error` keeps its stack. */
  error?: unknown;
  extra?: Record<string, unknown>;
}

/**
 * Where reported errors go (Sentry when `SENTRY_DSN` is set). Charger and
 * CSMS network errors are not reported: they are expected in the field.
 */
export interface ErrorReporter {
  /** Synchronous and never throws: reporting never interferes with the caller. */
  report(report: ErrorReport): void;
  /** Send what is pending (bounded by `timeoutMs`), then stop; idempotent. */
  close(timeoutMs: number): Promise<void>;
}

export const noopErrorReporter: ErrorReporter = {
  report: () => undefined,
  close: () => Promise.resolve(),
};
