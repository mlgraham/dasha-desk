/**
 * Append-only usage ledger — Postgres implementation.
 *
 * Usage clearing is idempotent by `job_id`. A retry with the same immutable usage
 * facts returns the existing row; reusing the same job id for different facts is a
 * hard conflict. A database failure marks accounting unhealthy, and subsequent
 * balance/grant/usage calls fail closed until the process is restarted after the
 * database has been repaired. This keeps the granted-credit alpha from silently
 * serving more unrecorded work after an accounting failure.
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startOfUtcDay } from './ledger.mjs';

const MAX_JOB_ID_LENGTH = 200;
const ACCOUNTING_UNHEALTHY = 'ACCOUNTING_UNHEALTHY';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_log (
  id                uuid PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text        NOT NULL CHECK (kind IN ('grant','usage')),
  consumer          text        NOT NULL,
  host              text,
  model             text,
  job_id             text,
  prompt_tokens     integer     NOT NULL DEFAULT 0,
  completion_tokens integer     NOT NULL DEFAULT 0,
  tokens            integer     NOT NULL,
  note              text
);
CREATE INDEX IF NOT EXISTS usage_log_consumer_idx ON usage_log (consumer);
CREATE INDEX IF NOT EXISTS usage_log_host_idx     ON usage_log (host) WHERE host IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_log_at_idx       ON usage_log (at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS usage_log_usage_job_idx
  ON usage_log (job_id)
  WHERE kind = 'usage' AND job_id IS NOT NULL;
`;

function asNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function usageShape({ consumer, host, model, promptTokens, completionTokens, jobId }) {
  if (typeof jobId !== 'string' || !jobId.trim() || jobId.length > MAX_JOB_ID_LENGTH) {
    throw new TypeError(`jobId must be 1-${MAX_JOB_ID_LENGTH} characters`);
  }
  for (const [field, value] of Object.entries({ consumer, host, model })) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  }
  const prompt = asNonNegativeInteger(promptTokens, 'promptTokens');
  const completion = asNonNegativeInteger(completionTokens, 'completionTokens');
  const tokens = prompt + completion;
  if (!Number.isSafeInteger(tokens)) throw new TypeError('total tokens must be a safe integer');
  return {
    kind: 'usage', consumer, host, model, jobId,
    promptTokens: prompt,
    completionTokens: completion,
    tokens,
  };
}

function sameUsage(a, b) {
  return ['consumer', 'host', 'model', 'jobId', 'promptTokens', 'completionTokens', 'tokens']
    .every((field) => a[field] === b[field]);
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    consumer: row.consumer,
    host: row.host,
    model: row.model,
    jobId: row.job_id ?? row.jobId,
    promptTokens: Number(row.prompt_tokens ?? row.promptTokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? row.completionTokens ?? 0),
    tokens: Number(row.tokens),
    note: row.note,
  };
}

/**
 * TLS to RDS.
 *
 * With the RDS CA bundle present the server certificate is actually verified. Without
 * it the connection is encrypted but unauthenticated — which is a meaningfully weaker
 * thing, so it warns loudly rather than passing silently for "SSL: on".
 */
