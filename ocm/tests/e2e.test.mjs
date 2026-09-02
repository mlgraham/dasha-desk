/**
 * OCM core-loop end-to-end tests.
 *
 * Drives the real gateway over a real WebSocket with stub hosts: the host holds a
 * socket, the developer POSTs, the gateway routes and streams, the ledger clears.
 * That is the whole of the PDF's §05 first version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_test_key';

async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  const gw = await createGateway({
    keys: new Map([[API_KEY, 'test-dev']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 10_000,
    // No aliases unless a test asks for them, so the rest of the suite keeps
    // exercising plain exact-name routing.
    modelAliases: '',
    ...opts,
  });
  // No shared bootstrap token exists any more, so a stub host authenticates the way
  // a real provider does: with an issued, account-bound credential.
  return ready(gw);
}

/**
 * Finish booting a gateway: listen, then issue the account-bound provider token a
 * stub host needs. Shared by every factory so they cannot drift apart.
 */
function ready(gw) {
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', async () => {
      const acct = await gw.accounts.createAccount('hosts@test.io');
      const tok = await gw.accounts.issue(acct.id, 'provider_token', 'stub host');
      resolve({ ...gw, hostToken: tok.secret, hostAccountId: acct.id,
                base: `http://127.0.0.1:${gw.server.address().port}`,
                wsBase: `ws://127.0.0.1:${gw.server.address().port}` });
    });
  });
}

/**
 * A stub host. `behaviour(job, api)` decides what this host does with a job,
 * which is how failure modes are exercised deterministically.
 */
async function connectHost(gw, { id, models = ['qwen3-8b'], behaviour }) {
  // One token per machine, because a provider token now binds to the first machine
  // that presents it. Sharing one across stub hosts is exactly what the binding is
  // designed to refuse, so the harness has to mirror how real providers are issued.
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  return new Promise((resolve, reject) => {
    // Header, not a query string: the production agent does the same, so a token
    // cannot reach a proxy access log.
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        t: 'hello',
        agent: { id, models, chip: 'stub', memory_gb: 24, region: 'local' },
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') { resolve({ ws, id }); return; }
      if (msg.t === 'job') {
        behaviour(msg, {
          chunk: (delta) => ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta })),
          done: (usage) => ws.send(JSON.stringify({ t: 'done', id: msg.id, usage })),
          error: (message) => ws.send(JSON.stringify({ t: 'error', id: msg.id, message })),
          drop: () => ws.close(),
        });
      }
    });
  });
}

