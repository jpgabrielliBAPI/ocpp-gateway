/**
 * Test-only port of the Open OCPP Trace reference consumer
 * (`conformance/validate.mjs` of open-ocpp-trace/specification, Apache-2.0):
 * schema validation, raw-frame fidelity, and the normative correlation rule.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

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
    if (record.payload !== undefined && !deepEqual(frame[3], record.payload))
      errors.push("payload");
  } else if (record.messageType === "CALLRESULT") {
    if (record.payload !== undefined && !deepEqual(frame[2], record.payload))
      errors.push("payload");
  } else if (record.messageType === "CALLERROR") {
    if (record.error?.code !== undefined && frame[2] !== record.error.code) errors.push("code");
    if (record.error?.description !== undefined && frame[3] !== record.error.description) {
      errors.push("description");
    }
    if (record.error?.details !== undefined && !deepEqual(frame[4], record.error.details)) {
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
