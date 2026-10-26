import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresTraceStore, TRACE_TABLE } from "../../src/trace/postgres-store";
import type { TraceDocument } from "../../src/trace/record";
import { SessionTracer } from "../../src/trace/session-tracer";
import { MemoryTraceSink } from "./memory-sink";

const POSTGRES_URL = process.env.TRACE_TEST_POSTGRES_URL;

function traceDocument(): TraceDocument {
  const sink = new MemoryTraceSink();
  const tracer = new SessionTracer(
    {
      sessionId: randomUUID(),
      tenantId: "tenant-a",
      chargePointId: "CP-001",
      protocol: "ocpp1.6",
      primaryId: "csms-main",
      secondaryIds: [],
    },
    sink,
  );
  const frame = tracer.fromCharger('[2,"m1","Heartbeat",{}]');
  frame.delivery(0).submitted();
  frame.commit();
  return sink.docs[0];
}

describe("PostgresTraceStore", () => {
  it("rejects a URL that is not PostgreSQL without exposing it", () => {
    expect(() =>
      PostgresTraceStore.create({
        postgresUrl: "mongodb://s3cret@db.example.com",
        retentionDays: 30,
      }),
    ).toThrow("invalid TRACE_POSTGRES_URL");
  });

  describe.skipIf(!POSTGRES_URL)("against PostgreSQL", () => {
    const ids: string[] = [];
    const admin = new Pool({
      connectionString: POSTGRES_URL ?? "postgresql://user:password@127.0.0.1/unused",
    });
    const store = PostgresTraceStore.create({ postgresUrl: POSTGRES_URL!, retentionDays: 30 });

    afterAll(async () => {
      if (ids.length) {
        await admin.query(`DELETE FROM ${TRACE_TABLE} WHERE id = ANY($1::text[])`, [ids]);
      }
      await store.close();
      await admin.end();
    });

    it("persists trace JSON, deduplicates retries, and advances delivery status", async () => {
      const doc = traceDocument();
      ids.push(doc.id);

      await expect(store.insertMany([doc])).resolves.toEqual({ rejected: [] });
      await expect(store.insertMany([doc])).resolves.toEqual({ rejected: [] });
      await store.updateDeliveries([
        {
          id: doc.id,
          index: 0,
          delivery: { ...doc.deliveries[0], status: "written", updatedAt: new Date() },
        },
      ]);
      await store.updateDeliveries([
        {
          id: doc.id,
          index: 0,
          delivery: { ...doc.deliveries[0], status: "submitted", updatedAt: new Date() },
        },
      ]);

      const result = await admin.query<{ document: TraceDocument & { expiresAt: string } }>(
        `SELECT document FROM ${TRACE_TABLE} WHERE id = $1`,
        [doc.id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].document.kind).toBe("trace");
      expect(result.rows[0].document.deliveries[0].status).toBe("written");
      expect(new Date(result.rows[0].document.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("recreates its schema on the next batch after the table is dropped", async () => {
      const doc = traceDocument();
      ids.push(doc.id);
      await store.insertMany([doc]);
      await admin.query(`DROP TABLE ${TRACE_TABLE}`);

      await expect(store.insertMany([doc])).rejects.toThrow();
      await expect(store.insertMany([doc])).resolves.toEqual({ rejected: [] });

      const result = await admin.query(`SELECT id FROM ${TRACE_TABLE} WHERE id = $1`, [doc.id]);
      expect(result.rows).toHaveLength(1);
    });
  });
});
