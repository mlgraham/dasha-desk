import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';
import { normalizeProviderAgent } from '../gateway/provider.mjs';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-provider-identity-'));
  const gateway = await createGateway({
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
    modelAliases: '',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  return {
    ...gateway,
    wsBase: `ws://127.0.0.1:${gateway.server.address().port}`,
  };
}

async function makeProvider(gateway, email) {
  const account = await gateway.accounts.createAccount(email);
  const token = await gateway.accounts.issue(account.id, 'provider_token', email);
  return { account, token };
}

function connectProvider(wsBase, token, agent) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${token}` } });
    let welcomed = false;
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'hello', agent })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'welcome') {
        welcomed = true;
        resolve({ socket, welcome: message });
      }
    });
    socket.addEventListener('close', (event) => {
      if (!welcomed) reject(new Error(`closed before welcome: ${event.code} ${event.reason}`));
    });
  });
}

function rejectedProvider(wsBase, token, firstMessage) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${token}` } });
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => socket.send(JSON.stringify(firstMessage)));
    socket.addEventListener('message', (event) => {
      if (JSON.parse(event.data).t === 'welcome') reject(new Error('unexpected provider welcome'));
    });
    socket.addEventListener('close', (event) => resolve({ socket, code: event.code, reason: event.reason }));
  });
}

test('provider capability claims are bounded and unknown identity fields are dropped', () => {
  const normalized = normalizeProviderAgent({
    id: 'm4-studio-1',
    models: ['ocm-coder', 'local/model:7b'],
    chip: 'Apple M4 Max',
    arch: 'arm64',
    region: 'us-west',
    runtime: 'mlx',
    memory_gb: 128,
    accountId: 'forged-account',
    credentialId: 'forged-credential',
    arbitrary: { nested: true },
  });

  assert.deepEqual(normalized, {
    id: 'm4-studio-1',
    models: ['ocm-coder', 'local/model:7b'],
    chip: 'Apple M4 Max',
    arch: 'arm64',
    region: 'us-west',
    runtime: 'mlx',
    memory_gb: 128,
  });
  assert.throws(() => normalizeProviderAgent({ id: 'bad id', models: ['x'] }), /agent id/);
  assert.throws(() => normalizeProviderAgent({ id: 'x', models: [] }), /models must contain/);
  assert.throws(() => normalizeProviderAgent({
    id: 'x', models: Array.from({ length: 33 }, (_, i) => `m${i}`),
  }), /models must contain/);
  assert.throws(() => normalizeProviderAgent({ id: 'x', models: ['same', 'same'] }), /duplicate model/);
  assert.throws(() => normalizeProviderAgent({ id: 'x', models: ['bad model'] }), /model ids/);
  assert.throws(() => normalizeProviderAgent({ id: 'x', models: ['ok'], memory_gb: 4097 }), /memory_gb/);
});

test('another provider account cannot take over an active host id', async () => {
  const gateway = await startGateway();
  let firstSocket;
  try {
    const first = await makeProvider(gateway, 'first@provider.test');
    const second = await makeProvider(gateway, 'second@provider.test');

    ({ socket: firstSocket } = await connectProvider(gateway.wsBase, first.token.secret, {
      id: 'shared-machine-name',
      models: ['ocm-coder'],
      accountId: second.account.id,
    }));

    const refused = await rejectedProvider(gateway.wsBase, second.token.secret, {
      t: 'hello',
      agent: { id: 'shared-machine-name', models: ['ocm-coder'] },
    });
    assert.equal(refused.code, 1008);

    const live = gateway.registry.get('shared-machine-name');
    assert.ok(live);
    assert.equal(live.caps.accountId, first.account.id,
      'authenticated account ownership must override anything claimed in hello');
    assert.equal(gateway.registry.online().length, 1);
  } finally {
    firstSocket?.close();
    await gateway.close();
  }
});

test('a same-account reconnect replaces the stale socket without duplicating the host', async () => {
  const gateway = await startGateway();
  let firstSocket;
  let secondSocket;
  try {
    const provider = await makeProvider(gateway, 'reconnect@provider.test');
    const secondToken = await gateway.accounts.issue(provider.account.id, 'provider_token', 'replacement');

    ({ socket: firstSocket } = await connectProvider(gateway.wsBase, provider.token.secret, {
      id: 'stable-machine', models: ['ocm-coder'],
    }));
    const firstClosed = new Promise((resolve) => firstSocket.addEventListener('close', resolve, { once: true }));

    ({ socket: secondSocket } = await connectProvider(gateway.wsBase, secondToken.secret, {
      id: 'stable-machine', models: ['ocm-coder'],
    }));
    const closeEvent = await firstClosed;

    assert.equal(closeEvent.code, 1001);
    assert.equal(gateway.registry.online().length, 1);
    assert.equal(gateway.registry.get('stable-machine').caps.accountId, provider.account.id);
  } finally {
    firstSocket?.close();
    secondSocket?.close();
    await gateway.close();
  }
});

test('a provider must send one valid bounded hello before any job protocol message', async () => {
  const gateway = await startGateway();
  let validSocket;
  try {
    const provider = await makeProvider(gateway, 'hello@provider.test');

    const noHello = await rejectedProvider(gateway.wsBase, provider.token.secret, {
      t: 'done', id: 'not-a-job',
    });
    assert.equal(noHello.code, 1008);

    const badCaps = await rejectedProvider(gateway.wsBase, provider.token.secret, {
      t: 'hello', agent: { id: 'bad id', models: ['ocm-coder'] },
    });
    assert.equal(badCaps.code, 1008);
    assert.equal(gateway.registry.online().length, 0);

    ({ socket: validSocket } = await connectProvider(gateway.wsBase, provider.token.secret, {
      id: 'valid-machine', models: ['ocm-coder'],
    }));
    const closed = new Promise((resolve) => validSocket.addEventListener('close', resolve, { once: true }));
    validSocket.send(JSON.stringify({
      t: 'hello', agent: { id: 'valid-machine', models: ['ocm-coder'] },
    }));
    assert.equal((await closed).code, 1008);
  } finally {
    validSocket?.close();
    await gateway.close();
  }
});
