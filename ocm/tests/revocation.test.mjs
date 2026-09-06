/**
 * Rubric §B: rotate by id, never by label. Labels are free text, so `mac` is a
 * prefix of `mac-2`, and a substring match on a revoke row can kill the credential a
 * machine is actively using. These tests pin the two guarantees ROADMAP S9 asks for:
 * the console shows the id so a person can act on it, and any scripted path that
 * accepts a label matches exactly and refuses unless exactly one row matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAccounts } from '../gateway/accounts.mjs';
import { createGateway } from '../gateway/server.mjs';

function ready(gw) {
  return new Promise((resolve) => {
    gw.server.listen(0, '127.0.0.1', () => {
      resolve({ ...gw, base: `http://127.0.0.1:${gw.server.address().port}` });
    });
  });
}

function startAdmin() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  return createGateway({
    adminToken: 'test-admin',
    inviteCode: 'potter',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 1_000,
  }).then(ready);
}

const admin = (gw, path, body) => fetch(`${gw.base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin' },
  body: JSON.stringify(body),
});

test('store: a label lookup is exact and whole-string, never a prefix or substring', async () => {
  const accounts = new MemoryAccounts();
  const acct = await accounts.createAccount('labels@dev.io');
  const other = await accounts.createAccount('other@dev.io');
  const short = await accounts.issue(acct.id, 'provider_token', 'mac');
  const long = await accounts.issue(acct.id, 'provider_token', 'mac-2');
  const upper = await accounts.issue(acct.id, 'provider_token', 'MAC');
  const elsewhere = await accounts.issue(other.id, 'provider_token', 'mac');

  const ids = (rows) => rows.map((r) => r.id).sort();
  assert.deepEqual(ids(await accounts.findByLabel(acct.id, 'mac')), [short.id],
    '`mac` must match only `mac`, not `mac-2` or `MAC`');
  assert.deepEqual(ids(await accounts.findByLabel(acct.id, 'mac-2')), [long.id]);
  assert.deepEqual(ids(await accounts.findByLabel(acct.id, 'MAC')), [upper.id]);
  assert.deepEqual(await accounts.findByLabel(acct.id, 'ma'), [], 'a prefix matches nothing');
  assert.deepEqual(await accounts.findByLabel(acct.id, 'ac-'), [], 'a substring matches nothing');
  assert.deepEqual(await accounts.findByLabel(acct.id, 'mac%'), [], 'LIKE syntax is literal');
  assert.deepEqual(await accounts.findByLabel(acct.id, ''), [], 'an empty label matches nothing');
  assert.deepEqual(await accounts.findByLabel(acct.id, null), [], 'a missing label matches nothing');
  assert.ok(!ids(await accounts.findByLabel(acct.id, 'mac')).includes(elsewhere.id),
    'a lookup is scoped to the account');

  await accounts.revoke(short.id);
  assert.deepEqual(await accounts.findByLabel(acct.id, 'mac'), [],
    'a revoked credential is not a live match');
});

test('/admin/revoke by label is exact and refuses unless exactly one live row matches', async () => {
  const gw = await startAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'r@evoke.io' })).json();
    const issue = async (label) => (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label })).json();
    const mac = await issue('mac');
    const mac2 = await issue('mac-2');
    const alive = async (cred) =>
      (await fetch(`${gw.base}/v1/provider/verify`,
        { headers: { authorization: `Bearer ${cred.secret}` } })).status === 200;

    assert.equal(await alive(mac), true);
    assert.equal(await alive(mac2), true);

    // A label is never a prefix match: `mac` is still running, `mac-2` goes.
    let r = await admin(gw, '/admin/revoke', { account_id: acct.id, label: 'mac-2' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { revoked: true, credential_id: mac2.id });
    assert.equal(await alive(mac2), false, 'the exact match was revoked');
    assert.equal(await alive(mac), true, 'the credential whose label is a prefix must survive');

    // A prefix, a substring and a case variant identify nothing.
    for (const label of ['ma', 'ac', 'MAC', 'mac%', 'mac-']) {
      r = await admin(gw, '/admin/revoke', { account_id: acct.id, label });
      assert.equal(r.status, 404, `label ${JSON.stringify(label)} must match nothing`);
      assert.equal(await alive(mac), true, `label ${JSON.stringify(label)} must not revoke \`mac\``);
    }

    // Two live credentials with the same label: refuse, name the count, revoke nothing.
    const twin = await issue('mac');
    r = await admin(gw, '/admin/revoke', { account_id: acct.id, label: 'mac' });
    assert.equal(r.status, 409, 'an ambiguous label must be refused');
    assert.match((await r.json()).error.message, /2 live credentials/);
    assert.equal(await alive(mac), true);
    assert.equal(await alive(twin), true);

    // The ambiguity resolves by id, which is what the console and scripts should use.
    r = await admin(gw, '/admin/revoke', { credential_id: twin.id });
    assert.deepEqual(await r.json(), { revoked: true, credential_id: twin.id });
    assert.equal(await alive(twin), false);
    assert.equal(await alive(mac), true);

    // A label needs an account to be scoped to, and nothing at all is a 400.
    assert.equal((await admin(gw, '/admin/revoke', { label: 'mac' })).status, 400);
    assert.equal((await admin(gw, '/admin/revoke', {})).status, 400);
    assert.equal(await alive(mac), true);
  } finally { await gw.close(); }
});

test('the console credential table shows each credential id and acts by id', async () => {
  const gw = await startAdmin();
  try {
    const acct = await (await admin(gw, '/admin/accounts', { email: 'me@dev.io' })).json();
    const key = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'developer_key', label: 'laptop' })).json();
    const tok = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label: 'mac' })).json();
    const tok2 = await (await admin(gw, '/admin/credentials',
      { account_id: acct.id, kind: 'provider_token', label: 'mac' })).json();

    const signin = await fetch(`${gw.base}/console/signin`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: key.secret }).toString(),
    });
    const cookie = signin.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${gw.base}/console`, { headers: { cookie } })).text();

    assert.match(html, /<th>Id<\/th>/, 'the credential table must have an Id column');
    for (const c of [key, tok, tok2]) {
      assert.match(html, new RegExp(`<code>${c.id}</code>`), `row for ${c.label} must show its id`);
      assert.match(html, new RegExp(`name="credential_id" value="${c.id}"`),
        'every revoke form posts the id, never the label');
    }
    assert.doesNotMatch(html, /name="label"[^>]*value=/, 'no form acts on a label');
    assert.doesNotMatch(html, /ocm_(live|host)_[A-Za-z0-9_-]{8,}/, 'no secret is rendered');
  } finally { await gw.close(); }
});