const post = (gw, body, key = API_KEY) => fetch(`${gw.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

const ask = (content = 'hello') => ({ model: 'qwen3-8b', messages: [{ role: 'user', content }] });

const echoHost = (job, api) => {
  for (const part of ['Hello', ', ', 'world']) api.chunk(part);
  api.done();
};

test('health, models and network reflect connected hosts', async () => {
  const gw = await startGateway();
  try {
    assert.equal((await (await fetch(`${gw.base}/healthz`)).json()).hosts, 0);
    await connectHost(gw, { id: 'h1', models: ['qwen3-8b', 'codellama'], behaviour: echoHost });

    const models = await (await fetch(`${gw.base}/v1/models`)).json();
    assert.deepEqual(models.data.map((m) => m.id), ['codellama', 'qwen3-8b']);
    assert.equal(models.object, 'list');

    const net = await (await fetch(`${gw.base}/v1/network`)).json();
    assert.equal(net.hosts.length, 1);
    assert.equal(net.hosts[0].chip, 'stub');
  } finally { await gw.close(); }
});

test('rejects a bad key and an unknown model', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    assert.equal((await post(gw, ask(), 'nope')).status, 401);
    assert.equal((await post(gw, { model: 'not-served', messages: [{ role: 'user', content: 'x' }] })).status, 503);
    assert.equal((await post(gw, { model: 'qwen3-8b' })).status, 400);
  } finally { await gw.close(); }
});

test('complete (non-streamed) response is OpenAI-shaped', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    const body = await (await post(gw, ask())).json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello, world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.completion_tokens > 0);
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  } finally { await gw.close(); }
});

test('streamed response emits OpenAI chunks through [DONE]', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    const res = await post(gw, { ...ask(), stream: true });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const raw = await res.text();

    const frames = raw.split('\n\n').filter(Boolean).map((l) => l.replace(/^data: /, ''));
    assert.equal(frames.at(-1), '[DONE]');
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f));
    assert.ok(parsed.every((p) => p.object === 'chat.completion.chunk'));
    assert.equal(parsed.map((p) => p.choices[0].delta.content || '').join(''), 'Hello, world');
    assert.equal(parsed.at(-1).choices[0].finish_reason, 'stop');
  } finally { await gw.close(); }
});

test('the ledger bills the gateway count, never the host\'s claim', async () => {
  const gw = await startGateway();
  try {
    // This host reports a wildly inflated usage figure, as a dishonest host would.
    await connectHost(gw, {
      id: 'h1',
      behaviour: (job, api) => { api.chunk('abcd'); api.done({ completion_tokens: 999_999 }); },
    });
    const before = await gw.ledger.balance('test-dev');
    await (await post(gw, ask())).json();

    const entry = (await gw.ledger.summary()).recent[0];
    assert.equal(entry.host, 'h1');
    assert.equal(entry.completionTokens, 1, 'four characters must meter as one token, not 999999');
    assert.equal(await gw.ledger.balance('test-dev'), before - entry.tokens);
    assert.equal(await gw.ledger.credited('h1'), 1);
  } finally { await gw.close(); }
});

test('a host failing before first token is retried on another host', async () => {
  const gw = await startGateway();
  try {
    let badCalls = 0;
    await connectHost(gw, { id: 'bad', behaviour: (job, api) => { badCalls++; api.error('runtime not ready'); } });
    await connectHost(gw, { id: 'good', behaviour: echoHost });

    const body = await (await post(gw, ask())).json();
    assert.equal(body.choices[0].message.content, 'Hello, world');
    assert.equal(badCalls, 1, 'the failing host should have been tried once');
    assert.equal((await gw.ledger.summary()).recent[0].host, 'good', 'only the host that delivered is credited');
    assert.equal(await gw.ledger.credited('bad'), 0, 'a host that delivered nothing earns nothing');
  } finally { await gw.close(); }
});

test('a non-streamed request whose host dies mid-generation is retried, not billed', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, {
      id: 'flaky',
      behaviour: (job, api) => { api.chunk('partial'); api.drop(); },
    });
    await connectHost(gw, { id: 'good', behaviour: echoHost });

    const body = await (await post(gw, ask())).json();
    assert.equal(body.choices[0].message.content, 'Hello, world',
      'the client must see a whole answer, not the dead host\'s partial one');
    assert.equal(await gw.ledger.credited('flaky'), 0,
      'tokens the client never received are not billable');
  } finally { await gw.close(); }
});

test('every host being unavailable is a 503, not a hang', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'bad1', behaviour: (j, api) => api.error('nope') });
    await connectHost(gw, { id: 'bad2', behaviour: (j, api) => api.error('nope') });
    const res = await post(gw, ask());
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /no healthy host|all candidate hosts/);
  } finally { await gw.close(); }
});

test('a disconnected host is removed from the registry', async () => {
  const gw = await startGateway();
  try {
    const host = await connectHost(gw, { id: 'h1', behaviour: echoHost });
    assert.equal(gw.registry.online().length, 1);
    host.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(gw.registry.online().length, 0);
    assert.equal((await post(gw, ask())).status, 503);
  } finally { await gw.close(); }
});

test('a host reconnecting with the same id is not deregistered by its stale socket', async () => {
  const gw = await startGateway();
  try {
    // First socket for this host id.
    const first = await connectHost(gw, { id: 'flappy', behaviour: echoHost });
    assert.equal(gw.registry.online().length, 1);

    // It reconnects — same id — before the old socket has finished closing.
    const second = await connectHost(gw, { id: 'flappy', behaviour: echoHost });
    assert.equal(gw.registry.online().length, 1, 'same id must not double-register');

    // Now the stale socket finally closes. The live registration must survive.
    first.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(gw.registry.online().length, 1,
      'the stale socket deregistered the live host — a reconnecting host would vanish');
    const body = await (await post(gw, ask())).json();
    assert.equal(body.choices[0].message.content, 'Hello, world',
      'the host must still serve after its old socket closed');
    void second;
  } finally { await gw.close(); }
});

test('the console is anonymous-safe and stats reflect real state', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'console-host', behaviour: echoHost });
    await (await post(gw, ask())).json();

    const res = await fetch(`${gw.base}/console`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Open-Compute Marketplace/);
    assert.match(html, /Sign in/, 'an anonymous visitor gets the landing page');
    assert.doesNotMatch(html, /console-host/,
      'provider identities must not be exposed to anonymous visitors');
    assert.match(html, /no confidentiality is\s*claimed/i,
      'the console must not overstate privacy');
    assert.doesNotMatch(html, /undefined|NaN/, 'template holes leaked into the page');

    // Counters are not public. They used to be, and carried every account id with
    // its balance plus a per-job log naming consumer, host and model.
    const anon = await fetch(`${gw.base}/console/stats.json`);
    assert.equal(anon.status, 401, 'stats must not be readable without a session');
    const body = await anon.text();
    assert.doesNotMatch(body, /test-dev|console-host/, 'the refusal must not leak the data');
  } finally { await gw.close(); }
});

test('stats.json is scoped: admins see the network, others see only themselves', async () => {
  const gw = await startConsole({ adminEmails: 'boss@dev.io' });
  try {
    const mk = async (email) => {
      const r = await form(gw, '/signup', { email, invite: 'potter' });
      return r.headers.get('set-cookie').split(';')[0];
    };
    const bossCookie = await mk('boss@dev.io');
    const userCookie = await mk('user@dev.io');
    const get = async (cookie) =>
      (await fetch(`${gw.base}/console/stats.json`, { headers: { cookie } })).json();

    const asAdmin = await get(bossCookie);
    assert.ok(asAdmin.consumers.length >= 2, 'an admin sees every consumer');

    const asUser = await get(userCookie);
    assert.ok(asUser.consumers.length <= 1, 'a normal user sees at most their own row');
    assert.ok(!/boss@dev\.io/.test(JSON.stringify(asUser)), 'no other account may appear');
    assert.ok(asUser.hosts.every((h) => !('accountId' in h)),
      'host ownership must not be exposed to a non-admin');
  } finally { await gw.close(); }
});

test('a provider token can be verified before install, with a reason when it fails', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'v@r.o' })).json();
    const tok = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label: 'air' })).json();
    const key = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key', label: 'laptop' })).json();

    const verify = (t) => fetch(`${gw.base}/v1/provider/verify`,
      { headers: t ? { authorization: `Bearer ${t}` } : {} });

    const good = await verify(tok.secret);
    assert.equal(good.status, 200);
    assert.equal((await good.json()).email, 'v@r.o');

    // Each failure must say which mistake was made, not merely "401".
    const asKey = await verify(key.secret);
    assert.equal(asKey.status, 401);
    assert.match((await asKey.json()).error.message, /developer key, not a provider token/);

    const unknown = await verify('ocm_host_not_a_real_token');
    assert.equal(unknown.status, 401);
    assert.match((await unknown.json()).error.message, /not recognised/);

    const none = await verify(null);
    assert.equal(none.status, 401);
    assert.match((await none.json()).error.message, /OCM_HOST_TOKEN/);
  } finally { await gw.close(); }
});

// ---------------------------------------------------------------------------
// Accounts and credentials
// ---------------------------------------------------------------------------

const admin = (gw, path, body) => fetch(`${gw.base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin' },
  body: JSON.stringify(body),
});