export function rdsTls(caPath = process.env.OCM_RDS_CA || '/etc/ocm/rds-ca.pem') {
  if (caPath && existsSync(caPath)) {
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  console.warn(JSON.stringify({ level: 'warn',
    msg: 'RDS CA bundle missing — Postgres TLS is encrypted but NOT verified',
    expected: caPath }));
  return { rejectUnauthorized: false };
}

export class PgLedger {
  constructor(connectionString, { ssl = true } = {}) {
    this.pool = new pg.Pool({
      connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: ssl ? rdsTls() : false,
    });
    this.accountingError = null;
  }

  health() {
    return { ok: !this.accountingError, error: this.accountingError };
  }

  #requireHealthy() {
    if (this.accountingError) throw new Error(ACCOUNTING_UNHEALTHY);
  }

  #markUnhealthy(error) {
    this.accountingError = error instanceof Error ? error.message : String(error);
  }

  async #query(text, values) {
    this.#requireHealthy();
    try {
      return await this.pool.query(text, values);
    } catch (error) {
      this.#markUnhealthy(error);
      throw new Error(ACCOUNTING_UNHEALTHY, { cause: error });
    }
  }

  async init() {
    try {
      await this.pool.query(SCHEMA);
      return this;
    } catch (error) {
      this.#markUnhealthy(error);
      throw new Error(ACCOUNTING_UNHEALTHY, { cause: error });
    }
  }

  async grant(consumer, tokens, note = 'granted') {
    if (typeof consumer !== 'string' || !consumer.trim()) throw new TypeError('consumer is required');
    asNonNegativeInteger(tokens, 'tokens');
    const id = randomUUID();
    await this.#query(
      `INSERT INTO usage_log (id, kind, consumer, tokens, note)
       VALUES ($1,'grant',$2,$3,$4)`,
      [id, consumer, tokens, note],
    );
    return { id, kind: 'grant', consumer, tokens, note };
  }

  async clear(input) {
    const row = usageShape(input);
    const id = randomUUID();
    const inserted = await this.#query(
      `INSERT INTO usage_log
         (id, kind, consumer, host, model, job_id, prompt_tokens, completion_tokens, tokens)
       VALUES ($1,'usage',$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id, at, kind, consumer, host, model, job_id,
                 prompt_tokens, completion_tokens, tokens, note`,
      [id, row.consumer, row.host, row.model, row.jobId,
       row.promptTokens, row.completionTokens, row.tokens],
    );
    if (inserted.rows[0]) return fromRow(inserted.rows[0]);

    const existingResult = await this.#query(
      `SELECT id, at, kind, consumer, host, model, job_id,
              prompt_tokens, completion_tokens, tokens, note
         FROM usage_log WHERE kind='usage' AND job_id=$1`,
      [row.jobId],
    );
    const existing = fromRow(existingResult.rows[0]);
    if (!existing) {
      const error = new Error(`ambiguous usage insert for job ${row.jobId}`);
      this.#markUnhealthy(error);
      throw new Error(ACCOUNTING_UNHEALTHY, { cause: error });
    }
    if (!sameUsage(existing, row)) throw new Error(`idempotency_conflict: job ${row.jobId}`);
    return { ...existing, replayed: true };
  }

  async balance(consumer) {
    const { rows } = await this.#query(
      `SELECT COALESCE(SUM(CASE WHEN kind='grant' THEN tokens ELSE -tokens END),0)::bigint AS balance
         FROM usage_log WHERE consumer = $1`, [consumer]);
    return Number(rows[0].balance);
  }

  async grantCount(consumer) {
    const { rows } = await this.#query(
      `SELECT COUNT(*)::int AS n FROM usage_log WHERE kind='grant' AND consumer = $1`, [consumer]);
    return rows[0].n;
  }

  async credited(host) {
    const { rows } = await this.#query(
      `SELECT COALESCE(SUM(completion_tokens),0)::bigint AS n
         FROM usage_log WHERE kind='usage' AND host = $1`, [host]);
    return Number(rows[0].n);
  }

  async summary() {
    this.#requireHealthy();
    let result;
    try {
      result = await Promise.all([
        this.pool.query(
          `SELECT consumer,
                  COALESCE(SUM(CASE WHEN kind='grant' THEN tokens ELSE 0 END),0)::bigint AS granted,
                  COALESCE(SUM(CASE WHEN kind='usage' THEN tokens ELSE 0 END),0)::bigint AS used,
                  COUNT(*) FILTER (WHERE kind='usage')::bigint AS requests
             FROM usage_log GROUP BY consumer ORDER BY consumer`),
        this.pool.query(
          `SELECT host, COALESCE(SUM(completion_tokens),0)::bigint AS n
             FROM usage_log WHERE kind='usage' AND host IS NOT NULL GROUP BY host`),
        this.pool.query(
          `SELECT COUNT(*)::bigint AS requests,
                  COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
                  COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens
             FROM usage_log WHERE kind='usage'`),
        this.pool.query(
          `SELECT id, at, consumer, host, model, job_id AS "jobId",
                  prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens", tokens
             FROM usage_log WHERE kind='usage' ORDER BY at DESC LIMIT 10`),
      ]);
    } catch (error) {
      this.#markUnhealthy(error);
      throw new Error(ACCOUNTING_UNHEALTHY, { cause: error });
    }
    const [consumers, hosts, totals, recent] = result;

    const creditedByHost = {};
    for (const r of hosts.rows) creditedByHost[r.host] = Number(r.n);
    const t = totals.rows[0];

    return {
      accounting: this.health(),
      consumers: consumers.rows.map((r) => ({
        consumer: r.consumer,
        granted: Number(r.granted),
        used: Number(r.used),
        requests: Number(r.requests),
        balance: Number(r.granted) - Number(r.used),
      })),
      creditedByHost,
      totals: {
        requests: Number(t.requests),
        prompt_tokens: Number(t.prompt_tokens),
        completion_tokens: Number(t.completion_tokens),
      },
      recent: recent.rows,
    };
  }

  /** Same shape as Ledger#servedToday: usage rows since midnight UTC, no consumer ids. */
  async servedToday(now = new Date()) {
    const since = startOfUtcDay(now);
    const { rows } = await this.#query(
      `SELECT COUNT(*)::bigint AS requests,
              COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0)::bigint AS completion_tokens
         FROM usage_log WHERE kind='usage' AND at >= $1`, [since.toISOString()]);
    const r = rows[0];
    return {
      since: since.toISOString(),
      requests: Number(r.requests),
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
    };
  }

  async close() { await this.pool.end(); }
}
