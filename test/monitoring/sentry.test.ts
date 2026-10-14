import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createTransport } from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ErrorReporter } from "../../src/error-reporter";
import { openSentryReporter } from "../../src/monitoring/sentry";

const CONFIG = {
  dsn: "https://publickey@o1.ingest.sentry.example.com/42",
  environment: "test",
  release: "ocpp-gateway@0.0.0-test",
};

/** What the transport would have sent: raw envelopes, item types and events. */
function recordingTransport() {
  const bodies: string[] = [];
  const itemTypes: string[] = [];
  const events: Record<string, unknown>[] = [];
  const transport = (options: Parameters<typeof createTransport>[0]) =>
    createTransport(options, (request) => {
      const body =
        typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
      bodies.push(body);
      const [, ...items] = body.split("\n");
      for (let i = 0; i + 1 < items.length; i += 2) {
        const { type } = JSON.parse(items[i]) as { type: string };
        itemTypes.push(type);
        if (type === "event") events.push(JSON.parse(items[i + 1]) as Record<string, unknown>);
      }
      return Promise.resolve({ statusCode: 200 });
    });
  return { bodies, itemTypes, events, transport };
}

let reporter: ErrorReporter | undefined;

afterEach(async () => {
  await reporter?.close(1_000);
  reporter = undefined;
});

describe("openSentryReporter", () => {
  it("sends a reported error as an exception event tagged with its component", async () => {
    const { events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });

    reporter.report({
      tag: "trace",
      message: "trace store unavailable",
      error: new Error("connect ECONNREFUSED"),
      extra: { queued: 3 },
    });
    await reporter.close(1_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      environment: "test",
      release: "ocpp-gateway@0.0.0-test",
      tags: { component: "trace" },
      extra: { log: "trace store unavailable", queued: 3 },
      exception: { values: [{ type: "Error", value: "connect ECONNREFUSED" }] },
    });
    expect(events[0].breadcrumbs ?? []).toEqual([]);
    // Neither source lines (they may quote credentials) nor local variables.
    const frames = JSON.stringify(events[0].exception);
    expect(frames).toContain('"frames"');
    expect(frames).not.toMatch(/"(pre_context|context_line|post_context|vars)"/);
    expect(events[0]).not.toHaveProperty("user");
    expect(events[0]).not.toHaveProperty("request");
  });

  it("sends a report without an error as a message grouped by component and message", async () => {
    const { events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });

    reporter.report({ tag: "trace", message: "trace batch dropped after failed writes" });
    await reporter.close(1_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      message: "trace batch dropped after failed writes",
      fingerprint: ["trace", "trace batch dropped after failed writes"],
    });
  });

  it.each([
    ["a string", "connection lost", "connection lost"],
    [
      "an object",
      { code: "E_STORE", url: "wss://u:s3cret@csms.example.com" },
      { code: "E_STORE", url: "wss://***@csms.example.com/" },
    ],
  ])("keeps a thrown value that is not an Error (%s) as the cause", async (_, thrown, sent) => {
    const { events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });

    reporter.report({ tag: "trace", message: "trace store unavailable", error: thrown });
    await reporter.close(1_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "trace store unavailable",
      extra: { cause: sent },
    });
  });

  it("masks credentials in URLs before sending", async () => {
    const { events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });

    reporter.report({
      tag: "routes",
      message: "failed",
      error: new Error("cannot reach wss://user:s3cret@csms.example.com/ocpp?token=t0ken#fr4g"),
      extra: { urls: ["mongodb://admin:hunter2@mongo.example.com:27017"] },
    });
    reporter.report({ tag: "proxy", message: "upgrade to wss://csms.example.com/?key=k3y failed" });
    await reporter.close(1_000);

    const sent = JSON.stringify(events);
    expect(events).toHaveLength(2);
    expect(sent).not.toMatch(/s3cret|t0ken|fr4g|hunter2|k3y/);
    expect(sent).toContain("wss://***@csms.example.com/ocpp?token=***#***");
  });

  it("masks credentials of URLs written back to back or ending in punctuation", async () => {
    const { bodies, events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });

    reporter.report({
      tag: "routes",
      message: "failed",
      error: new Error(
        "cannot reach wss://a.example.com/ocpp,wss://alice:s3cret@b.example.com/ocpp?token=!",
      ),
      extra: {
        backends: "wss://a.example.com/ocpp;wss://bob:hunt3r@c.example.com/ocpp#k3y)",
        // The URL parser alone would read "123" as a port and keep the rest.
        slashInPassword: "wss://carol:123/pa55@d.example.com/ocpp",
      },
    });
    await reporter.close(1_000);

    expect(events).toHaveLength(1);
    const sent = bodies.join("\n");
    expect(sent).not.toMatch(/alice|s3cret|bob|hunt3r|k3y|token=!|carol|pa55/);
    expect(sent).toContain(
      "cannot reach wss://a.example.com/ocpp,wss://***@b.example.com/ocpp?token=***",
    );
    expect(sent).toContain("wss://a.example.com/ocpp;wss://***@c.example.com/ocpp#***");
    expect(sent).toContain("wss://***@d.example.com/ocpp");
  });

  it("sends no breadcrumbs, sessions nor traces of the gateway's WebSocket traffic", async () => {
    const { bodies, itemTypes, events, transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });
    const csms = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(csms, "listening");
    const { port } = csms.address() as AddressInfo;
    try {
      const ws = new WebSocket(`ws://user:s3cret@127.0.0.1:${port}/ocpp/CP-001?token=t0ken`, {
        headers: { authorization: "Basic czNjcmV0" },
      });
      await once(ws, "open");
      ws.close();
      await once(ws, "close");

      reporter.report({ tag: "proxy", message: "WebSocket server error", error: new Error("x") });
      await reporter.close(1_000);
    } finally {
      csms.close();
    }

    expect(events).toHaveLength(1);
    expect(events[0].breadcrumbs ?? []).toEqual([]);
    expect(itemTypes).toEqual(["event"]);
    expect(bodies.join("\n")).not.toMatch(/s3cret|t0ken|czNjcmV0|CP-001/);
  });

  it("never throws, even after being closed", async () => {
    const { transport } = recordingTransport();
    reporter = openSentryReporter(CONFIG, { transport });
    await reporter.close(1_000);

    expect(() => reporter?.report({ tag: "proxy", message: "late" })).not.toThrow();
    await expect(reporter.close(1_000)).resolves.toBeUndefined();
  });
});