function startGatewayWithAdmin() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  return createGateway({
    adminToken: 'test-admin',
    keys: new Map([[API_KEY, 'test-dev']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 10_000,
  }).then(ready);
}

test('admin routes require the admin token', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    const res = await fetch(`${gw.base}/admin/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    assert.equal(res.status, 401, 'admin routes must not be open');
  } finally { await gw.close(); }
});

test('an issued developer key authorises requests and is billed to its account', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    const acct = await (await admin(gw, '/admin/accounts', { email: 'Dev@Example.com' })).json();
    assert.match(acct.id, /^acct_/);
    assert.equal(acct.email, 'dev@example.com', 'email should be normalised');

    const cred = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key', label: 'laptop' })).json();
    assert.match(cred.secret, /^ocm_live_/);

    const body = await (await post(gw, ask(), cred.secret)).json();
    assert.equal(body.choices[0].message.content, 'Hello, world');

    const s = await gw.ledger.summary();
    assert.ok(s.consumers.some((c) => c.consumer === acct.id),
      'usage must be billed to the account, not a shared consumer');
  } finally { await gw.close(); }
});

test('the plaintext secret is never stored or retrievable', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'x@y.z' })).json();
    const cred = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key' })).json();

    const listed = await gw.accounts.listCredentials(acct.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secret, undefined, 'secret must not come back from storage');
    assert.equal(listed[0].hash, undefined, 'hash must not be exposed either');
    assert.ok(JSON.stringify(listed).indexOf(cred.secret) === -1,
      'the plaintext must appear nowhere in stored state');
  } finally { await gw.close(); }
});

test('a revoked key stops working immediately', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    const acct = await (await admin(gw, '/admin/accounts', { email: 'r@e.v' })).json();
    const cred = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key' })).json();

    assert.equal((await post(gw, ask(), cred.secret)).status, 200);
    const r = await (await admin(gw, '/admin/revoke', { credential_id: cred.id })).json();
    assert.equal(r.revoked, true);
    assert.equal((await post(gw, ask(), cred.secret)).status, 401,
      'a revoked key must be refused');
  } finally { await gw.close(); }
});

test('a valid developer key cannot open a provider socket, and the refusal is logged', async () => {
  const gw = await startGatewayWithAdmin();
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'mixed@r.o' })).json();
    const key = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key', label: 'laptop' })).json();
    assert.match(key.secret, /^ocm_live_/);

    // The mistake this guards: putting a developer key in OCM_HOST_TOKEN. The key
    // is valid, so nothing about it looks wrong to whoever installed the agent.
    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`${gw.wsBase}/host/connect`,
        { headers: { authorization: `Bearer ${key.secret}` } });
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
    });
    assert.equal(rejected, true, 'a developer key must not authorise a host socket');

    const line = errs.find((e) => e.includes('provider socket rejected'));
    assert.ok(line, 'a rejected provider must leave a server-side record');
    assert.match(line, /developer key, not a provider token/,
      'the log must say which mistake was made');
    assert.doesNotMatch(line, /ocm_live_[A-Za-z0-9_-]{8}/,
      'the log must never contain the presented secret');
  } finally { console.error = realError; await gw.close(); }
});

test('a host presenting an issued provider token connects; a bad one does not', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'p@r.o' })).json();
    const tok = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label: 'mac mini' })).json();
    assert.match(tok.secret, /^ocm_host_/);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${gw.wsBase}/host/connect`,
        { headers: { authorization: `Bearer ${tok.secret}` } });
      ws.addEventListener('error', reject);
      ws.addEventListener('open', () => ws.send(JSON.stringify({
        t: 'hello', agent: { id: 'owned-host', models: ['qwen3-8b'] } })));
      ws.addEventListener('message', (ev) => {
        if (JSON.parse(ev.data).t === 'welcome') resolve();
      });
    });
    assert.equal(gw.registry.get('owned-host').caps.accountId, acct.id,
      'the host must be bound to the issuing account');

    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`${gw.wsBase}/host/connect`,
        { headers: { authorization: 'Bearer ocm_host_not_a_real_token' } });
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
    });
    assert.equal(rejected, true, 'an unissued provider token must be refused');

    // Even a VALID token is refused in a query string: credentials belong in headers,
    // and a URL is recorded by every proxy in the path.
    const viaUrl = await new Promise((resolve) => {
      const ws = new WebSocket(`${gw.wsBase}/host/connect?token=${encodeURIComponent(tok.secret)}`);
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
    });
    assert.equal(viaUrl, true, 'a valid token in a query string must still be refused');
  } finally { await gw.close(); }
});

