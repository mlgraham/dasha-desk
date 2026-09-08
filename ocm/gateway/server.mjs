/**
 * OCM gateway.
 *
 * Consumers speak the OpenAI chat-completions API. Hosts hold a persistent outbound
 * WebSocket and never accept inbound connections — that asymmetry is the core design
 * decision (docs/ARCHITECTURE.md) and everything here follows from it.
 *
 * Responsibilities, per the PDF's component table: TLS/key auth (TLS terminates
 * upstream), socket registry, request framing and streaming, host selection with
 * failover before first token, and gateway-side metering.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { accept } from './ws.mjs';
import { Ledger } from './ledger.mjs';
import { createMailer, recoveryMessage, maskEmail } from './mail.mjs';
import { stats, renderLanding, renderDashboard, renderNetwork, renderProviderGuide, renderSecret, renderRecoverForm, renderRecoverConfirm, renderRecoverInvalid, renderEnrollment, renderStatus } from './console.mjs';
import { issueSession, readSession, cookieHeader, clearCookieHeader, readCookie, parseForm } from './session.mjs';
import { AccountExistsError, MemoryAccounts, normalizeEmail } from './accounts.mjs';
import { normalizeProviderAgent } from './provider.mjs';

const HEARTBEAT_MS = 30_000;
const HOST_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 120_000;
// A cold MLX host spends ~75s loading a 7B-4bit model before its first token, so a
// 120s budget leaves barely 45s to generate in. Give a host we have no evidence is
// warm a longer leash, rather than timing out a machine that is working correctly.
const COLD_JOB_TIMEOUT_MS = 300_000;
const MAX_ROUTE_ATTEMPTS = 3;
const MAX_COMPLETION_BYTES = 2 * 1024 * 1024;
// Public alias -> the local builds that satisfy it.
//
// A provider advertises whatever its runtime reports. An MLX host that never set
// OCM_MODEL_MAP advertises `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`, while
// every doc, example and console snippet tells consumers to ask for `ocm-coder` —
// so that provider was unreachable by the documented call and earned nothing.
// Fixing it only in the installer would leave every already-running host stranded
// and require someone with root on each machine. Resolving the alias here fixes
// them all at once, and the gateway still dispatches under the name the HOST
// advertises, so nothing is asked to serve a name it does not know.
const DEFAULT_MODEL_ALIASES = 'ocm-coder=mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';

export function parseAliases(spec) {
  const map = new Map();
  const publicByLocal = new Map();
  for (const rawPair of String(spec || '').split(',')) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const splitAt = pair.indexOf('=');
    if (splitAt <= 0 || splitAt === pair.length - 1) {
      throw new Error(`invalid model alias "${pair}"; expected public=local`);
    }
    const pub = pair.slice(0, splitAt).trim();
    const local = pair.slice(splitAt + 1).trim();
    if (!pub || !local) throw new Error(`invalid model alias "${pair}"; names may not be blank`);
    const existing = publicByLocal.get(local);
    if (existing && existing !== pub) {
      throw new Error(`ambiguous model alias: ${local} is mapped by both ${existing} and ${pub}`);
    }
    publicByLocal.set(local, pub);
    if (!map.has(pub)) map.set(pub, []);
    if (!map.get(pub).includes(local)) map.get(pub).push(local);
  }
  return map;
}

// How long after serving a model we still believe a host has it resident.
const WARM_TTL_MS = 20 * 60_000;
// MLX serialises on the GPU, so piling work on one host only grows latency. Past
// this we would rather warm a second host than queue deeper on a fast one.
const MAX_INFLIGHT_PER_HOST = 2;

// The agent and its installer are served from the gateway so a provider fetches
// exactly the code this deployment expects, rather than a version drifting in a repo.
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent');
/**
 * SHA-256 of the installer we are actually serving, computed from the bytes on disk
 * rather than a build artifact, so the published hash cannot drift from the file.
 * Cached by mtime: the file only changes on deploy.
 */
let _installHash = null;
async function installSha256() {
  try {
    const path = join(AGENT_DIR, 'install.sh');
    const { mtimeMs, size } = await stat(path);
    if (_installHash && _installHash.mtimeMs === mtimeMs && _installHash.size === size) {
      return _installHash.hex;
    }
    const hex = createHash('sha256').update(await readFile(path)).digest('hex');
    _installHash = { mtimeMs, size, hex };
    return hex;
  } catch {
    return null;   // never let a missing file take the page down
  }
}

const DOWNLOADS = {
  '/agent.py': { file: 'agent.py', type: 'text/x-python; charset=utf-8' },
  '/install.sh': { file: 'install.sh', type: 'text/x-shellscript; charset=utf-8' },
};

/**
 * Gateway-side token count.
 *
 * DELIBERATELY APPROXIMATE, and the only number the ledger trusts — the host's own
 * count is never used, because a host is untrusted (PDF §04). Before anything is
 * billed for money this must be replaced with the model's real tokenizer; the
 * architecture is what is being proven here, not the arithmetic.
 */
export function countTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

class Registry {
  constructor(aliases = new Map()) { this.hosts = new Map(); this.aliases = aliases; }

  /**
   * The name to put on the wire for this host, or null if it cannot serve the model.
   * A host that advertises the requested name gets it verbatim; otherwise we send the
   * local build it actually advertises, so the alias never reaches a runtime that
   * would try to load a model by that name and fail.
   */
  wireName(host, model) {
    if (host.models.has(model)) return model;
    for (const local of this.aliases.get(model) || []) {
      if (host.models.has(local)) return local;
    }
    return null;
  }

