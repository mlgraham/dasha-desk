#!/usr/bin/env node
/**
 * Watches the live getdasha.com Worker contract.
 *
 * Live owner is Cloudflare Worker dasha-lobby (www + lobby routes). Source ships from the
 * operator Worker tree — not this GitHub repo, not GitHub Pages, not Designer-publish.
 * This file does not implement that Worker. It asserts what visitors must get.
 *
 * Do not restore Studio. /studio is retired (308 home). Do not treat privacy 308-as-home
 * as success. /compute is a first-class product page. Do not weaken blank-page, mint,
 * plugin.jup.ag, stale SRI, missing H1, or broken OAuth start checks.
 *
 *   node watch.mjs              # production
 *   node watch.mjs --fixture    # local fixtures (verify)
 *   node watch.mjs --json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkComputeRelease } from './watch-compute-release.mjs';
import { leftoverHits } from './leftover-chess.test.mjs';

export const MINT = '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump';
export const ORIGIN = 'https://www.getdasha.com';
export const LOBBY = 'https://lobby.getdasha.com';
export const PAGES = 'https://uuriko.github.io/dasha-desk/';
const RETIRED = /\b(thesis card|conviction receipt|forecasting)\b/i;
const GONE = [
  /can go to zero/i,
  /not financial advice/i,
  /association is not endorsement/i,
  /not affiliated with dasha/i,
];
const HOME_308 = ['/studio', '/verse', '/learn', '/graph'];
const BUY_308 = ['/dasha', '/desk'];
const SITEMAP_REQUIRED = ['/privacy', '/lobby', '/chess', '/faucet', '/bag', '/how-to-buy', '/simp', '/compute'];
const SITEMAP_NOT_INDEXABLE = ['/studio', '/dasha', '/desk', '/verse', '/learn', '/graph'];

const here = dirname(fileURLToPath(import.meta.url));

const fail = (bag, ok, msg) => { if (!ok) bag.failures.push(msg); };
const warn = (bag, ok, msg) => { if (!ok) bag.warnings.push(msg); };

function decodeEscapes(html) {
  return html + '\n' + html.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlank(html) {
  if (/Loading studio/i.test(html)) return true;
  const text = visibleText(html);
  if (hasHeading(html)) return text.length < 8;
  return text.length < 80;
}

function hasHeading(html) {
  return /<h[1-6][\s>]/i.test(html);
}

function locationOf(res) {
  const headers = res.headers || {};
  if (typeof headers.get === 'function') return String(headers.get('location') || '');
  return String(headers.location || headers.Location || '');
}

function isHomeLoc(loc) {
  return /^https:\/\/www\.getdasha\.com\/?(?:\?.*)?$/.test(loc);
}

function isHowToBuyLoc(loc) {
  return /^https:\/\/www\.getdasha\.com\/how-to-buy\/?(?:\?.*)?$/.test(loc);
}

function isLobbyLoc(loc) {
  return loc.startsWith('https://www.getdasha.com/lobby');
}

function isOauthXLoc(loc) {
  return /^https:\/\/lobby\.getdasha\.com\/oauth\/x\/start\/?(?:\?.*)?$/.test(loc);
}

function header(res, name) {
  const headers = res.headers || {};
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

function scanMint(bag, label, html, { required = false } = {}) {
  for (const found of html.match(/[1-9A-HJ-NP-Za-km-z]{32,44}pump/g) || []) {
    fail(bag, found.endsWith(MINT), `${label}: shows an address that is not our mint — ${found}`);
  }
  if (required) fail(bag, html.includes(MINT), `${label}: the mint is not shown at all`);
}

function scanRetiredCopy(bag, label, html) {
  const searchable = decodeEscapes(html);
  fail(bag, !RETIRED.test(html), `${label}: a retired product is live again`);
  for (const gone of GONE) {
    fail(bag, !gone.test(searchable), `${label}: copy the operator removed is live again — ${gone.source}`);
  }
  fail(bag, !/\bNFA\b/i.test(searchable), `${label}: copy the operator removed is live again — NFA`);
  fail(bag, !/plugin\.jup\.ag/i.test(html), `${label}: plugin.jup.ag is live`);
}

async function checkSri(bag, probe, label, html) {
  for (const script of new Set(html.match(/https:\/\/lobby\.getdasha\.com\/[^"'\s)]+\.js/g) || [])) {
    const at = html.indexOf(script);
    let pin = null;
    let nearest = Infinity;
    for (const m of html.matchAll(/sha384-[A-Za-z0-9+/=]+/g)) {
      const d = Math.abs(m.index - at);
      if (d < nearest) {
        nearest = d;
        pin = m[0];
      }
    }
    if (!pin || nearest > 2000) continue;
    const asset = await probe(script, { redirect: 'follow' });
    if (!asset.ok) {
      fail(bag, false, `${label}: ${script} is unreachable but the page pins it`);
      continue;
    }
    const bytes = new Uint8Array(await asset.arrayBuffer());
    const digest = createHash('sha384').update(bytes).digest('base64');
    const served = 'sha384-' + digest;
    fail(
      bag,
      served === pin,
      `${label}: pins ${pin.slice(0, 20)}… but ${script} serves ${served.slice(0, 20)}… — the browser is refusing that script`,
    );
  }
}

function chessApi(html) {
  const m = html.match(/\bvar\s+API\s*=\s*(['"])(.*?)\1/);
  return m ? m[2] : null;
}

function playFindSurfacesBadResponse(html) {
  for (const m of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = m[2];
    const inner = m[3];
    const isPlayFind = /id=["'](gate-action|gate-find)["']/.test(attrs)
      || />\s*Play\s*</i.test(m[0])
      || />\s*Find\s*</i.test(m[0])
      || /Play|Find/.test(inner);
    if (isPlayFind && /bad response/i.test(inner)) return true;
  }
  return false;
}

export function loadFixtureProbe(dir = join(here, 'fixtures', 'watch')) {
  const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
  const resolve = (url) => {
    const u = new URL(url);
    const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
    const key = `${u.origin}${path}`;
    return routes[key] || routes[`${u.origin}${u.pathname}`] || null;
  };
  const materialize = (entry) => {
    if (!entry) {
      return {
        ok: false,
        status: 0,
        error: 'unmapped fixture',
        headers: { get: () => '' },
        text: async () => '',
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    let body = '';
    if (entry.file) body = readFileSync(join(dir, entry.file));
    else if (entry.body != null) body = Buffer.from(String(entry.body));
    else if (entry.json != null) body = Buffer.from(JSON.stringify(entry.json));
    else body = Buffer.alloc(0);
    const location = entry.location || '';
    const extra = entry.headers || {};
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase();
          if (key === 'location') return location;
          return extra[key] || extra[name] || '';
        },
      },
      text: async () => body.toString('utf8'),
      json: async () => (entry.json != null ? entry.json : JSON.parse(body.toString('utf8'))),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return async (url, { redirect = 'follow' } = {}) => {
    const hop = resolve(url);
    if (hop && hop.status >= 300 && hop.status < 400 && hop.location && redirect === 'follow') {
      return materialize(resolve(hop.location) || hop);
    }
    return materialize(hop);
  };
}

export async function liveProbe(url, { redirect = 'follow', tries = 3 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { redirect, headers: { 'user-agent': 'dasha-watch' } });
      if (res.ok || (res.status >= 300 && res.status < 400) || (res.status < 500 && res.status !== 429)) {
        return res;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    if (i < tries) await new Promise((r) => setTimeout(r, i * 3000));
  }
  return {
    ok: false,
    status: 0,
    error: last,
    headers: { get: () => '' },
    text: async () => '',
    json: async () => null,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

async function page200(bag, probe, route, check) {
  const res = await probe(ORIGIN + route, { redirect: 'follow' });
  fail(bag, res.ok, `${route}: unreachable — ${res.error || 'HTTP ' + res.status}`);
  if (!res.ok) return;
  const html = await res.text();
  fail(bag, !isBlank(html), `${route}: blank page`);
  scanMint(bag, route, html, { required: check.mintRequired });
  scanRetiredCopy(bag, route, html);
  if (check.h1) fail(bag, /<h1[\s>]/i.test(html), `${route}: missing H1`);
  if (check.heading) fail(bag, hasHeading(html), `${route}: missing H1 or section heading`);
  if (check.match) {
    for (const [re, msg] of check.match) fail(bag, re.test(html), msg);
  }
  if (check.forbid) {
    for (const [re, msg] of check.forbid) fail(bag, !re.test(html), msg);
  }
  await checkSri(bag, probe, route === '/' ? 'home' : route.slice(1), html);
  if (check.after) await check.after(bag, html, res);
}

async function expect308(bag, probe, route, okLoc, label) {
  const res = await probe(ORIGIN + route, { redirect: 'manual' });
  const loc = locationOf(res);
  fail(
    bag,
    res.status === 308 && okLoc(loc),
    `${route}: expected 308 → ${label} (got HTTP ${res.status || 0} ${loc || 'no location'})`,
  );
}

export async function runWatch({ probe, skipPages = false } = {}) {
  const bag = { failures: [], warnings: [] };

  await page200(bag, probe, '/', {
    mintRequired: true,
    h1: true,
    match: [
      [/\$dasha/i, '/: missing $dasha'],
      [/\bChat\b/, '/: missing Chat'],
      [/\bBuy\b/, '/: missing Buy'],
      [/jup\.ag/, '/: missing jup.ag'],
      [/id=["']chat-door["']|class=["'][^"']*chat-door/, '/: missing chat-door'],
      [/faucet/i, '/: missing faucet'],
      [/grwm/i, '/: missing grwm'],
      // Must be a real <a> element. The bare href pattern also matched the
      // CSS selector `a[href="/compute"]` inside the stylesheet that HIDES
      // Compute, so this check passed while the link was invisible.
      [/<a\b[^>]*\bhref=["'](?:https:\/\/(?:www\.)?getdasha\.com)?\/compute\/?["'][^>]*>/i, '/: missing Compute link'],
    ],
    forbid: [
      [/chess-door/i, '/: chess-door is on Home'],
      [/\bVVAIFU\b/i, '/: VVAIFU is first paint — that copy belongs on /which'],
    ],
    after: async (b, html) => {
      warn(b, (html.match(/<h1[\s>]/gi) || []).length <= 1, '/: Home should have one H1');
      const hidesCompute = /[^{}]*(?:a\[href[^\]]*compute[^\]]*\]|\.compute\b)[^{}]*\{[^{}]*display\s*:\s*none[^{}]*\}/i.test(html);
      fail(b, !hidesCompute, '/: Compute link is hidden by a display:none rule');
    },
  });

  await page200(bag, probe, '/how-to-buy', {
    mintRequired: true,
    h1: true,
    match: [
      [/how to buy/i, '/how-to-buy: missing beginner buy copy'],
      [/mint/i, '/how-to-buy: missing mint checker'],
    ],
  });

  await page200(bag, probe, '/which', {
    mintRequired: true,
    h1: true,
    match: [[/VVAIFU|other (dasha|coin)/i, '/which: missing other-coin page']],
  });

  await page200(bag, probe, '/bag', {
    mintRequired: true,
    h1: true,
    match: [[/mint-dead|freeze-dead|burned/i, '/bag: missing on-chain facts']],
  });

  await page200(bag, probe, '/simp', {
    h1: true,
    match: [[/quiz|board|simp/i, '/simp: missing quiz/board']],
  });

  await page200(bag, probe, '/lobby', {
    h1: true,
    match: [[/lobby|chat|forum|community|simp/i, '/lobby: missing community room']],
  });

  await page200(bag, probe, '/chess', {
    heading: true,
    forbid: [
      [/id=["']buy-share-x["']/, '/chess: leftover id=buy-share-x'],
    ],
    after: async (b, html) => {
      const api = chessApi(html);
      fail(b, api !== null, '/chess: var API is missing');
      fail(b, Boolean(api), '/chess: var API is empty');
      if (api) {
        fail(
          b,
          api === LOBBY || api === `${LOBBY}/`,
          `/chess: var API must be ${LOBBY} (got ${JSON.stringify(api)})`,
        );
      }
      fail(b, !playFindSurfacesBadResponse(html), '/chess: Play/Find surfaced "bad response"');
      const leftover = leftoverHits(html);
      fail(b, leftover.length === 0, `/chess: leftover after style+script strip — ${leftover.join(', ')}`);
    },
  });

  await page200(bag, probe, '/faucet', { heading: true });
  await page200(bag, probe, '/contribute', { heading: true });
  await page200(bag, probe, '/digest', {
    heading: true,
    match: [[/tape|digest/i, '/digest: missing branded tape']],
  });

  {
    const privacyHead = await probe(ORIGIN + '/privacy', { redirect: 'manual' });
    const loc = locationOf(privacyHead);
    fail(
      bag,
      privacyHead.status !== 308 || !isHomeLoc(loc),
      '/privacy: 308 home — Privacy must be a real 200 page',
    );
  }
  await page200(bag, probe, '/privacy', {
    h1: true,
    match: [[/<h1[^>]*>\s*Privacy\s*<\/h1>/i, '/privacy: H1 must be Privacy']],
  });

  {
    const feed = await probe(ORIGIN + '/bounties.json', { redirect: 'follow' });
    let listings = 0;
    if (feed.ok) {
      const text = await feed.text();
      warn(bag, /dasha-bounties-feed/.test(text), '/bounties.json: reachable but not the listings feed');
      try {
        const data = JSON.parse(text);
        listings = Array.isArray(data.items) ? data.items.length : 0;
      } catch { /* feed shape is a warning above */ }
    }
    if (listings > 0 || feed.ok) {
      await page200(bag, probe, '/bounties', {
        h1: true,
        match: [[/bount/i, '/bounties: missing bounty page']],
      });
    }
  }

  for (const route of HOME_308) {
    await expect308(bag, probe, route, isHomeLoc, 'https://www.getdasha.com/');
  }
  for (const route of BUY_308) {
    await expect308(bag, probe, route, isHowToBuyLoc, 'https://www.getdasha.com/how-to-buy');
  }
  await expect308(bag, probe, '/forum', isLobbyLoc, 'https://www.getdasha.com/lobby');
  await expect308(bag, probe, '/oauth/x/start', isOauthXLoc, `${LOBBY}/oauth/x/start`);

  await page200(bag, probe, '/compute', {
    h1: true,
    match: [
      [/<title>[^<]*Compute/i, '/compute: title must name Compute'],
      [/<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/www\.getdasha\.com\/compute["']/i, '/compute: missing www canonical'],
      [/OpenAI-compatible|Ollama|idle Macs/i, '/compute: missing product explanation'],
    ],
  });

  await checkComputeRelease(bag, probe, { origin: ORIGIN, fail });

  {
    const sitemap = await probe(`${ORIGIN}/sitemap.xml`, { redirect: 'follow' });
    fail(bag, sitemap.ok, 'sitemap.xml is missing — search engines have no route list');
    if (sitemap.ok) {
      const xml = await sitemap.text();
      fail(bag, !/lobby\?/.test(xml), 'sitemap: lobby? query must not be listed');
      for (const path of SITEMAP_REQUIRED) {
        fail(bag, xml.includes(`${ORIGIN}${path}`), `sitemap: missing ${path}`);
      }
      for (const path of SITEMAP_NOT_INDEXABLE) {
        fail(bag, !xml.includes(`${ORIGIN}${path}`), `sitemap: ${path} must not be an indexable 200`);
      }
    }
  }

  {
    const robots = await probe(`${ORIGIN}/robots.txt`, { redirect: 'follow' });
    warn(bag, robots.ok && (await robots.text()).trim().length > 0, 'robots.txt is empty — no rules and no Sitemap line');
  }

  {
    const price = await probe(`${LOBBY}/price`, { redirect: 'follow' });
    if (!price.ok) warn(bag, false, 'price: /price is unreachable — the homepage chart will be missing');
    else {
      const data = await price.json().catch(() => null);
      warn(bag, data && data.priceUsd > 0, 'price: /price returned no usable number');
      if (data) {
        const age = Number(data.staleForMs);
        if (data.stale) {
          fail(bag, Number.isFinite(age), 'price: reports itself stale but gives no age — the freshness check cannot see how bad it is');
          fail(bag, !(age > 30 * 60_000), `price: serving a reading ${Math.round(age / 60000)} minutes old — the chart is showing a stale number as current`);
        }
      }
    }
  }

  {
    const apex = await probe('https://getdasha.com/', { redirect: 'manual' });
    const loc = locationOf(apex);
    warn(bag, apex.status === 301 && /www\.getdasha\.com/.test(loc), 'apex getdasha.com should 301 to www');
  }

  if (!skipPages) {
    for (const [label, url] of [['pages', PAGES], ['pages /bounties/', PAGES + 'bounties/']]) {
      const res = await probe(url, { redirect: 'follow' });
      if (!res.ok) {
        warn(bag, false, `${label}: unreachable`);
        continue;
      }
      const html = await res.text();
      scanMint(bag, label, html, { required: label === 'pages' });
      fail(bag, !RETIRED.test(html), `${label}: a retired product is live again`);
    }
  }

  return bag;
}

function printReport(bag, json) {
  if (json) {
    console.log(JSON.stringify({ ok: bag.failures.length === 0, failures: bag.failures, warnings: bag.warnings }, null, 2));
    return;
  }
  for (const w of bag.warnings) console.log('  warn  ' + w);
  for (const f of bag.failures) console.error('  FAIL  ' + f);
  const target = process.argv.includes('--fixture') ? 'fixtures/watch' : ORIGIN;
  console.log(`\n${bag.failures.length} failure(s), ${bag.warnings.length} warning(s) on ${target}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const json = process.argv.includes('--json');
  const fixture = process.argv.includes('--fixture');
  const probe = fixture ? loadFixtureProbe() : liveProbe;
  const bag = await runWatch({ probe, skipPages: fixture });
  printReport(bag, json);
  process.exit(bag.failures.length ? 1 : 0);
}