test('with no bootstrap credentials configured, nothing is accepted by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  const gw = await createGateway({ ledgerPath: join(dir, 'usage.jsonl'), keys: undefined });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.server.address().port}`;
  try {
    // The old defaults must not be honoured.
    for (const key of ['ocm_live_dev', 'host-dev-token', '']) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(ask()),
      });
      assert.equal(res.status, 401, `well-known default "${key}" must not authorise`);
    }
    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.server.address().port}/host/connect`,
        { headers: { authorization: 'Bearer host-dev-token' } });
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
    });
    assert.equal(rejected, true, 'the old default host token must not connect');
  } finally { await gw.close(); }
});

// ---------------------------------------------------------------------------
// Console flows: invite-gated signup, sign-in, credential management
// ---------------------------------------------------------------------------

function startConsole(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  return createGateway({
    inviteCode: 'potter',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    keys: new Map([[API_KEY, 'test-dev']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 5_000,
    ...opts,
  }).then(ready);
}

const form = (gw, path, fields, cookie) => fetch(`${gw.base}/console${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded',
             ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

test('signup refuses an existing email and issues nothing (no takeover by address)', async () => {
  const gw = await startConsole();
  try {
    // First signup: a real account and a real key exist for this email.
    const first = await form(gw, '/signup', { email: 'owner@dev.io', invite: 'potter' });
    assert.equal(first.status, 200);
    const ownerKey = (await first.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];

    // An attacker who knows only the email tries to sign up as them.
    const attack = await form(gw, '/signup', { email: 'owner@dev.io' });
    assert.equal(attack.status, 302, 'a duplicate email must be refused, not served');
    assert.equal(attack.headers.get('set-cookie'), null,
      'no session cookie may be issued for an existing email');
    assert.match(attack.headers.get('location'), /already/,
      'the refusal must tell them to sign in');

    // The attacker was handed no credential: a 302 carries no body and, asserted
    // above, no cookie. And the owner's key still authenticates, so nothing about
    // their account changed. Signin needs no provider, so this is host-independent.
    const attackBody = await attack.text();
    assert.doesNotMatch(attackBody, /ocm_live_/, 'no key may be returned to the attacker');
    const ownerSignin = await form(gw, '/signin', { key: ownerKey });
    assert.equal(ownerSignin.status, 302);
    assert.ok(ownerSignin.headers.get('set-cookie'), "the owner's key still signs in");

    // Case-insensitive: the email is lowercased, so a case variant is the same account.
    const variant = await form(gw, '/signup', { email: 'OWNER@DEV.IO' });
    assert.equal(variant.status, 302, 'email match must be case-insensitive');
    assert.match(variant.headers.get('location'), /already/);
  } finally { await gw.close(); }
});

test('signup works without a code, but the account starts at zero', async () => {
  const gw = await startConsole();
  try {
    const res = await form(gw, '/signup', { email: 'nocode@dev.io' });
    assert.equal(res.status, 200, 'signup must not require a code');
    const html = await res.text();
    const secret = html.match(/ocm_live_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(secret, 'a key is still issued');
    assert.match(html, /balance is zero/i, 'the user must be told why nothing will work');

    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;
    assert.equal(await gw.ledger.balance(acct), 0);
    assert.equal(await gw.ledger.grantCount(acct), 0);

    // The key is valid but unfunded: 402, not 401, and it says what to do.
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    const call = await post(gw, ask(), secret);
    assert.equal(call.status, 402);
    assert.match((await call.json()).error.message, /redeem an invite code/i);
  } finally { await gw.close(); }
});

test('a wrong code at signup is refused rather than silently ignored', async () => {
  const gw = await startConsole();
  try {
    const res = await form(gw, '/signup', { email: 'wrong@dev.io', invite: 'nope' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /error=/,
      'a mistyped code must not quietly create a zero-token account');
  } finally { await gw.close(); }
});

test('a code at signup grants tokens', async () => {
  const gw = await startConsole();
  try {
    const res = await form(gw, '/signup', { email: 'coded@dev.io', invite: 'potter' });
    const html = await res.text();
    const secret = html.match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;
    assert.equal(await gw.ledger.balance(acct), 5000);
    assert.equal(await gw.ledger.grantCount(acct), 1);
  } finally { await gw.close(); }
});

test('a code can be redeemed retroactively, exactly once', async () => {
  const gw = await startConsole();
  try {
    const signup = await form(gw, '/signup', { email: 'later@dev.io' });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const secret = (await signup.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;
    assert.equal(await gw.ledger.balance(acct), 0);

    // The dashboard should be offering the redemption.
    const before = await (await fetch(`${gw.base}/console`, { headers: { cookie } })).text();
    assert.match(before, /Redeem an invite code/);

    const wrong = await form(gw, '/redeem', { invite: 'nope' }, cookie);
    assert.match(wrong.headers.get('location'), /error=/);
    assert.equal(await gw.ledger.balance(acct), 0, 'a wrong code must not grant');

    const ok = await form(gw, '/redeem', { invite: 'potter' }, cookie);
    assert.match(ok.headers.get('location'), /notice=/);
    assert.equal(await gw.ledger.balance(acct), 5000);
    assert.equal(await gw.ledger.grantCount(acct), 1);

    // Second redemption must be refused, and must not add tokens.
    const again = await form(gw, '/redeem', { invite: 'potter' }, cookie);
    assert.match(again.headers.get('location'), /error=/);
    assert.equal(await gw.ledger.balance(acct), 5000, 'a code must not be redeemable twice');
    assert.equal(await gw.ledger.grantCount(acct), 1);

    const after = await (await fetch(`${gw.base}/console`, { headers: { cookie } })).text();
    assert.doesNotMatch(after, /Redeem an invite code/, 'the form should be gone once redeemed');
  } finally { await gw.close(); }
});

test('redeeming at signup blocks a second redemption later', async () => {
  const gw = await startConsole();
  try {
    const signup = await form(gw, '/signup', { email: 'both@dev.io', invite: 'potter' });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const secret = (await signup.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;

    const again = await form(gw, '/redeem', { invite: 'potter' }, cookie);
    assert.match(decodeURIComponent(again.headers.get('location')), /already redeemed/i);
    assert.equal(await gw.ledger.balance(acct), 5000, 'signup + redeem must not stack');
  } finally { await gw.close(); }
});

test('redemption requires a session', async () => {
  const gw = await startConsole();
  try {
    const res = await form(gw, '/redeem', { invite: 'potter' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/', 'anonymous redemption must not grant anything');
  } finally { await gw.close(); }
});

test('sign-in with a developer key opens the dashboard; a bad key does not', async () => {
  const gw = await startConsole();
  try {
    const signup = await form(gw, '/signup', { email: 'me@dev.io', invite: 'potter' });
    const secret = (await signup.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];

    const bad = await form(gw, '/signin', { key: 'ocm_live_nope' });
    assert.match(bad.headers.get('location'), /error=/);

    const good = await form(gw, '/signin', { key: secret });
    assert.equal(good.status, 302);
    const cookie = good.headers.get('set-cookie').split(';')[0];

    const dash = await fetch(`${gw.base}/console`, { headers: { cookie } });
    const html = await dash.text();
    assert.match(html, /me@dev\.io/, 'the dashboard must identify the signed-in account');
    assert.match(html, /Your balance/);
    assert.doesNotMatch(html, /undefined|NaN/);

    // No cookie: the landing page, not the dashboard.
    const anon = await (await fetch(`${gw.base}/console`)).text();
    assert.match(anon, /Sign in/);
    assert.doesNotMatch(anon, /me@dev\.io/, 'an anonymous visitor must not see account data');
  } finally { await gw.close(); }
});

test('a forged or expired session cookie is rejected', async () => {
  const gw = await startConsole();
  try {
    const signup = await form(gw, '/signup', { email: 'f@dev.io', invite: 'potter' });
    const secret = (await signup.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;

    for (const forged of [`${acct}.99999999999.badsignature`, `${acct}.1.abc`, 'garbage']) {
      const res = await fetch(`${gw.base}/console`, { headers: { cookie: `ocm_session=${forged}` } });
      const html = await res.text();
      assert.match(html, /Sign in/, `forged cookie "${forged.slice(0, 20)}" must not authenticate`);
      assert.doesNotMatch(html, /f@dev\.io/);
    }
  } finally { await gw.close(); }
});

test('a signed-in account cannot revoke a credential it does not own', async () => {
  const gw = await startConsole();
  try {
    const a = await form(gw, '/signup', { email: 'a@own.io', invite: 'potter' });
    const aCookie = a.headers.get('set-cookie').split(';')[0];
    const b = await form(gw, '/signup', { email: 'b@own.io', invite: 'potter' });
    const bSecret = (await b.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const bAcct = (await gw.accounts.resolve(bSecret, 'developer_key')).accountId;
    const bCred = (await gw.accounts.listCredentials(bAcct))[0];

    await form(gw, '/keys/revoke', { credential_id: bCred.id }, aCookie);

    const after = (await gw.accounts.listCredentials(bAcct))[0];
    assert.equal(after.revoked_at, null, "one account revoked another account's credential");
    assert.ok(await gw.accounts.resolve(bSecret, 'developer_key'), "the victim's key must still work");
  } finally { await gw.close(); }
});

test('a provider token binds to the first machine and refuses a second', async () => {
  const gw = await startGatewayWithAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'bind@r.o' })).json();
    const tok = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label: 'the-mac' })).json();

    const connect = (id) => new Promise((resolve) => {
      const ws = new WebSocket(`${gw.wsBase}/host/connect`,
        { headers: { authorization: `Bearer ${tok.secret}` } });
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      ws.addEventListener('error', () => done({ ok: false }));
      ws.addEventListener('close', () => done({ ok: false }));
      ws.addEventListener('open', () => ws.send(JSON.stringify({
        t: 'hello', agent: { id, models: ['qwen3-8b'], chip: 'stub', memory_gb: 24 } })));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'welcome') done({ ok: true, ws });
        if (m.t === 'error') done({ ok: false, message: m.message });
      });
    });

    const first = await connect('machine-one');
    assert.equal(first.ok, true, 'the first machine claims the token');

    // A different machine presenting the same token must be turned away, and told why.
    const second = await connect('machine-two');
    assert.equal(second.ok, false, 'a second machine must not be able to use it');
    assert.match(second.message || '', /bound to machine-one/,
      'the refusal must name the machine holding it, and how to fix it');
    assert.match(second.message || '', /console/i);

    // Releasing it lets a different machine claim it, so a rebuild is not a lockout.
    assert.equal(await gw.accounts.rebind(tok.id, acct.id), true);
    const third = await connect('machine-two');
    assert.equal(third.ok, true, 'after release, another machine may claim it');
    first.ws?.close(); third.ws?.close();
  } finally { await gw.close(); }
});