  /**
   * Register or reconnect one authenticated provider identity.
   *
   * The user-chosen host id is namespaced by the issuing account. Another account
   * must never replace it, because credits and operational history are keyed by that
   * id. A same-account reconnect is legitimate: install/reboot/network recovery all
   * reuse OCM_AGENT_ID. Existing in-flight jobs fail before the socket is replaced,
   * and the old socket cannot mutate the new registration afterwards.
   */
  add(hostId, conn, caps, credentialId = null) {
    const existing = this.hosts.get(hostId);
    const currentOwner = existing?.caps.accountId || null;
    const nextOwner = caps.accountId || null;
    if (existing && currentOwner !== nextOwner) {
      return { ok: false, error: 'host id already belongs to another provider account' };
    }

    const oldJobs = existing ? [...existing.inflight.values()] : [];
    const host = {
      id: hostId,
      conn,
      caps,
      credentialId,
      models: new Set(caps.models || []),
      inflight: new Map(),
      // Preserve useful cache evidence across an authenticated reconnect by the same
      // account, but never across an account boundary.
      warm: existing ? new Map(existing.warm) : new Map(),
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    };
    this.hosts.set(hostId, host);

    if (existing && existing.conn !== conn) {
      for (const job of oldJobs) {
        Promise.resolve(job.onError('provider reconnected')).catch(() => {});
      }
      existing.conn.close(1001, 'replaced by authenticated reconnect');
    }
    return { ok: true, host, replaced: !!existing };
  }

  remove(hostId) { this.hosts.delete(hostId); }
  get(hostId) { return this.hosts.get(hostId); }
  online() { return [...this.hosts.values()]; }

  /** Is this host known to have the exact wire model loaded right now? */
  isWarm(host, wireModel) { return (host.warm.get(wireModel) || 0) > Date.now() - WARM_TTL_MS; }

  /**
   * Choose a host for a model.
   *
   * Inflight count alone is not enough once hosts differ in speed: a COLD host with
   * nothing to do outranks a warm one with a single job, and the consumer waits 75s
   * for a model load while a machine that could have answered in a second sits
   * nearly idle. So rank by warmth first.
   *
   * The tension is that preferring warm hosts forever would starve every new
   * provider — a cold machine never gets the request that would warm it, so it never
   * earns. The cap resolves it: warm hosts take work until they are saturated, and
   * the next request goes to a cold host, which warms up and then competes on equal
   * terms. Deep queueing is the last resort rather than the default.
   *
   *   0  warm, under the cap      — fast, and has room
   *   1  cold, under the cap      — slow once, then it is warm and useful
   *   2  saturated                — queue only when there is nowhere better
   */
  pick(model, exclude = new Set()) {
    const fresh = Date.now() - HOST_TIMEOUT_MS;
    const candidates = this.online().filter((h) =>
      !exclude.has(h.id) && h.lastSeen > fresh && !h.conn.closed && this.wireName(h, model));
    if (!candidates.length) return null;
    const rank = (h) => {
      if (h.inflight.size >= MAX_INFLIGHT_PER_HOST) return 2;
      return this.isWarm(h, this.wireName(h, model)) ? 0 : 1;
    };
    candidates.sort((a, b) => rank(a) - rank(b) || a.inflight.size - b.inflight.size);
    return candidates[0];
  }

  /**
   * What consumers may ask for. A host advertising a local build that an alias
   * covers is published under the PUBLIC name, so the catalogue matches the docs
   * rather than exposing whichever raw id a provider happened to configure.
   */
  models() {
    const publicOf = new Map();
    for (const [pub, locals] of this.aliases) for (const l of locals) publicOf.set(l, pub);
    const all = new Set();
    for (const h of this.online()) for (const m of h.models) all.add(publicOf.get(m) || m);
    return [...all].sort();
  }
}

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const apiError = (res, code, message, type = 'invalid_request_error') =>
  json(res, code, { error: { message, type } });

const html = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8',
                        'cache-control': 'no-store',
                        'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };

const readBody = (req, limit = 2 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const parts = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  req.on('error', reject);
});

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

/** Public health must never echo a database hostname, user, path, or driver error. */
export function publicAccountingHealth(ledger) {
  const health = ledger.health?.() || { ok: true };
  return { ok: health.ok !== false };
}

