import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../gateway/ledger.mjs';
import {
  createGateway,
  parseAliases,
  publicAccountingHealth,
} from '../gateway/server.mjs';

const AGENT = fileURLToPath(new URL('../agent/agent.py', import.meta.url));

const usage = (overrides = {}) => ({
  consumer: 'acct_test',
  host: 'provider-m4',
  model: 'ocm-coder',
  promptTokens: 5,
  completionTokens: 7,
  jobId: 'job-1',
  ...overrides,
});

async function listen(gateway) {
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const port = gateway.server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
  };
}

function connectHost(wsBase, token, id, models, onJob = () => {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/host/connect`,
      { headers: { authorization: `Bearer ${token}` } });
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      t: 'hello', agent: { id, models },
    })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'welcome') return resolve(socket);
      if (message.t === 'job') onJob(message, socket);
    });
  });
}

test('the MLX agent imports successfully and never puts its credential in the URL', () => {
  const source = readFileSync(AGENT, 'utf8');
  assert.match(source, /^import threading$/m,
    'MlxRuntime constructs a threading.Lock during module import');
  assert.match(source, /websockets==13\.1/,
    'the handshake-header API must be pinned rather than inherited from an unbounded major');
  assert.match(source, /extra_headers=\{"Authorization": f"Bearer \{HOST_TOKEN\}"\}/,
    'the provider token must be sent in the Authorization header');
  assert.doesNotMatch(source, /host\/connect\?token=/,
    'provider credentials must never be embedded in a WebSocket URL');

  execFileSync('python3', ['-m', 'py_compile', AGENT]);

  // Import the MLX path on Linux without installing MLX or websockets. MlxRuntime
  // must be constructible before mlx_lm is imported lazily by an actual job.
  const stub = mkdtempSync(join(tmpdir(), 'ocm-python-'));
  for (const dir of ['websockets', 'websockets/legacy']) {
    mkdirSync(join(stub, dir), { recursive: true });
    writeFileSync(join(stub, dir, '__init__.py'), '');
  }
  writeFileSync(join(stub, 'websockets/legacy/client.py'),
    'def connect(*args, **kwargs):\n    return None\n');

  execFileSync('python3', ['-c', [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("ocm_agent", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'assert module.RUNTIME.name == "mlx"',
    'assert module.RUNTIME._lock is not None',
  ].join('; '), AGENT], {
    env: { ...process.env, PYTHONPATH: stub, OCM_RUNTIME: 'mlx' },
  });
});

test('production provider socket auth refuses URL credentials', async () => {
  // There is no loopback exception any more: a credential in a URL is recorded by
  // every proxy in the path, so the gateway reads it from the Authorization header
  // and nowhere else. A VALID token in the query string is refused, even from the
  // actual loopback TCP peer.
  const dir = mkdtempSync(join(tmpdir(), 'ocm-socket-auth-'));
  const gw = await createGateway({ ledgerPath: join(dir, 'usage.jsonl'), keys: new Map() });
  const { ws: wsBase } = await listen(gw);
  try {
    const account = await gw.accounts.createAccount('socket-auth@test.dev');
    const token = await gw.accounts.issue(account.id, 'provider_token', 'test');
    const refused = await new Promise((resolve) => {
      const socket = new WebSocket(`${wsBase}/host/connect?token=${encodeURIComponent(token.secret)}`);
      socket.addEventListener('error', () => resolve(true));
      socket.addEventListener('open', () => resolve(false));
    });
    assert.equal(refused, true, 'a valid token in a query string must be refused on loopback');
    const socket = await connectHost(wsBase, token.secret, 'header-host', ['m']);
    socket.close();
  } finally { await gw.close(); }
});

test('public health exposes accounting state without leaking its internal error', () => {
  assert.deepEqual(publicAccountingHealth({
    health: () => ({ ok: false, error: 'private database driver failure details' }),
  }), { ok: false });
  assert.deepEqual(publicAccountingHealth({}), { ok: true });
});

test('provider verification accepts only the Authorization header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-provider-auth-'));
  const gw = await createGateway({ ledgerPath: join(dir, 'usage.jsonl'), keys: new Map() });
  const { base } = await listen(gw);
  try {
    const account = await gw.accounts.createAccount('provider@test.dev');
    const token = await gw.accounts.issue(account.id, 'provider_token', 'test');

    const query = await fetch(`${base}/v1/provider/verify?token=${encodeURIComponent(token.secret)}`);
    assert.equal(query.status, 401, 'public HTTP endpoints must not accept credentials from URLs');

    const header = await fetch(`${base}/v1/provider/verify`, {
      headers: { authorization: `Bearer ${token.secret}` },
    });
    assert.equal(header.status, 200);
  } finally { await gw.close(); }
});

test('model aliases reject blank and ambiguous reverse mappings', () => {
  assert.throws(() => parseAliases('ocm-coder='), /invalid model alias/);
  assert.throws(() => parseAliases('alias-a=raw-build,alias-b=raw-build'), /ambiguous model alias/);
  assert.deepEqual(parseAliases('ocm-coder=raw-build').get('ocm-coder'), ['raw-build']);
});

test('duplicate and conflicting terminal messages clear one usage row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-terminal-race-'));
  const apiKey = 'ocm_race_key';
  const gw = await createGateway({
    keys: new Map([[apiKey, 'race-consumer']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 1_000,
    modelAliases: '',
  });
  const { base, ws } = await listen(gw);
  let socket;
  try {
    const provider = await gw.accounts.createAccount('race-provider@test.dev');
    const racyToken = await gw.accounts.issue(provider.id, 'provider_token', 'racy-host');
    socket = await connectHost(ws, racyToken.secret, 'racy-host', ['race-model'], (message, host) => {
      host.send(JSON.stringify({ t: 'chunk', id: message.id, delta: 'abcd' }));
      host.send(JSON.stringify({ t: 'done', id: message.id }));
      host.send(JSON.stringify({ t: 'error', id: message.id, message: 'late error' }));
      host.send(JSON.stringify({ t: 'done', id: message.id }));
    });

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'race-model', messages: [{ role: 'user', content: 'go' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'abcd');

    const summary = await gw.ledger.summary();
    assert.equal(summary.totals.requests, 1,
      'done + error + done must have one settlement owner and one usage row');
  } finally {
    socket?.close();
    await gw.close();
  }
});

test('a client abort before first token never dispatches a failover job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-client-abort-'));
  const apiKey = 'ocm_abort_key';
  const gw = await createGateway({
    keys: new Map([[apiKey, 'abort-consumer']]),
    ledgerPath: join(dir, 'usage.jsonl'),
    grantTokens: 1_000,
    modelAliases: '',
  });
  const { base, ws } = await listen(gw);
  let first;
  let backup;
  let firstJobs = 0;
  let backupJobs = 0;
  let dispatchedResolve;
  const dispatched = new Promise((resolve) => { dispatchedResolve = resolve; });

  try {
    const provider = await gw.accounts.createAccount('abort-provider@test.dev');
    const hangingToken = await gw.accounts.issue(provider.id, 'provider_token', 'hanging-host');
    const backupToken = await gw.accounts.issue(provider.id, 'provider_token', 'backup-host');
    first = await connectHost(ws, hangingToken.secret, 'hanging-host', ['abort-model'], () => {
      firstJobs += 1;
      dispatchedResolve();
      // Deliberately never return a token or terminal message.
    });

    const controller = new AbortController();
    const request = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'abort-model', messages: [{ role: 'user', content: 'wait' }] }),
      signal: controller.signal,
    }).catch((error) => error);

    await dispatched;
    backup = await connectHost(ws, backupToken.secret, 'backup-host', ['abort-model'], (message, host) => {
      backupJobs += 1;
      host.send(JSON.stringify({ t: 'chunk', id: message.id, delta: 'should-not-run' }));
      host.send(JSON.stringify({ t: 'done', id: message.id }));
    });

    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(firstJobs, 1);
    assert.equal(backupJobs, 0,
      'closing the client is an abort, not a pre-commit provider failure to retry');
  } finally {
    first?.close();
    backup?.close();
    await gw.close();
  }
});

test('local usage clearing is at-most-once and conflicts fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ledger-'));
  const ledger = new Ledger(join(dir, 'usage.jsonl'));
  await ledger.init();
  await ledger.grant('acct_test', 100, 'test grant');

  const first = await ledger.clear(usage());
  const replay = await ledger.clear(usage());
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);

  const summary = await ledger.summary();
  assert.equal(summary.totals.requests, 1,
    'an identical terminal retry must not create a second debit/provider credit');
  assert.equal(summary.recent.length, 1);
  assert.equal(await ledger.balance('acct_test'), 88);
  assert.equal(await ledger.credited('provider-m4'), 7);

  await assert.rejects(
    ledger.clear(usage({ completionTokens: 8 })),
    /idempotency_conflict/,
    'one job id cannot be reused for different accounting facts',
  );
  await assert.rejects(ledger.clear(usage({ jobId: '' })), /jobId must be/);
  await assert.rejects(ledger.clear(usage({ promptTokens: 1.5 })), /safe integer/);
  await assert.rejects(ledger.clear(usage({
    promptTokens: Number.MAX_SAFE_INTEGER,
    completionTokens: 1,
  })), /total tokens must be a safe integer/);
});

test('an append failure makes accounting unhealthy and stops balance reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ledger-fail-'));
  const path = join(dir, 'usage.jsonl');
  const ledger = new Ledger(path);
  await ledger.init();
  await ledger.grant('acct_test', 100);

  // Replace the log file with a directory so appendFileSync deterministically fails,
  // including on privileged CI runners.
  unlinkSync(path);
  mkdirSync(path);

  await assert.rejects(ledger.clear(usage()), /ACCOUNTING_UNHEALTHY/);
  assert.equal(ledger.health().ok, false);
  await assert.rejects(ledger.balance('acct_test'), /ACCOUNTING_UNHEALTHY/,
    'the gateway balance gate must stop accepting new work after accounting fails');
});

test('duplicate or conflicting persisted rows are detected at startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ledger-corrupt-'));
  const base = {
    id: 'one', at: new Date(0).toISOString(), kind: 'usage',
    consumer: 'acct_test', host: 'provider-m4', model: 'ocm-coder',
    jobId: 'same-job', promptTokens: 1, completionTokens: 1, tokens: 2,
  };

  const duplicatePath = join(dir, 'duplicate.jsonl');
  writeFileSync(duplicatePath, `${JSON.stringify(base)}\n${JSON.stringify({ ...base, id: 'two' })}\n`);
  const duplicate = new Ledger(duplicatePath);
  await assert.rejects(duplicate.init(), /duplicate persisted usage rows/);
  assert.equal(duplicate.health().ok, false);

  const conflictPath = join(dir, 'conflict.jsonl');
  mkdirSync(dirname(conflictPath), { recursive: true });
  writeFileSync(conflictPath, `${JSON.stringify(base)}\n${JSON.stringify({
    ...base, id: 'two', completionTokens: 2, tokens: 3,
  })}\n`);
  const conflict = new Ledger(conflictPath);
  await assert.rejects(conflict.init(), /conflicting persisted usage rows/);
  assert.equal(conflict.health().ok, false);
});