test('an unknown model falls back to the default and the response says so', async () => {
  const gw = await startGateway({ defaultModel: 'qwen3-8b' });
  try {
    await connectHost(gw, { id: 'fallback-host', behaviour: echoHost });

    // What an unmodified OpenAI client actually sends.
    const res = await post(gw, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200, 'an unmodified client must not get a 503');

    // The disclosure is the whole basis for doing this at all.
    assert.equal(res.headers.get('x-ocm-served-model'), 'qwen3-8b',
      'the header must name what actually served');
    const body = await res.json();
    assert.equal(body.model, 'qwen3-8b',
      'the response model must be what served, never an echo of the request');

    // A model we DO serve is untouched, and gets no substitution header.
    const direct = await post(gw, ask());
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get('x-ocm-served-model'), null,
      'no substitution means no header');
    assert.equal((await direct.json()).model, 'qwen3-8b');
  } finally { await gw.close(); }
});

test('with no default configured, an unknown model is refused with what is available', async () => {
  const gw = await startGateway({ defaultModel: '' });
  try {
    await connectHost(gw, { id: 'strict-host', behaviour: echoHost });
    const res = await post(gw, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 503);
    const msg = (await res.json()).error.message;
    assert.match(msg, /gpt-4o/, 'the error names what was asked for');
    assert.match(msg, /Available: qwen3-8b/, 'and what could be asked for instead');
  } finally { await gw.close(); }
});

test('a host reports whether it is warm, so loading is not mistaken for broken', async () => {
  const gw = await startGateway();
  try {
    await connectHost(gw, { id: 'warm-probe', behaviour: echoHost });
    // Freshly connected: no tokens produced yet, so not warm.
    let net = await (await fetch(`${gw.base}/v1/network`)).json();
    assert.equal(net.hosts[0].warm, false, 'a host that has served nothing is not warm');

    await (await post(gw, ask())).json();
    net = await (await fetch(`${gw.base}/v1/network`)).json();
    assert.equal(net.hosts[0].warm, true, 'producing tokens marks the host warm');

    // The public view must still carry no account identity.
    assert.ok(!('accountId' in net.hosts[0]), '/v1/network must not expose ownership');
  } finally { await gw.close(); }
});

