import { Pool } from "pg";
import type { TraceConfig } from "../config";
import { createLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { DELIVERY_STATUS_RANK, type DeliveryStatus, type TraceDocument } from "./record";
import type { DeliveryUpdate, TraceStore } from "./writer";

export const TRACE_TABLE = "ocpp_traces";
const log = createLogger("trace");

const STATUSES = Object.keys(DELIVERY_STATUS_RANK) as DeliveryStatus[];
const EARLIER_STATUSES = Object.fromEntries(
  STATUSES.map((status) => [
    status,
    STATUSES.filter((candidate) => DELIVERY_STATUS_RANK[candidate] < DELIVERY_STATUS_RANK[status]),
  ]),
) as Record<DeliveryStatus, DeliveryStatus[]>;

/** PostgreSQL-backed trace store. The pool connects lazily and keeps credentials out of errors. */
export class PostgresTraceStore implements TraceStore {
  private schemaReady: Promise<void> | undefined;
  private readonly pool: Pool;

  static create(config: Pick<TraceConfig, "postgresUrl" | "retentionDays">): PostgresTraceStore {
    try {
      const url = new URL(config.postgresUrl);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
        throw new Error("unsupported URL");
      }
      return new PostgresTraceStore(
        new Pool({
          connectionString: config.postgresUrl,
          connectionTimeoutMillis: 5_000,
          query_timeout: 30_000,
          application_name: "ocpp-gateway",
        }),
        config.retentionDays,
      );
    } catch {
      throw new Error("invalid TRACE_POSTGRES_URL");
    }
  }

  constructor(
    pool: Pool,
    private readonly retentionDays: number,
  ) {
    this.pool = pool;
    this.pool.on("error", (err: Error) => {
      log.warn("idle PostgreSQL client error", { error: errorMessage(this.safeError(err)) });
    });
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${TRACE_TABLE} (
            id text PRIMARY KEY,
            tenant_id text,
            session_id text NOT NULL,
            charge_point_id text NOT NULL,
            seq bigint NOT NULL,
            received_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL,
            document jsonb NOT NULL
          );
          CREATE INDEX IF NOT EXISTS ocpp_traces_charge_point_history
            ON ${TRACE_TABLE} (tenant_id, charge_point_id, received_at);
          CREATE INDEX IF NOT EXISTS ocpp_traces_session_sequence
            ON ${TRACE_TABLE} (tenant_id, session_id, seq);
          CREATE INDEX IF NOT EXISTS ocpp_traces_expiry ON ${TRACE_TABLE} (expires_at);
        `);
      } catch (err) {
        this.schemaReady = undefined;
        throw this.safeError(err);
      }
    })();
    return this.schemaReady;
  }

  private safeError(err: unknown): Error {
    const error = err instanceof Error ? err : new Error(String(err));
    const safe = new Error(
      error.message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://[redacted]"),
    );
    safe.name = error.name;
    return safe;
  }

  async insertMany(docs: TraceDocument[]): Promise<{ rejected: { id: string; reason: string }[] }> {
    await this.ensureSchema();
    const rejected: { id: string; reason: string }[] = [];
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const doc of docs) {
      let document: string;
      try {
        document = JSON.stringify(doc);
      } catch {
        rejected.push({ id: doc.id, reason: "not-storable" });
        continue;
      }
      if (!document) {
        rejected.push({ id: doc.id, reason: "not-storable" });
        continue;
      }
      const offset = values.length;
      rows.push(
        `($${offset + 1}::text, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::text, $${offset + 5}::bigint, $${offset + 6}::timestamptz, $${offset + 7}::jsonb)`,
      );
      values.push(
        doc.id,
        doc.tenantId,
        doc.sessionId,
        doc.chargePointId,
        doc.seq,
        doc.receivedAt,
        JSON.stringify({
          ...doc,
          expiresAt: new Date(doc.receivedAt.getTime() + this.retentionDays * 86_400_000),
        }),
      );
    }
    if (!rows.length) return { rejected };

    try {
      await this.pool.query(
        `INSERT INTO ${TRACE_TABLE} (id, tenant_id, session_id, charge_point_id, seq, received_at, expires_at, document)
         SELECT input.id, input.tenant_id, input.session_id, input.charge_point_id, input.seq, input.received_at,
                (input.document->>'expiresAt')::timestamptz, input.document
         FROM (VALUES ${rows.join(", ")}) AS input(id, tenant_id, session_id, charge_point_id, seq, received_at, document)
         ON CONFLICT (id) DO NOTHING`,
        values,
      );
      await this.pool.query(`DELETE FROM ${TRACE_TABLE} WHERE expires_at <= now()`);
    } catch (err) {
      this.schemaReady = undefined;
      throw this.safeError(err);
    }
    return { rejected };
  }

  async updateDeliveries(updates: DeliveryUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.ensureSchema();
    const client = await this.pool.connect().catch((err: unknown) => {
      throw this.safeError(err);
    });
    try {
      await client.query("BEGIN");
      for (const { id, index, delivery } of updates) {
        await client.query(
          `UPDATE ${TRACE_TABLE}
           SET document = jsonb_set(document, ARRAY['deliveries', $2::text], $3::jsonb, false)
           WHERE id = $1
             AND document->'deliveries'->($2::int)->>'status' = ANY($4::text[])`,
          [id, index, JSON.stringify(delivery), EARLIER_STATUSES[delivery.status]],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.schemaReady = undefined;
      throw this.safeError(err);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch((err: unknown) => {
      throw this.safeError(err);
    });
  }
}
