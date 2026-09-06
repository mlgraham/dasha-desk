#!/usr/bin/env node
/**
 * Leftover lock after style+script strip.
 *
 * Official Dasha Telegram stays: https://t.me/+xB7S8mIQaKFiZjRh
 * Footer (and other intentional community chrome) may use that exact invite.
 * Invented groups fail. Quiet pin may not dump mint/Buy/Chess/TG.
 *
 * Leftover ids still gone: forum-play, buy-share-tg.
 * Play on lobby (forum-play-go) is product.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OFFICIAL_TG = 'https://t.me/+xB7S8mIQaKFiZjRh';

const root = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

export function stripStyleScript(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
}

export function leftoverHits(html) {
  const stripped = stripStyleScript(html);
  const hits = [];
  if (/id=["']forum-play["']/.test(stripped)) hits.push('forum-play');
  if (/id=["']buy-share-tg["']/.test(stripped)) hits.push('buy-share-tg');
  return hits;
}

function pinInners(html) {
  const stripped = stripStyleScript(html);
  const inners = [];
  for (const m of stripped.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = m[2];
    if (
      /\bclass=["'][^"']*\bforum-pin\b/.test(attrs)
      || /\bclass=["'](?:[^"']*\s)?pin(?:\s[^"']*)?["']/.test(attrs)
      || /\bid=["']pin["']/.test(attrs)
    ) {
      inners.push(m[3]);
    }
  }
  return inners;
}

export function pinDumpHits(html) {
  const hits = [];
  for (const inner of pinInners(html)) {
    if (/t\.me\//i.test(inner) || /telegram\.me\//i.test(inner) || /\bTelegram\b/i.test(inner) || />TG</i.test(inner)) {
      hits.push('pin-tg');
    }
    const pile = [
      /53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump/.test(inner),
      /\bBuy\b/i.test(inner),
      /\bChess\b/i.test(inner),
    ].filter(Boolean).length;
    if (pile >= 2) hits.push('pin-dump');
  }
  return [...new Set(hits)];
}

export function unofficialTelegramHrefs(html) {
  return [...String(html).matchAll(/https?:\/\/(?:t\.me|telegram\.me)\/[^\s"'<>]*/gi)]
    .map((m) => m[0].replace(/\/$/, ''))
    .filter((href) => href !== OFFICIAL_TG);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const surfaces = {
    'home/index.html': read('home/index.html'),
    'lobby/index.html': read('lobby/index.html'),
    'privacy/index.html': read('privacy/index.html'),
    'desk/index.html': read('desk/index.html'),
    '404.html': read('404.html'),
    'bounties/index.html': read('bounties/index.html'),
    'fixtures/watch/home.html': read('fixtures/watch/home.html'),
    'fixtures/watch/lobby.html': read('fixtures/watch/lobby.html'),
    'fixtures/watch/chess.html': read('fixtures/watch/chess.html'),
    'fixtures/watch/howto.html': read('fixtures/watch/howto.html'),
    'fixtures/watch/bounties.html': read('fixtures/watch/bounties.html'),
  };

  for (const [name, html] of Object.entries(surfaces)) {
    const hits = leftoverHits(html);
    assert.deepEqual(hits, [], `${name} leftover after style+script strip: ${hits.join(', ')}`);
    assert.deepEqual(pinDumpHits(html), [], `${name} quiet pin dumped mint/Buy/Chess/TG`);
    assert.deepEqual(unofficialTelegramHrefs(html), [], `${name} invented Telegram group`);
  }

  {
    const officialFooter = `<footer><a href="${OFFICIAL_TG}">Telegram</a></footer>`;
    assert.deepEqual(leftoverHits(officialFooter), []);
    assert.deepEqual(pinDumpHits(officialFooter), []);
    assert.deepEqual(unofficialTelegramHrefs(officialFooter), []);
  }

  {
    const pinDump = `<p class="forum-pin"><span class="forum-ca">53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump</span> <a href="${OFFICIAL_TG}">TG</a></p>`;
    assert.deepEqual(leftoverHits(pinDump), []);
    assert.ok(pinDumpHits(pinDump).includes('pin-tg'));
    assert.deepEqual(unofficialTelegramHrefs(pinDump), []);
  }

  {
    const invented = '<footer><a href="https://t.me/dashacommunity">Telegram</a></footer>';
    assert.deepEqual(unofficialTelegramHrefs(invented), ['https://t.me/dashacommunity']);
  }

  {
    const leftoverChess = `<a id="buy-share-tg" href="${OFFICIAL_TG}">TG</a>`;
    assert.deepEqual(leftoverHits(leftoverChess), ['buy-share-tg']);
    assert.deepEqual(unofficialTelegramHrefs(leftoverChess), []);
  }

  {
    const alreadyGone = '<section id="forum-play" class="forum-play"></section>';
    assert.deepEqual(leftoverHits(alreadyGone), ['forum-play']);
  }

  assert.doesNotMatch(stripStyleScript(read('lobby/index.html')), /id=["']forum-play-go["']/);
  assert.doesNotMatch(stripStyleScript(read('lobby/index.html')), /id=["']bb-x["']/);
  assert.match(read('bounties/index.html'), /id="bb-x"/);
  assert.match(read('bounties/index.html'), /href="https:\/\/lobby\.getdasha\.com\/oauth\/x\/start"/);

  console.log('leftover-lobby: PASS');
}
