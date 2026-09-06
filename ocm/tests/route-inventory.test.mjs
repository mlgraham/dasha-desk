/**
 * Every route declares its auth level, and is probed to prove it enforces it.
 *
 * This exists because `/console/stats.json` shipped unauthenticated and returned every
 * account id with balances plus a rolling per-job activity log. Nothing caught it: the
 * suite tested that the endpoint *worked*, never that it was *guarded*. A route can be
 * added, or an existing one's guard removed, and no test notices.
 *
 * Two halves, and both matter:
 *
 *   1. INVENTORY — every route predicate in server.mjs must appear in the table below.
 *      A new route fails the suite until someone states what it requires. This is the
 *      half that catches the route nobody thought about.
 *
 *   2. BEHAVIOUR — each declared route is probed with NO credential. `public` routes
 *      must answer; guarded routes must refuse. This is the half that catches a guard
 *      that was declared and then quietly broken.
 *
 * Declaring a route `public` is a deliberate act. Read what it returns before you do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

/**
 * `auth` is what the route requires:
 *   public        — deliberately open to anyone. Must expose no account identity.
 *   session       — a console session cookie.
 *   developer_key — an `ocm_live_` key as a bearer token.
 *   provider_token— an `ocm_host_` token.
 *   admin_token   — the operator bearer token.
 *
 * `unauth` is the status an anonymous request must get. For console pages a redirect
 * to the landing page counts as refusal.
 */
const ROUTES = [
  // ---- public surface -------------------------------------------------------
  { method: 'GET', path: '/healthz', auth: 'public', unauth: 200,
    why: 'liveness only: service name and a host count' },
  { method: 'GET', path: '/v1/models', auth: 'public', unauth: 200,
    why: 'the catalogue a consumer chooses from; carries no account identity' },
  { method: 'GET', path: '/v1/network', auth: 'public', unauth: 200,
    why: 'marketplace status: hosts, chips, models. No accountId, deliberately' },
  { method: 'GET', path: '/install.sh', auth: 'public', unauth: 200,
    why: 'providers must be able to fetch and read it before installing' },
  { method: 'GET', path: '/agent.py', auth: 'public', unauth: 200,
    why: 'same: the code a provider runs should be readable first' },
  { method: 'GET', path: '/install.sh.sha256', auth: 'public', unauth: 200,
    why: 'the checksum is useless if it needs a credential' },
  { method: 'GET', path: '/console/', auth: 'public', unauth: 200,
    why: 'the landing page. Anonymous gets the sign-in form, never a dashboard' },
  { method: 'GET', path: '/console/provider', auth: 'public', unauth: 200,
    why: 'the recruiting guide. Holds no account data; it is the link prospects get' },
  { method: 'GET', path: '/console/status', auth: 'public', unauth: 200,
    why: 'providers online and tokens served. No owners, ids or balances, by design' },

  // ---- guarded --------------------------------------------------------------
  { method: 'GET', path: '/console/stats.json', auth: 'session', unauth: 401,
    why: 'THE REGRESSION. Account ids, balances, and a per-job log of who ran what where' },
  { method: 'GET', path: '/console/network', auth: 'session+admin', unauth: 302,
    why: 'lists every account and its usage. Non-admins get the same redirect as strangers' },
  { method: 'POST', path: '/console/redeem', auth: 'session', unauth: 302,
    why: 'grants tokens against an account' },
  { method: 'POST', path: '/console/keys/new', auth: 'session', unauth: 302,
    why: 'mints a credential' },
  { method: 'POST', path: '/console/keys/revoke', auth: 'session', unauth: 302,
    why: 'destroys a credential' },
  { method: 'POST', path: '/console/keys/rebind', auth: 'session', unauth: 302,
    why: 'frees a provider token from its machine; scoped to the signed-in account' },
  { method: 'POST', path: '/admin/accounts', auth: 'admin_token', unauth: 401,
    why: 'creates funded accounts' },
  { method: 'POST', path: '/admin/credentials', auth: 'admin_token', unauth: 401,
    why: 'mints any credential for any account' },
  { method: 'POST', path: '/admin/revoke', auth: 'admin_token', unauth: 401,
    why: 'revokes any credential' },
  { method: 'POST', path: '/v1/chat/completions', auth: 'developer_key', unauth: 401,
    why: 'spends an account balance' },
  { method: 'GET', path: '/v1/provider/verify', auth: 'provider_token', unauth: 401,
    why: 'confirms a token is real; must not become an oracle without one' },

  // ---- unauthenticated by design, but not "public" --------------------------
  // These establish identity rather than consuming it, so they cannot require a
  // credential. They are listed so nobody mistakes them for an oversight.
  { method: 'POST', path: '/console/signup', auth: 'none-by-design', unauth: null,
    why: 'creates an account. Must NOT authenticate an existing email (see e2e)' },
  { method: 'POST', path: '/console/signin', auth: 'none-by-design', unauth: null,
    why: 'exchanges a developer key for a session' },
  { method: 'POST', path: '/console/signout', auth: 'none-by-design', unauth: null,
    why: 'clearing a cookie needs no proof' },
];

// ---------------------------------------------------------------------------

function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-routes-'));
  return createGateway({
    adminToken: 'admin-token-for-tests',
    sessionSecret: 'route-inventory-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    modelAliases: '',
  }).then((gw) => new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', () => resolve({
      ...gw, base: `http://127.0.0.1:${gw.server.address().port}`,
    }));
  }));
}

