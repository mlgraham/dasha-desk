# Live getdasha.com routes

Source of record is the operator Cloudflare Worker **dasha-lobby** (www + lobby hosts).
This repository does not contain that Worker. Do not invent one here. Do not
`wrangler deploy` from here. Do not Designer-publish. GitHub Pages is a mirror for
static pastes, not production.

Mint (exact): `53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump`.
Jupiter is `jup.ag` + that mint. Never `plugin.jup.ag`.

`watch.mjs` asserts this map. Wrong redirects, blank pages, stale SRI, missing H1,
broken OAuth start, and a wrong mint are failures.

## 200

| Route | Job |
| --- | --- |
| `/` | `$dasha` + Chat + Buy. `jup.ag` + mint. chat-door + faucet + grwm. No plugin.jup.ag, no chess-door, no VVAIFU (other-coin copy is `/which`, not first paint). |
| `/how-to-buy` | Beginner buy + mint checker. |
| `/which` | Other-coin page. |
| `/bag` | On-chain facts. |
| `/simp` | Quiz / board. |
| `/lobby` | The one community room. |
| `/chess` | Play on www. Client `var API` must be `https://lobby.getdasha.com` and must not be empty. Play/Find must not surface `bad response`. leftover `id=buy-share-x` stays gone. |
| `/faucet` | Public faucet. |
| `/privacy` | Real Privacy page, H1 Privacy. **Not** 308 home. |
| `/contribute` | Contribute. |
| `/bounties` | 200 when listings exist. |
| `/digest` | Branded tape with an H1 or section heading. |
| `/compute` | Dasha Compute. Branded product page with a www canonical and a clear open-model/Ollama explanation. |

## 308

| Route | Location |
| --- | --- |
| `/studio` `/verse` `/learn` `/graph` | `https://www.getdasha.com/` |
| `/dasha` `/desk` | `https://www.getdasha.com/how-to-buy` (named tool, not generic home) |
| `/forum` | `https://www.getdasha.com/lobby` |
| `/oauth/x/start` (www) | `https://lobby.getdasha.com/oauth/x/start` |

## Retired

| Route | Job |
| --- | --- |
| `/studio` | Retired. Do not restore Meme Studio on www. |

## Sitemap

Must include `/privacy` `/lobby` `/chess` `/faucet` `/bag` `/how-to-buy` `/simp` `/compute`.

Must not list a `lobby?` query, and must not list `/studio` `/dasha` `/desk` `/verse` `/learn` `/graph` as indexable 200s.

## Chess off Home

Chess is `/chess`. Home must not ship a chess-door.
