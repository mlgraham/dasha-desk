#!/usr/bin/env node
/**
 * Local Watch contract. Does not hit production.
 * Good fixtures must pass. Wrong redirects, blank pages, bad mint, plugin.jup.ag,
 * stale SRI, missing H1, broken OAuth, and empty chess API must still fail.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtureProbe, runWatch, ORIGIN, LOBBY, MINT } from './watch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'watch');

function overlay(probe, patches) {
  return async (url, opts) => {
    const u = new URL(url);
    const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
    const key = `${u.origin}${path}`;
    if (patches[key]) {
      const entry = patches[key];
      const body = Buffer.from(entry.body || '');
      return {
        ok: entry.status >= 200 && entry.status < 300,
        status: entry.status,
        headers: {
          get: (name) => {
            if (String(name).toLowerCase() === 'location') return entry.location || '';
            return (entry.headers && entry.headers[String(name).toLowerCase()]) || '';
          },
        },
        text: async () => body.toString('utf8'),
        json: async () => (entry.json != null ? entry.json : null),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    }
    return probe(url, opts);
  };
}

const good = loadFixtureProbe(fixtureDir);
const baseline = await runWatch({ probe: good, skipPages: true });
assert.equal(baseline.failures.length, 0, `good fixtures must pass:\n${baseline.failures.join('\n')}`);

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/studio`]: {
        status: 200,
        body: '<!doctype html><h1>Studio</h1><p>No dedication.</p>',
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => f.startsWith('/studio: expected 308')), bag.failures.join('\n'));
  assert.ok(!bag.failures.some((f) => /CC0|likeness/i.test(f)), 'Watch must not require Studio CC0/likeness on a retired route');
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/privacy`]: { status: 308, location: `${ORIGIN}/`, body: '' },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /\/privacy/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/desk`]: { status: 308, location: `${ORIGIN}/`, body: '' },
      [`${ORIGIN}/dasha`]: { status: 308, location: `${ORIGIN}/`, body: '' },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => f.startsWith('/desk:')), bag.failures.join('\n'));
  assert.ok(bag.failures.some((f) => f.startsWith('/dasha:')), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/`]: {
        status: 200,
        body: `<!doctype html><h1>$dasha</h1><a id="chat-door">Chat</a><a>Buy</a><p>faucet grwm</p><p>plugin.jup.ag ${MINT}</p>`,
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /plugin\.jup\.ag/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/`]: {
        status: 200,
        body: '<!doctype html><h1>$dasha</h1><a id="chat-door">Chat</a><a>Buy</a><p>faucet grwm jup.ag 11111111111111111111111111111111pump</p>',
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /not our mint/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/how-to-buy`]: { status: 200, body: '<!doctype html><p></p>' },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /blank page|missing H1/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/privacy`]: { status: 200, body: `<!doctype html><p>We don't hold it. ${MINT}</p>` },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /\/privacy: missing H1/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/oauth/x/start`]: { status: 404, body: 'not found' },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => f.startsWith('/oauth/x/start:')), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/chess`]: {
        status: 200,
        body: '<!doctype html><h1>Chess</h1><script>var API=\'\';</script><button id="gate-action">bad response</button><button id="gate-find">Find</button>',
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /var API is empty/.test(f)), bag.failures.join('\n'));
  assert.ok(bag.failures.some((f) => /bad response/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/chess`]: {
        status: 200,
        body: '<!doctype html><h1>Chess</h1><script>var API=\'https://lobby.getdasha.com\';</script><button id="gate-action">Play</button><button id="gate-find">Find</button><p id="buy-flash" hidden>bought. <a id="buy-share-x" href="https://x.com/intent/post">X</a></p>',
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /leftover id=buy-share-x/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/chess`]: {
        status: 200,
        body: '<!doctype html><h1>Chess</h1><script>var API=\'https://lobby.getdasha.com\';</script><button id="gate-action">Play</button><button id="gate-find">Find</button><footer><a href="https://t.me/+xB7S8mIQaKFiZjRh">Telegram</a></footer>',
      },
    }),
    skipPages: true,
  });
  assert.equal(bag.failures.length, 0, `official chess footer TG without leftover id must pass:\n${bag.failures.join('\n')}`);
}

{
  const pin = readFileSync(join(fixtureDir, 'home.html'), 'utf8');
  const stale = pin.replace(
    'sha384-FzI+vBDCbm64kOB54trhapHWjR6ugybc4wrY8GMgqEYeUJ4rTg1mCO+w2bS4HKNp',
    'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  const bag = await runWatch({
    probe: overlay(good, { [`${ORIGIN}/`]: { status: 200, body: stale } }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /refusing that script/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/`]: {
        status: 200,
        body: `<!doctype html><title>$dasha</title><link rel="canonical" href="${ORIGIN}/"><h1>It’s time $dasha.</h1><a id="chat-door" href="${ORIGIN}/lobby">Chat</a><a href="https://jup.ag/swap">Buy</a><code>${MINT}</code><section id="dasha-home-faucet">faucet</section><section id="grwm">grwm</section>`,
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /\/: missing Compute link/.test(f)), bag.failures.join('\n'));
}

{
  const pin = readFileSync(join(fixtureDir, 'home.html'), 'utf8');
  const hidden = pin.replace(
    '</head>',
    '<style id="dasha-home-chrome-hide">a[href="/compute"],.compute{display:none!important}</style></head>',
  );
  const bag = await runWatch({
    probe: overlay(good, { [`${ORIGIN}/`]: { status: 200, body: hidden } }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /hidden by a display:none/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/compute`]: {
        status: 200,
        body: '<!doctype html><title>Worker room</title><h1>Machines</h1><p>Nothing here explains the product or its canonical URL.</p>',
      },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /\/compute: title must name Compute/.test(f)), bag.failures.join('\n'));
  assert.ok(bag.failures.some((f) => /\/compute: missing www canonical/.test(f)), bag.failures.join('\n'));
  assert.ok(bag.failures.some((f) => /\/compute: missing product explanation/.test(f)), bag.failures.join('\n'));
}

{
  const bag = await runWatch({
    probe: overlay(good, {
      [`${ORIGIN}/dasha-compute-open-alpha.tar.gz`]: { status: 404, body: '' },
    }),
    skipPages: true,
  });
  assert.ok(bag.failures.some((f) => /dasha-compute-open-alpha\.tar\.gz: missing provenance archive/.test(f)), bag.failures.join('\n'));
}

const cli = spawnSync(process.execPath, ['watch.mjs', '--fixture', '--json'], {
  cwd: here,
  encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
const report = JSON.parse(cli.stdout);
assert.equal(report.ok, true);
assert.equal(report.failures.length, 0);
assert.ok(!JSON.stringify(report).includes('CC0'));

assert.equal(MINT, '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump');
assert.equal(LOBBY, 'https://lobby.getdasha.com');

console.log('dasha-watch-contract: PASS');
