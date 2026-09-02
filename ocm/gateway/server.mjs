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
import { stats, renderLanding, renderDashboard, renderNetwork, renderProviderGuide, renderSecret } from './console.mjs';
import { issueSession, readSession, cookieHeader, clearCookieHeader, readCookie, parseForm } from './session.mjs';
import { MemoryAccounts } from './accounts.mjs';

const HEARTBEAT_MS = 30_000;
const HOST_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 120_000;
// A cold MLX host spends ~75s loading a 7B-4bit model before its first token, so a
// 120s budget leaves barely 45s to generate in. Give a host we have no evidence is
// warm a longer leash, rather than timing out a machine that is working correctly.
const COLD_JOB_TIMEOUT_MS = 300_000;
const MAX_ROUTE_ATTEMPTS = 3;
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

function parseAliases(spec) {
  const map = new Map();
  for (const pair of String(spec || '').split(',')) {
    const [pub, local] = pair.split('=');
    if (!pub || !local) continue;
    const key = pub.trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(local.trim());
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

  add(hostId, conn, caps) {
    this.hosts.set(hostId, {
      id: hostId, conn, caps,
      models: new Set(caps.models || []),
      inflight: new Map(),
      // model -> when this host last actually produced tokens for it. Evidence the
      // weights are resident, which is the difference between a 1s reply and 75s.
      warm: new Map(),
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    });
    return this.hosts.get(hostId);
  }

  remove(hostId) { this.hosts.delete(hostId); }
  get(hostId) { return this.hosts.get(hostId); }
  online() { return [...this.hosts.values()]; }

  /** Is this host known to have the model loaded right now? */
  isWarm(host, model) { return (host.warm.get(model) || 0) > Date.now() - WARM_TTL_MS; }

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
      return this.isWarm(h, model) ? 0 : 1;
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
} = {}) {
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
            : html(res, 200, renderLanding({ inviteRequired: !!inviteCode,
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
          const acct = await accounts.createAccount(f.email);
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
              ? `<p>Install the agent on the Mac you want to contribute:</p>
<pre>OCM_HOST_TOKEN="${cred.secret}"${agentId ? ` OCM_AGENT_ID="${agentId}"` : ''} sh install.sh</pre>
${agentId ? `<p class="muted">Keep <code>OCM_AGENT_ID</code> the same on every reinstall of this
machine — a different name registers a second provider instead of recovering this one.</p>` : ''}
<p class="muted">See <a href="/provider">Run a provider</a> for the full guide.</p>`
              : `<pre>export OPENAI_BASE_URL="https://${apiHost}/v1"
export OPENAI_API_KEY="${cred.secret}"</pre>`,
          }));
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
        if (req.method === 'POST' && url.pathname === '/admin/revoke') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!body.credential_id) return apiError(res, 400, 'credential_id is required');
          return json(res, 200, { revoked: await accounts.revoke(body.credential_id) });
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
        return json(res, 200, { ok: true, service: 'ocm-gateway', hosts: registry.online().length });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: registry.models().map((id) => ({ id, object: 'model', owned_by: 'ocm' })),
        });
      }
      // Check a provider token WITHOUT opening a socket. The installer and the
      // agent's --doctor both call this: before it existed, the only way to learn
      // that a token was wrong was a silent 401 on the WebSocket upgrade, which
      // reads identically to a network fault and sent people editing files by hand.
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
        const found = await accounts.resolve(presented, 'provider_token');
        if (!found) {
          return apiError(res, 401,
            'this provider token is not recognised — it may have been revoked, or issued against a different deployment. Issue a new one from the console.',
            'authentication_error');
        }
        const acct = await accounts.accountFor(found.accountId);
        return json(res, 200, { ok: true, account_id: found.accountId, email: acct ? acct.email : null });
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
      if (outcome.ok || outcome.committed) return;
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
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        host.inflight.delete(jobId);
        res.off('close', onClientGone);
        resolve(result);
      };

      // Bill only what reached the client, and only ever the gateway's own count.
      // A ledger failure must not fail a request the user already received, but it
      // must be loud: this is unbilled usage, and silence would hide revenue loss.
      const meter = async () => {
        const completionTokens = countTokens(text);
        try {
          await ledger.clear({ consumer, host: host.id, model, promptTokens, completionTokens, jobId });
        } catch (err) {
          console.error(JSON.stringify({ level: 'error', msg: 'LEDGER WRITE FAILED — usage not billed',
            jobId, consumer, host: host.id, completionTokens, error: String(err) }));
        }
        return completionTokens;
      };

      const onClientGone = () => {
        if (settled) return;
        host.conn.sendJson({ t: 'cancel', id: jobId });
        if (committed) void meter();
        finish({ ok: false, committed });
      };

      const timer = setTimeout(() => {
        host.conn.sendJson({ t: 'cancel', id: jobId });
        if (committed) { void meter(); try { res.end(); } catch {} }
        finish({ ok: false, committed });
      }, registry.isWarm(host, model) ? JOB_TIMEOUT_MS : COLD_JOB_TIMEOUT_MS);

      host.inflight.set(jobId, {
        onChunk(delta) {
          if (settled || !delta) return;
          // First tokens are proof the weights are resident. Recording warmth here
          // rather than on dispatch means it is evidence, never an assumption.
          if (!text) host.warm.set(model, Date.now());
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
          if (settled) return;
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
            committed = true;
            const completionTokens = await meter();
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
          if (settled) return;
          if (committed) {
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

      // The consumer's name may be an alias; the host only knows its own.
      const sent = host.conn.sendJson({
        t: 'job', id: jobId, model: registry.wireName(host, model) || model, messages });
      if (sent === false && !committed) finish({ ok: false, committed: false, message: 'host backpressure' });
    });
  }

  server.on('upgrade', async (req, socket) => {
    const url = new URL(req.url, 'http://gateway');
    if (url.pathname !== '/host/connect') { socket.destroy(); return; }
    // Header only. The query-string fallback existed so hosts running the pre-header
    // agent kept working during the migration; both live hosts are updated, so it is
    // gone. A credential in a URL is recorded verbatim by every proxy in the path.
    const presented = bearer(req);
    // Account-bound provider token first; the shared bootstrap token still works
    // so existing hosts keep running during migration.
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
    const conn = accept(req, socket);
    if (!conn) return;
    sockets.add(conn);

    let hostId = null;
    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'hello') {
        hostId = msg.agent?.id || randomUUID();
        registry.add(hostId, conn, { ...(msg.agent || {}), accountId });
        conn.sendJson({ t: 'welcome', host_id: hostId, heartbeat_ms: HEARTBEAT_MS });
        return;
      }
      const host = hostId && registry.get(hostId);
      if (!host) return;
      host.lastSeen = Date.now();
      const job = msg.id && host.inflight.get(msg.id);
      if (msg.t === 'chunk') job?.onChunk(msg.delta);
      else if (msg.t === 'done') Promise.resolve(job?.onDone()).catch((e) => console.error('onDone', e));
      else if (msg.t === 'error') Promise.resolve(job?.onError(msg.message || 'host error')).catch((e) => console.error('onError', e));
    });

    conn.on('pong', () => { const h = hostId && registry.get(hostId); if (h) h.lastSeen = Date.now(); });

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

  const heartbeat = setInterval(() => {
    for (const host of registry.online()) {
      if (Date.now() - host.lastSeen > HOST_TIMEOUT_MS) { host.conn.close(1001, 'stale'); continue; }
      host.conn.ping();
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
