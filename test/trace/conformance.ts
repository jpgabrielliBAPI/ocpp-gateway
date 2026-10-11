/**
 * Test-only port of the Open OCPP Trace reference consumer
 * (`conformance/validate.mjs` of open-ocpp-trace/specification, Apache-2.0):
 * schema validation, raw-frame fidelity, and the normative correlation rule;
 * plus the gateway's conversation views checked against it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import type { OcppTraceRecord, TraceDocument } from "../../src/trace/record";

export const SPEC_DIR = join(__dirname, "..", "fixtures", "open-ocpp-trace");

const schema = JSON.parse(
  readFileSync(join(SPEC_DIR, "schema", "trace-v1.schema.json"), "utf8"),
) as object;
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateRecord = ajv.compile(schema);

/** The fields of a trace record the reference consumer reads. */
export interface SpecRecord {
  schemaVersion?: string;
  direction: string;
  messageType: string;
  messageId?: string;
  action?: string;
  payload?: unknown;
  raw?: string;
  error?: { code?: string; description?: string; details?: unknown };
  [key: string]: unknown;
}

/** Schema violations of `record`, empty when it is valid. */
export function schemaErrors(record: unknown): string[] {
  if (validateRecord(record)) return [];
  return (validateRecord.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
}

const MESSAGE_TYPE: Record<number, string> = { 2: "CALL", 3: "CALLRESULT", 4: "CALLERROR" };

/** Raw-fidelity violations of `record`, empty when `raw` decodes to the record. */
export function rawFidelityErrors(record: SpecRecord): string[] {
  if (record.raw === undefined) return [];
  let frame: unknown;
  try {
    frame = JSON.parse(record.raw);
  } catch {
    return ["raw does not parse as JSON"];
  }
  if (!Array.isArray(frame)) return ["raw is not an OCPP-J array"];
  const errors: string[] = [];
  if (MESSAGE_TYPE[frame[0] as number] !== record.messageType) errors.push("messageType");
  if (record.messageId !== undefined && frame[1] !== record.messageId) errors.push("messageId");
  if (record.messageType === "CALL") {
    if (frame[2] !== record.action) errors.push("action");
    if (record.payload !== undefined && !isDeepStrictEqual(frame[3], record.payload))
      errors.push("payload");
  } else if (record.messageType === "CALLRESULT") {
    if (record.payload !== undefined && !isDeepStrictEqual(frame[2], record.payload))
      errors.push("payload");
  } else if (record.messageType === "CALLERROR") {
    if (record.error?.code !== undefined && frame[2] !== record.error.code) errors.push("code");
    if (record.error?.description !== undefined && frame[3] !== record.error.description) {
      errors.push("description");
    }
    if (record.error?.details !== undefined && !isDeepStrictEqual(frame[4], record.error.details)) {
      errors.push("details");
    }
  }
  return errors;
}

export interface ConsumerView {
  schemaVersion: string;
  counts: { records: number; calls: number; callResults: number; callErrors: number };
  records: {
    index: number;
    messageType: string;
    messageId?: string;
    action?: string;
    correlatesWith?: number;
  }[];
  unansweredCalls: number[];
  orphanResponses: number[];
}

/**
 * The normative correlation rule: a CALLRESULT or CALLERROR correlates with
 * the most recent preceding CALL that has the same messageId, travels in the
 * opposite direction, and is not yet answered.
 */
export function buildConsumerView(records: SpecRecord[]): ConsumerView {
  const view: ConsumerView["records"] = records.map((r, index) => {
    const entry: ConsumerView["records"][number] = {
      index,
      messageType: r.messageType,
      messageId: r.messageId,
    };
    if (r.messageType === "CALL") entry.action = r.action;
    return entry;
  });
  const answered = new Set<number>();
  const orphanResponses: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.messageType === "CALL") continue;
    let match = -1;
    for (let j = i - 1; j >= 0; j--) {
      const c = records[j];
      if (
        c.messageType === "CALL" &&
        c.messageId === r.messageId &&
        c.direction !== r.direction &&
        !answered.has(j)
      ) {
        match = j;
        break;
      }
    }
    if (match === -1) {
      orphanResponses.push(i);
    } else {
      answered.add(match);
      view[i].action = records[match].action;
      view[i].correlatesWith = match;
    }
  }
  const unansweredCalls = records
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => r.messageType === "CALL" && !answered.has(i))
    .map(({ i }) => i);
  return {
    schemaVersion: records[0]?.schemaVersion ?? "unknown",
    counts: {
      records: records.length,
      calls: records.filter((r) => r.messageType === "CALL").length,
      callResults: records.filter((r) => r.messageType === "CALLRESULT").length,
      callErrors: records.filter((r) => r.messageType === "CALLERROR").length,
    },
    records: view,
    unansweredCalls,
    orphanResponses,
  };
}

export interface Fixture {
  name: string;
  records: SpecRecord[];
  expected: ConsumerView;
}

/** Every reference fixture of the vendored corpus. */
export function loadFixtures(): Fixture[] {
  const dir = join(SPEC_DIR, "fixtures");
  return readdirSync(dir)
    .sort()
    .map((name) => ({
      name,
      records: readFileSync(join(dir, name, "trace.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SpecRecord),
      expected: JSON.parse(readFileSync(join(dir, name, "expected.json"), "utf8")) as ConsumerView,
    }));
}

/**
 * The conversation a record belongs to: its CSMS source, or the primary for a
 * charger frame (the one the charger talks with; mirrored copies are observed
 * by secondaries, never answered to by the charger).
 */
function homeConversation({ meta: { gateway } }: OcppTraceRecord) {
  return gateway.source.type === "csms"
    ? gateway.source.id
    : gateway.destinations.find((d) => d.role === "primary")?.target;
}

/** The records exchanged between the charger and the CSMS `backendId`, in reception order. */
function conversationView(docs: TraceDocument[], backendId: string): OcppTraceRecord[] {
  return docs
    .flatMap((d) => (d.kind === "trace" ? [d.trace] : []))
    .filter(({ meta: { gateway } }) =>
      gateway.source.type === "csms"
        ? gateway.source.id === backendId
        : gateway.destinations.some((d) => d.target === backendId),
    )
    .sort((a, b) => a.meta.gateway.seq - b.meta.gateway.seq);
}

/**
 * Every record conforms to the spec, and within each conversation the
 * gateway's correlation is the reference consumer's, for the records that
 * conversation is the home of.
 */
export function expectConforming(docs: TraceDocument[], backendIds: string[]): void {
  for (const doc of docs) {
    if (doc.kind !== "trace") continue;
    expect(schemaErrors(doc.trace)).toEqual([]);
    expect(rawFidelityErrors(doc.trace as unknown as SpecRecord)).toEqual([]);
  }
  for (const backendId of backendIds) {
    const view = conversationView(docs, backendId);
    const consumer = buildConsumerView(view as unknown as SpecRecord[]);
    view.forEach((record, i) => {
      if (homeConversation(record) !== backendId) return;
      const expected = consumer.records[i].correlatesWith;
      const ours = record.meta.gateway.correlation;
      expect(ours?.callTraceId).toBe(
        expected === undefined ? undefined : view[expected].meta.gateway.traceId,
      );
      if (ours) expect(ours.action).toBe(consumer.records[i].action);
    });
  }
}
