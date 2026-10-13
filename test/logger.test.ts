import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";

import { configureLogger, createLogger } from "../src/logger";

function parseLogEntry(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON log object");
  }
  return parsed as Record<string, unknown>;
}

describe("logger", () => {
  const createSink = () => {
    const stdoutEntries: string[] = [];
    const stderrEntries: string[] = [];

    return {
      sink: {
        stdout: (line: string) => stdoutEntries.push(line),
        stderr: (line: string) => stderrEntries.push(line),
      },
      stdoutEntries,
      stderrEntries,
    };
  };

  beforeEach(() => {
    configureLogger({ logLevel: "info" });
  });

  it("suppresses logs below configured level", () => {
    const { sink, stdoutEntries, stderrEntries } = createSink();
    configureLogger({ logLevel: "error", sink });
    const logger = createLogger("proxy");

    logger.info("info message");
    logger.error("error message");

    expect(stdoutEntries).toHaveLength(0);
    expect(stderrEntries).toHaveLength(1);
    expect(parseLogEntry(stderrEntries[0]).level).toBe("error");
  });

  const longPayload = '[2,"abc","Heartbeat",{"data":"' + "a".repeat(160) + '"}]';

  it.each([
    {
      description: "uses a configured limit",
      config: { debugMessageMaxLength: 4 },
      payload: '[2,"abc","Heartbeat",{}]',
      expectedPayload: '[2,"',
    },
    {
      description: "uses the default limit",
      config: {},
      payload: longPayload,
      expectedPayload: longPayload.slice(0, 120),
    },
    {
      description: "does not truncate when the limit is explicitly undefined",
      config: { debugMessageMaxLength: undefined },
      payload: longPayload,
      expectedPayload: longPayload,
    },
  ])("$description", ({ config, payload, expectedPayload }) => {
    const { sink, stdoutEntries } = createSink();
    configureLogger({ logLevel: "debug", sink, ...config });
    const logger = createLogger("proxy");

    logger.debugOcppFrame("charger -> proxy", payload);

    const parsed = parseLogEntry(stdoutEntries[0]);
    expect(parsed.level).toBe("debug");
    expect(parsed.message).toBe("[OCPP CALL] (abc): " + expectedPayload);
  });

  describe("debugOcppFrame below the debug level", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("never parses the frame when debug is disabled", () => {
      const { sink, stdoutEntries } = createSink();
      configureLogger({ logLevel: "info", sink });
      const logger = createLogger("proxy");
      const parse = vi.spyOn(JSON, "parse");

      logger.debugOcppFrame("charger -> proxy", '[2,"abc","DataTransfer",{}]', { url: "x" });

      expect(parse).not.toHaveBeenCalled();
      expect(stdoutEntries).toHaveLength(0);
    });

    it("still summarises the frame when debug is enabled", () => {
      const { sink, stdoutEntries } = createSink();
      configureLogger({ logLevel: "debug", sink });
      const logger = createLogger("proxy");
      const parse = vi.spyOn(JSON, "parse");

      logger.debugOcppFrame("charger -> proxy", '[3,"abc",{}]', { url: "x" });

      expect(parse).toHaveBeenCalledTimes(1);
      expect(parseLogEntry(stdoutEntries[0])).toMatchObject({
        level: "debug",
        url: "x",
        message: '[OCPP RESULT] (abc): [3,"abc",{}]',
      });
    });
  });

  it("writes logs to a provided sink", () => {
    const outputSink = createSink();
    configureLogger({
      logLevel: "debug",
      sink: outputSink.sink,
    });
    const logger = createLogger("proxy");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(outputSink.stdoutEntries).toHaveLength(3);
    expect(outputSink.stderrEntries).toHaveLength(1);
    expect(parseLogEntry(outputSink.stderrEntries[0]).level).toBe("error");
  });
});
