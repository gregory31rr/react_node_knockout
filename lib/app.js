/**
 * lib/app.js — the small web framework Knockout runs on (no outside packages).
 *
 *   app.get('/path/:id', handler) / app.post(...)   register a page
 *   page(req, {title, body})                        wrap a page in the app's frame (top bar, menu, phone tab bar)
 *   html`...`                                       safe HTML (lib/util.js): everything you put in ${} is escaped
 *   loginRequired / adminOnly / ownerOnly           who may open a page
 *   flash(res, text)                                a one-time message on the next page
 *   audit(req, action, detail)                      one line in the append-only activity log
 *
 * Who is who (set on every request by buildContext):
 *   req.user   the signed-in account       req.ws    their workspace (one manager's world)
 *   req.admin  true for the workspace's manager(s): sees and changes everything in the workspace
 *   req.me     the person record of a team member with an account (sees their own items, logs time, knocks things out)
 *   req.owner  true for the app owner (you): the Knockout admin console
 */
const crypto = require('crypto');
const { one, all, run } = require('./db');
const U = require('./util');
const { html, raw } = U;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const deny = (msg = 'You do not have access to that page.') => { throw new HttpError(403, msg); };
const notFound = () => { throw new HttpError(404, 'That page does not exist or you cannot see it.'); };
const bad = msg => { throw new HttpError(400, msg); };

// ───────────── routing ─────────────
const routes = [];
function add(method, pattern, handlers) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handlers });
}
const app = { get: (p, ...h) => add('GET', p, h), post: (p, ...h) => add('POST', p, h) };