/** Route predicates as they appear in the source, so a new one cannot hide. */
function routesInSource() {
  const src = readFileSync(new URL('../gateway/server.mjs', import.meta.url), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/consolePath === '([^']+)'/g)) {
    found.add(`/console${m[1] === '/' ? '/' : m[1]}`);
  }
  for (const m of src.matchAll(/url\.pathname === '([^']+)'/g)) {
    if (!m[1].startsWith('/console')) found.add(m[1]);
  }
  // Static downloads are a table rather than a predicate.
  for (const m of src.matchAll(/'(\/[a-z0-9.]+)':\s*\{\s*file:/g)) found.add(m[1]);
  return found;
}

test('every route in the source is declared in the inventory', () => {
  const declared = new Set(ROUTES.map((r) => r.path));
  const undeclared = [...routesInSource()].filter((p) => !declared.has(p));
  assert.deepEqual(undeclared, [],
    `route(s) exist with no declared auth level. Add them to ROUTES in this file and ` +
    `state what they require before shipping: ${undeclared.join(', ')}`);
});

test('every declared route is still reachable in the source', () => {
  // The mirror of the above: a stale entry hides that a route was deleted, and a
  // stale "public" line is worse than none.
  const inSource = routesInSource();
  const stale = ROUTES.map((r) => r.path)
    .filter((p) => !inSource.has(p) && p !== '/console/');
  assert.deepEqual(stale, [],
    `declared route(s) no longer exist in the source; remove them: ${stale.join(', ')}`);
});

test('an anonymous request gets what the inventory says it should', async () => {
  const gw = await startGateway();
  const failures = [];
  try {
    for (const r of ROUTES) {
      if (r.unauth === null) continue;   // identity-establishing, probed elsewhere
      const res = await fetch(`${gw.base}${r.path}`, {
        method: r.method, redirect: 'manual',
        ...(r.method === 'POST'
          ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }
          : {}),
      });
      if (res.status !== r.unauth) {
        failures.push(`${r.method} ${r.path}: declared ${r.auth} (expect ${r.unauth} ` +
                      `unauthenticated) but got ${res.status}. ${r.why}`);
      }
      // A guarded route must not leak the thing it guards in its refusal.
      if (r.auth !== 'public' && r.auth !== 'none-by-design') {
        const body = await res.text();
        if (/acct_[A-Za-z0-9_-]{6,}|ocm_(live|host)_[A-Za-z0-9_-]{8,}/.test(body)) {
          failures.push(`${r.method} ${r.path}: refusal body leaked an account id or credential`);
        }
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
  } finally { await gw.close(); }
});

test('no credential is ever placed in a URL', () => {
  // Rubric §B, promoted from review to test. A query string is recorded verbatim by
  // every proxy in the path, so `?token=` wrote a live provider credential into ALB
  // access logs on every reconnect. The agent now sends an Authorization header.
  const agent = readFileSync(new URL('../agent/agent.py', import.meta.url), 'utf8');
  const code = agent.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /[?&]token=/,
    'the agent must not put a credential in a URL; use an Authorization header');
  assert.match(code, /Authorization.*Bearer/,
    'the agent must present the provider token as a bearer header');
});

test('the gateway accepts credentials only in headers', () => {
  // Rubric §B. The agent stopped putting the token in the URL first; the gateway kept
  // accepting it so live hosts survived the migration. Both are updated, so the
  // fallback is gone and this asserts it cannot come back.
  const src = readFileSync(new URL('../gateway/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /searchParams\.get\('token'\)/,
    'the gateway must not read a credential from a query string');
});

test('the rotation helper never takes a credential in argv', () => {
  // Rubric §B. `ps` exposes arguments to any local user, and shells keep history.
  // The helper prompts with echo off, or reads stdin / OCM_HOST_TOKEN_FILE; an
  // argument of any kind is refused outright rather than accepted with a warning.
  const src = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
  const helper = src.slice(src.indexOf("cat > \"$PREFIX/bin/ocm-agent-token\""),
                           src.indexOf('chmod 755 "$PREFIX/bin/ocm-agent-token"'));
  assert.match(helper, /if \[ \$# -ne 0 \]; then/,
    'the helper must refuse any command-line argument');
  assert.match(helper, /stty -echo/,
    'the interactive path must hide the token while it is typed');
  assert.match(helper, /IFS= read -r NEW_TOKEN/,
    'the helper must read the token from stdin or the prompt');
  assert.match(helper, /OCM_HOST_TOKEN_FILE/,
    'the helper must accept a token from a file for automation');
  assert.match(helper, /shell history/,
    'the helper must say why an argument is refused');
});

test('no static shared credential can authenticate a host', () => {
  // Rubric §B, promoted from review to test. A shared bootstrap token used to let any
  // machine join; it was disabled in production only by stripping an env var, which is
  // a deployment detail standing in for a code guarantee.
  const src = readFileSync(new URL('../gateway/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /hostToken/,
    'the shared bootstrap host-token path must not exist');
  assert.doesNotMatch(src, /process\.env\.OCM_HOST_TOKEN/,
    'the gateway must not read a shared host token from the environment');
});

test('no public route exposes account identity', async () => {
  // `public` is the dangerous declaration, so it gets its own assertion rather than
  // relying on whoever added the line having thought about it.
  const gw = await startGateway();
  try {
    const acct = await gw.accounts.createAccount('inventory@dev.io');
    await gw.accounts.issue(acct.id, 'developer_key', 'k');
    for (const r of ROUTES.filter((x) => x.auth === 'public' && x.method === 'GET')) {
      const body = await (await fetch(`${gw.base}${r.path}`)).text();
      assert.doesNotMatch(body, /inventory@dev\.io/,
        `${r.path} is public and exposed an account email`);
      assert.doesNotMatch(body, /acct_[A-Za-z0-9_-]{6,}/,
        `${r.path} is public and exposed an account id`);
    }
  } finally { await gw.close(); }
});
