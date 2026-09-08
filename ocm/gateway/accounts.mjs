/**
 * Accounts and credentials.
 *
 * Two credential kinds, both account-bound and revocable:
 *   - developer keys  (`ocm_live_…`) authorise /v1/* requests
 *   - provider tokens (`ocm_host_…`) authorise a host socket
 * plus enrollment codes (`ocm_enroll_…`): single-use, minutes-lived, exchanged by the
 * installer for a provider token already bound to the machine.
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
// Short-lived, single-use, exchanged by the installer for a provider token that is
// already bound to the machine. Low value if it leaks: it expires in minutes and
// works once, which is the whole point of handing people this instead of a token.
export const mintEnrollmentCode = () => mint('ocm_enroll');
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/**
 * Email is a label and future notification route, not an authenticator. Until OCM
 * verifies mailbox ownership, public signup must never use a matching email to
 * reopen an existing account or mint another credential for it.
 */
export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)
      || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new TypeError('a valid email address is required');
  }
  return email;
}

export class AccountExistsError extends Error {
  constructor() {
    super('account already exists — sign in with an existing developer key');
    this.name = 'AccountExistsError';
    this.code = 'ACCOUNT_EXISTS';
  }
}

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
-- Onboarding funnel: when the machine holding this credential first connected, and
-- when it was last seen. Together with enrollment_codes (issued, used) and usage_log
-- (first job) this says where a new provider stopped.
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS first_connected_at timestamptz;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS last_connected_at  timestamptz;