// ───────────── cookies, body ─────────────
function parseCookies(h) { const o = {}; for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o; }
const secure = () => process.env.NODE_ENV === 'production';
function setCookie(res, name, value, maxAge) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure() ? '; Secure' : ''}; Max-Age=${maxAge}`;
  const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
const MAX_BODY = 60 * 1024 * 1024;   // recordings can be large; forms are tiny
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'That upload is too large (60 MB max).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}

// ───────────── sessions ─────────────
const SESSION_DAYS = 30;
async function loadSession(req) {
  const sid = parseCookies(req.headers.cookie).sid; if (!sid || sid.length > 100) return null;
  const s = await one('SELECT * FROM sessions WHERE id=?', U.sha256(sid));
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
async function startSession(req, res, user) {
  const sid = U.token(32), csrf = U.token(24);
  await run('INSERT INTO sessions(id,user_id,csrf,expires_at,ip,agent) VALUES(?,?,?,?,?,?)', U.sha256(sid), user.id, csrf, Date.now() + SESSION_DAYS * 864e5, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200));
  await run('UPDATE users SET last_login_at=ko_now() WHERE id=?', user.id);
  setCookie(res, 'sid', sid, SESSION_DAYS * 86400);
}
async function endSession(req, res) { if (req.session) await run('DELETE FROM sessions WHERE id=?', req.session.id); setCookie(res, 'sid', '', 0); }

async function buildContext(req) {
  req.user = null; req.ws = null; req.admin = false; req.me = null; req.owner = false;
  if (!req.session) return;
  const u = await one('SELECT * FROM users WHERE id=?', req.session.user_id);
  if (!u || u.disabled_at) return;
  req.user = u; req.owner = u.platform_role === 'owner';
  // Which workspace: the app owner helping someone, else the one they're looking at (if they still belong to it), else their first.
  req.memberships = await all("SELECT m.*, w.name ws_name, w.status ws_status FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.status='active' AND w.status<>'closed' ORDER BY m.role='admin' DESC, m.id", u.id);
  if (req.owner && req.session.help_ws) {
    req.ws = await one('SELECT * FROM workspaces WHERE id=?', req.session.help_ws);
    if (req.ws) { req.admin = true; req.helping = true; return; }
  }
  let m = req.memberships.find(x => Number(x.workspace_id) === Number(u.workspace_id)) || req.memberships[0];
  if (m) {
    // Only remember a fallback when they have no tie at all to the old one (a blocked membership may be let back in).
    if (Number(m.workspace_id) !== Number(u.workspace_id) && !(u.workspace_id && await one('SELECT 1 x FROM memberships WHERE user_id=? AND workspace_id=?', u.id, u.workspace_id))) await run('UPDATE users SET workspace_id=? WHERE id=?', m.workspace_id, u.id);
    req.ws = await one('SELECT * FROM workspaces WHERE id=?', m.workspace_id);
    req.admin = m.role === 'admin';
    req.me = await one('SELECT * FROM people WHERE workspace_id=? AND user_id=?', m.workspace_id, u.id) || null;
  }
  if (!u.last_seen_at || Date.now() - U.parseTs(u.last_seen_at).getTime() > 5 * 60e3) await run('UPDATE users SET last_seen_at=ko_now() WHERE id=?', u.id);
}
const loginRequired = req => { if (!req.user) throw new HttpError(401, 'Please sign in.'); };
/** Pages inside a workspace. A closed or paused workspace is read only (the app owner controls that). */
function wsRequired(req) {
  loginRequired(req);
  if (!req.ws) { if (req.owner) throw new HttpError(409, 'admin'); deny('Your account is not part of a workspace yet.'); }
  if (req.ws.status === 'closed') deny('This workspace is closed. Contact the Knockout owner.');
}
const adminOnly = req => { wsRequired(req); if (!req.admin) deny('Only the workspace manager can do that.'); };
const ownerOnly = req => { loginRequired(req); if (!req.owner) deny(); };
const paidOnly = req => { wsRequired(req); if (!['pro', 'team'].includes(req.ws.plan)) deny('Outside links are part of the paid plan.'); };

// ───────────── flash, audit, notify ─────────────
function flash(res, msg, kind = 'ok') { setCookie(res, 'flash', JSON.stringify({ msg: String(msg).slice(0, 400), kind }), 60); }
async function audit(req, action, detail) {
  await run('INSERT INTO audit(workspace_id,user_id,action,detail,ip) VALUES(?,?,?,?,?)', req.ws?.id || null, req.user?.id || null, action, detail ? JSON.stringify(detail).slice(0, 2000) : null, req.ip || null);
}
/** Managers of a workspace (for notices). */
const managers = wsId => all("SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='admin' AND m.status='active' AND u.disabled_at IS NULL", wsId);
/** A friendly code people share to connect, like KO-7F3K-92QX. */
const newCode = () => 'KO-' + U.code(4) + '-' + U.code(4);
/** What people can turn on or off (Settings → Notifications). Anything without a kind always comes through. */
const NOTIFY_KINDS = { done: 'Someone knocks something out', blocked: 'Someone marks a note waiting / blocked', unblocked: 'A blocker is cleared', vendor: 'A vendor updates or finishes their link',
  comments: 'Comments on notes', assigned: 'Something is handed to me or moved', nudges: 'Nudges', timeoff: 'Time off requests and answers', training: 'Certifications and training', calls: 'Call reminders' };
async function notify(userId, text, link, kind) {
  if (!userId) return;
  if (kind) { const u = await one('SELECT notify_prefs FROM users WHERE id=?', userId); try { if (u?.notify_prefs && JSON.parse(u.notify_prefs)[kind] === false) return; } catch { } }
  await run('INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)', userId, String(text).slice(0, 300), link || null);
}
const csrf = req => html`<input type="hidden" name="_csrf" value="${req.session?.csrf || ''}">`;
const baseUrl = req => process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

// ───────────── small view helpers ─────────────
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;
const empty = (text, extra = '') => html`<div class="empty"><p>${text}</p>${extra}</div>`;
// The three big buttons are Ask, Update and Task. Tell and Decision are there when you need them.
const KIND = { ask: ['Ask', '?', 'A question or request for someone'], update: ['Update', '↻', 'An update you need from someone'], task: ['Task', '✓', 'Work to do'], tell: ['Tell', '📣', 'Something to tell someone'], decision: ['Decision', '◆', 'A decision to make or get'] };
const PRI = { 1: ['P1', 'p1', 'Urgent'], 2: ['P2', 'p2', 'High'], 3: ['P3', 'p3', 'Normal'], 4: ['P4', 'p4', 'Low'] };
const STATUS = { open: 'Open', doing: 'In progress', waiting: 'Waiting', blocked: 'Blocked', done: 'Knocked out' };
const loeText = h => h == null || h === '' ? '' : Number(h) >= 8 && Number(h) % 8 === 0 ? `${Number(h) / 8}d` : `${+Number(h).toFixed(2)}h`;
const hoursText = h => h == null || h === '' ? '' : `${+Number(h).toFixed(1)}h`;
/** A steady color for each name (same name, same color). */
const hue = n => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = n => String(n || '?').replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const avatar = (p, size = '') => p ? html`<span class="av ${size}" style="--h:${hue(p.name)}" aria-hidden="true">${initials(p.name)}</span>` : '';
const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M9 8v16M9 16l9-8M12.5 13l7.5 11" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24" cy="9" r="2.6" fill="var(--punch)"/></svg>';
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#14182b">
<link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><script src="/static/app.js" defer><\/script>`;