test('the provider guide is public and warns about plaintext prompts', async () => {
  const gw = await startConsole();
  try {
    // The guide is deliberately public: it is the link prospects are sent, and it
    // carries no account data. It used to 302 to an unexplained login wall.
    const anon = await fetch(`${gw.base}/console/provider`);
    assert.equal(anon.status, 200, 'the recruiting guide must be readable signed out');
    const anonHtml = await anon.text();
    assert.doesNotMatch(anonHtml, /Sign out/, 'a signed-out visitor gets no account chrome');
    assert.match(anonHtml, /no invite code/i,
      'a signed-out provider must be told they need no invite code');

    const s = await form(gw, '/signup', { email: 'p@dev.io', invite: 'potter' });
    const cookie = s.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${gw.base}/console/provider`, { headers: { cookie } })).text();
    assert.match(html, /plaintext/i, 'providers must be told they can see prompts');
    assert.match(html, /Apple Silicon/, 'the hardware requirement must be stated');
    assert.match(html, /no inbound ports/i);

    // The instructions have to carry the two facts that actually cost downtime:
    // which credential to use, and how to change it without editing files.
    assert.match(html, /ocm_host_/, 'the guide must name the provider token prefix');
    assert.match(html, /developer key is not a provider token/i,
      'the guide must distinguish the two credentials');
    assert.match(html, /ocm-agent-token/,
      'the guide must give a supported way to rotate a token');
    // A credential passed as an argument is visible via ps and kept in shell history.
    assert.match(html, /printf '%s'[^|]*\|\s*sudo[^<]*ocm-agent-token/,
      'the documented rotation must pipe the token, not pass it as an argument');
    assert.match(html, /Never pass a token as a command-line argument/i,
      'the guide must say why');
    assert.match(html, /Do not edit/i,
      'the guide must warn against hand-editing the run wrapper');
    assert.match(html, /OCM_AGENT_ID/,
      'the guide must name the identity variable, or a reinstall silently registers a second host');
  } finally { await gw.close(); }
});

test('minting a provider token hands back a command that names the machine', async () => {
  const gw = await startConsole();
  try {
    const up = await form(gw, '/signup', { email: 'mint@dev.io', invite: 'potter' });
    const cookie = up.headers.get('set-cookie').split(';')[0];
    const res = await form(gw, '/keys/new',
      { kind: 'provider_token', label: 'MacBook Air M5 24GB' }, cookie);
    const html = await res.text();

    // Without OCM_AGENT_ID the installer defaults to `hostname -s`, and a second
    // install of the same machine registers a duplicate host rather than
    // recovering it. The label was just typed; carry it through.
    assert.match(html, /OCM_AGENT_ID="macbook-air-m5-24gb"/,
      'the install command must carry the label as the agent id, slugged');
    assert.match(html, /OCM_HOST_TOKEN="ocm_host_/);

    // A label with shell metacharacters must not survive into the command.
    const nasty = await form(gw, '/keys/new',
      { kind: 'provider_token', label: 'a"; rm -rf /; #' }, cookie);
    const nastyHtml = await nasty.text();
    const id = nastyHtml.match(/OCM_AGENT_ID="([^"]*)"/);
    if (id) assert.match(id[1], /^[a-z0-9-]*$/, 'the agent id must be slugged to [a-z0-9-]');

    // A developer key is not installed on a machine, so it gets no agent id.
    const dev = await form(gw, '/keys/new', { kind: 'developer_key', label: 'laptop' }, cookie);
    assert.doesNotMatch(await dev.text(), /OCM_AGENT_ID/);
  } finally { await gw.close(); }
});

test('a freshly installed MLX provider advertises the name consumers request', () => {
  // The console, the docs and every example tell a consumer to ask for `ocm-coder`.
  // An MLX host with no OCM_MODEL_MAP advertises the raw model id instead, so a
  // provider created by this installer was unreachable by the documented call.
  const src = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
  assert.match(src, /MODEL_MAP="\$\{OCM_MODEL_MAP:-ocm-coder=\$MLX_MODEL\}"/,
    'the installer must default the model map to the public alias');
  assert.match(src, /^OCM_MODEL_MAP=\$MODEL_MAP$/m,
    'the map must be written into agent.env');
  // Between the heredoc opener and its closing delimiter (a line that is just ENV).
  const openAt = src.indexOf('cat > /etc/ocm/agent.env <<ENV');
  const body = src.slice(openAt, src.indexOf('\nENV\n', openAt));
  assert.match(body, /OCM_MODEL_MAP=\$MODEL_MAP/,
    'the map must be written inside the agent.env heredoc');
});

test('the installer waits for launchd teardown before bootstrapping', () => {
  // bootout is asynchronous. Bootstrapping into a half-torn-down job fails, and
  // under `set -eu` the script died having already removed the working daemon —
  // so a reinstall took a healthy provider offline and left it there.
  const src = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
  const boot = src.slice(src.indexOf('launchctl bootout system/com.ocm.agent'));
  const wait = boot.indexOf('launchctl print system/com.ocm.agent');
  const bootstrap = boot.indexOf('launchctl bootstrap system');
  assert.ok(wait > 0 && wait < bootstrap,
    'a wait for teardown must sit between bootout and bootstrap');
  assert.match(boot.slice(0, boot.indexOf('PLIST') > 0 ? undefined : undefined),
    /NO agent running/,
    'a failed bootstrap must say the machine is left with no agent, not exit quietly');
});

test('a public alias reaches a host that advertises only the raw build', async () => {
  const gw = await startGateway({ modelAliases: 'ocm-coder=raw-build-7b' });
  try {
    // This host never set OCM_MODEL_MAP, so it advertises its runtime's own id —
    // the situation every MLX provider our installer created was in.
    await connectHost(gw, { id: 'raw-host', models: ['raw-build-7b'], behaviour: echoHost });

    assert.equal(gw.registry.pick('ocm-coder').id, 'raw-host',
      'the alias must find a host advertising the underlying build');
    assert.equal(gw.registry.pick('raw-build-7b').id, 'raw-host',
      'the raw name must keep working for anyone already using it');

    // The catalogue publishes the documented name, not the raw id.
    const models = (await (await fetch(`${gw.base}/v1/models`)).json()).data.map((m) => m.id);
    assert.deepEqual(models, ['ocm-coder']);

    // And the host is asked for the name it actually knows.
    const host = gw.registry.get('raw-host');
    assert.equal(gw.registry.wireName(host, 'ocm-coder'), 'raw-build-7b');
    assert.equal(gw.registry.wireName(host, 'raw-build-7b'), 'raw-build-7b');
    assert.equal(gw.registry.wireName(host, 'something-else'), null);

    const r = await (await post(gw, { model: 'ocm-coder',
      messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.ok(r.choices[0].message.content, 'a request under the alias must be served');
  } finally { await gw.close(); }
});

test('a host advertising the public name is dispatched under it unchanged', async () => {
  const gw = await startGateway({ modelAliases: 'ocm-coder=raw-build-7b' });
  try {
    await connectHost(gw, { id: 'mapped-host', models: ['ocm-coder'], behaviour: echoHost });
    const host = gw.registry.get('mapped-host');
    assert.equal(gw.registry.wireName(host, 'ocm-coder'), 'ocm-coder',
      'a host that already publishes the alias must not be rewritten');
    assert.equal(gw.registry.wireName(host, 'raw-build-7b'), null,
      'it does not advertise the raw build, so it must not be offered it');
  } finally { await gw.close(); }
});

test('routing prefers a warm host, but lets a cold one warm up', async () => {
  const gw = await startGateway();
  try {
    // Two hosts serving the same model. Neither has produced a token, so neither
    // is warm and the tie breaks on inflight.
    await connectHost(gw, { id: 'host-a', behaviour: echoHost });
    await connectHost(gw, { id: 'host-b', behaviour: echoHost });
    const both = new Set();
    for (let i = 0; i < 6; i++) both.add(gw.registry.pick('qwen3-8b').id);
    assert.equal(both.size >= 1, true);

    // Serve one request: host-a produces tokens, so it becomes warm for MODEL.
    await (await post(gw, ask())).json();
    const warm = [...gw.registry.online()].filter((h) => gw.registry.isWarm(h, 'qwen3-8b'));
    assert.equal(warm.length, 1, 'exactly the host that produced tokens is warm');
    const warmId = warm[0].id;

    // A warm host with room must win over a cold idle one — the whole point.
    assert.equal(gw.registry.pick('qwen3-8b').id, warmId,
      'a warm host must outrank a cold host that merely looks idle');

    // Saturate the warm host. Now the cold one is the better choice: it costs one
    // slow request and then competes, instead of being starved forever.
    const host = gw.registry.get(warmId);
    const stub = () => ({ onChunk() {}, onDone() {}, onError() {} });
    host.inflight.set('j1', stub()); host.inflight.set('j2', stub());
    assert.notEqual(gw.registry.pick('qwen3-8b').id, warmId,
      'past the cap, work must go to a cold host rather than queue deeper');

    // Warmth is per model, not per host.
    assert.equal(gw.registry.isWarm(host, 'some-other-model'), false);
  } finally { await gw.close(); }
});

test('warmth is recorded from tokens produced, never from dispatch', async () => {
  const gw = await startGateway();
  try {
    // A host that accepts a job and produces nothing must not be marked warm.
    await connectHost(gw, { id: 'silent', behaviour: echoHost });
    const h = gw.registry.get('silent');
    h.warm.clear();
    assert.equal(gw.registry.isWarm(h, 'qwen3-8b'), false);
    h.warm.set('qwen3-8b', Date.now() - (21 * 60_000));
    assert.equal(gw.registry.isWarm(h, 'qwen3-8b'), false, 'warmth must expire');
    h.warm.set('qwen3-8b', Date.now());
    assert.equal(gw.registry.isWarm(h, 'qwen3-8b'), true);
  } finally { await gw.close(); }
});

test('the installer generates a run wrapper that forwards its arguments', () => {
  // This is generated by an UNQUOTED heredoc, so $UV and $PREFIX must expand at
  // install time — but anything else with a $ expands then too. A bare "$@" there
  // expanded to the INSTALLER's own arguments, baking a literal "" into the wrapper;
  // argparse rejects that, so the daemon could not start at all. Escaping the quotes
  // as well is the other wrong answer: it passes a literal `"--doctor"`, quotes and
  // all. So generate the file for real and run it, rather than grepping for a shape.
  const src = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
  const open = 'cat > "$PREFIX/bin/ocm-agent-run" <<RUN';
  const start = src.indexOf(open);
  assert.ok(start > 0, 'the wrapper heredoc must exist');
  const block = src.slice(start, src.indexOf('\nRUN\n', start) + 5);

  const dir = mkdtempSync(join(tmpdir(), 'ocm-wrap-'));
  execFileSync('sh', ['-c', `PREFIX=${dir}; UV=/bin/echo; mkdir -p $PREFIX/bin; ${block}`]);
  const wrapper = readFileSync(join(dir, 'bin', 'ocm-agent-run'), 'utf8');
  assert.match(wrapper, /agent\.py "\$@"\s*$/,
    'the wrapper must forward "$@" literally');
  assert.doesNotMatch(wrapper, /agent\.py ""/,
    'the installer\'s own empty arguments must not be baked in');

  // And it has to behave, not merely look right.
  execFileSync('chmod', ['+x', join(dir, 'bin', 'ocm-agent-run')]);
  const run = (args) => execFileSync('sh',
    ['-c', `. /dev/null; ${join(dir, 'bin', 'ocm-agent-run')} ${args} 2>/dev/null || true`],
    { encoding: 'utf8' });
  assert.match(run('--doctor'), /agent\.py --doctor\s*$/,
    '--doctor must reach the agent unquoted');
  assert.doesNotMatch(run(''), /agent\.py \S/,
    'no arguments must mean no arguments');

  // `umask 077` is set earlier for the token file and stays in effect, so a bare
  // `chmod +x` leaves these helpers root-only. Neither holds a secret, and 700 blocks
  // the owner from reading back what was installed — the verification we ask for.
  assert.match(src, /chmod 755 "\$PREFIX\/bin\/ocm-agent-run"/,
    'the run wrapper must be readable, not 700');
  assert.match(src, /chmod 755 "\$PREFIX\/bin\/ocm-agent-token"/,
    'the rotation helper must be readable too');
  assert.match(src, /chmod 600 \/etc\/ocm\/agent\.env/,
    'the token file itself must stay root-only');
});

test('the installer hash is published and matches the bytes served', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/install.sh.sha256`);
    assert.equal(res.status, 200);
    const [hex, name] = (await res.text()).trim().split(/\s+/);
    assert.match(hex, /^[0-9a-f]{64}$/, 'a sha256 hex digest');
    assert.equal(name, 'install.sh', 'shasum -c parseable');

    // The published hash must be of the file actually served, not a build artifact
    // that can drift from it.
    const script = await (await fetch(`${gw.base}/install.sh`)).text();
    const actual = createHash('sha256').update(script).digest('hex');
    assert.equal(hex, actual, 'the published hash must match the served installer');
  } finally { await gw.close(); }
});

