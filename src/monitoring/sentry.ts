import * as Sentry from "@sentry/node";
import type { SentryConfig } from "../config";
import type { ErrorReporter } from "../error-reporter";
import { isPlainObject } from "../utils/objects";
import { redactUrlsInText } from "../utils/url";

/**
 * Report errors to Sentry: errors only (no tracing, logs or sessions). The
 * only module importing `@sentry/node`, loaded only when `SENTRY_DSN` is set.
 * `overrides` is for tests (a recording transport).
 */
export function openSentryReporter(
  config: SentryConfig,
  overrides: Partial<Sentry.NodeOptions> = {},
): ErrorReporter {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    // Collect nothing beyond the reported error: request headers carry the
    // chargers' Authorization, query strings and local variables may carry
    // credentials or OCPP payloads.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // No default integrations: the http one would record breadcrumbs of every
    // CSMS upgrade (URLs may carry credentials) and a session per request.
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      // "strict" keeps Node's crash on an unhandled rejection, which Sentry's
      // default "warn" would otherwise swallow.
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    beforeSend: scrubEvent,
    ...overrides,
  });

  let closing: Promise<void> | undefined;
  return {
    report: ({ tag, message, error, extra }) => {
      try {
        const context = { level: "error" as const, tags: { component: tag } };
        if (error instanceof Error) {
          Sentry.captureException(error, { ...context, extra: { log: message, ...extra } });
        } else {
          Sentry.captureMessage(message, { ...context, extra, fingerprint: [tag, message] });
        }
      } catch {
        // Reporting is best-effort: the error is already logged.
      }
    },
    close: (timeoutMs) => {
      closing ??= Sentry.close(timeoutMs).then(
        () => undefined,
        () => undefined,
      );
      return closing;
    },
  };
}

/**
 * A safety net: credentials in URLs (userinfo, query values, fragment) never
 * leave the gateway, whatever was reported.
 */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.message) event.message = redactUrlsInText(event.message);
  if (event.fingerprint) event.fingerprint = event.fingerprint.map(redactUrlsInText);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactUrlsInText(exception.value);
  }
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message) breadcrumb.message = redactUrlsInText(breadcrumb.message);
  }
  return event;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactUrlsInText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}