export async function createGateway({
  inviteCode = process.env.OCM_INVITE_CODE || '',
  sessionSecret = process.env.OCM_SESSION_SECRET || process.env.OCM_ADMIN_TOKEN || 'dev-session-secret',
  secureCookies = process.env.OCM_INSECURE_COOKIES !== '1',
  adminToken = process.env.OCM_ADMIN_TOKEN || '',
  // Console accounts allowed to see the network-wide view. Comma-separated emails;
  // empty means nobody, which is the safe default for a page that lists every user.
  adminEmails = process.env.OCM_ADMIN_EMAILS || '',
  modelAliases = process.env.OCM_MODEL_ALIASES ?? DEFAULT_MODEL_ALIASES,
  // A tool pointed at us with only the two env vars sends its own model string
  // ('gpt-4o', 'claude-...'), which we do not serve, and got a 503. That defeats
  // "works unmodified", which is the distribution strategy. Unknown names now fall
  // back to this, and the response says what actually served so the substitution is
  // never silent. Set to '' to restore strict matching.
  defaultModel = process.env.OCM_DEFAULT_MODEL ?? 'ocm-coder',
  databaseUrl = process.env.DATABASE_URL || '',
  consoleHost = process.env.OCM_CONSOLE_HOST || 'ocm.getdasha.com',
  apiHost = process.env.OCM_API_HOST || 'api.ocm.getdasha.com',
  keys = null,
  ledgerPath = 'ocm/.data/usage.jsonl',
  grantTokens = Number(process.env.OCM_GRANT_TOKENS || 1_000_000),
  // Account recovery by email ships dark: the form, the link and the routes exist only
  // when this is on. Off until Amazon grants production sending, because in the SES
  // sandbox an unverified address silently receives nothing.
  recoveryEnabled = process.env.OCM_RECOVERY_ENABLED === '1',
  // Tests inject a stub; production builds the SES client on first send.
  mailer = null,
} = {}) {
  const mail = mailer || (recoveryEnabled ? createMailer() : null);
  const registry = new Registry(parseAliases(modelAliases));
  const admins = new Set(String(adminEmails).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isAdmin = (account) => !!account && admins.has(account.email.toLowerCase());
  // Postgres when DATABASE_URL is set, JSONL otherwise. Same async interface, so
  // nothing below this line knows which store it has. The pg import is dynamic on
  // purpose: local runs and the test suite stay dependency-free, which is a property
  // worth keeping — the socket handling should be readable without a node_modules.
  let ledger;
  if (databaseUrl) {
    const { PgLedger } = await import('./pg-ledger.mjs');
    ledger = new PgLedger(databaseUrl);
  } else {
    ledger = new Ledger(ledgerPath);
  }
  await ledger.init();

  // Accounts: Postgres-backed in production, in-memory for tests. Credentials are
  // stored only as SHA-256 hashes and are account-bound and revocable.
  let accounts;
  if (databaseUrl) {
    const { PgAccounts } = await import('./accounts.mjs');
    accounts = new PgAccounts(ledger.pool);
  } else {
    accounts = new MemoryAccounts();
  }
  await accounts.init();

  const sockets = new Set();   // every live host socket, registered or not

  // Bootstrap developer key, for first-run only. Empty unless explicitly set, for
  // the same reason the shared host token was removed: real callers hold issued,
  // revocable, account-bound credentials.
  const consumers = keys
    || (process.env.OCM_API_KEY ? new Map([[process.env.OCM_API_KEY, 'dev']]) : new Map());
  for (const consumer of new Set(consumers.values())) {
    if ((await ledger.balance(consumer)) <= 0) await ledger.grant(consumer, grantTokens, 'alpha grant');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const reqHost = (req.headers.host || '').split(':')[0].toLowerCase();
    try {
      // The console shares the gateway's ALB target group and is selected by Host
      // header, so it needs no infrastructure of its own. /console works on any
      // hostname, which is what makes it testable locally.
      // ---- console -------------------------------------------------------
      const onConsole = reqHost === consoleHost.toLowerCase() || url.pathname.startsWith('/console');
      const consolePath = url.pathname.replace(/^\/console/, '') || '/';

      if (onConsole) {
        // A session is only as valid as the credential that opened it: revoking a
        // key must sign out its browser session too, or "revoked" means one thing
        // for the API and something weaker for the console.
        const claim = readSession(sessionSecret, readCookie(req.headers.cookie));
        let account = null;
        if (claim && await accounts.credentialActive(claim.credentialId)) {
          account = await accounts.accountFor(claim.accountId);
        } else if (claim) {
          res.setHeader('set-cookie', clearCookieHeader());
        }

        if (req.method === 'GET' && consolePath === '/') {
          return account
            ? html(res, 200, await renderDashboard({ registry, ledger, accounts, account, apiHost,
                admin: isAdmin(account),
                redeemed: (await ledger.grantCount(account.id)) > 0,
                inviteRequired: !!inviteCode,
                notice: url.searchParams.get('notice'),
                error: url.searchParams.get('error') }))
            : html(res, 200, renderLanding({ inviteRequired: !!inviteCode, recoveryEnabled,
                error: url.searchParams.get('error') }));
        }

        // Counters. This used to be open, and returned every account id with its
        // balance, the host->owner mapping, and a rolling per-job log naming which
        // consumer ran which model where — cross-account activity telemetry to
        // anyone with the URL. It is now session-gated and scoped: an admin sees
        // the network, and everyone else sees their own usage against anonymous
        // hosts. `/v1/network` remains public, but carries no account identity.
        if (req.method === 'GET' && consolePath === '/stats.json') {
          if (!account) return apiError(res, 401, 'sign in to read stats', 'authentication_error');
          const full = await stats(registry, ledger);
          if (isAdmin(account)) return json(res, 200, full);
          return json(res, 200, {
            hosts: full.hosts.map(({ accountId, ...h }) => ({ ...h, mine: accountId === account.id })),
            consumers: full.consumers.filter((c) => c.consumer === account.id),
            totals: full.totals,
            recent: full.recent.filter((r) => r.consumer === account.id),
          });
        }

        if (req.method === 'GET' && consolePath === '/provider') {
          // Readable signed out on purpose: it is the link prospects are sent, it
          // contains no account data, and it is the best recruiting asset we have.
          return html(res, 200, renderProviderGuide({
            account, apiHost, models: registry.models(), admin: isAdmin(account),
            installHash: await installSha256(),
          }));
        }

        // Public status: providers online and tokens served, with no account
        // identity anywhere on the page. `/status` on the console host resolves
        // here too, since anything on that host is a console path.
        if (req.method === 'GET' && consolePath === '/status') {
          return html(res, 200, await renderStatus({ registry, ledger }));
        }

        // Network-wide view: every host, account and consumer. Admins only — the
        // page is a user list, so a non-admin gets the same redirect as a stranger
        // rather than a hint that the page exists.
        if (req.method === 'GET' && consolePath === '/network') {
          if (!isAdmin(account)) return redirect(res, '/');
          return html(res, 200, await renderNetwork({ registry, ledger, accounts, account }));
        }

        if (req.method === 'POST' && consolePath === '/signup') {
          const f = parseForm(await readBody(req));
          if (!f.email) return redirect(res, '/?error=' + encodeURIComponent('An email address is required.'));
          // Signup must NEVER authenticate an existing email. Accounts are keyed by
          // email, so without this an unauthenticated visitor who types someone
          // else's address is handed a live session and a working key on that
          // account — takeover by address alone. An existing email is turned away
          // here, before any credential is issued or cookie set; recovering access
          // requires the account's developer key (or, later, an emailed link).
          if (await accounts.accountByEmail(f.email)) {
            return redirect(res, '/?error=' + encodeURIComponent(
              'An account with that email already exists. Sign in with your developer key.'));
          }
          // Signup is open. The invite code buys TOKENS, not entry — a wrong code is
          // still refused outright, because silently creating a useless account
          // would leave someone wondering why nothing works.
          const offered = (f.invite || '').trim();
          if (offered && inviteCode && offered !== inviteCode) {
            return redirect(res, '/?error=' + encodeURIComponent('That invite code is not valid.'));
          }
          let acct;
          try {
            acct = await accounts.createAccount(f.email);
          } catch (err) {
            if (err instanceof AccountExistsError || err?.code === 'ACCOUNT_EXISTS') {
              return redirect(res, '/?error=' + encodeURIComponent(
                'An account cannot be created with those details. Sign in with an existing developer key.'));
            }
            throw err;
          }
          const granted = offered && (!inviteCode || offered === inviteCode)
            && (await ledger.grantCount(acct.id)) === 0;
          if (granted) await ledger.grant(acct.id, grantTokens, 'invite grant');
          const cred = await accounts.issue(acct.id, 'developer_key', 'first key');
          res.setHeader('set-cookie',
            cookieHeader(issueSession(sessionSecret, acct.id, cred.id), { secure: secureCookies }));
          return html(res, 200, renderSecret({
            title: 'Your developer key',
            secret: cred.secret,
            whatNext: `<p>Point any OpenAI client at the gateway:</p>
<pre>export OPENAI_BASE_URL="https://${apiHost}/v1"
export OPENAI_API_KEY="${cred.secret}"</pre>
${granted
  ? `<p class="muted">You have ${grantTokens.toLocaleString('en-US')} granted tokens. These are credits, not money.</p>`
  : `<div class="note warn"><strong>Your balance is zero.</strong> The account exists and
     the key is valid, but API requests will be refused until you redeem an invite code —
     you can do that from the console at any time.</div>`}
<div class="note"><strong>Want to contribute a Mac instead?</strong> Running a provider
needs no invite code: your machine earns credits as it serves. See
<a href="/provider">Run a provider</a>.</div>`,
          }));
        }

        // ---- account recovery by email ---------------------------------------
        // The request form always answers the same way, so it is not an oracle for
        // which addresses have accounts. The emailed link opens a page that only mints
        // a key on an explicit POST; the token is single-use and expires.
        if (consolePath === '/recover' || consolePath === '/recover/confirm') {
          if (!recoveryEnabled) return apiError(res, 404, 'account recovery is not enabled on this deployment');
        }
        if (req.method === 'GET' && consolePath === '/recover') {
          return html(res, 200, renderRecoverForm({ sent: url.searchParams.get('sent') === '1' }));
        }
        if (req.method === 'POST' && consolePath === '/recover') {
          const f = parseForm(await readBody(req));
          let email = null;
          try { email = normalizeEmail(f.email); } catch { email = null; }
          const acct = email ? await accounts.accountByEmail(email) : null;
          // Cap outstanding links per account: a stranger typing an address in a loop
          // must not be able to fill someone's inbox.
          if (acct && mail && (await accounts.openRecoveries(acct.id)) < 3) {
            const rec = await accounts.issueRecovery(acct.id);
            const link = `https://${consoleHost}/recover/confirm?t=${rec.token}`;
            mail.send({ to: acct.email, ...recoveryMessage({ link, consoleHost }) })
              .catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'recovery mail failed',
                accountId: acct.id, error: e.message })));
          }
          return redirect(res, '/recover?sent=1');
        }
        if (req.method === 'GET' && consolePath === '/recover/confirm') {
          const t = url.searchParams.get('t') || '';
          const live = /^ocm_recover_[-A-Za-z0-9_]{16,}$/.test(t) ? await accounts.peekRecovery(t) : null;
          if (!live) return html(res, 400, renderRecoverInvalid());
          const acct = await accounts.accountFor(live.accountId);
          return html(res, 200, renderRecoverConfirm({ token: t, emailMasked: maskEmail(acct ? acct.email : '') }));
        }
        if (req.method === 'POST' && consolePath === '/recover/confirm') {
          const f = parseForm(await readBody(req));
          const t = f.t || '';
          const used = /^ocm_recover_[-A-Za-z0-9_]{16,}$/.test(t) ? await accounts.redeemRecovery(t) : null;
          if (!used) return html(res, 400, renderRecoverInvalid());
          const cred = await accounts.issue(used.accountId, 'developer_key',
            `recovered ${new Date().toISOString().slice(0, 10)}`);
          await accounts.recordRecoveryCredential(used.recoveryId, cred.id);
          await accounts.markEmailVerified(used.accountId);
          console.error(JSON.stringify({ level: 'info', msg: 'account recovered', accountId: used.accountId }));
          res.setHeader('set-cookie',
            cookieHeader(issueSession(sessionSecret, used.accountId, cred.id), { secure: secureCookies }));
          return html(res, 200, renderSecret({
            title: 'Your new developer key',
            secret: cred.secret,
            whatNext: `<p>Your existing keys are unchanged; revoke any you no longer hold from the console.
You are signed in with this one.</p>`,
          }));
        }

        if (req.method === 'POST' && consolePath === '/signin') {
          const f = parseForm(await readBody(req));
          const found = await accounts.resolve(f.key, 'developer_key');
          if (!found) return redirect(res, '/?error=' + encodeURIComponent('That key is not valid, or has been revoked.'));
          res.setHeader('set-cookie',
            cookieHeader(issueSession(sessionSecret, found.accountId, found.credentialId), { secure: secureCookies }));
          return redirect(res, '/');
        }

        if (req.method === 'POST' && consolePath === '/signout') {
          res.setHeader('set-cookie', clearCookieHeader());
          return redirect(res, '/');
        }

        if (req.method === 'POST' && consolePath === '/redeem') {
          if (!account) return redirect(res, '/');
          const f = parseForm(await readBody(req));
          const offered = (f.invite || '').trim();
          if (!offered) return redirect(res, '/?error=' + encodeURIComponent('Enter an invite code.'));
          if (inviteCode && offered !== inviteCode) {
            return redirect(res, '/?error=' + encodeURIComponent('That invite code is not valid.'));
          }
          // One redemption per account, decided by the ledger rather than a flag that
          // could drift away from it.
          if ((await ledger.grantCount(account.id)) > 0) {
            return redirect(res, '/?error=' + encodeURIComponent('This account has already redeemed a code.'));
          }
          await ledger.grant(account.id, grantTokens, 'invite grant');
          return redirect(res, '/?notice=' + encodeURIComponent(
            `${grantTokens.toLocaleString('en-US')} tokens added.`));
        }

        if (req.method === 'POST' && consolePath === '/keys/new') {
          if (!account) return redirect(res, '/');
          const f = parseForm(await readBody(req));
          const kind = f.kind === 'provider_token' ? 'provider_token' : 'developer_key';
          const cred = await accounts.issue(account.id, kind, f.label || null);
          const isProvider = kind === 'provider_token';
          // The label the person just typed is the obvious name for the machine, so
          // put it in the command as OCM_AGENT_ID. Without it the installer falls
          // back to `hostname -s`, and a household with three Macs all called
          // Jonathans-MacBook-Air registers duplicates. Slugged, not escaped: the
          // result is [a-z0-9-] only, so it cannot break out of the quotes.
          const agentId = (f.label || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
          return html(res, 200, renderSecret({
            title: isProvider ? 'Your provider token' : 'Your developer key',
            secret: cred.secret,
            whatNext: isProvider
              ? `<p>This token is shown once. Do not put it on a command line — it would
appear in shell history and the process list.</p>
<p>Install the agent on the Mac you want to contribute:</p>
<pre>read -rsp "Provider token: " OCM_HOST_TOKEN
printf '\\n'
sudo --preserve-env=OCM_HOST_TOKEN${agentId ? ` OCM_AGENT_ID="${agentId}"` : ''} sh install.sh</pre>
${agentId ? `<p class="muted">Keep <code>OCM_AGENT_ID</code> the same on every reinstall of this
machine — a different name registers a second provider instead of recovering this one.</p>` : ''}
<p class="muted">See <a href="/provider">Run a provider</a> for the full guide.</p>`
              : `<pre>export OPENAI_BASE_URL="https://${apiHost}/v1"
export OPENAI_API_KEY="${cred.secret}"</pre>`,
          }));
        }

        if (req.method === 'POST' && consolePath === '/enroll') {
          if (!account) return redirect(res, '/');
          const f = parseForm(await readBody(req));
          const label = (f.label || '').slice(0, 64) || null;
          const enr = await accounts.issueEnrollment(account.id, label);
          // Same slug rule as /keys/new: [a-z0-9-] only, so it cannot break out of quotes.
          const agentId = (label || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
          return html(res, 200, renderEnrollment({ code: enr.code, label, agentId,
                                                   expiresAt: enr.expires_at, apiHost }));
        }
        if (req.method === 'POST' && consolePath === '/keys/rebind') {
          if (!account) return redirect(res, '/');
          const f = parseForm(await readBody(req));
          // Scoped to the signed-in account, so one person cannot free another's token.
          const ok = await accounts.rebind(f.credential_id, account.id);
          return redirect(res, '/?notice=' + encodeURIComponent(ok
            ? 'Token released. The next machine to present it will claim it.'
            : 'That credential could not be released.'));
        }

        if (req.method === 'POST' && consolePath === '/keys/revoke') {
          if (!account) return redirect(res, '/');
          const f = parseForm(await readBody(req));
          const creds = await accounts.listCredentials(account.id);
          // Only ever revoke a credential the signed-in account actually owns.
          if (!creds.some((c) => c.id === f.credential_id)) return redirect(res, '/');
          await accounts.revoke(f.credential_id);
          if (claim && f.credential_id === claim.credentialId) {
            res.setHeader('set-cookie', clearCookieHeader());
          }
          return redirect(res, '/?notice=' + encodeURIComponent('Credential revoked.'));
        }
      }
      if (url.pathname.startsWith('/admin/')) {
        if (!adminToken || !bearer(req) || bearer(req) !== adminToken) {
          return apiError(res, 401, 'admin token required', 'authentication_error');
        }
        if (req.method === 'POST' && url.pathname === '/admin/accounts') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!body.email) return apiError(res, 400, 'email is required');
          const acct = await accounts.createAccount(body.email);
          // A new account starts with granted balance, recorded in the ledger like
          // any other entry. Without this the first request 402s on an empty balance.
          if ((await ledger.balance(acct.id)) <= 0) {
            await ledger.grant(acct.id, grantTokens, 'alpha grant');
          }
          return json(res, 200, { ...acct, granted_tokens: grantTokens });
        }
        if (req.method === 'POST' && url.pathname === '/admin/credentials') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!body.account_id || !body.kind) return apiError(res, 400, 'account_id and kind are required');
          if (!['developer_key', 'provider_token'].includes(body.kind)) {
            return apiError(res, 400, 'kind must be developer_key or provider_token');
          }
          // The plaintext appears here and nowhere else, ever.
          return json(res, 200, await accounts.issue(body.account_id, body.kind, body.label || null));
        }
        if (req.method === 'POST' && url.pathname === '/admin/enroll') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!body.account_id) return apiError(res, 400, 'account_id is required');
          const minutes = Number(body.ttl_minutes);
          const ttl = minutes > 0 ? Math.min(minutes, 60) * 60 * 1000 : undefined;
          // The code appears here and nowhere else.
          return json(res, 200, await accounts.issueEnrollment(body.account_id, body.label || null, ttl));
        }
        if (req.method === 'POST' && url.pathname === '/admin/revoke') {
          const body = JSON.parse(await readBody(req) || '{}');
          // Revoke by id. A label is accepted only as an exact, whole-string match
          // scoped to one account, and only when it identifies exactly one live
          // credential: labels are free text, so `mac` is a prefix of `mac-2` and a
          // looser match would revoke the token a machine is actively using.
          let id = body.credential_id;
          if (!id && body.label !== undefined) {
            if (!body.account_id) return apiError(res, 400, 'label lookup requires account_id');
            const matches = await accounts.findByLabel(body.account_id, body.label);
            if (matches.length === 0) return apiError(res, 404, 'no live credential has exactly that label');
            if (matches.length > 1) {
              return apiError(res, 409, `${matches.length} live credentials share that label; revoke by credential_id`);
            }
            id = matches[0].id;
          }
          if (!id) return apiError(res, 400, 'credential_id is required');
          return json(res, 200, { revoked: await accounts.revoke(id), credential_id: id });
        }
        return apiError(res, 404, `no admin route for ${req.method} ${url.pathname}`);
      }
      if (req.method === 'GET' && url.pathname === '/install.sh.sha256') {
        const hash = await installSha256();
        if (!hash) return apiError(res, 404, 'installer not available');
        // `shasum -a 256` output shape, so it can be piped straight into `shasum -c`.
        const body = `${hash}  install.sh\n`;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8',
                             'cache-control': 'no-cache',
                             'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (req.method === 'GET' && DOWNLOADS[url.pathname]) {
        const { file, type } = DOWNLOADS[url.pathname];
        try {
          const body = await readFile(join(AGENT_DIR, file));
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache',
                               'content-length': body.length });
          return res.end(body);
        } catch {
          return apiError(res, 404, `${url.pathname} is not available on this deployment`);
        }
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const accounting = publicAccountingHealth(ledger);
        return json(res, accounting.ok ? 200 : 503, {
          ok: accounting.ok,
          service: 'ocm-gateway',
          hosts: registry.online().length,
          accounting,
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: registry.models().map((id) => ({ id, object: 'model', owned_by: 'ocm' })),
        });
      }
      // Check a provider token WITHOUT opening a socket. The installer and the
      // agent's --doctor both call this. Header auth is mandatory on this public
      // HTTP route; provider credentials are never accepted from a URL.
      if (req.method === 'GET' && url.pathname === '/v1/provider/verify') {
        const presented = bearer(req);
        if (!presented) {
          return apiError(res, 401, 'no provider token presented — set OCM_HOST_TOKEN', 'authentication_error');
        }
        if (/^ocm_live_/.test(presented)) {
          return apiError(res, 401,
            'that is a developer key, not a provider token. Provider tokens start with ocm_host_ and are issued from the console under New provider token.',
            'authentication_error');
        }
        if (/^ocm_enroll_/.test(presented)) {
          return apiError(res, 401,
            'that is an enrollment code, not a provider token. The installer exchanges it for one: paste it at the installer prompt.',
            'authentication_error');
        }
        const found = await accounts.resolve(presented, 'provider_token');
        if (!found) {
          return apiError(res, 401,
            'this provider token is not recognised — it may have been revoked, or issued against a different deployment. Issue a new one from the console.',
            'authentication_error');
        }
        const acct = await accounts.accountFor(found.accountId);
        return json(res, 200, { ok: true, account_id: found.accountId, email: acct ? acct.email : null });
      }
      // Exchange a single-use enrollment code for a provider token bound to this
      // machine. The code is the credential, so there is no auth header; unknown,
      // used and expired are one answer on purpose (no oracle). The token appears in
      // this response and nowhere else, ever.
      if (req.method === 'POST' && url.pathname === '/v1/provider/enroll') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); }
        catch { return apiError(res, 400, 'body must be JSON'); }
        const code = typeof body.code === 'string' ? body.code : '';
        const agentId = typeof body.agent_id === 'string' ? body.agent_id : '';
        const label = typeof body.label === 'string' && body.label ? body.label.slice(0, 64) : null;
        if (!/^ocm_enroll_[-A-Za-z0-9_]{16,}$/.test(code)) {
          return apiError(res, 400, 'code must be an enrollment code beginning ocm_enroll_');
        }
        if (!/^[-A-Za-z0-9._]{1,64}$/.test(agentId)) {
          return apiError(res, 400, 'agent_id may contain only letters, numbers, dot, underscore and hyphen (64 max)');
        }
        const issued = await accounts.redeemEnrollment(code, agentId, label);
        if (!issued) {
          return apiError(res, 401, 'enrollment code is not valid: unknown, already used, or expired', 'authentication_error');
        }
        console.error(JSON.stringify({ level: 'info', msg: 'provider enrolled',
          accountId: issued.accountId, agentId, rotated: issued.rotated.length }));
        return json(res, 200, { ok: true, token: issued.secret, agent_id: agentId,
                                label: issued.label, rotated: issued.rotated.length });
      }
      if (req.method === 'GET' && url.pathname === '/v1/network') {
        return json(res, 200, {
          hosts: registry.online().map((h) => ({
            id: h.id, chip: h.caps.chip, memory_gb: h.caps.memory_gb,
            region: h.caps.region, models: [...h.models],
            // Public, and carries no account identity: whether this host will answer
            // in about a second or has to load a model first.
            warm: [...h.warm.keys()].some((m) => registry.isWarm(h, m)),
            inflight: h.inflight.size, uptime_s: Math.round((Date.now() - h.connectedAt) / 1000),
          })),
          models: registry.models(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await handleChat(req, res);
      }
      return apiError(res, 404, `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      return apiError(res, 500, err.message, 'internal_error');
    }
  });

  /**
   * Resolve a developer key to a ledger consumer.
   * Account credentials win; the bootstrap env key is still accepted so the running
   * system keeps working while credentials are migrated. Retire the legacy path once
   * every caller holds an account key.
   */
  async function resolveConsumer(key) {
    const found = await accounts.resolve(key, 'developer_key');
    if (found) return found.accountId;
    return consumers.get(key) || null;
  }

  async function handleChat(req, res) {
    const key = bearer(req);
    const consumer = await resolveConsumer(key);
    if (!consumer) return apiError(res, 401, 'invalid api key', 'authentication_error');
    if ((await ledger.balance(consumer)) <= 0) {
      const fresh = (await ledger.grantCount(consumer)) === 0;
      return apiError(res, 402, fresh
        ? `this account has no granted balance — redeem an invite code at https://${consoleHost}`
        : 'balance exhausted', 'insufficient_quota');
    }

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return apiError(res, 400, 'body must be JSON'); }

    const { model, messages, stream = false } = body || {};
    if (!model) return apiError(res, 400, 'model is required');
    if (!Array.isArray(messages) || !messages.length) return apiError(res, 400, 'messages must be a non-empty array');

    // Resolve what will actually serve this request. Asking for something we have is
    // unchanged; asking for something we do not falls back, and is disclosed below.
    let served = model;
    let substituted = false;
    if (!registry.pick(model) && defaultModel && registry.pick(defaultModel)) {
      served = defaultModel;
      substituted = true;
    }

    const promptTokens = countTokens(messages.map((m) => m?.content || '').join('\n'));
    const jobId = randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const chatId = `chatcmpl-${jobId.slice(0, 12)}`;
    const tried = new Set();

    // Failover applies only before the first token: once bytes have shipped the
    // client has a partial answer and re-running would duplicate it (PDF §03).
    for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
      const host = registry.pick(served, tried);
      if (!host) {
        const available = registry.models();
        return apiError(res, 503, tried.size
          ? `no healthy host for model ${served} after ${tried.size} attempt(s)`
          : `no host currently serving model ${model}. Available: ${available.join(', ') || 'none'}`,
          'service_unavailable');
      }
      tried.add(host.id);
      // The response carries the model that served, never an echo of the request.
      // Silent substitution is the fastest way to become untrustworthy.
      if (substituted && !res.headersSent) res.setHeader('x-ocm-served-model', served);
      const outcome = await runJob({ host, jobId, model: served, messages, stream, res, chatId, created, consumer, promptTokens });
      if (outcome.ok || outcome.committed || outcome.aborted || res.destroyed || res.writableEnded) return;
      // else: nothing was delivered to the client — safe to try another host
    }
    if (!res.headersSent) apiError(res, 503, 'all candidate hosts failed', 'service_unavailable');
  }

  /**
   * Run one job on one host.
   *
   * `committed` means bytes have actually been written to the CLIENT — not that the
   * host sent tokens. Only that makes retrying unsafe, and only that is billable:
   * "a host dropping before first token is retried elsewhere; one dropping
   * mid-stream bills only what shipped" (PDF §03). For a non-streaming request
   * nothing is committed until the final JSON, so a host dying mid-generation is
   * transparently retried and never billed.
   */
  function runJob({ host, jobId, model, messages, stream, res, chatId, created, consumer, promptTokens }) {
    return new Promise((resolve) => {
      let committed = false;   // bytes written to the client
      let text = '';           // what we have delivered (streaming) or accumulated
      let textBytes = 0;
      let state = 'open';      // open -> settling -> settled
      const wireModel = registry.wireName(host, model) || model;

      const cleanup = () => {
        clearTimeout(timer);
        host.inflight.delete(jobId);
        res.off('close', onClientGone);
      };

      // Claim before the first await. Duplicate done/error/close/timeout paths then
      // observe `settling` and cannot all enter ledger.clear or finalize a response.
      const claimSettlement = () => {
        if (state !== 'open') return false;
        state = 'settling';
        cleanup();
        return true;
      };

      const finish = (result) => {
        if (state === 'settled') return;
        state = 'settled';
        cleanup();
        resolve(result);
      };

      // Bill only what reached the client, and only ever the gateway's own count.
      // The ledgers are idempotent by jobId and mark accounting unhealthy on a
      // write/database failure, which makes subsequent balance checks fail closed.
      const meter = async () => {
        const completionTokens = countTokens(text);
        try {
          await ledger.clear({ consumer, host: host.id, model, promptTokens, completionTokens, jobId });
        } catch (err) {
          console.error(JSON.stringify({ level: 'error', msg: 'LEDGER WRITE FAILED — accounting disabled',
            jobId, consumer, host: host.id, completionTokens, error: String(err) }));
        }
        return completionTokens;
      };

      const onClientGone = () => {
        if (state !== 'open') return;
        host.conn.sendJson({ t: 'cancel', id: jobId });
        const wasCommitted = committed;
        if (!claimSettlement()) return;
        if (!wasCommitted) return finish({ ok: false, committed: false, aborted: true });
        void meter().finally(() => finish({ ok: false, committed: true, aborted: true }));
      };

      const timer = setTimeout(() => {
        if (state !== 'open') return;
        host.conn.sendJson({ t: 'cancel', id: jobId });
        const wasCommitted = committed;
        if (!claimSettlement()) return;
        if (!wasCommitted) return finish({ ok: false, committed: false });
        void meter().finally(() => {
          try { res.end(); } catch {}
          finish({ ok: false, committed: true });
        });
      }, registry.isWarm(host, wireModel) ? JOB_TIMEOUT_MS : COLD_JOB_TIMEOUT_MS);

      host.inflight.set(jobId, {
        onChunk(delta) {
          if (state !== 'open') return;
          if (typeof delta !== 'string') {
            host.conn.close(1003, 'completion chunks must be text');
            return;
          }
          if (!delta) return;
          const bytes = Buffer.byteLength(delta);
          if (textBytes + bytes > MAX_COMPLETION_BYTES) {
            host.conn.close(1009, 'completion exceeds gateway limit');
            return;
          }
          textBytes += bytes;
          // First tokens are proof the exact wire model is resident. Public aliases
          // and raw build names therefore share the same warmth evidence.
          if (!text) host.warm.set(wireModel, Date.now());
          text += delta;
          if (!stream) return;   // non-stream commits nothing until the end
          if (!committed) {
            committed = true;
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
          }
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        },
        async onDone() {
          if (!claimSettlement()) return;
          if (stream) {
            if (!committed) {
              committed = true;
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            }
            const completionTokens = await meter();
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            void completionTokens;
          } else {
            const completionTokens = await meter();
            committed = true;
            json(res, 200, {
              id: chatId, object: 'chat.completion', created, model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens,
                       total_tokens: promptTokens + completionTokens },
            });
          }
          finish({ ok: true, committed: true });
        },
        async onError(message) {
          const wasCommitted = committed;
          if (!claimSettlement()) return;
          if (wasCommitted) {
            // Mid-stream failure: close the stream cleanly and bill what shipped.
            await meter();
            if (stream) { res.write('data: [DONE]\n\n'); res.end(); }
            finish({ ok: false, committed: true });
          } else {
            // Nothing delivered: no bill, and handleChat may retry elsewhere.
            finish({ ok: false, committed: false, message });
          }
        },
      });

      res.on('close', onClientGone);

      const sent = host.conn.sendJson({
        t: 'job', id: jobId, model: wireModel, messages });
      if (sent === false && !committed && claimSettlement()) {
        finish({ ok: false, committed: false, message: 'host send failed' });
      }
    });
  }

  server.on('upgrade', async (req, socket) => {
    const url = new URL(req.url, 'http://gateway');
    if (url.pathname !== '/host/connect') { socket.destroy(); return; }
    // Header only. The query-string fallback existed so hosts running the pre-header
    // agent kept working during the migration; both live hosts are updated, so it is
    // gone. A credential in a URL is recorded verbatim by every proxy in the path.
    const presented = bearer(req);
    // Account-bound provider tokens only. The shared bootstrap token this used to
    // accept was a static credential that let any machine join; it was disabled in
    // production by stripping its env var, which is a deployment detail standing in
    // for a code guarantee. Now there is no such path to re-enable by accident.
    const owner = await accounts.resolve(presented, 'provider_token');
    if (!owner) {
      // A rejected provider was previously invisible here: the socket was closed
      // with no record, so "my Mac will not connect" had no server-side evidence
      // at all. Log the token's SHAPE — never the token — which is enough to tell
      // the common mistakes apart: a developer key used as a host token, an empty
      // OCM_HOST_TOKEN, or a real ocm_host token that is revoked or unknown.
      const shape = !presented ? 'absent'
        : /^ocm_host_/.test(presented) ? 'ocm_host (unknown or revoked)'
        : /^ocm_live_/.test(presented) ? 'ocm_live — a developer key, not a provider token'
        : 'unrecognised prefix';
      console.error(JSON.stringify({ level: 'warn', msg: 'provider socket rejected',
        token: shape, ua: req.headers['user-agent'] || null,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null }));
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const accountId = owner.accountId;
    const credentialId = owner.credentialId;
    const conn = accept(req, socket);
    if (!conn) return;
    sockets.add(conn);

    let hostId = null;
    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { conn.close(1007, 'provider messages must be valid JSON'); return; }

      if (!hostId) {
        if (msg?.t !== 'hello') {
          conn.close(1008, 'first provider message must be hello');
          return;
        }
        let agent;
        try { agent = normalizeProviderAgent(msg.agent); }
        catch (err) {
          console.error(JSON.stringify({ level: 'warn', msg: 'invalid provider hello',
            accountId, error: err.message }));
          conn.close(1008, 'invalid provider capabilities');
          return;
        }
        // A provider token binds to the first machine that presents it. Before this,
        // any token worked from any machine under any name, two machines could share
        // one undetected, and revoking "the token for that Mac" was convention only.
        // The agent id only arrives with hello, so this cannot happen at the upgrade.
        // The binding is persisted on the credential; the registry's account check
        // below is the in-memory half (one id cannot be taken by another account).
        Promise.resolve(accounts.claimAgent(credentialId, agent.id))
          .then((claim) => {
            if (conn.closed) return;
            if (!claim.ok) {
              console.error(JSON.stringify({ level: 'warn', msg: 'provider socket refused: token bound elsewhere',
                accountId, presented_as: agent.id, bound_to: claim.boundTo }));
              conn.sendJson({ t: 'error', message:
                `this provider token is bound to ${claim.boundTo}. Rebind it in the console ` +
                `under Credentials, or issue a token for this machine.` });
              conn.close(1008, 'token bound to another machine');
              return;
            }
            const registration = registry.add(agent.id, conn, { ...agent, accountId }, credentialId);
            if (!registration.ok) {
              console.error(JSON.stringify({ level: 'warn', msg: 'provider identity collision',
                accountId, hostId: agent.id }));
              conn.close(1008, 'provider id already in use');
              return;
            }
            hostId = agent.id;
            // Onboarding funnel: the first connect of this credential's machine is the
            // "connected" step. Recorded once, never overwritten; last-seen moves.
            if (typeof accounts.markConnected === 'function') {
              Promise.resolve(accounts.markConnected(credentialId))
                .catch((e) => console.error('markConnected', e));
            }
            conn.sendJson({ t: 'welcome', host_id: hostId, heartbeat_ms: HEARTBEAT_MS });
          })
          .catch((e) => { console.error('claimAgent', e); conn.close(1011, 'internal'); });
        return;
      }

      if (msg?.t === 'hello') {
        conn.close(1008, 'provider hello may be sent only once');
        return;
      }
      if (msg?.id !== undefined
          && (typeof msg.id !== 'string' || msg.id.length < 1 || msg.id.length > 128)) {
        conn.close(1008, 'invalid job id');
        return;
      }

      const host = registry.get(hostId);
      // A superseded socket must not update the new provider's heartbeat or complete
      // one of its jobs merely because both connections used the same stable id.
      if (!host || host.conn !== conn) {
        conn.close(1008, 'provider connection was superseded');
        return;
      }
      host.lastSeen = Date.now();
      const job = msg.id && host.inflight.get(msg.id);
      if (msg.t === 'chunk') {
        if (typeof msg.delta !== 'string') {
          conn.close(1003, 'completion chunks must be text');
          return;
        }
        job?.onChunk(msg.delta);
      } else if (msg.t === 'done') {
        Promise.resolve(job?.onDone()).catch((e) => console.error('onDone', e));
      } else if (msg.t === 'error') {
        const message = typeof msg.message === 'string'
          ? msg.message.slice(0, 512)
          : 'host error';
        Promise.resolve(job?.onError(message)).catch((e) => console.error('onError', e));
      }
    });

    conn.on('pong', () => {
      const host = hostId && registry.get(hostId);
      if (host?.conn === conn) host.lastSeen = Date.now();
    });

    conn.on('close', () => {
      sockets.delete(conn);
      const host = hostId && registry.get(hostId);
      if (!host) return;
      // A host that reconnects keeps its id, so a newer socket may already have
      // replaced this one in the registry. Without this guard a stale socket's
      // close would deregister the LIVE connection and fail its in-flight jobs —
      // exactly when a flaky host reconnects faster than its old socket dies.
      if (host.conn !== conn) return;
      // A dropped socket fails every job it was carrying; those that have not yet
      // shipped a token are retried on another host by handleChat.
      for (const job of host.inflight.values()) Promise.resolve(job.onError('host disconnected')).catch(() => {});
      registry.remove(hostId);
    });
  });

  let heartbeatRunning = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      for (const host of registry.online()) {
        if (host.credentialId && !(await accounts.credentialActive(host.credentialId))) {
          host.conn.close(1008, 'provider token revoked');
          continue;
        }
        if (Date.now() - host.lastSeen > HOST_TIMEOUT_MS) {
          host.conn.close(1001, 'stale');
          continue;
        }
        host.conn.ping();
      }
    } finally {
      heartbeatRunning = false;
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = () => new Promise((resolve) => {
    clearInterval(heartbeat);
    void ledger.close?.();
    // Close every socket, not only the registered ones: an unregistered or
    // superseded socket still holds the server handle open and would hang shutdown.
    for (const conn of sockets) conn.close(1001, 'gateway shutting down');
    sockets.clear();
    server.close(resolve);
  });

  return { server, registry, ledger, accounts, close, consumers, resolveConsumer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  // Binds loopback by default so a local run is not exposed; the deployed unit sets
  // HOST=0.0.0.0 because the ALB health-checks and proxies over the VPC network.
  const host = process.env.HOST || '127.0.0.1';
  const { server } = await createGateway();
  server.listen(port, host, () => {
    console.log(JSON.stringify({ ok: true, service: 'ocm-gateway', url: `http://${host}:${port}` }));
  });
}
