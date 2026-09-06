/**
 * Enrollment codes (ROADMAP P1): a short-lived, single-use code the installer exchanges
 * for a provider token already bound to the machine.
 *
 * What is pinned here, and why:
 *   - a code works exactly once, and unknown / used / expired produce one identical
 *     answer, so the endpoint is not an oracle for which codes exist;
 *   - the token it produces is bound to the presented agent id at mint, not on first
 *     connect, so a leaked exchange response still cannot be used from another machine;
 *   - re-enrolling the same machine name on the same account revokes the older token,
 *     which is what makes rotation automatic and "was this Mac registered?" moot;
 *   - the console mints codes only for the signed-in account; the code is rendered once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

const ADMIN = 'admin-token-for-enrollment-tests';
const INVALID = 'enrollment code is not valid: unknown, already used, or expired';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-enroll-'));
  const gw = await createGateway({
    adminToken: ADMIN,
    sessionSecret: 'enrollment-test-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
    modelAliases: '',
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const enroll = (base, body) => fetch(`${base}/v1/provider/enroll`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const verify = (base, token) => fetch(`${base}/v1/provider/verify`,
  { headers: { authorization: `Bearer ${token}` } });

test('a code is exchanged once for a token bound to the machine; unknown, used and expired are one answer', async () => {
  const gw = await startGateway();
  try {
    const account = await gw.accounts.createAccount('enroll-one@example.test');
    const issued = await gw.accounts.issueEnrollment(account.id, 'Studio Mac');
    assert.match(issued.code, /^ocm_enroll_[-A-Za-z0-9_]{16,}$/);
    assert.ok(issued.expires_at > new Date(), 'a fresh code is not yet expired');

    const ok = await enroll(gw.base, { code: issued.code, agent_id: 'studio-mac' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.match(body.token, /^ocm_host_[-A-Za-z0-9_]{16,}$/);
    assert.equal(body.agent_id, 'studio-mac');
    assert.equal(body.label, 'Studio Mac', 'the label given at issue time names the token');
    assert.equal(body.rotated, 0);
    assert.ok(!('account_id' in body) && !('email' in body), 'the exchange reveals no account identity');

    // The token is real and bound at mint: another machine name is refused outright.
    assert.equal((await verify(gw.base, body.token)).status, 200);
    const found = await gw.accounts.resolve(body.token, 'provider_token');
    const other = await gw.accounts.claimAgent(found.credentialId, 'some-other-mac');
    assert.equal(other.ok, false);
    assert.equal(other.boundTo, 'studio-mac');
    const same = await gw.accounts.claimAgent(found.credentialId, 'studio-mac');
    assert.equal(same.ok, true);

    // Second use, an unknown but well-formed code, and an expired code: identical answers.
    const used = await enroll(gw.base, { code: issued.code, agent_id: 'studio-mac' });
    const unknown = await enroll(gw.base, { code: 'ocm_enroll_' + 'A'.repeat(32), agent_id: 'studio-mac' });
    const shortLived = await gw.accounts.issueEnrollment(account.id, 'gone', 1);
    await new Promise((r) => setTimeout(r, 5));
    const expired = await enroll(gw.base, { code: shortLived.code, agent_id: 'studio-mac' });
    for (const res of [used, unknown, expired]) assert.equal(res.status, 401);
    const bodies = await Promise.all([used, unknown, expired].map((r) => r.text()));
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[1], bodies[2]);
    assert.match(bodies[0], new RegExp(INVALID));
    assert.doesNotMatch(bodies[0], /acct_|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);

    // Malformed input is a 400, never a lookup.
    assert.equal((await enroll(gw.base, { code: 'ocm_host_' + 'A'.repeat(32), agent_id: 'x' })).status, 400);
    assert.equal((await enroll(gw.base, { code: issued.code, agent_id: 'bad name!' })).status, 400);
    assert.equal((await enroll(gw.base, { code: issued.code })).status, 400);
    const notJson = await fetch(`${gw.base}/v1/provider/enroll`, { method: 'POST', body: '{' });
    assert.equal(notJson.status, 400);

    // The code itself is not a provider token, and the verify route says so.
    const asBearer = await verify(gw.base, issued.code);
    assert.equal(asBearer.status, 401);
    assert.match(await asBearer.text(), /enrollment code/);

    // Pending list never carries the code, and drops a used one.
    const pending = await gw.accounts.listEnrollments(account.id);
    assert.deepEqual(pending, [], 'used and expired codes are not pending');
    const fresh = await gw.accounts.issueEnrollment(account.id, 'later');
    const list = await gw.accounts.listEnrollments(account.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'later');
    assert.ok(!('code' in list[0]) && !('hash' in list[0]));
    void fresh;
  } finally { await gw.close(); }
});

test('re-enrolling the same machine name rotates: the older token is revoked, the new one works', async () => {
  const gw = await startGateway();
  try {
    const account = await gw.accounts.createAccount('enroll-rotate@example.test');
    // A hand-issued token that this machine already uses.
    const legacy = await gw.accounts.issue(account.id, 'provider_token', 'mac');
    const claim = await gw.accounts.claimAgent(legacy.id, 'mac');
    assert.equal(claim.ok, true);
    // A token bound to a *different* machine on the same account must survive.
    const sibling = await gw.accounts.issue(account.id, 'provider_token', 'mac-2', { boundAgentId: 'mac-2' });

    const first = await gw.accounts.issueEnrollment(account.id, 'mac');
    const r1 = await (await enroll(gw.base, { code: first.code, agent_id: 'mac' })).json();
    assert.equal(r1.rotated, 1, 'the legacy token bound to mac was rotated out');
    assert.equal(await gw.accounts.resolve(legacy.secret, 'provider_token'), null, 'legacy token is revoked');
    assert.ok(await gw.accounts.resolve(r1.token, 'provider_token'), 'new token works');
    assert.ok(await gw.accounts.resolve(sibling.secret, 'provider_token'), 'mac-2 untouched');

    const second = await gw.accounts.issueEnrollment(account.id, 'mac');
    const r2 = await (await enroll(gw.base, { code: second.code, agent_id: 'mac' })).json();
    assert.equal(r2.rotated, 1);
    assert.equal(await gw.accounts.resolve(r1.token, 'provider_token'), null, 'previous enrolled token is revoked');
    assert.ok(await gw.accounts.resolve(r2.token, 'provider_token'));

    // Another account enrolling the same name does not touch this account's tokens.
    const otherAccount = await gw.accounts.createAccount('enroll-other@example.test');
    const theirs = await gw.accounts.issueEnrollment(otherAccount.id, 'mac');
    const r3 = await (await enroll(gw.base, { code: theirs.code, agent_id: 'mac' })).json();
    assert.equal(r3.rotated, 0);
    assert.ok(await gw.accounts.resolve(r2.token, 'provider_token'), 'first account still has its token');
  } finally { await gw.close(); }
});

test('the console mints a code for the signed-in account only, shows it once, and the admin route mints for any account', async () => {
  const gw = await startGateway();
  try {
    const account = await gw.accounts.createAccount('enroll-console@example.test');
    const key = await gw.accounts.issue(account.id, 'developer_key', 'laptop');

    // No session: bounce, no code.
    const anon = await fetch(`${gw.base}/console/enroll`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'label=mac' });
    assert.equal(anon.status, 302);
    assert.doesNotMatch(await anon.text(), /ocm_enroll_/);

    const signin = await fetch(`${gw.base}/console/signin`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `key=${encodeURIComponent(key.secret)}` });
    const cookie = (signin.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'sign-in issues a session cookie');

    const page = await fetch(`${gw.base}/console/enroll`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'label=' + encodeURIComponent('Studio Mac') });
    assert.equal(page.status, 200);
    const body = await page.text();
    const codes = body.match(/ocm_enroll_[-A-Za-z0-9_]{16,}/g) || [];
    assert.equal(codes.length, 1, 'the code is rendered exactly once');
    assert.match(body, /works once/);
    assert.match(body, /OCM_AGENT_ID="studio-mac"/, 'the label becomes the suggested machine name');
    assert.doesNotMatch(body, /acct_[A-Za-z0-9_-]{6,}|ocm_host_|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
      'the code page carries no account id, token or email');

    // That code belongs to this account: exchanging it yields a token on it.
    const ex = await (await enroll(gw.base, { code: codes[0], agent_id: 'studio-mac' })).json();
    const found = await gw.accounts.resolve(ex.token, 'provider_token');
    assert.equal(found.accountId, account.id);

    // The dashboard offers enrollment first and reports outstanding codes.
    await gw.accounts.issueEnrollment(account.id, 'pending-one');
    const dash = await (await fetch(`${gw.base}/console/`, { headers: { cookie } })).text();
    assert.match(dash, /Enroll a Mac/);
    assert.match(dash, /1 enrollment code outstanding/);
    assert.doesNotMatch(dash, /ocm_enroll_/, 'the dashboard never shows a code');

    // Admin path.
    const noAdmin = await fetch(`${gw.base}/admin/enroll`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id: account.id }) });
    assert.equal(noAdmin.status, 401);
    const admin = await fetch(`${gw.base}/admin/enroll`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ account_id: account.id, label: 'ops-mac', ttl_minutes: 5 }) });
    assert.equal(admin.status, 200);
    const minted = await admin.json();
    assert.match(minted.code, /^ocm_enroll_/);
    const ttl = new Date(minted.expires_at) - Date.now();
    assert.ok(ttl > 4 * 60 * 1000 && ttl <= 5 * 60 * 1000, `ttl_minutes is honoured (${ttl}ms)`);
  } finally { await gw.close(); }
});
