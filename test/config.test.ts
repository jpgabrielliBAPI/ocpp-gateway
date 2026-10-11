import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const environmentVariables = [
    "ROUTES_FILE",
    "LOG_LEVEL",
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    "PORT",
    "LISTEN_HOST",
    "TENANT_BASE_DOMAIN",
    "TENANT_HOST_HEADER",
    "MAX_MESSAGE_BYTES",
    "TRACE_ENABLED",
    "TRACE_MONGODB_URI",
    "TRACE_MONGODB_DATABASE",
    "TRACE_RETENTION_DAYS",
    "TRACE_QUEUE_MAX",
  ] as const;

  beforeEach(() => {
    for (const envName of environmentVariables) {
      vi.stubEnv(envName, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies defaults", () => {
    const config = loadConfig();

    expect(config.port).toBe(9000);
    expect(config.listenHost).toBeUndefined();
    expect(config.routesFile).toBe("./routes.json");
    expect(config.loggerConfig.logLevel).toBe("info");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(120);
    expect(config.tenantBaseDomain).toBeUndefined();
    expect(config.tenantHostHeader).toBeUndefined();
    expect(config.maxMessageBytes).toBe(1024 * 1024);
    expect(config.trace).toBeUndefined();
  });

  it("reads MAX_MESSAGE_BYTES", () => {
    vi.stubEnv("MAX_MESSAGE_BYTES", "2048");

    expect(loadConfig().maxMessageBytes).toBe(2048);
  });

  it("accepts the largest MAX_MESSAGE_BYTES ws can enforce", () => {
    vi.stubEnv("MAX_MESSAGE_BYTES", "2147483647");

    expect(loadConfig().maxMessageBytes).toBe(2147483647);
  });

  it("treats an empty MAX_MESSAGE_BYTES as the default", () => {
    vi.stubEnv("MAX_MESSAGE_BYTES", "  ");

    expect(loadConfig().maxMessageBytes).toBe(1024 * 1024);
  });

  it.each(["127.0.0.1", "::1", "localhost", "0.0.0.0"])("reads LISTEN_HOST %s", (value) => {
    vi.stubEnv("LISTEN_HOST", ` ${value} `);

    expect(loadConfig().listenHost).toBe(value);
  });

  it("treats an empty LISTEN_HOST as unset", () => {
    vi.stubEnv("LISTEN_HOST", "  ");

    expect(loadConfig().listenHost).toBeUndefined();
  });

  it("normalises TENANT_BASE_DOMAIN", () => {
    vi.stubEnv("TENANT_BASE_DOMAIN", "OCPP.Example.com.");

    expect(loadConfig().tenantBaseDomain).toBe("ocpp.example.com");
  });

  it("normalises TENANT_HOST_HEADER to lowercase", () => {
    vi.stubEnv("TENANT_HOST_HEADER", "X-Forwarded-Host");

    expect(loadConfig().tenantHostHeader).toBe("x-forwarded-host");
  });

  it.each(["TENANT_BASE_DOMAIN", "TENANT_HOST_HEADER"])("treats an empty %s as unset", (name) => {
    vi.stubEnv(name, "  ");

    const config = loadConfig();
    expect(config.tenantBaseDomain).toBeUndefined();
    expect(config.tenantHostHeader).toBeUndefined();
  });

  it("reads ROUTES_FILE", () => {
    vi.stubEnv("ROUTES_FILE", "/etc/ocpp-gateway/routes.json");

    expect(loadConfig().routesFile).toBe("/etc/ocpp-gateway/routes.json");
  });

  it.each([
    { description: "empty", value: "" },
    { description: "whitespace", value: "   " },
  ])("disables debug message truncation when env var is $description", ({ value }) => {
    vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", value);

    expect(loadConfig().loggerConfig.debugMessageMaxLength).toBeUndefined();
  });

  it.each([
    { value: "1", expected: 1 },
    { value: "65535", expected: 65535 },
  ])("accepts port boundary $value", ({ value, expected }) => {
    vi.stubEnv("PORT", value);

    expect(loadConfig().port).toBe(expected);
  });

  it.each([
    {
      envName: "PORT",
      value: "70000",
      expectedCause: 'Value must be an integer between 1 and 65535: "70000"',
    },
    {
      envName: "PORT",
      value: "9000junk",
      expectedCause: 'Invalid integer: "9000junk"',
    },
    {
      envName: "PORT",
      value: "3.14",
      expectedCause: 'Invalid integer: "3.14"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "0",
      expectedCause: 'Value must be a positive integer: "0"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "abc",
      expectedCause: 'Invalid integer: "abc"',
    },
    {
      envName: "LISTEN_HOST",
      value: "127.0.0.1:9000",
      expectedCause: 'Invalid listen host: "127.0.0.1:9000"',
    },
    {
      envName: "TENANT_BASE_DOMAIN",
      value: "ocpp.example.com:443",
      expectedCause: 'Invalid hostname: "ocpp.example.com:443"',
    },
    {
      envName: "TENANT_BASE_DOMAIN",
      value: "*.ocpp.example.com",
      expectedCause: 'Invalid hostname: "*.ocpp.example.com"',
    },
    {
      envName: "TENANT_HOST_HEADER",
      value: "X Forwarded Host",
      expectedCause: 'Invalid HTTP header name: "X Forwarded Host"',
    },
    {
      envName: "MAX_MESSAGE_BYTES",
      value: "1MiB",
      expectedCause: 'Invalid integer: "1MiB"',
    },
    {
      envName: "MAX_MESSAGE_BYTES",
      value: "0",
      expectedCause: 'Value must be an integer between 1 and 2147483647: "0"',
    },
    {
      envName: "MAX_MESSAGE_BYTES",
      value: "-1",
      expectedCause: 'Value must be an integer between 1 and 2147483647: "-1"',
    },
    {
      // ws truncates maxPayload to a signed 32-bit integer: this would wrap to
      // a negative value and disable the limit.
      envName: "MAX_MESSAGE_BYTES",
      value: "2147483648",
      expectedCause: 'Value must be an integer between 1 and 2147483647: "2147483648"',
    },
    {
      envName: "LOG_LEVEL",
      value: "verbose",
      expectedCause: 'Invalid value: "verbose". Expected one of: debug, info, warn, error.',
    },
  ])("rejects invalid $envName value $value", ({ envName, value, expectedCause }) => {
    vi.stubEnv(envName, value);

    expect(() => loadConfig()).toThrow(
      `Invalid value for environment variable ${envName}: ${expectedCause}`,
    );
  });

  it("parses custom log settings", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", "77");
    vi.stubEnv("PORT", "9001");

    const config = loadConfig();

    expect(config.loggerConfig.logLevel).toBe("warn");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(77);
    expect(config.port).toBe(9001);
  });

  describe("trace archiving", () => {
    const enable = () => {
      vi.stubEnv("TRACE_ENABLED", "true");
      vi.stubEnv("TRACE_MONGODB_URI", "mongodb://user:s3cret@mongo.example.com:27017/?tls=true");
    };

    it("is disabled by default, whatever the other TRACE_ settings", () => {
      vi.stubEnv("TRACE_MONGODB_URI", "not a uri");
      vi.stubEnv("TRACE_RETENTION_DAYS", "-1");

      expect(loadConfig().trace).toBeUndefined();
    });

    it("applies defaults once enabled", () => {
      enable();

      expect(loadConfig().trace).toEqual({
        mongodbUri: "mongodb://user:s3cret@mongo.example.com:27017/?tls=true",
        database: "ocpp_gateway",
        retentionDays: 30,
        queueMax: 10_000,
      });
    });

    it("reads every setting", () => {
      enable();
      vi.stubEnv("TRACE_MONGODB_URI", " mongodb+srv://cluster.example.com ");
      vi.stubEnv("TRACE_MONGODB_DATABASE", "traces");
      vi.stubEnv("TRACE_RETENTION_DAYS", "7");
      vi.stubEnv("TRACE_QUEUE_MAX", "500");

      expect(loadConfig().trace).toEqual({
        mongodbUri: "mongodb+srv://cluster.example.com",
        database: "traces",
        retentionDays: 7,
        queueMax: 500,
      });
    });

    it("requires TRACE_MONGODB_URI", () => {
      vi.stubEnv("TRACE_ENABLED", "true");

      expect(() => loadConfig()).toThrow(
        "Invalid value for environment variable TRACE_MONGODB_URI: required when TRACE_ENABLED is true",
      );
    });

    it("rejects a non-MongoDB URI without echoing it", () => {
      enable();
      vi.stubEnv("TRACE_MONGODB_URI", "https://user:s3cret@mongo.example.com");

      expect(() => loadConfig()).toThrow(
        "Invalid value for environment variable TRACE_MONGODB_URI: must start with mongodb:// or mongodb+srv://",
      );
      expect(() => loadConfig()).not.toThrow(/s3cret/);
    });

    it.each([
      { envName: "TRACE_ENABLED", value: "yes", expectedCause: /Invalid boolean value/ },
      { envName: "TRACE_MONGODB_DATABASE", value: "a/b", expectedCause: /Invalid database name/ },
      { envName: "TRACE_MONGODB_DATABASE", value: "a.b", expectedCause: /Invalid database name/ },
      {
        envName: "TRACE_MONGODB_DATABASE",
        value: "x".repeat(64),
        expectedCause: /Invalid database name/,
      },
      { envName: "TRACE_RETENTION_DAYS", value: "0", expectedCause: /between 1 and 36500/ },
      { envName: "TRACE_RETENTION_DAYS", value: "1.5", expectedCause: /Invalid integer/ },
      { envName: "TRACE_QUEUE_MAX", value: "0", expectedCause: /between 1 and 1000000/ },
    ])("rejects invalid $envName value $value", ({ envName, value, expectedCause }) => {
      enable();
      vi.stubEnv(envName, value);

      expect(() => loadConfig()).toThrow(`Invalid value for environment variable ${envName}`);
      expect(() => loadConfig()).toThrow(expectedCause);
    });

    it("refuses MAX_MESSAGE_BYTES above what a MongoDB document can hold", () => {
      enable();
      vi.stubEnv("MAX_MESSAGE_BYTES", String(15 * 1024 * 1024 + 1));

      expect(() => loadConfig()).toThrow(
        "Invalid value for environment variable MAX_MESSAGE_BYTES: must not exceed 15728640 when TRACE_ENABLED is true",
      );
    });
  });
});
