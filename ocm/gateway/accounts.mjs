/**
 * Accounts and credentials.
 *
 * Two credential kinds, both account-bound and revocable:
 *   - developer keys  (`ocm_live_…`) authorise /v1/* requests
 *   - provider tokens (`ocm_host_…`) authorise a host socket
 *
 * Only the SHA-256 hash is stored. The plaintext is returned exactly once, at
 * creation, and cannot be recovered afterwards — losing one means issuing another.
 * A leaked database therefore does not yield working credentials.
 *
 * Lookup is by hash, so it is a single indexed query rather than a scan-and-compare.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const hashSecret = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const mint = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
export const mintDeveloperKey = () => mint('ocm_live');
export const mintProviderToken = () => mint('ocm_host');

/** Constant-time compare for equal-length hex digests. */
export function sameSecret(a, b) {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id         text PRIMARY KEY,
  email      text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES accounts(id),
  kind        text NOT NULL CHECK (kind IN ('developer_key','provider_token')),
  hash        text NOT NULL UNIQUE,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS credentials_hash_idx    ON credentials (hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS credentials_account_idx ON credentials (account_id);
-- A provider token binds to the first machine that presents it, so a leaked token
-- cannot be used from somewhere else and per-machine revocation means what an
-- operator assumes it means. Added later, hence the ALTER for existing databases.
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS bound_agent_id text;
`;

/**
 * Postgres-backed store. The in-memory variant below keeps tests dependency-free.
 */
export class PgAccounts {
  constructor(pool) { this.pool = pool; }

  async init() { await this.pool.query(SCHEMA); return this; }

  async createAccount(email) {
    const id = `acct_${randomBytes(9).toString('base64url')}`;
    const { rows } = await this.pool.query(
      `INSERT INTO accounts (id, email) VALUES ($1,$2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, created_at`, [id, email.toLowerCase()]);
    return rows[0];
  }

  async issue(accountId, kind, label = null) {
    const secret = kind === 'developer_key' ? mintDeveloperKey() : mintProviderToken();
    const id = `cred_${randomBytes(9).toString('base64url')}`;
    await this.pool.query(
      `INSERT INTO credentials (id, account_id, kind, hash, label) VALUES ($1,$2,$3,$4,$5)`,
      [id, accountId, kind, hashSecret(secret), label]);
    // The only time the plaintext exists outside the caller's hands.
    return { id, secret, kind, label };
  }

  async resolve(secret, kind) {
    if (!secret) return null;
    const { rows } = await this.pool.query(
      `UPDATE credentials SET last_used_at = now()
        WHERE hash = $1 AND kind = $2 AND revoked_at IS NULL
        RETURNING id, account_id`, [hashSecret(secret), kind]);
    return rows[0] ? { credentialId: rows[0].id, accountId: rows[0].account_id } : null;
  }

  async revoke(credentialId) {
    const { rowCount } = await this.pool.query(
      `UPDATE credentials SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL`, [credentialId]);
    return rowCount > 0;
  }

  /** Is this credential still usable? Console sessions re-check on every request. */
  async credentialActive(credentialId) {
    if (!credentialId) return false;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM credentials WHERE id = $1 AND revoked_at IS NULL`, [credentialId]);
    return rows.length > 0;
  }

  async listCredentials(accountId) {
    const { rows } = await this.pool.query(
      `SELECT id, kind, label, created_at, last_used_at, revoked_at, bound_agent_id
         FROM credentials WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    return rows;
  }

  async accountFor(accountId) {
    const { rows } = await this.pool.query(`SELECT id, email FROM accounts WHERE id = $1`, [accountId]);
    return rows[0] || null;
  }

  /** Existing account for this email, or null. Signup uses it to refuse a duplicate. */
  async accountByEmail(email) {
    const { rows } = await this.pool.query(
      `SELECT id, email FROM accounts WHERE email = $1`, [String(email || '').toLowerCase()]);
    return rows[0] || null;
  }

  /**
   * Claim this credential for a machine, or report the conflict.
   *
   * Returns {ok:true} when the token is unbound (first use, now bound) or already
   * bound to this same agent. Returns {ok:false, boundTo} when it belongs to a
   * different machine. The bind is conditional in SQL so two hosts racing the same
   * unbound token cannot both win.
   */
  async claimAgent(credentialId, agentId) {
    if (!credentialId || !agentId) return { ok: true };
    const { rows } = await this.pool.query(
      `UPDATE credentials SET bound_agent_id = $2
         WHERE id = $1 AND (bound_agent_id IS NULL OR bound_agent_id = $2)
       RETURNING bound_agent_id`, [credentialId, agentId]);
    if (rows.length) return { ok: true, bound: rows[0].bound_agent_id };
    const cur = await this.pool.query(
      `SELECT bound_agent_id FROM credentials WHERE id = $1`, [credentialId]);
    return { ok: false, boundTo: cur.rows[0] ? cur.rows[0].bound_agent_id : null };
  }

  /** Release the binding so the token can be moved to another machine. */
  async rebind(credentialId, accountId) {
    const { rowCount } = await this.pool.query(
      `UPDATE credentials SET bound_agent_id = NULL
        WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`, [credentialId, accountId]);
    return rowCount > 0;
  }

  /** Every account, oldest first — for the admin network view only. */
  async listAccounts() {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.email, a.created_at,
              COUNT(c.id) FILTER (WHERE c.kind='developer_key'  AND c.revoked_at IS NULL)::int AS developer_keys,
              COUNT(c.id) FILTER (WHERE c.kind='provider_token' AND c.revoked_at IS NULL)::int AS provider_tokens,
              MAX(c.last_used_at) AS last_used_at
         FROM accounts a LEFT JOIN credentials c ON c.account_id = a.id
        GROUP BY a.id ORDER BY a.created_at`);
    return rows;
  }
}

