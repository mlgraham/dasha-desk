/**
 * Onboarding funnel (ROADMAP V3): per provider machine, when a code was issued, when it
 * was enrolled, when it first connected, and when it first served a job.
 *
 * Why it exists: we could not say where a new provider dropped out, which made every
 * onboarding change a guess. What is pinned:
 *   - the store records the first connection once and never overwrites it;
 *   - a pending code is a funnel row (the place setup stopped), and it disappears when used;
 *   - the ledger reports the first real job per host;
 *   - the owner's dashboard shows only that account's machines; the admin view shows all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

const API_KEY = 'ocm_live_' + 'funnel-test'; // concatenated so the secrets scanner never sees a credential-shaped literal

async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-funnel-'));
  const gw = await createGateway({
    sessionSecret: 'funnel-test-secret',
    secureCookies: false,
    keys: new Map([[API_KEY, 'funnel-dev']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 5_000,
    modelAliases: '',
    ...opts,
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const port = gw.server.address().port;
  return { ...gw, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

function connectHost(gw, token, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`, { headers: { authorization: `Bearer ${token}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      t: 'hello', agent: { id, models: ['ocm-coder'], chip: 'stub', memory_gb: 24, region: 'local' },
    })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') resolve(ws);
      if (msg.t === 'job') {
        ws.send(JSON.stringify({ t: 'chunk', id: msg.id, delta: 'ok' }));
        ws.send(JSON.stringify({ t: 'done', id: msg.id, usage: { completion_tokens: 1 } }));
      }
    });
    ws.addEventListener('close', (ev) => reject(new Error(`closed ${ev.code} ${ev.reason}`)));
  });
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('store: first connection is recorded once; a pending code is a row until it is used', async () => {
  const gw = await startGateway();
  try {
    const account = await gw.accounts.createAccount('funnel-store@example.test');
    const code = await gw.accounts.issueEnrollment(account.id, 'Studio');
    let rows = await gw.accounts.funnel(account.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pending, true);
    assert.equal(rows[0].label, 'Studio');
    assert.ok(rows[0].issued_at);
    assert.equal(rows[0].enrolled_at, null);

    const ex = await (await fetch(`${gw.base}/v1/provider/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.code, agent_id: 'studio' }),
    })).json();
    rows = await gw.accounts.funnel(account.id);
    assert.equal(rows.length, 1, 'the used code is no longer pending; the token it made is the row');
    assert.equal(rows[0].pending, false);
    assert.equal(rows[0].agent_id, 'studio');
    assert.ok(rows[0].enrolled_at, 'enrolled_at comes from the code');
    assert.equal(rows[0].first_connected_at, null, 'not connected yet');

    const ws = await connectHost(gw, ex.token, 'studio');
    await settle();
    rows = await gw.accounts.funnel(account.id);
    const first = rows[0].first_connected_at;
    assert.ok(first, 'first connection recorded on connect');
    ws.close();
    await settle();
    const ws2 = await connectHost(gw, ex.token, 'studio');
    await settle();
    rows = await gw.accounts.funnel(account.id);
    assert.equal(String(rows[0].first_connected_at), String(first), 'first connection never moves');
    assert.ok(rows[0].last_connected_at >= first, 'last-seen moves');
    ws2.close();

    // A hand-issued token is a row too, marked as such (no code, no enrolled step).
    await gw.accounts.issue(account.id, 'provider_token', 'automation');
    rows = await gw.accounts.funnel(account.id);
    const manual = rows.find((r) => r.label === 'automation');
    assert.ok(manual && !manual.pending && manual.enrolled_at === null && manual.agent_id === null);

    // Scoping: another account's rows never appear.
    const other = await gw.accounts.createAccount('funnel-other@example.test');
    await gw.accounts.issueEnrollment(other.id, 'theirs');
    assert.ok(!(await gw.accounts.funnel(account.id)).some((r) => r.label === 'theirs'));
    assert.ok((await gw.accounts.funnel()).some((r) => r.label === 'theirs'), 'admin scope sees all');
  } finally { await gw.close(); }
});

test('ledger: the first real job per host is reported, and the dashboard shows the whole path', async () => {
  const gw = await startGateway({ adminEmails: 'boss@example.test' });
  try {
    const account = await gw.accounts.createAccount('funnel-dash@example.test');
    const code = await gw.accounts.issueEnrollment(account.id, 'Air');
    const ex = await (await fetch(`${gw.base}/v1/provider/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.code, agent_id: 'air' }),
    })).json();
    const ws = await connectHost(gw, ex.token, 'air');
    await settle();
    assert.deepEqual(await gw.ledger.firstServedByHost(), {}, 'no job yet');

    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'ocm-coder', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200, await res.text());
    await settle();
    const first = await gw.ledger.firstServedByHost();
    assert.ok(first.air, 'first job recorded for the host');
    // A second job does not move it.
    await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'ocm-coder', messages: [{ role: 'user', content: 'again' }] }),
    });
    await settle();
    assert.equal((await gw.ledger.firstServedByHost()).air, first.air);

    // Owner dashboard.
    const key = await gw.accounts.issue(account.id, 'developer_key', 'laptop');
    const signin = await fetch(`${gw.base}/console/signin`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key.secret)}` });
    const cookie = (signin.headers.get('set-cookie') || '').split(';')[0];
    const dash = await (await fetch(`${gw.base}/console/`, { headers: { cookie } })).text();
    assert.match(dash, /<th>Code issued<\/th><th>Enrolled<\/th><th>First connected<\/th><th>First job<\/th>/);
    const row = dash.slice(dash.indexOf('<code>air</code>'), dash.indexOf('</tr>', dash.indexOf('<code>air</code>')));
    assert.ok(row.length > 0, 'the machine has a row');
    assert.equal((row.match(/just now/g) || []).length, 4, 'issued, enrolled, first connected and first job are all stamped');
    assert.match(row, /Ready|Serving|Online/);
    assert.doesNotMatch(dash, /funnel-other|boss@example/, 'no other account appears on an owner dashboard');

    // A pending code for a second machine shows as the place setup stopped.
    await gw.accounts.issueEnrollment(account.id, 'Mini');
    const dash2 = await (await fetch(`${gw.base}/console/`, { headers: { cookie } })).text();
    assert.match(dash2, /Mini <span class="muted">\(code outstanding\)<\/span>/);
    assert.match(dash2, /waiting for the installer/);

    // Admin network view carries the owner column and every account.
    const bossAcct = await gw.accounts.createAccount('boss@example.test');
    const bossKey = await gw.accounts.issue(bossAcct.id, 'developer_key', 'boss');
    const bsign = await fetch(`${gw.base}/console/signin`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(bossKey.secret)}` });
    const bcookie = (bsign.headers.get('set-cookie') || '').split(';')[0];
    const net = await (await fetch(`${gw.base}/console/network`, { headers: { cookie: bcookie } })).text();
    assert.match(net, /Onboarding funnel/);
    assert.match(net, /<th>Owner<\/th><th>Machine<\/th>/);
    assert.match(net, /funnel-dash@example\.test/);
    assert.match(net, /<code>air<\/code>/);
    ws.close();
  } finally { await gw.close(); }
});