const NAV = [
  ['/', 'Today', '◎'], ['/items', 'Items', '☰'], ['/calls', 'Calls', '◉', 'admin'], ['/people', 'People', '👥', 'admin'], ['/time-off', 'Time off', '🌴', 'member'],
  ['/training', 'Training', '📜', 'member'], ['/projects', 'Projects', '▤'], ['/insights', 'Insights', '▲'], ['/updates', 'Updates', '✉', 'admin'], ['/notes', 'Notes', '✎'],
];
// The simple view keeps only the few places most people need.
const SIMPLE_NAV = [['/', 'My board', '▦'], ['/people', 'People', '👥', 'admin'], ['/time-off', 'Time off', '🌴'], ['/updates', 'Updates', '✉', 'admin'], ['/notes', 'Notes', '✎']];
const navOn = (path, href) => href === '/' ? path === '/' : path === href || path.startsWith(href + '/') || (href === '/people' && /^\/(time-off|training)/.test(path));

async function page(req, { title, body, wide }) {
  const f = req.flashMsg, owner = req.owner;
  const unread = req.user ? Number((await one('SELECT count(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', req.user.id)).n) : 0;
  const simple = req.user?.view_mode !== 'full';
  const nav = !req.ws ? [] : simple ? SIMPLE_NAV.filter(n => !n[3] || (n[3] === 'admin' ? req.admin : !req.admin)) : NAV.filter(n => !n[3] || (n[3] === 'admin' ? req.admin : !req.admin));
  return html`<!doctype html><html lang="en"><head>${raw(HEAD)}<title>${title ? title + ' · ' : ''}Knockout</title></head>
<body class="${req.ws ? 'has-nav' : ''} ${req.user && req.user.view_mode !== 'full' ? 'simple' : ''}"><a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="top-in">
  <a class="brand" href="/">${raw(LOGO)}<span>Knockout</span></a>
  ${req.ws && (req.memberships?.length > 1 || req.helping) ? html`<details class="menu ws-switch"><summary class="ws-btn" aria-label="Switch workspace">${req.ws.name} ▾</summary><div class="menu-panel">
    <p class="muted small">Your workspaces</p>${(req.memberships || []).map(m => html`<form method="post" action="/switch">${csrf(req)}<button class="link" name="ws" value="${m.workspace_id}">${Number(m.workspace_id) === Number(req.ws.id) && !req.helping ? '✓ ' : ''}${m.ws_name}<small class="muted"> · ${m.role === 'admin' ? 'yours' : 'member'}</small></button></form>`)}</div></details>` : ''}
  ${req.ws ? html`<nav class="nav" aria-label="Main">${nav.map(([h, l]) => html`<a href="${h}" ${navOn(req.path, h) ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>` : ''}
  <div class="top-right">
    ${req.ws ? (req.user.view_mode !== 'full' ? html`<a class="btn primary add-btn" href="/board/new"><span aria-hidden="true">＋</span><span class="hide-sm">New note</span></a>` : html`<button type="button" class="btn primary add-btn" data-open-quick aria-label="Add something"><span aria-hidden="true">＋</span><span class="hide-sm">Add</span></button>`) : ''}
    ${req.user ? html`<a class="icon-btn" href="/notifications" aria-label="Notifications${unread ? `, ${unread} new` : ''}">🔔${unread ? html`<i class="dot">${unread}</i>` : ''}</a>
      <details class="menu"><summary class="icon-btn" aria-label="Account menu">${avatar({ name: req.user.name })}</summary><div class="menu-panel">
        <p class="muted small">${req.user.name}<br>${req.user.email}</p>
        ${req.ws ? html`<a href="/connect">🤝 Connect with someone</a><form method="post" action="/view">${csrf(req)}<button class="link" name="mode" value="${req.user.view_mode === 'full' ? 'simple' : 'full'}">${req.user.view_mode === 'full' ? '▦ Simple view (sticky notes)' : '◎ Full view (everything)'}</button></form><a href="/settings">Settings</a>` : ''}${owner ? html`<a href="/admin">Knockout admin</a>` : ''}
        <form method="post" action="/theme">${csrf(req)}<button class="link" name="theme" value="${req.user.theme === 'dark' ? 'light' : 'dark'}">${req.user.theme === 'dark' ? 'Light mode' : 'Dark mode'}</button></form>
        <form method="post" action="/logout">${csrf(req)}<button class="link">Sign out</button></form></div></details>` : ''}
  </div></div></header>
${req.helping ? html`<div class="help-bar">🛟 You're helping in <b>${req.ws.name}</b> as the Knockout owner. Everything you do is logged. <form method="post" action="/admin/help/stop">${csrf(req)}<button class="btn sm">Stop helping</button></form></div>` : ''}
<main id="main" class="wrap ${wide ? 'wide' : ''}">
  ${f ? html`<div class="flash ${f.kind}" role="status">${f.msg}</div>` : ''}
  ${body}
</main>
${req.ws ? html`${simple ? '' : quickAdd(req)}<nav class="tabbar" aria-label="Main">${nav.filter(n => simple || (req.admin ? ['/', '/items', '/calls', '/people', '/notes'] : ['/', '/items', '/time-off', '/projects', '/notes']).includes(n[0])).map(([h, l, ic]) => html`<a href="${h}" ${navOn(req.path, h) ? raw('aria-current="page"') : ''}><span aria-hidden="true">${ic}</span>${l}</a>`)}</nav>` : ''}
</body></html>`;
}
/** Ask · Update · Task (and Tell, Decision): picks the kind for a quick add. "Auto" lets the words decide. */
function kindPicker(sel = '') {
  const opt = (k, l, cls = '') => html`<label class="kp ${cls}"><input type="radio" name="kind" value="${k}" ${sel === k ? raw('checked') : ''}><span>${l}</span></label>`;
  return html`<div class="kind-pick" role="radiogroup" aria-label="What is it?">${opt('ask', '? Ask')}${opt('update', '↻ Update')}${opt('task', '✓ Task')}${opt('tell', '📣 Tell', 'more')}${opt('decision', '◆ Decision', 'more')}${opt('', 'Auto', 'auto')}</div>`;
}
/** The quick-add box (opens from ＋ or by pressing "n"): one line, plain words. */
function quickAdd(req, defaults = {}) {
  return html`<dialog class="quick" id="quick"><form method="post" action="/items/quick" class="stack">${csrf(req)}
    <input type="hidden" name="back" value="${req.url}">${Object.entries(defaults).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <p class="big-label" id="q-label">What do you need to knock out?</p>
    ${kindPicker()}
    <input id="q-text" name="text" required autocomplete="off" maxlength="500" aria-labelledby="q-label" placeholder="@john cutover date #gcp p1 2h fri" data-parse>
    <div class="parse-preview muted small" aria-live="polite"></div>
    <p class="muted small"><b>Ask</b> a question · get an <b>Update</b> from someone · a <b>Task</b> to do. Then: <b>@name</b> person · <b>#tag</b> project · <b>p1</b>–<b>p4</b> · <b>2h</b> / <b>30m</b> / <b>1d</b> LOE · <b>fri</b>, <b>next week</b>, <b>10/15</b> due · <b>for @sam</b> hands it to Sam</p>
    <div class="actions"><button class="btn primary">Add it</button><button type="button" class="btn" data-close>Cancel</button></div></form></dialog>`;
}
function bare(title, body) {
  return html`<!doctype html><html lang="en"><head>${raw(HEAD)}<title>${title} · Knockout</title></head><body class="bare"><main id="main" class="wrap narrow">
    <a class="brand big" href="/">${raw(LOGO)}<span>Knockout</span></a>${body}</main></body></html>`;
}

module.exports = {
  app, routes, HttpError, deny, notFound, bad, parseCookies, setCookie, readBody, loadSession, startSession, endSession, buildContext,
  loginRequired, wsRequired, adminOnly, ownerOnly, paidOnly, flash, audit, notify, NOTIFY_KINDS, managers, newCode, csrf, baseUrl, page, bare, quickAdd, kindPicker, badge, empty, avatar, initials,
  KIND, PRI, STATUS, loeText, hoursText, LOGO, HEAD,
};
