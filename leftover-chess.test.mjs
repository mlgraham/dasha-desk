#!/usr/bin/env node
/**
 * Leftover lock after style+script strip.
 *
 * Live /chess still ships unused leftover id=buy-share-x in the hidden
 * buy-flash after the buy-share-tg strip. Worker polish should drop it.
 *
 * Official Dasha Telegram stays: https://t.me/+xB7S8mIQaKFiZjRh
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
  if (/id=["']buy-share-x["']/.test(stripped)) hits.push('buy-share-x');
  return hits;
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
  }

  {
    const officialFooter = `<footer><a href="${OFFICIAL_TG}">Telegram</a></footer>`;
    assert.deepEqual(leftoverHits(officialFooter), []);
  }

  {
    const leftoverChess = '<p id="buy-flash" hidden>bought. <a id="buy-share-x" href="https://x.com/intent/post">X</a></p>';
    assert.deepEqual(leftoverHits(leftoverChess), ['buy-share-x']);
  }

  {
    const leftoverInScript = '<script>var id="buy-share-x";</script><h1>Chess</h1>';
    assert.deepEqual(leftoverHits(leftoverInScript), []);
  }

  assert.doesNotMatch(stripStyleScript(read('fixtures/watch/chess.html')), /id=["']buy-share-x["']/);

  console.log('leftover-chess: PASS');
}