test('onboarding copy states the facts that stopped providers', async () => {
  const gw = await startConsole();
  try {
    // Signed out: the recruiting page carries the credit facts and the agent block.
    const guide = await (await fetch(`${gw.base}/console/provider`)).text();
    assert.match(guide, /not money/i, 'credits must be defined honestly');
    assert.match(guide, /up to about 90\s*seconds|~90s/i, 'cold start must be documented');
    assert.match(guide, /Setting this up with an AI agent/i, 'the agent block must be present');
    assert.match(guide, /brew install uv/, 'the root-shell-free path must be offered');

    // Prose tables must wrap. A blanket td{white-space:nowrap} once forced a whole
    // paragraph onto one line, giving that column a ~1400px width on a 390px phone,
    // which is what triggered iOS to inflate its text out of proportion.
    // The intent, not a count: any table on this page carries prose and must wrap.
    // A blanket nowrap once forced a paragraph onto one line, giving that column a
    // ~1400px width on a 390px phone and triggering iOS to inflate its text.
    const proseTables = guide.match(/<div class="tablewrap"><table>/g) || [];
    assert.ok(proseTables.length >= 1, 'the guide should still have a prose table');
    assert.doesNotMatch(guide, /<div class="tablewrap"><table class="data">/,
      'prose tables must not be marked as data tables');
    assert.doesNotMatch(guide, /agent yields when you need the GPU/,
      'the unimplemented yielding claim must be gone');

    // Signup: the first screen everyone sees must not imply providers are blocked.
    const up = await form(gw, '/signup', { email: 'prov@dev.io' });
    const upHtml = await up.text();
    assert.match(upHtml, /needs no invite code/i,
      'the post-signup page must tell a provider they need no code');

    // The zero-balance banner says the same.
    const cookie = up.headers.get('set-cookie').split(';')[0];
    const home = await (await fetch(`${gw.base}/console`, { headers: { cookie } })).text();
    assert.match(home, /does not affect running a provider/i);
  } finally { await gw.close(); }
});

