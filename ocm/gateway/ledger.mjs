/**
 * Append-only usage ledger — local/JSONL implementation.
 *
 * Used for development and tests. Production uses `pg-ledger.mjs` against Postgres;
 * both expose the same async interface so the gateway does not know which it has.
 *
 * Usage rows are idempotent by `jobId`. A repeated clear with the same immutable
 * payload returns the original row; reusing a job id with different accounting
 * facts is a hard conflict. If the append-only log becomes unwritable, accounting
 * is marked unhealthy and balance reads fail closed so the gateway stops accepting
 * new work rather than continuing to serve unrecorded usage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_JOB_ID_LENGTH = 200;
const ACCOUNTING_UNHEALTHY = 'ACCOUNTING_UNHEALTHY';

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
    kind: 'usage',
    consumer,
    host,
    model,
    jobId,
    promptTokens: prompt,
    completionTokens: completion,
    tokens,
  };
}

function sameUsage(a, b) {
  return ['consumer', 'host', 'model', 'jobId', 'promptTokens', 'completionTokens', 'tokens']
    .every((field) => a[field] === b[field]);
}

export class Ledger {
  constructor(path = 'ocm/.data/usage.jsonl') {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.entries = existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    this.usageByJob = new Map();
    this.accountingError = null;

    for (const entry of this.entries) {
      if (entry.kind !== 'usage' || !entry.jobId) continue;
      const prior = this.usageByJob.get(entry.jobId);
      if (prior) {
        this.accountingError = sameUsage(prior, entry)
          ? `duplicate persisted usage rows for job ${entry.jobId}`
          : `conflicting persisted usage rows for job ${entry.jobId}`;
        continue;
      }
      this.usageByJob.set(entry.jobId, entry);
    }
  }

  async init() {
    // Startup has no live HTTP surface yet, so operators receive the repair detail.
    // Runtime calls use #requireHealthy(), whose public-safe error is generic.
    if (this.accountingError) throw new Error(`${ACCOUNTING_UNHEALTHY}: ${this.accountingError}`);
    return this;
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

  /** Credit a consumer with granted balance. Billing is a later problem. */
  async grant(consumer, tokens, note = 'granted') {
    this.#requireHealthy();
    if (typeof consumer !== 'string' || !consumer.trim()) throw new TypeError('consumer is required');
    asNonNegativeInteger(tokens, 'tokens');
    return this.#append({ kind: 'grant', consumer, tokens, note });
  }

  /**
   * Clear one request exactly once: debit the consumer, credit the provider.
   * `tokens` is what the GATEWAY counted, never what the host claimed.
   */
  async clear(input) {
    this.#requireHealthy();
    const row = usageShape(input);
    const prior = this.usageByJob.get(row.jobId);
    if (prior) {
      if (!sameUsage(prior, row)) throw new Error(`idempotency_conflict: job ${row.jobId}`);
      return { ...prior, replayed: true };
    }

    const entry = this.#append(row);
    this.usageByJob.set(row.jobId, entry);
    return entry;
  }

  #append(partial) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), ...partial };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
    } catch (error) {
      this.#markUnhealthy(error);
      throw new Error(ACCOUNTING_UNHEALTHY, { cause: error });
    }
    this.entries.push(entry);
    return entry;
  }

  async balance(consumer) {
    this.#requireHealthy();
    let n = 0;
    for (const e of this.entries) {
      if (e.consumer !== consumer) continue;
      if (e.kind === 'grant') n += e.tokens;
      else if (e.kind === 'usage') n -= e.tokens;
    }
    return n;
  }

  /** How many grants this account has received. One redemption per account. */
  async grantCount(consumer) {
    this.#requireHealthy();
    return this.entries.filter((e) => e.kind === 'grant' && e.consumer === consumer).length;
  }

  async credited(host) {
    this.#requireHealthy();
    return this.entries
      .filter((e) => e.kind === 'usage' && e.host === host)
      .reduce((n, e) => n + e.completionTokens, 0);
  }

  /** Everything the console needs, in one call, so backends stay interchangeable. */
  async summary() {
    this.#requireHealthy();
    const usage = this.entries.filter((e) => e.kind === 'usage');
    const consumers = new Map();
    for (const e of this.entries) {
      if (!e.consumer) continue;
      const c = consumers.get(e.consumer)
        || { consumer: e.consumer, granted: 0, used: 0, requests: 0 };
      if (e.kind === 'grant') c.granted += e.tokens;
      else if (e.kind === 'usage') { c.used += e.tokens; c.requests += 1; }
      consumers.set(e.consumer, c);
    }
    const creditedByHost = {};
    for (const e of usage) {
      creditedByHost[e.host] = (creditedByHost[e.host] || 0) + e.completionTokens;
    }
    return {
      accounting: this.health(),
      consumers: [...consumers.values()].map((c) => ({ ...c, balance: c.granted - c.used })),
      creditedByHost,
      totals: {
        requests: usage.length,
        prompt_tokens: usage.reduce((n, e) => n + e.promptTokens, 0),
        completion_tokens: usage.reduce((n, e) => n + e.completionTokens, 0),
      },
      recent: usage.slice(-10).reverse(),
    };
  }

  /**
   * Usage since the start of the current UTC day: what the public status page shows
   * as "served today". Grants are excluded, and nothing per-consumer is returned, so
   * the result can be published as-is.
   */
  /** Earliest usage row per host: the moment a machine first served a real job. */
  async firstServedByHost() {
    this.#requireHealthy();
    const first = {};
    for (const e of this.entries) {
      if (e.kind !== 'usage' || !e.host) continue;
      if (!first[e.host] || e.at < first[e.host]) first[e.host] = e.at;
    }
    return first;
  }

  async servedToday(now = new Date()) {
    this.#requireHealthy();
    const since = startOfUtcDay(now);
    const usage = this.entries.filter((e) => e.kind === 'usage' && new Date(e.at) >= since);
    return {
      since: since.toISOString(),
      requests: usage.length,
      prompt_tokens: usage.reduce((n, e) => n + e.promptTokens, 0),
      completion_tokens: usage.reduce((n, e) => n + e.completionTokens, 0),
    };
  }

  async close() {}
}

/** Midnight UTC, so "today" means the same thing on every ledger backend. */
export function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
