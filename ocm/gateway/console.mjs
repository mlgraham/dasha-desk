/**
 * Server-rendered consoles (PDF §05: "Consoles — two static pages").
 *
 * Served on the console hostname by Host header, so it shares the gateway's ALB
 * target group and needs no extra infrastructure.
 *
 * There are no accounts yet, so this shows network-wide state and says so. Showing
 * a per-provider earnings figure before providers can log in would be theatre.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const dur = (s) => {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
};

const num = (n) => n.toLocaleString('en-US');

/** Relative time for funnel columns: a person reads "3h ago" faster than a timestamp. */
const ago = (d) => {
  if (!d) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(d)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/**
 * One table, four steps: code issued, enrolled, first connected, first job. Shared by
 * the owner's dashboard and the admin network view (which adds the owner column).
 */
function funnelTable(rows, { live, firstServed, credited, owner = null }) {
  if (!rows.length) return '';
  const body = rows.map((r) => {
    const h = r.agent_id ? live.get(r.agent_id) : null;
    const now = r.pending ? '<span class="muted">waiting for the installer</span>'
      : h ? (h.inflight ? 'Serving' : h.warm ? 'Ready' : 'Online, cold')
      : r.first_connected_at ? `<span class="muted">offline, seen ${esc(ago(r.last_connected_at))}</span>`
      : '<span class="muted">never connected</span>';
    const name = r.agent_id ? `<code>${esc(r.agent_id)}</code>`
      : `${esc(r.label || 'unnamed')} <span class="muted">(${r.pending ? 'code outstanding' : 'unclaimed token'})</span>`;
    return `<tr>${owner ? `<td>${owner(r.account_id)}</td>` : ''}
    <td>${name}</td>
    <td>${esc(ago(r.issued_at))}</td>
    <td>${r.enrolled_at ? esc(ago(r.enrolled_at)) : (r.pending ? '—' : '<span class="muted">token, not code</span>')}</td>
    <td>${esc(ago(r.first_connected_at))}</td>
    <td>${esc(ago(r.agent_id ? firstServed[r.agent_id] : null))}</td>
    <td>${now}</td>
    <td>${num(r.agent_id ? (credited[r.agent_id] || 0) : 0)}</td></tr>`;
  }).join('');
  return `<table class="data">
<thead><tr>${owner ? '<th>Owner</th>' : ''}<th>Machine</th><th>Code issued</th><th>Enrolled</th><th>First connected</th><th>First job</th><th>Now</th><th>Credited</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

export async function stats(registry, ledger) {
  const led = await ledger.summary();
  const hosts = registry.online().map((h) => ({
    id: h.id,
    chip: h.caps.chip || '—',
    memory_gb: h.caps.memory_gb || 0,
    region: h.caps.region || '—',
    accountId: h.caps.accountId || null,
    runtime: h.caps.runtime || '—',
    models: [...h.models],
    inflight: h.inflight.size,
    // Same evidence /v1/network publishes: will this host answer in about a second,
    // or does it have to load a model first.
    warm: [...h.warm.keys()].some((m) => registry.isWarm(h, m)),
    uptime_s: Math.round((Date.now() - h.connectedAt) / 1000),
    credited: led.creditedByHost[h.id] || 0,
  }));

  return {
    hosts,
    consumers: led.consumers,
    totals: led.totals,
    recent: led.recent,
  };
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b66;--line:#e4e3df;--card:#fff;--ok:#1a7f47;--idle:#9a9a94;--warn:#b45309;--accent:#1a1a19}
@media (prefers-color-scheme:dark){:root{--bg:#131312;--fg:#eeede9;--dim:#9a9a94;--line:#2b2b29;--card:#1c1c1a;--ok:#4ade80;--idle:#6b6b66;--warn:#fbbf24;--accent:#eeede9}}
*{box-sizing:border-box}
/* iOS Safari inflates text inside any block wider than the viewport, and computes the
   factor per block from its width. Our tables are min-width:480px inside a scrolling
   wrapper, so on a phone each column was boosted by a different amount and the widest
   column came out visibly larger than the rest of the page. 100% disables the automatic
   boost while leaving user-initiated zoom alone; 'none' would break that and is wrong. */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:40px 24px 72px}
a{color:var(--fg)}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:34px 0 12px;font-weight:600}
h3{font-size:15px;margin:0 0 8px}
.sub{color:var(--dim);margin:0 0 8px}
.note{border:1px solid var(--line);border-left:3px solid var(--dim);background:var(--card);padding:11px 14px;border-radius:6px;color:var(--dim);font-size:13px;margin:14px 0}
.warn{border-left-color:var(--warn)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.k{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.v{font-size:23px;font-variant-numeric:tabular-nums;margin-top:4px;letter-spacing:-.02em}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:480px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:11px 14px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
/* nowrap is opt-in, not the default. A blanket rule here kept dates like 2026-08-30
   whole, but it also applied to prose tables, forcing a whole paragraph onto one line
   and blowing that column out to ~1400px on a phone. Data tables opt in; prose wraps. */
table.data td, table.data th, th{white-space:nowrap}
tr:last-child td{border-bottom:0}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle}
.on{background:var(--ok)} .off{background:var(--idle)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-size:13px;background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow-x:auto;font-size:13px;line-height:1.5;margin:10px 0}
.empty{padding:22px 14px;color:var(--dim);font-size:14px}
form{margin:0}
label{display:block;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 5px}
input[type=text],input[type=email],input[type=password]{width:100%;padding:9px 11px;font:14px ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
button{margin-top:14px;padding:9px 16px;font:14px/1 ui-sans-serif,system-ui,sans-serif;background:var(--accent);color:var(--bg);border:0;border-radius:6px;cursor:pointer}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
.row>*{flex:1 1 280px}
.secret{background:var(--card);border:1px solid var(--warn);border-radius:8px;padding:14px;margin:12px 0}
.secret code{display:block;word-break:break-all;padding:9px 11px;font-size:13px;background:var(--bg)}
.muted{color:var(--dim);font-size:13px}
/* Provider guide: one command per line with room around it, so a sequence reads as
   steps rather than a wall. */
.step{margin:0 0 26px}
.step h3{font-size:15px;font-weight:600;margin:0 0 10px;letter-spacing:-.01em}
.step .num{color:var(--dim);font-weight:400;margin-right:8px}
.cmd{display:block;background:var(--card);border:1px solid var(--line);border-radius:6px;
  padding:11px 13px;margin:0 0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre}
.cap{font-size:13px;color:var(--dim);margin:0 0 14px;line-height:1.5}
.cap:last-child{margin-bottom:0}
.opt{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 5px}
.facts{margin:0 0 26px;padding:0;list-style:none}
.facts li{padding:9px 0;border-bottom:1px solid var(--line);font-size:14px;line-height:1.5}
.facts li:last-child{border-bottom:0}
.facts b{font-weight:600}
details{border:1px solid var(--line);border-radius:8px;background:var(--card);margin:0 0 26px}
summary{cursor:pointer;padding:13px 15px;font-size:14px;font-weight:600;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:'+';color:var(--dim);margin-right:9px;font-weight:400}
details[open] summary::before{content:'−'}
details .body{padding:0 15px 15px}
nav{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 18px;font-size:14px;align-items:center;min-width:0}
nav .links{display:flex;gap:16px;align-items:center;flex-wrap:wrap;min-width:0}
nav .links a{white-space:nowrap}
nav .who{display:flex;gap:10px;align-items:center;margin-left:auto;min-width:0;max-width:100%}
nav .who .muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
nav .who button{flex:none}
@media (max-width:520px){
  .wrap{padding:24px 16px 56px}
  nav .who{margin-left:0;width:100%;justify-content:space-between}
  h1{font-size:20px}
  .v{font-size:20px}
}
footer{margin-top:44px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
`;

const page = (title, body, { footer = true } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}
${footer ? `<footer>Tokens are counted at the gateway, never taken from a host's own report.
Prompts are visible in plaintext to whoever runs a provider — no confidentiality is
claimed that the architecture cannot enforce.</footer>` : ''}</div></body></html>`;

/**
 * Two groups so the header degrades in order on a narrow screen: the identity
 * group drops to its own row first, and the email truncates with an ellipsis
 * rather than widening the page. Nothing here is hidden by overflow — every link
 * and the button stay reachable at any width.
 */
const nav = (email, admin = false) => `<nav>
  <div class="links"><strong>OCM</strong>
    <a href="/">Overview</a><a href="/provider">Run a provider</a><a href="/status">Status</a>${admin ? '<a href="/network">Network</a>' : ''}</div>
  ${email ? `<div class="who"><span class="muted" title="${esc(email)}">${esc(email)}</span>
    <form method="post" action="/signout"><button class="ghost" style="margin:0;padding:6px 12px">Sign out</button></form></div>`
    : `<div class="who"><a class="muted" href="/">Sign in or create an account</a></div>`}</nav>`;

/** Shown exactly once — the plaintext is not recoverable afterwards. */
export function renderSecret({ title, secret, whatNext }) {
  return page(title, `<h1>${esc(title)}</h1>
<div class="secret"><strong>Copy this now — it is shown once and cannot be retrieved again.</strong>
<code>${esc(secret)}</code></div>
${whatNext || ''}
<p><a href="/">Back to the console</a></p>`);
}

/** The enrollment code page. Shown once; the code expires in minutes and works once. */
export function renderEnrollment({ code, label, agentId, expiresAt, apiHost }) {
  const mins = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 60000));
  const id = agentId || 'a-stable-name';
  return page('Enrollment code', `<h1>Enrollment code${label ? ` for ${esc(label)}` : ''}</h1>
<div class="secret"><strong>Valid for ${mins} minutes and works once.</strong>
<code>${esc(code)}</code></div>
<p>On the Mac you are adding, in Terminal:</p>
<pre>curl -fsSL https://${esc(apiHost)}/install.sh -o install.sh
shasum -a 256 install.sh      # compare with https://${esc(apiHost)}/install.sh.sha256
sudo OCM_AGENT_ID="${esc(id)}" sh install.sh</pre>
<p>The installer asks for this code with typing hidden, exchanges it for a provider token
that only this machine can use, and never shows you that token. If this machine was
enrolled before under the same name, its previous token is revoked in the same step, so
re-enrolling is how you rotate. Keep <code>OCM_AGENT_ID</code> the same every time.</p>
<p class="muted">A code that expires unused is harmless; issue another. Automation that
needs a long-lived credential can still use <strong>New provider token</strong>.</p>
<p><a href="/">Back to the console</a></p>`);
}

export function renderLanding({ inviteRequired, error }) {
  return page('OCM console', `<h1>Open-Compute Marketplace</h1>
<p class="sub">Alpha.</p>
${error ? `<div class="note warn">${esc(error)}</div>` : ''}
<div class="row">
  <div class="card"><h3>Sign in</h3>
    <p class="muted">With a developer key you already hold.</p>
    <form method="post" action="/signin">
      <label for="k">Developer key</label>
      <input id="k" type="password" name="key" placeholder="ocm_live_…" autocomplete="off" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
  <div class="card"><h3>Create an account</h3>
    <p class="muted">Anyone can sign up. An invite code is what gives you tokens.</p>
    <form method="post" action="/signup">
      <label for="e">Email</label>
      <input id="e" type="email" name="email" required>
      ${inviteRequired ? `<label for="i">Invite code <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
      <input id="i" type="text" name="invite" autocomplete="off" placeholder="leave blank to start with zero">` : ''}
      <button type="submit">Create account</button>
    </form>
  </div>
</div>
<div class="note">Without a code your account starts at zero tokens and requests will
be refused — you can redeem one from the console later. Credits are not money; there
is no billing.</div>`);
}

export async function renderDashboard({ registry, ledger, accounts, account, apiHost, notice, error, redeemed, inviteRequired, admin = false }) {
  const s = await stats(registry, ledger);
  const mine = s.consumers.find((c) => c.consumer === account.id)
    || { granted: 0, used: 0, balance: 0, requests: 0 };
  const creds = await accounts.listCredentials(account.id);
  const pending = typeof accounts.listEnrollments === 'function' ? await accounts.listEnrollments(account.id) : [];
  const myHosts = s.hosts.filter((h) => h.accountId === account.id);
  const funnel = typeof accounts.funnel === 'function'
    ? (await accounts.funnel(account.id)).filter((r) => !r.revoked_at) : [];
  const firstServed = typeof ledger.firstServedByHost === 'function' ? await ledger.firstServedByHost() : {};
  const led = await ledger.summary();
  const live = new Map(s.hosts.map((h) => [h.id, h]));
  const funnelHtml = funnelTable(funnel, { live, firstServed, credited: led.creditedByHost });

  const credRows = creds.length ? creds.map((c) => `<tr>
    <td>${c.kind === 'developer_key' ? 'Developer key' : 'Provider token'}</td>
    <td>${esc(c.label || '—')}</td>
    <td><code>${esc(c.id)}</code></td>
    <td>${c.kind === 'provider_token'
      ? (c.bound_agent_id ? `<code>${esc(c.bound_agent_id)}</code>` : '<span class="muted">unclaimed</span>')
      : '<span class="muted">—</span>'}</td>
    <td>${new Date(c.created_at).toISOString().slice(0, 10)}</td>
    <td>${c.last_used_at ? new Date(c.last_used_at).toISOString().slice(0, 10) : 'never'}</td>
    <td>${c.revoked_at ? '<span class="muted">revoked</span>'
      : `${c.kind === 'provider_token' && c.bound_agent_id
          ? `<form method="post" action="/keys/rebind" style="display:inline"><input type="hidden" name="credential_id" value="${esc(c.id)}">
             <button class="ghost" style="margin:0;padding:5px 10px">Release</button></form> `
          : ''}<form method="post" action="/keys/revoke" style="display:inline"><input type="hidden" name="credential_id" value="${esc(c.id)}">
         <button class="ghost" style="margin:0;padding:5px 10px">Revoke</button></form>`}</td>
  </tr>`).join('') : '';

  const hostRows = myHosts.length ? myHosts.map((h) => `<tr>
    <td><span class="dot ${h.inflight ? 'on' : 'off'}"></span><code>${esc(h.id)}</code></td>
    <td>${esc(h.chip)}</td><td>${h.memory_gb} GiB</td>
    <td>${dur(h.uptime_s)}</td><td>${num(h.credited)}</td>
  </tr>`).join('') : '';

  const redeemBlock = redeemed ? '' : `
<div class="note warn"><strong>This account has no tokens yet.</strong> API requests are
refused until an invite code is redeemed. One redemption per account.
<strong>This does not affect running a provider</strong> — contributing a Mac needs no
invite code, and earns credits as it serves.</div>
<form class="card" method="post" action="/redeem" style="margin-bottom:8px">
  <h3>Redeem an invite code</h3>
  <label for="rc">Invite code</label>
  <input id="rc" type="text" name="invite" autocomplete="off" required>
  <button type="submit">Redeem</button>
</form>`;

  return page('OCM console', `${nav(account.email, admin)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${error ? `<div class="note warn">${esc(error)}</div>` : ''}
${redeemBlock}
<h2>Your balance</h2>
<div class="grid">
  <div class="card"><div class="k">Balance</div><div class="v">${num(mine.balance)}</div></div>
  <div class="card"><div class="k">Used</div><div class="v">${num(mine.used)}</div></div>
  <div class="card"><div class="k">Requests</div><div class="v">${num(mine.requests)}</div></div>
  <div class="card"><div class="k">Providers online</div><div class="v">${s.hosts.length}</div></div>
</div>

<h2>Your providers</h2>
<div class="tablewrap">${funnelHtml || (hostRows ? `<table class="data">
<thead><tr><th>Host</th><th>Chip</th><th>Memory</th><th>Uptime</th><th>Tokens credited</th></tr></thead>
<tbody>${hostRows}</tbody></table>`
  : '<div class="empty">None yet. <a href="/provider">Run a provider</a> to contribute a Mac.</div>')}</div>
${funnelHtml ? `<p class="muted" style="margin-top:8px">Each machine's path: code issued, enrolled, first connected, first job served.
A row that stops early is where that machine's setup stopped.</p>` : ''}

<h2>Credentials</h2>
<div class="tablewrap">${credRows ? `<table class="data">
<thead><tr><th>Kind</th><th>Label</th><th>Id</th><th>Machine</th><th>Created</th><th>Last used</th><th></th></tr></thead>
<tbody>${credRows}</tbody></table>` : '<div class="empty">No credentials yet.</div>'}</div>
${creds.length ? `<p class="muted" style="margin-top:8px">Labels are free text and can collide.
Act on a credential by its <strong>id</strong>: the buttons here do, and scripted revocation should too.</p>` : ''}
${creds.some((c) => c.kind === 'provider_token') ? `<p class="muted" style="margin-top:8px">A provider
token claims the first machine that uses it and will not work from another one.
<strong>Release</strong> frees it for a different machine, for instance after a rebuild.</p>` : ''}
${pending.length ? `<p class="muted" style="margin-top:8px">${pending.length} enrollment code${pending.length === 1 ? '' : 's'} outstanding;
the newest expires in ${Math.max(1, Math.round((new Date(pending[0].expires_at) - Date.now()) / 60000))} min. Unused codes expire harmlessly.</p>` : ''}
<div class="row" style="margin-top:12px">
  <form class="card" method="post" action="/enroll">
    <h3>Enroll a Mac</h3><p class="muted">Get a one-time code, valid 15 minutes. The installer
    exchanges it for a token only that machine can use; re-enrolling rotates it.</p>
    <label for="l0">Machine name</label><input id="l0" type="text" name="label" placeholder="mac mini">
    <button type="submit">Get enrollment code</button></form>
  <form class="card" method="post" action="/keys/new">
    <input type="hidden" name="kind" value="developer_key">
    <h3>New developer key</h3><p class="muted">For calling the API.</p>
    <label for="l1">Label</label><input id="l1" type="text" name="label" placeholder="laptop">
    <button type="submit">Issue key</button></form>
  <form class="card" method="post" action="/keys/new">
    <input type="hidden" name="kind" value="provider_token">
    <h3>New provider token</h3><p class="muted">For automation that needs a long-lived
    credential. For a Mac you are setting up by hand, enroll it instead.</p>
    <label for="l2">Label</label><input id="l2" type="text" name="label" placeholder="ci-runner">
    <button type="submit">Issue token</button></form>
</div>

<h2>Using the API</h2>
<pre>export OPENAI_BASE_URL="https://${esc(apiHost)}/v1"
export OPENAI_API_KEY="ocm_live_…"</pre>
<p class="muted">Anything that speaks the OpenAI API works unmodified — no SDK of ours to install.
If your tool asks for a model we do not serve, such as <code>gpt-4o</code>, the request is
served by the network default rather than refused. The response tells you what actually
ran, in the <code>model</code> field and an <code>x-ocm-served-model</code> header, so a
substitution is never silent.</p>`);
}

/**
 * Public status: the recruiting view a prospect can see without signing in.
 * Hosts, chips, models, and tokens served — the same subset `/v1/network` already
 * publishes, plus two aggregate counters. Deliberately absent: owners, account ids,
 * balances, credentials, and any per-request log. `stats()` is not used here because
 * it carries account ids on hosts and a per-consumer table; this page reads only what
 * it will show.
 */
export async function renderStatus({ registry, ledger }) {
  const [led, today] = await Promise.all([ledger.summary(), ledger.servedToday()]);
  const hosts = registry.online().map((h) => ({
    id: h.id,
    chip: h.caps.chip || '—',
    memory_gb: h.caps.memory_gb || 0,
    region: h.caps.region || '—',
    models: [...h.models],
    inflight: h.inflight.size,
    warm: [...h.warm.keys()].some((m) => registry.isWarm(h, m)),
    uptime_s: Math.round((Date.now() - h.connectedAt) / 1000),
  }));
  // An idle host that has not loaded a model is cold, not warming: nothing is
  // happening until a request arrives, and then it takes about a minute.
  const state = (h) => h.inflight ? 'Serving' : h.warm ? 'Ready' : 'Cold';
  const models = registry.models();
  const allTime = led.totals.prompt_tokens + led.totals.completion_tokens;
  const todayTokens = today.prompt_tokens + today.completion_tokens;

  const hostRows = hosts.map((h) => `<tr>
    <td><span class="dot ${h.inflight || h.warm ? 'on' : 'off'}"></span><code>${esc(h.id)}</code></td>
    <td>${state(h)}</td>
    <td>${esc(h.chip)}</td><td>${h.memory_gb} GiB</td><td>${esc(h.region)}</td>
    <td>${esc(h.models.join(', ') || '—')}</td>
    <td>${dur(h.uptime_s)}</td></tr>`).join('');

  return page('OCM status', `${nav('')}
<h1>Network status</h1>
<p class="sub">Live. Idle Apple Silicon Macs behind one OpenAI-compatible API.</p>
<div class="grid">
  <div class="card"><div class="k">Providers online</div><div class="v">${hosts.length}</div></div>
  <div class="card"><div class="k">Tokens served today</div><div class="v">${num(todayTokens)}</div></div>
  <div class="card"><div class="k">Tokens served all time</div><div class="v">${num(allTime)}</div></div>
  <div class="card"><div class="k">Requests today</div><div class="v">${num(today.requests)}</div></div>
</div>

<h2>Providers</h2>
<div class="tablewrap">${hostRows ? `<table class="data">
<thead><tr><th>Host</th><th>State</th><th>Chip</th><th>Memory</th><th>Region</th><th>Serving</th><th>Connected</th></tr></thead>
<tbody>${hostRows}</tbody></table>` : '<div class="empty">No providers connected right now.</div>'}</div>
<p class="cap" style="margin-top:8px">Cold means the machine will load its model on the first request and answer in
about a minute; Ready and Serving answer in about a second.</p>

<h2>Models</h2>
<p>${models.length ? models.map((m) => `<code>${esc(m)}</code>`).join(' ') : '<span class="muted">None advertised.</span>'}</p>

<h2>Take part</h2>
<p>Have an Apple Silicon Mac that sits idle? <a href="/provider">Run a provider</a> and earn credits
for the tokens it serves. To call the network, <a href="/">create an account</a> and use any
OpenAI-compatible client unmodified.</p>
<p class="muted">Counters reset at midnight UTC (today began ${esc(today.since.slice(0, 16).replace('T', ' '))} UTC).
The same figures are available as JSON at <a href="/v1/network">/v1/network</a> on the API host.</p>`);
}

/** Admin-only: the whole network, with account emails. Never rendered to a non-admin. */
export async function renderNetwork({ registry, ledger, accounts, account }) {
  const s = await stats(registry, ledger);
  const all = await accounts.listAccounts();
  const emailOf = new Map(all.map((a) => [a.id, a.email]));
  const who = (id) => id ? esc(emailOf.get(id) || id) : '—';
  const funnelRows = typeof accounts.funnel === 'function'
    ? (await accounts.funnel()).filter((r) => !r.revoked_at) : [];
  const firstServed = typeof ledger.firstServedByHost === 'function' ? await ledger.firstServedByHost() : {};
  const led = await ledger.summary();
  const funnelAll = funnelTable(funnelRows, {
    live: new Map(s.hosts.map((h) => [h.id, h])), firstServed, credited: led.creditedByHost, owner: who,
  });
  const day = (d) => d ? new Date(d).toISOString().slice(0, 10) : 'never';

  const hostRows = s.hosts.map((h) => `<tr>
    <td><span class="dot ${h.inflight ? 'on' : 'off'}"></span><code>${esc(h.id)}</code></td>
    <td>${who(h.accountId)}</td>
    <td>${h.inflight ? 'Serving' : h.warm ? 'Ready' : 'Cold'}</td>
    <td>${esc(h.chip)}</td><td>${h.memory_gb} GiB</td>
    <td>${esc(h.models.join(', ') || '—')}</td><td>${h.inflight}</td>
    <td>${dur(h.uptime_s)}</td><td>${num(h.credited)}</td></tr>`).join('');

  const byConsumer = new Map(s.consumers.map((c) => [c.consumer, c]));
  const acctRows = all.map((a) => {
    const c = byConsumer.get(a.id) || { granted: 0, used: 0, balance: 0, requests: 0 };
    return `<tr><td>${esc(a.email)}</td><td>${day(a.created_at)}</td>
    <td>${a.developer_keys}</td><td>${a.provider_tokens}</td>
    <td>${num(c.balance)}</td><td>${num(c.used)}</td><td>${num(c.requests)}</td>
    <td>${day(a.last_used_at)}</td></tr>`;
  }).join('');

  const recentRows = s.recent.map((r) => `<tr>
    <td>${esc(new Date(r.at).toISOString().replace('T', ' ').slice(0, 19))}</td>
    <td>${who(r.consumer)}</td><td><code>${esc(r.host || '—')}</code></td>
    <td>${esc(r.model || '—')}</td><td>${num(r.promptTokens || 0)}</td><td>${num(r.completionTokens || 0)}</td></tr>`).join('');

  return page('OCM network', `${nav(account.email, true)}
<h1>Network</h1>
<p class="sub">Everything the gateway knows, across every account. Visible to administrators only.</p>
<div class="grid">
  <div class="card"><div class="k">Providers online</div><div class="v">${s.hosts.length}</div></div>
  <div class="card"><div class="k">Accounts</div><div class="v">${num(all.length)}</div></div>
  <div class="card"><div class="k">Requests</div><div class="v">${num(s.totals.requests)}</div></div>
  <div class="card"><div class="k">Prompt tokens</div><div class="v">${num(s.totals.prompt_tokens)}</div></div>
  <div class="card"><div class="k">Completion tokens</div><div class="v">${num(s.totals.completion_tokens)}</div></div>
</div>

<h2>Providers</h2>
<div class="tablewrap">${hostRows ? `<table class="data">
<thead><tr><th>Host</th><th>Owner</th><th>State</th><th>Chip</th><th>Memory</th><th>Models</th><th>In flight</th><th>Uptime</th><th>Credited</th></tr></thead>
<tbody>${hostRows}</tbody></table>` : '<div class="empty">No providers connected.</div>'}</div>

<h2>Onboarding funnel</h2>
<div class="tablewrap">${funnelAll || '<div class="empty">No provider machines yet.</div>'}</div>
<p class="muted" style="margin-top:8px">Every provider machine across every account, with where its setup got to.
Revoked tokens are omitted; a rotated machine shows its current token only.</p>

<h2>Accounts</h2>
<div class="tablewrap">${acctRows ? `<table class="data">
<thead><tr><th>Email</th><th>Created</th><th>Dev keys</th><th>Host tokens</th><th>Balance</th><th>Used</th><th>Requests</th><th>Last used</th></tr></thead>
<tbody>${acctRows}</tbody></table>` : '<div class="empty">No accounts.</div>'}</div>

<h2>Recent requests</h2>
<div class="tablewrap">${recentRows ? `<table class="data">
<thead><tr><th>When (UTC)</th><th>Consumer</th><th>Host</th><th>Model</th><th>Prompt</th><th>Completion</th></tr></thead>
<tbody>${recentRows}</tbody></table>` : '<div class="empty">No requests yet.</div>'}</div>
<p class="muted" style="margin-top:12px">Raw counters: <a href="/console/stats.json">stats.json</a> (anonymous, no emails).</p>`);
}

export function renderProviderGuide({ account = null, apiHost, models, admin = false, installHash = null }) {
  const email = account ? account.email : '';
  return page('Run a provider', `${nav(email, admin)}
<h1>Run a provider</h1>
<p class="sub">Contribute an Apple Silicon Mac and earn credits for the tokens it serves.</p>

<div class="note">Apple Silicon (M1 or later) and macOS 14+. The agent holds one
<em>outbound</em> connection, so there are no inbound ports and no router configuration.</div>

<h2>Worth knowing first</h2>
<ul class="facts">
<li><b>Credits are not money.</b> They count the tokens your machine has served. There is no payout and no expiry today.</li>
<li><b>You need no invite code at all.</b> Codes give API tokens to consumers; a provider earns by serving.</li>
<li><b>You will see the prompts.</b> Anything routed to your machine is visible to you in plaintext, and the same is true of every other provider.</li>
<li><b>It holds one model in memory,</b> about 4.5 GB, and downloads roughly the same on first use.</li>
<li><b>Inference runs as your account,</b> never as root. Only the installer needs <code>sudo</code>.
  The other side of that: the token file is owned by your account, so anything running as you can read it.</li>
</ul>

<h2>Install</h2>

<div class="step">
  <h3><span class="num">1</span>Get an enrollment code</h3>
  <p class="cap">On the <a href="/">console</a>, under <strong>Enroll a Mac</strong>. Give the
  machine a name; the code is shown once, is valid for 15 minutes, and works once. The
  installer exchanges it for a provider token that only this machine can use, and you never
  handle that token. Enrolling the same name again rotates it.</p>
  <div class="note warn"><strong>A developer key is not a provider token, and not an enrollment code either.</strong> Codes start
  <code>ocm_enroll_</code> and provider tokens <code>ocm_host_</code>; developer keys start
  <code>ocm_live_</code> and are refused here. This is the most common reason a new provider
  never appears.</div>
</div>

<div class="step">
  <h3><span class="num">2</span>Download the installer</h3>
  <p class="opt">Optional, skips a root shell</p>
  <code class="cmd">brew install uv</code>
  <p class="cap">The installer needs <code>uv</code>. Installing it yourself avoids the one
  step where the installer pipes a third party's script into a root shell.</p>
  <code class="cmd">curl -fsSL https://${esc(apiHost)}/install.sh -o install.sh</code>
</div>

<div class="step">
  <h3><span class="num">3</span>Check what you downloaded</h3>
  <code class="cmd">shasum -a 256 install.sh</code>
  ${installHash ? `<p class="cap">Should print <code style="word-break:break-all">${esc(installHash)}</code><br>
  Also at <a href="https://${esc(apiHost)}/install.sh.sha256">/install.sh.sha256</a>.</p>`
  : '<p class="cap">Compare with /install.sh.sha256.</p>'}
  <code class="cmd">less install.sh</code>
  <p class="cap">About 340 lines. It writes only to <code>/opt/ocm</code>,
  <code>/etc/ocm</code> and <code>/Library/LaunchDaemons</code>.</p>
</div>

<div class="step">
  <h3><span class="num">4</span>Run it</h3>
  <code class="cmd">sudo OCM_AGENT_ID="my-mac" sh install.sh</code>
  <p class="cap">It asks for your enrollment code (or a provider token) with typing hidden,
  so nothing lands in shell history or the process list. Do not put either on the command
  line. The code is exchanged and the resulting token checked against the gateway before
  anything is written, so a bad one fails here with the reason. Keep
  <code>OCM_AGENT_ID</code> the same on every reinstall: it is the name the token is bound
  to, and a different name registers a second provider instead of recovering the first.</p>
</div>

<div class="step">
  <h3><span class="num">5</span>Confirm it connected</h3>
  <code class="cmd">/opt/ocm/bin/ocm-agent-run --doctor</code>
  <p class="cap">Expect <code>token ok</code>. Your Mac then appears on the
  <a href="/">console</a> under <strong>Your providers</strong>.</p>
  <div class="note">The first request your machine serves takes <strong>up to about 90
  seconds</strong> while the model loads. Everything after that takes about a second.</div>
</div>

<h2>Changing the token later</h2>
<code class="cmd">sudo /opt/ocm/bin/ocm-agent-token</code>
<p class="cap">Prompts for the new token with typing hidden, verifies it first, and changes
nothing if the gateway refuses it. It will not accept a token as a command-line argument:
that would be visible to any local user through <code>ps</code> and kept in your shell
history. Automation can pipe the token on stdin or set <code>OCM_HOST_TOKEN_FILE</code>.
<strong>Do not edit</strong> <code>/opt/ocm/bin/ocm-agent-run</code>, which is generated on
every reinstall and holds no token.</p>

<h2>Updating later</h2>
<code class="cmd">sudo /opt/ocm/bin/ocm-agent-update</code>
<p class="cap">Moves this machine to the current agent build with nothing to retype: it reads
the settings and token already on disk, fetches the current installer from the same
gateway, checks its published checksum, and runs it. The new agent has to pass its own
check as your account before anything is replaced. Add <code>--check</code> to see whether
a new build exists without changing anything.</p>

<details><summary>Setting this up with an AI agent</summary><div class="body">
<p class="cap">Paste this to it.</p>
<pre>You are installing the OCM provider agent on this Mac. It contributes idle GPU to a
compute marketplace and earns credits, which are a token count and not money.

Verify before installing:
1. \`uname -m\` must be arm64. MLX cannot run on Intel and the installer refuses.
2. Download, do not pipe:
   curl -fsSL https://${esc(apiHost)}/install.sh -o install.sh
3. Compare \`shasum -a 256 install.sh\` with https://${esc(apiHost)}/install.sh.sha256
   Stop if they differ.
4. Read it. About 340 lines. It writes only to /opt/ocm, /etc/ocm and
   /Library/LaunchDaemons, and sends the token only to /v1/provider/verify.
5. \`brew install uv\` first if Homebrew is present, to skip the root-shell step.

Ask the user for an ENROLLMENT CODE starting ocm_enroll_, issued in the console under
Enroll a Mac (valid 15 minutes, works once). A provider token starting ocm_host_ also
works. A developer key (ocm_live_) is refused.

Never put the code or a token on a command line: it would sit in shell history and be
visible to any local user through ps. The installer asks for it with typing hidden:

  sudo OCM_AGENT_ID="a-stable-name" sh install.sh

If you cannot drive an interactive prompt, ask the user to run that one line and
paste the token when asked. Do not work around the prompt.

Keep OCM_AGENT_ID identical on every reinstall or the machine registers twice.
Inference runs as the invoking user, not root.
Confirm with: /opt/ocm/bin/ocm-agent-run --doctor   (expect: token ok)
The first request takes up to ~90s while the model loads. That is not a fault.
Rotate later with: sudo /opt/ocm/bin/ocm-agent-token   (it prompts; or pipe on stdin)
Update later with: sudo /opt/ocm/bin/ocm-agent-update  (--check to only look; no token needed)
Never edit /opt/ocm/bin/ocm-agent-run; it is generated and holds no token.

Tell the user plainly: as a provider they can read every prompt routed to this
machine in plaintext, and so can every other provider.</pre>
</div></details>

<details><summary>If it will not connect</summary><div class="body">
<div class="tablewrap"><table>
<tbody>
<tr><td>First request takes ~90s</td><td>The model is loading. Nothing to do.</td></tr>
<tr><td><code>REFUSED BY GATEWAY</code></td><td>Token wrong, revoked, or never issued here. Issue a new one.</td></tr>
<tr><td><code>a developer key…</code></td><td>An <code>ocm_live_</code> key is in <code>OCM_HOST_TOKEN</code>.</td></tr>
<tr><td><code>disconnected… retrying</code></td><td>Ordinary churn. It reconnects itself.</td></tr>
<tr><td>Connected, not listed</td><td>No models reported. <code>--doctor</code> names the problem.</td></tr>
</tbody></table></div>
</div></details>

<h2>What it will run</h2>
<p class="muted">${models.length ? models.map(esc).join(', ') : 'No models are currently served.'}
Expect the fans under sustained load. The agent does not yield the GPU back automatically,
so treat it as a background tenant on a machine you are still using.</p>

${account ? '' : `<div class="note"><a href="/">Create an account</a> to issue a provider
token. No invite code is needed to run a provider.</div>`}`);
}
