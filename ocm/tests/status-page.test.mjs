/**
 * Public status page (ROADMAP P6): "N providers online, tokens served today", with
 * no account identity. Readable signed out, so the probe here is adversarial about
 * what leaks rather than about what renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createGateway } from '../gateway/server.mjs';
import { Ledger, startOfUtcDay } from '../gateway/ledger.mjs';

const CONSOLE_HOST = 'console.test.invalid';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-status-'));
  const gw = await createGateway({
    sessionSecret: 'status-page-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    modelAliases: '',
    consoleHost: CONSOLE_HOST,
  });
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', async () => {
      const acct = await gw.accounts.createAccount('owner@test.io');
      const port = gw.server.address().port;
      resolve({ ...gw, hostAccountId: acct.id, port,
                base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
    });
  });
}

/** A stub provider that connects the way a real one does: header auth, then hello. */
async function connectHost(gw, id, models) {
  const cred = await gw.accounts.issue(gw.hostAccountId, 'provider_token', `stub ${id}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${cred.secret}` } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello',
        agent: { id, models, chip: 'Apple M-stub', memory_gb: 24, region: 'local' } }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') resolve(ws);
    });
  });
}

/** Plain http.request, because fetch will not let a test set the Host header. */
function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET',
                              headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the status page shows providers and totals and nothing about accounts', async () => {
  const gw = await startGateway();
  const sockets = [];
  try {
    sockets.push(await connectHost(gw, 'stub-one', ['ocm-coder']));
    sockets.push(await connectHost(gw, 'stub-two', ['ocm-coder', 'other-model']));

    // Two usage rows today, one grant, and one usage row from yesterday that must
    // count all-time but not today.
    await gw.ledger.grant(gw.hostAccountId, 5000, 'test grant');
    await gw.ledger.clear({ consumer: gw.hostAccountId, host: 'stub-one', model: 'ocm-coder',
                            promptTokens: 100, completionTokens: 40, jobId: 'job-a' });
    await gw.ledger.clear({ consumer: gw.hostAccountId, host: 'stub-two', model: 'ocm-coder',
                            promptTokens: 10, completionTokens: 5, jobId: 'job-b' });
    const yesterday = new Date(startOfUtcDay().getTime() - 60_000).toISOString();
    gw.ledger.entries.push({ id: 'old', at: yesterday, kind: 'usage', consumer: gw.hostAccountId,
      host: 'stub-one', model: 'ocm-coder', jobId: 'job-old',
      promptTokens: 1000, completionTokens: 1000, tokens: 2000 });

    const today = await gw.ledger.servedToday();
    assert.deepEqual(today, { since: startOfUtcDay().toISOString(), requests: 2,
                              prompt_tokens: 110, completion_tokens: 45 });

    const res = await get(gw.port, '/console/status');
    assert.equal(res.status, 200);
    const body = res.body;

    // What it must show.
    assert.match(body, /Providers online<\/div><div class="v">2</);
    assert.match(body, /stub-one/);
    assert.match(body, /stub-two/);
    assert.match(body, /Tokens served today<\/div><div class="v">155</);
    assert.match(body, /Tokens served all time<\/div><div class="v">2,155</);
    assert.match(body, /Requests today<\/div><div class="v">2</);
    assert.match(body, /Cold/, 'an idle host that has never loaded a model is cold, not warming');
    assert.match(body, /other-model/);
    assert.match(body, /href="\/provider"/);

    // What it must never show. The hosts belong to an account with an email and an
    // id, and the ledger holds a consumer id and a grant; none of it may surface.
    // The stylesheet has `@media`, so look for an address, not the character.
    assert.doesNotMatch(body, /[\w.+-]+@[\w-]+\.[\w.]+/, 'no email address on a public page');
    assert.doesNotMatch(body, /owner@|test\.io/, 'the host owner must not surface');
    assert.doesNotMatch(body, /acct_/, 'no account id on a public page');
    assert.doesNotMatch(body, /ocm_(live|host)_/, 'no credential on a public page');
    assert.doesNotMatch(body, /5,000|balance|granted/i, 'no balances or grants');
    assert.doesNotMatch(body, /job-/, 'no per-request log');

    // On the console host, /status is the same page.
    const short = await get(gw.port, '/status', CONSOLE_HOST);
    assert.equal(short.status, 200);
    assert.match(short.body, /Network status/);

    // Off the console host, /status is not an API route.
    const api = await get(gw.port, '/status');
    assert.equal(api.status, 404);
  } finally {
    for (const ws of sockets) ws.close();
    await gw.close();
  }
});

test('an empty network renders honestly', async () => {
  const gw = await startGateway();
  try {
    const res = await get(gw.port, '/console/status');
    assert.equal(res.status, 200);
    assert.match(res.body, /Providers online<\/div><div class="v">0</);
    assert.match(res.body, /No providers connected right now/);
    assert.match(res.body, /Tokens served today<\/div><div class="v">0</);
  } finally { await gw.close(); }
});

test('servedToday uses a UTC day boundary on the JSONL ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-status-ledger-'));
  const ledger = await new Ledger(join(dir, 'usage.jsonl')).init();
  const at = new Date('2026-09-06T23:30:00Z');
  const row = { consumer: 'c', host: 'h', model: 'm', promptTokens: 3, completionTokens: 4 };
  await ledger.clear({ ...row, jobId: 'j1' });
  ledger.entries[0].at = '2026-09-06T00:00:00.000Z';   // exactly midnight counts
  await ledger.clear({ ...row, jobId: 'j2' });
  ledger.entries[1].at = '2026-09-05T23:59:59.000Z';   // one second earlier does not
  const t = await ledger.servedToday(at);
  assert.equal(t.since, '2026-09-06T00:00:00.000Z');
  assert.equal(t.requests, 1);
  assert.equal(t.prompt_tokens, 3);
  assert.equal(t.completion_tokens, 4);
});
