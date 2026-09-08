/**
 * Account recovery by email (ROADMAP S3).
 *
 * Accounts are identified by a developer key shown once. Losing it lost the account.
 * This is the emailed-link flow, and what is pinned:
 *   - the request form answers identically for known and unknown addresses (no oracle);
 *   - the link's page consumes nothing; only the explicit confirm does, once;
 *   - unknown, used and expired tokens get the same refusal;
 *   - a new key is minted, existing keys are untouched, the mailbox is marked verified;
 *   - outstanding links per account are capped, so a stranger cannot fill an inbox;
 *   - with the flag off, nothing exists: no link on the landing page, routes 404.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';
import { maskEmail, recoveryMessage } from '../gateway/mail.mjs';

function stubMailer() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { messageId: `stub-${sent.length}` }; } };
}

async function startGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-recovery-'));
  const gw = await createGateway({
    sessionSecret: 'recovery-test-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
    modelAliases: '',
    consoleHost: 'console.test',
    ...opts,
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const form = (base, path, fields, cookie) => fetch(`${base}/console${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

const linkIn = (mail) => (mail.text.match(/https:\/\/console\.test\/recover\/confirm\?t=(ocm_recover_[-A-Za-z0-9_]+)/) || [])[1];

test('the request form is not an oracle, the link is single-use, and existing keys survive', async () => {
  const mailer = stubMailer();
  const gw = await startGateway({ recoveryEnabled: true, mailer });
  try {
    const account = await gw.accounts.createAccount('owner@example.test');
    const oldKey = await gw.accounts.issue(account.id, 'developer_key', 'laptop');

    const landing = await (await fetch(`${gw.base}/console/`)).text();
    assert.match(landing, /Recover by email/);
    assert.equal((await fetch(`${gw.base}/console/recover`)).status, 200);

    // Unknown address and known address: same redirect, same page; mail only for the known one.
    const unknown = await form(gw.base, '/recover', { email: 'nobody@example.test' });
    const known = await form(gw.base, '/recover', { email: 'Owner@Example.test' });
    assert.equal(unknown.status, 302); assert.equal(known.status, 302);
    assert.equal(unknown.headers.get('location'), known.headers.get('location'));
    const sentPage = await (await fetch(`${gw.base}${known.headers.get('location').replace(/^\/recover/, '/console/recover')}`)).text();
    assert.match(sentPage, /If that address has an account/);
    assert.doesNotMatch(sentPage, /owner@example|nobody@example/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mailer.sent.length, 1, 'exactly one mail, to the real account');
    assert.equal(mailer.sent[0].to, 'owner@example.test');
    assert.equal(mailer.sent[0].subject, 'Recover access to your Open-Compute Marketplace account');
    assert.match(mailer.sent[0].text, /30 minutes/);
    assert.match(mailer.sent[0].text, /ignore this email/);
    const token = linkIn(mailer.sent[0]);
    assert.ok(token, 'the mail carries the link');
    assert.doesNotMatch(mailer.sent[0].text, /ocm_live_/, 'the mail never carries a key');

    // The link's page is read-only and masks the address.
    const page = await fetch(`${gw.base}/console/recover/confirm?t=${token}`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /o…r@example\.test/);
    assert.doesNotMatch(body, /owner@example\.test/);
    assert.ok(await gw.accounts.peekRecovery(token), 'viewing the page consumed nothing');

    // Confirm: a new key, a session, the old key untouched, the mailbox verified.
    const confirm = await form(gw.base, '/recover/confirm', { t: token });
    assert.equal(confirm.status, 200);
    const secretPage = await confirm.text();
    const keys = secretPage.match(/ocm_live_[-A-Za-z0-9_]{16,}/g) || [];
    assert.equal(keys.length, 1, 'the new key is shown exactly once');
    assert.ok(confirm.headers.get('set-cookie'), 'signed in');
    assert.ok(await gw.accounts.resolve(oldKey.secret, 'developer_key'), 'the old key still works');
    const found = await gw.accounts.resolve(keys[0], 'developer_key');
    assert.equal(found.accountId, account.id);
    const acct = await gw.accounts.accountFor(account.id);
    assert.ok(acct.email_verified_at, 'a used link proves the mailbox');

    // Used, expired and unknown: one answer.
    const again = await form(gw.base, '/recover/confirm', { t: token });
    const viewAgain = await fetch(`${gw.base}/console/recover/confirm?t=${token}`);
    const expired = await gw.accounts.issueRecovery(account.id, 1);
    await new Promise((r) => setTimeout(r, 5));
    const exp = await form(gw.base, '/recover/confirm', { t: expired.token });
    const unk = await form(gw.base, '/recover/confirm', { t: 'ocm_recover_' + 'A'.repeat(32) });
    const bad = await form(gw.base, '/recover/confirm', { t: 'garbage' });
    for (const r of [again, viewAgain, exp, unk, bad]) assert.equal(r.status, 400);
    const texts = await Promise.all([again, exp, unk].map((r) => r.text()));
    assert.equal(texts[0], texts[1]); assert.equal(texts[1], texts[2]);
    assert.equal((await gw.accounts.listCredentials(account.id)).filter((c) => c.kind === 'developer_key').length, 2,
      'no second key was minted by the replay');

    // Cap: at most three outstanding links per account.
    mailer.sent.length = 0;
    for (let i = 0; i < 5; i++) await form(gw.base, '/recover', { email: 'owner@example.test' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mailer.sent.length, 3, 'the fourth and fifth requests send nothing');
  } finally { await gw.close(); }
});

test('with the flag off nothing exists, and the message helpers are what Amazon was shown', async () => {
  const mailer = stubMailer();
  const gw = await startGateway({ recoveryEnabled: false, mailer });
  try {
    const landing = await (await fetch(`${gw.base}/console/`)).text();
    assert.doesNotMatch(landing, /Recover by email/);
    assert.equal((await fetch(`${gw.base}/console/recover`)).status, 404);
    assert.equal((await form(gw.base, '/recover', { email: 'x@example.test' })).status, 404);
    assert.equal((await fetch(`${gw.base}/console/recover/confirm?t=ocm_recover_${'A'.repeat(32)}`)).status, 404);
    assert.equal(mailer.sent.length, 0);
  } finally { await gw.close(); }
  assert.equal(maskEmail('michael@example.com'), 'm…l@example.com');
  assert.equal(maskEmail('ab@x.io'), 'a@x.io');
  const m = recoveryMessage({ link: 'https://console.test/recover/confirm?t=x', consoleHost: 'console.test' });
  assert.match(m.text, /can only be used once/);
  assert.match(m.text, /Your existing key\nis not changed/);
  assert.match(m.text, /https:\/\/console\.test\. Open-Compute Marketplace\./);
});