/** In-memory equivalent, so the test suite needs no database. */
export class MemoryAccounts {
  constructor() { this.accounts = new Map(); this.creds = new Map(); }
  async init() { return this; }

  async createAccount(email) {
    const lower = email.toLowerCase();
    for (const a of this.accounts.values()) if (a.email === lower) return a;
    const acct = { id: `acct_${randomBytes(9).toString('base64url')}`, email: lower, created_at: new Date() };
    this.accounts.set(acct.id, acct);
    return acct;
  }

  async issue(accountId, kind, label = null) {
    const secret = kind === 'developer_key' ? mintDeveloperKey() : mintProviderToken();
    const id = `cred_${randomBytes(9).toString('base64url')}`;
    this.creds.set(id, { id, account_id: accountId, kind, hash: hashSecret(secret),
                         label, created_at: new Date(), last_used_at: null, revoked_at: null });
    return { id, secret, kind, label };
  }

  async resolve(secret, kind) {
    if (!secret) return null;
    const h = hashSecret(secret);
    for (const c of this.creds.values()) {
      if (c.kind === kind && !c.revoked_at && sameSecret(c.hash, h)) {
        c.last_used_at = new Date();
        return { credentialId: c.id, accountId: c.account_id };
      }
    }
    return null;
  }

  async revoke(credentialId) {
    const c = this.creds.get(credentialId);
    if (!c || c.revoked_at) return false;
    c.revoked_at = new Date();
    return true;
  }

  async credentialActive(credentialId) {
    const c = this.creds.get(credentialId);
    return !!c && !c.revoked_at;
  }

  async claimAgent(credentialId, agentId) {
    if (!credentialId || !agentId) return { ok: true };
    const c = this.creds.get(credentialId);
    if (!c) return { ok: true };
    if (!c.bound_agent_id || c.bound_agent_id === agentId) {
      c.bound_agent_id = agentId;
      return { ok: true, bound: agentId };
    }
    return { ok: false, boundTo: c.bound_agent_id };
  }

  async rebind(credentialId, accountId) {
    const c = this.creds.get(credentialId);
    if (!c || c.account_id !== accountId || c.revoked_at) return false;
    c.bound_agent_id = null;
    return true;
  }

  async listCredentials(accountId) {
    return [...this.creds.values()].filter((c) => c.account_id === accountId)
      .map(({ hash, ...rest }) => rest);
  }

  async accountFor(accountId) { return this.accounts.get(accountId) || null; }

  async accountByEmail(email) {
    const lower = String(email || '').toLowerCase();
    for (const a of this.accounts.values()) if (a.email === lower) return a;
    return null;
  }

  async listAccounts() {
    return [...this.accounts.values()].map((a) => {
      const creds = [...this.creds.values()].filter((c) => c.account_id === a.id);
      const live = (kind) => creds.filter((c) => c.kind === kind && !c.revoked_at).length;
      const used = creds.map((c) => c.last_used_at).filter(Boolean).sort((x, y) => y - x)[0] || null;
      return { ...a, developer_keys: live('developer_key'), provider_tokens: live('provider_token'), last_used_at: used };
    });
  }
}