test('the gateway serves the agent and installer it expects', async () => {
  const gw = await startGateway();
  try {
    const agent = await fetch(`${gw.base}/agent.py`);
    assert.equal(agent.status, 200);
    assert.match(agent.headers.get('content-type'), /python/);
    const py = await agent.text();
    assert.match(py, /OCM host agent/, 'must be the real agent');
    assert.match(py, /class MlxRuntime/);

    const install = await fetch(`${gw.base}/install.sh`);
    assert.equal(install.status, 200);
    const sh = await install.text();
    assert.match(sh, /Apple Silicon is required/, 'the installer must refuse Intel Macs');
    assert.match(sh, /OCM_HOST_TOKEN/);
    assert.match(sh, /launchctl bootstrap/, 'it must install a persistent service');
    assert.match(sh, /plaintext/, 'it must be honest about what a provider can see');
    assert.doesNotMatch(sh, /ocm_host_[A-Za-z0-9_-]{10}/, 'no real token may be baked in');
  } finally { await gw.close(); }
});

test('the Network tab exists only for admin emails and lists every account', async () => {
  const gw = await startConsole({ adminEmails: 'Boss@dev.io, other@dev.io' });
  try {
    const anon = await fetch(`${gw.base}/console/network`, { redirect: 'manual' });
    assert.equal(anon.status, 302, 'anonymous must be redirected');

    const u = await form(gw, '/signup', { email: 'user@dev.io', invite: 'potter' });
    const uCookie = u.headers.get('set-cookie').split(';')[0];
    const uHome = await (await fetch(`${gw.base}/console`, { headers: { cookie: uCookie } })).text();
    assert.doesNotMatch(uHome, /href="\/network"/, 'non-admins must not see the tab');
    const uNet = await fetch(`${gw.base}/console/network`, { redirect: 'manual', headers: { cookie: uCookie } });
    assert.equal(uNet.status, 302, 'non-admins are redirected, not shown a 403');

    const a = await form(gw, '/signup', { email: 'boss@dev.io', invite: 'potter' });
    const aCookie = a.headers.get('set-cookie').split(';')[0];
    const aHome = await (await fetch(`${gw.base}/console`, { headers: { cookie: aCookie } })).text();
    assert.match(aHome, /href="\/network"/, 'admins see the tab (match is case-insensitive)');
    const net = await fetch(`${gw.base}/console/network`, { headers: { cookie: aCookie } });
    assert.equal(net.status, 200);
    const html = await net.text();
    assert.match(html, /user@dev\.io/, 'the network page lists other accounts');
    assert.match(html, /boss@dev\.io/);

    // The anonymous counters must not have grown an email column as a side effect.
    const stats = JSON.stringify(await (await fetch(`${gw.base}/console/stats.json`)).json());
    assert.doesNotMatch(stats, /@dev\.io/);
  } finally { await gw.close(); }
});

test('revoking a key ends its console session immediately', async () => {
  const gw = await startConsole();
  try {
    const signup = await form(gw, '/signup', { email: 'rev@dev.io', invite: 'potter' });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const secret = (await signup.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const acct = (await gw.accounts.resolve(secret, 'developer_key')).accountId;
    const cred = (await gw.accounts.listCredentials(acct))[0];

    // Signed in and working.
    const before = await (await fetch(`${gw.base}/console`, { headers: { cookie } })).text();
    assert.match(before, /rev@dev\.io/);

    await gw.accounts.revoke(cred.id);

    // The API refuses it — and so must the console, with the same cookie.
    await connectHost(gw, { id: 'h1', behaviour: echoHost });
    assert.equal((await post(gw, ask(), secret)).status, 401);

    const after = await fetch(`${gw.base}/console`, { headers: { cookie } });
    const html = await after.text();
    assert.doesNotMatch(html, /rev@dev\.io/,
      'a revoked key must not keep its browser session alive');
    assert.match(html, /Sign in/);
    assert.match(after.headers.get('set-cookie') || '', /ocm_session=;/,
      'the dead cookie should be cleared, not just ignored');
  } finally { await gw.close(); }
});

test('a session cookie naming another account cannot be forged', async () => {
  const gw = await startConsole();
  try {
    const a = await form(gw, '/signup', { email: 'victim@dev.io', invite: 'potter' });
    const aSecret = (await a.text()).match(/ocm_live_[A-Za-z0-9_-]+/)[0];
    const aAcct = (await gw.accounts.resolve(aSecret, 'developer_key')).accountId;
    const aCred = (await gw.accounts.listCredentials(aAcct))[0];

    const b = await form(gw, '/signup', { email: 'attacker@dev.io', invite: 'potter' });
    const bCookie = b.headers.get('set-cookie').split(';')[0];

    // Swap the account id into an otherwise valid-looking cookie: the HMAC covers it.
    const forged = bCookie.replace(/ocm_session=[^.]+\./, `ocm_session=${aAcct}.`);
    const res = await fetch(`${gw.base}/console`, { headers: { cookie: forged } });
    const html = await res.text();
    assert.doesNotMatch(html, /victim@dev\.io/, 'account id in the cookie must be signed');
    assert.match(html, /Sign in/);
    void aCred;
  } finally { await gw.close(); }
});
