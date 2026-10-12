import { isIP } from "node:net";
import type { LoggerConfig, LogLevel } from "./logger";
import { DEFAULT_DEBUG_MESSAGE_MAX_LENGTH, DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./logger";
import { parseHostname } from "./tenants";
import {
  parseBoolean,
  parseEnv,
  parseIntegerInRange,
  parseOptionalIntegerInRange,
  parseOptionalHeaderName,
  parseOptionalPositiveInteger,
  parseStringUnion,
} from "./utils/value-parsers";

/**
 * A security default, not a protocol limit: typical OCPP frames are a few KiB,
 * but OCPP does not cap message size (1.6 `DataTransfer.data` has no maximum
 * length), so deployments with large vendor-specific payloads may need more.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
/** `ws` truncates `maxPayload` to a signed 32-bit integer; above this it wraps and the limit is lost. */
const MAX_MESSAGE_BYTES_UPPER_BOUND = 2 ** 31 - 1;
/**
 * Largest message that still fits a MongoDB document (16 MiB) as a raw frame,
 * with room for the envelope: trace archiving never truncates a frame.
 */
const TRACE_MAX_MESSAGE_BYTES = 15 * 1024 * 1024;

const DEFAULT_TRACE_DATABASE = "ocpp_gateway";
const DEFAULT_TRACE_RETENTION_DAYS = 30;
const DEFAULT_TRACE_QUEUE_MAX = 10_000;

/** MongoDB trace archiving settings; see README "Trace archiving". */
export interface TraceConfig {
  /** May carry credentials: never log it. */
  mongodbUri: string;
  database: string;
  /** Each trace expires this many days after it was received (MongoDB TTL). */
  retentionDays: number;
  /** Trace documents buffered in memory while waiting for MongoDB; more are dropped. */
  queueMax: number;
  /** Only write into an existing capped collection; never create it. */
  requireCapped: boolean;
}

export interface Config {
  port: number;
  /** Address or hostname the gateway listens on. Unset: all interfaces. */
  listenHost?: string;
  routesFile: string;
  loggerConfig: LoggerConfig;
  /** Tenants are subdomains of this domain (`acme.<base>` → `acme`). Unset: none. */
  tenantBaseDomain?: string;
  /**
   * Header carrying the hostname the charger dialled, set by a trusted reverse
   * proxy in front of the gateway. Unset: the `Host` header is used.
   */
  tenantHostHeader?: string;
  /**
   * Largest WebSocket message accepted from a charger or an upstream CSMS;
   * a bigger one closes that connection with `1009`.
   */
  maxMessageBytes: number;
  /** Trace archiving to MongoDB. Unset: disabled. */
  trace?: TraceConfig;
}

function parseOptionalHostname(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const hostname = parseHostname(value.trim());
  if (hostname === null) throw new Error(`Invalid hostname: "${value}"`);
  return hostname;
}

function parseOptionalListenHost(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const host = value.trim();
  if (isIP(host) === 0 && parseHostname(host) === null) {
    throw new Error(`Invalid listen host: "${value}"`);
  }
  return host;
}

function parseMongodbUri(value: string | undefined): string {
  const uri = value?.trim() ?? "";
  // The URI may carry credentials: errors never echo it.
  if (uri === "") throw new Error("required when TRACE_ENABLED is true");
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error("must start with mongodb:// or mongodb+srv://");
  }
  return uri;
}

/** MongoDB database names: none of `/`, `\`, `.`, space, `"`, `$`, `*`, `<`, `>`, `:`, `|`, `?`, NUL; under 64 bytes. */
function parseDatabaseName(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return DEFAULT_TRACE_DATABASE;
  const name = value.trim();
  if (/[/\\. "$*<>:|?]/.test(name) || name.includes("\0") || Buffer.byteLength(name) > 63) {
    throw new Error(`Invalid database name: "${value}"`);
  }
  return name;
}

function loadTraceConfig(maxMessageBytes: number): TraceConfig | undefined {
  if (!parseEnv("TRACE_ENABLED", (value) => parseBoolean(value, false))) return undefined;

  const config: TraceConfig = {
    mongodbUri: parseEnv("TRACE_MONGODB_URI", parseMongodbUri),
    database: parseEnv("TRACE_MONGODB_DATABASE", parseDatabaseName),
    retentionDays: parseEnv("TRACE_RETENTION_DAYS", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_TRACE_RETENTION_DAYS, 1, 36_500),
    ),
    queueMax: parseEnv("TRACE_QUEUE_MAX", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_TRACE_QUEUE_MAX, 1, 1_000_000),
    ),
    requireCapped: parseEnv("TRACE_REQUIRE_CAPPED", (value) => parseBoolean(value, false)),
  };
  if (maxMessageBytes > TRACE_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Invalid value for environment variable MAX_MESSAGE_BYTES: must not exceed ${TRACE_MAX_MESSAGE_BYTES} when TRACE_ENABLED is true`,
    );
  }
  return config;
}

export function loadConfig(): Config {
  const routesFile = process.env.ROUTES_FILE ?? "./routes.json";

  const logLevel: LogLevel = parseEnv("LOG_LEVEL", (value) =>
    parseStringUnion(value, LOG_LEVELS, DEFAULT_LOG_LEVEL),
  );
  const debugMessageMaxLength: number | undefined = parseEnv(
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    (value) => parseOptionalPositiveInteger(value, DEFAULT_DEBUG_MESSAGE_MAX_LENGTH),
  );

  const port: number = parseEnv("PORT", (value) => parseIntegerInRange(value ?? "9000", 1, 65535));
  const listenHost = parseEnv("LISTEN_HOST", parseOptionalListenHost);

  const tenantBaseDomain = parseEnv("TENANT_BASE_DOMAIN", parseOptionalHostname);
  const tenantHostHeader = parseEnv("TENANT_HOST_HEADER", parseOptionalHeaderName);
  const maxMessageBytes = parseEnv("MAX_MESSAGE_BYTES", (value) =>
    parseOptionalIntegerInRange(value, DEFAULT_MAX_MESSAGE_BYTES, 1, MAX_MESSAGE_BYTES_UPPER_BOUND),
  );

  return {
    port,
    listenHost,
    routesFile,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
    tenantBaseDomain,
    tenantHostHeader,
    maxMessageBytes,
    trace: loadTraceConfig(maxMessageBytes),
  };
}
