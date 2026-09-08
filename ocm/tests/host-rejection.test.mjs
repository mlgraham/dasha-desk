/**
 * A provider socket refused for a revoked token names the credential (label, the
 * machine it was bound to, when it was revoked) in the log, never the token. A stray
 * agent at some IP was retrying a rotated-out token once a minute on 2026-09-08 and
 * "unknown or revoked" could not say which machine it was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-reject-'));
  const gw = await createGateway({ ledgerPath: join(dir, 'usage.jsonl'), keys: new Map(), modelAliases: '' });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, wsBase: `ws://127.0.0.1:${gw.server.address().port}` };
}

function rejected(wsBase, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/host/connect`, { headers: { authorization: `Bearer ${token}` } });
    ws.addEventListener('error', () => resolve('error'));
    ws.addEventListener('close', () => resolve('closed'));
    ws.addEventListener('open', () => resolve('open'));
  });
}

test('a revoked provider token is named in the rejection log; an unknown one is not; the token never is', async () => {
  const gw = await startGateway();
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    const account = await gw.accounts.createAccount('reject@example.test');
    const cred = await gw.accounts.issue(account.id, 'provider_token', 'old-mini', { boundAgentId: 'mini' });
    await gw.accounts.revoke(cred.id);
    assert.notEqual(await rejected(gw.wsBase, cred.secret), 'open');
    await new Promise((r) => setTimeout(r, 30));
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((j) => j && j.msg === 'provider socket rejected');
    assert.ok(entry, 'the rejection is logged');
    assert.equal(entry.token, 'ocm_host (revoked)');
    assert.equal(entry.revoked_label, 'old-mini');
    assert.equal(entry.revoked_bound_to, 'mini');
    assert.ok(entry.revoked_at);
    assert.ok(!lines.some((l) => l.includes(cred.secret)), 'the token itself is never logged');

    lines.length = 0;
    await rejected(gw.wsBase, 'ocm_host_' + 'B'.repeat(32));
    await new Promise((r) => setTimeout(r, 30));
    const unknown = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((j) => j && j.msg === 'provider socket rejected');
    assert.equal(unknown.token, 'ocm_host (unknown)');
    assert.ok(!('revoked_label' in unknown));
  } finally { console.error = orig; await gw.close(); }
});