-- Enrollment codes: what a person pastes instead of a provider token. Stored hashed
-- like every other secret; used once; expire. The credential a code produced is
-- recorded so the console can show what came of it.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES accounts(id),
  hash          text NOT NULL UNIQUE,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  agent_id      text,
  credential_id text
);
CREATE INDEX IF NOT EXISTS enrollment_codes_account_idx ON enrollment_codes (account_id);
`;

/**
 * One funnel row per provider machine: issued -> enrolled -> connected -> (first job
 * comes from the ledger). Pending codes are rows too, so a code that was never used
 * is visible as the place onboarding stopped.
 */
export function shapeFunnel(credRows, pendingRows) {
  const creds = credRows.map((c) => ({
    credential_id: c.id, account_id: c.account_id, label: c.label || null,
    agent_id: c.bound_agent_id || null,
    issued_at: c.code_issued_at || c.created_at,
    enrolled_at: c.enrolled_at || null,
    first_connected_at: c.first_connected_at || null,
    last_connected_at: c.last_connected_at || null,
    revoked_at: c.revoked_at || null,
    pending: false,
  }));
  const pending = pendingRows.map((e) => ({
    credential_id: null, account_id: e.account_id, label: e.label || null, agent_id: null,
    issued_at: e.created_at, expires_at: e.expires_at, enrolled_at: null,
    first_connected_at: null, last_connected_at: null, revoked_at: null, pending: true,
  }));
  return [...pending, ...creds];
}

/**
 * Postgres-backed store. The in-memory variant below keeps tests dependency-free.
 */
export class PgAccounts {
  constructor(pool) { this.pool = pool; }

  async init() { await this.pool.query(SCHEMA); return this; }

  /**
   * Atomically create a new account. A duplicate is a hard stop: without email
   * verification, returning the existing row would let anyone who knows an address
   * mint a new developer key for that person's account.
   */
  async createAccount(email) {
    const normalized = normalizeEmail(email);
    const id = `acct_${randomBytes(9).toString('base64url')}`;
    const inserted = await this.pool.query(
      `INSERT INTO accounts (id, email) VALUES ($1,$2)
         ON CONFLICT (email) DO NOTHING
       RETURNING id, email, created_at`, [id, normalized]);
    if (!inserted.rows[0]) throw new AccountExistsError();
    return inserted.rows[0];
  }

  async issue(accountId, kind, label = null, { boundAgentId = null } = {}) {
    const secret = kind === 'developer_key' ? mintDeveloperKey() : mintProviderToken();
    const id = `cred_${randomBytes(9).toString('base64url')}`;
    await this.pool.query(
      `INSERT INTO credentials (id, account_id, kind, hash, label, bound_agent_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, accountId, kind, hashSecret(secret), label, boundAgentId]);
    // The only time the plaintext exists outside the caller's hands.
    return { id, secret, kind, label };
  }

  /** Mint a single-use enrollment code for this account. Plaintext returned once. */
  async issueEnrollment(accountId, label = null, ttlMs = ENROLLMENT_TTL_MS) {
    const code = mintEnrollmentCode();
    const id = `enr_${randomBytes(9).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `INSERT INTO enrollment_codes (id, account_id, hash, label, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, accountId, hashSecret(code), label, expiresAt]);
    return { id, code, label, expires_at: expiresAt };
  }

  /**
   * Exchange a code for a provider token bound to `agentId`. One transaction: the
   * code is consumed conditionally (unused, unexpired) so two racing redemptions
   * cannot both win; the new token is minted already bound; and any other live
   * provider token on the same account bound to the same machine is revoked, so
   * re-enrolling a machine is how it rotates. Returns null for unknown, used and
   * expired alike — the caller must not distinguish them.
   */
  async redeemEnrollment(code, agentId, label = null) {
    if (!code || !agentId) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const used = await client.query(
        `UPDATE enrollment_codes SET used_at = now(), agent_id = $2
          WHERE hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id, account_id, label`, [hashSecret(code), agentId]);
      if (!used.rows[0]) { await client.query('ROLLBACK'); return null; }
      const enr = used.rows[0];
      const secret = mintProviderToken();
      const credId = `cred_${randomBytes(9).toString('base64url')}`;
      const finalLabel = label || enr.label || agentId;
      await client.query(
        `INSERT INTO credentials (id, account_id, kind, hash, label, bound_agent_id)
         VALUES ($1,$2,'provider_token',$3,$4,$5)`,
        [credId, enr.account_id, hashSecret(secret), finalLabel, agentId]);
      const rotated = await client.query(
        `UPDATE credentials SET revoked_at = now()
          WHERE account_id = $1 AND kind = 'provider_token' AND bound_agent_id = $2
            AND revoked_at IS NULL AND id <> $3
        RETURNING id`, [enr.account_id, agentId, credId]);
      await client.query(`UPDATE enrollment_codes SET credential_id = $2 WHERE id = $1`, [enr.id, credId]);
      await client.query('COMMIT');
      return { credentialId: credId, secret, accountId: enr.account_id, label: finalLabel,
               rotated: rotated.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Codes not yet used and not yet expired, for the dashboard. Never the code itself. */
  async listEnrollments(accountId) {
    const { rows } = await this.pool.query(
      `SELECT id, label, created_at, expires_at FROM enrollment_codes
        WHERE account_id = $1 AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`, [accountId]);
    return rows;
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

  /**
   * Unrevoked credentials whose label is exactly `label` (case-sensitive, whole
   * string). Labels are free text, so `mac` prefixes `mac-2`: a substring or LIKE
   * match here can revoke the token a machine is actively using. The caller must
   * refuse unless exactly one row comes back.
   */
  async findByLabel(accountId, label) {
    if (!accountId || typeof label !== 'string' || !label) return [];
    const { rows } = await this.pool.query(
      `SELECT id, kind, label FROM credentials
        WHERE account_id = $1 AND label = $2 AND revoked_at IS NULL`, [accountId, label]);
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

  /** The machine holding this credential connected. First time is kept; last time moves. */
  async markConnected(credentialId) {
    if (!credentialId) return;
    await this.pool.query(
      `UPDATE credentials SET first_connected_at = COALESCE(first_connected_at, now()),
                              last_connected_at = now()
        WHERE id = $1`, [credentialId]);
  }

  /** Funnel rows for one account, or every account when accountId is null (admin). */
  async funnel(accountId = null) {
    const params = accountId ? [accountId] : [];
    const scope = accountId ? 'AND c.account_id = $1' : '';
    const creds = await this.pool.query(
      `SELECT c.id, c.account_id, c.label, c.bound_agent_id, c.created_at, c.revoked_at,
              c.first_connected_at, c.last_connected_at,
              e.created_at AS code_issued_at, e.used_at AS enrolled_at
         FROM credentials c LEFT JOIN enrollment_codes e ON e.credential_id = c.id
        WHERE c.kind = 'provider_token' ${scope}
        ORDER BY c.created_at DESC`, params);
    const pending = await this.pool.query(
      `SELECT id, account_id, label, created_at, expires_at FROM enrollment_codes
        WHERE used_at IS NULL AND expires_at > now() ${accountId ? 'AND account_id = $1' : ''}
        ORDER BY created_at DESC`, params);
    return shapeFunnel(creds.rows, pending.rows);
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
  constructor() { this.accounts = new Map(); this.creds = new Map(); this.enrollments = new Map(); }
  async init() { return this; }

  async createAccount(email) {
    const normalized = normalizeEmail(email);
    for (const account of this.accounts.values()) {
      if (account.email === normalized) throw new AccountExistsError();
    }
    const account = {
      id: `acct_${randomBytes(9).toString('base64url')}`,
      email: normalized,
      created_at: new Date(),
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async issue(accountId, kind, label = null, { boundAgentId = null } = {}) {
    const secret = kind === 'developer_key' ? mintDeveloperKey() : mintProviderToken();
    const id = `cred_${randomBytes(9).toString('base64url')}`;
    this.creds.set(id, { id, account_id: accountId, kind, hash: hashSecret(secret),
                         label, created_at: new Date(), last_used_at: null, revoked_at: null,
                         bound_agent_id: boundAgentId });
    return { id, secret, kind, label };
  }

  async issueEnrollment(accountId, label = null, ttlMs = ENROLLMENT_TTL_MS) {
    const code = mintEnrollmentCode();
    const id = `enr_${randomBytes(9).toString('base64url')}`;
    const expires_at = new Date(Date.now() + ttlMs);
    this.enrollments.set(id, { id, account_id: accountId, hash: hashSecret(code), label,
                               created_at: new Date(), expires_at, used_at: null,
                               agent_id: null, credential_id: null });
    return { id, code, label, expires_at };
  }

  async redeemEnrollment(code, agentId, label = null) {
    if (!code || !agentId) return null;
    const h = hashSecret(code);
    let enr = null;
    for (const e of this.enrollments.values()) {
      if (sameSecret(e.hash, h)) { enr = e; break; }
    }
    if (!enr || enr.used_at || enr.expires_at <= new Date()) return null;
    enr.used_at = new Date(); enr.agent_id = agentId;
    const finalLabel = label || enr.label || agentId;
    const cred = await this.issue(enr.account_id, 'provider_token', finalLabel, { boundAgentId: agentId });
    const rotated = [];
    for (const c of this.creds.values()) {
      if (c.account_id === enr.account_id && c.kind === 'provider_token' && c.bound_agent_id === agentId
          && !c.revoked_at && c.id !== cred.id) { c.revoked_at = new Date(); rotated.push(c.id); }
    }
    enr.credential_id = cred.id;
    return { credentialId: cred.id, secret: cred.secret, accountId: enr.account_id, label: finalLabel, rotated };
  }

  async listEnrollments(accountId) {
    const now = new Date();
    return [...this.enrollments.values()]
      .filter((e) => e.account_id === accountId && !e.used_at && e.expires_at > now)
      .map(({ id, label, created_at, expires_at }) => ({ id, label, created_at, expires_at }));
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

  async findByLabel(accountId, label) {
    if (!accountId || typeof label !== 'string' || !label) return [];
    return [...this.creds.values()]
      .filter((c) => c.account_id === accountId && !c.revoked_at && c.label === label)
      .map(({ id, kind, label: l }) => ({ id, kind, label: l }));
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

  async markConnected(credentialId) {
    const c = this.creds.get(credentialId);
    if (!c) return;
    const now = new Date();
    c.first_connected_at = c.first_connected_at || now;
    c.last_connected_at = now;
  }

  async funnel(accountId = null) {
    const byCred = new Map();
    for (const e of this.enrollments.values()) if (e.credential_id) byCred.set(e.credential_id, e);
    const creds = [...this.creds.values()]
      .filter((c) => c.kind === 'provider_token' && (!accountId || c.account_id === accountId))
      .sort((a, b) => b.created_at - a.created_at)
      .map((c) => {
        const e = byCred.get(c.id);
        return { ...c, code_issued_at: e ? e.created_at : null, enrolled_at: e ? e.used_at : null };
      });
    const now = new Date();
    const pending = [...this.enrollments.values()]
      .filter((e) => !e.used_at && e.expires_at > now && (!accountId || e.account_id === accountId))
      .sort((a, b) => b.created_at - a.created_at);
    return shapeFunnel(creds, pending);
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
