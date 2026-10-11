/**
 * routes/home.js — Today: the first thing you see.
 *
 * Manager view: your score (knocked out today / this week, LOE done), then
 *   Needs a decision now   overdue items and items that will miss their date (with who could take them)
 *   Today & tomorrow, This week, Top priority with no date
 *   Waiting on others      things you handed to people, oldest first
 *   To tell / To ask       grouped by person: tap a name to open their 1:1 page with everything for them
 * Team member view: their own list (late, today, this week, later), questions waiting for their answer, and what they knocked out.
 */
const A = require('../lib/app');
const { app, page, csrf } = A;
const { one, all } = require('../lib/db');
const U = require('../lib/util');
const { html } = U;
const W = require('../lib/work');
const V = require('../lib/views');

const scoreSql = (s, since) => one(`SELECT count(*) n, COALESCE(sum(loe),0) loe FROM items i WHERE ${s.sql} AND i.status='done' AND i.completed_at >= ?`, ...s.args, since);
function weekStart() { const t = U.today(), wd = new Date(t + 'T12:00:00Z').getUTCDay() || 7; return U.addDays(t, 1 - wd); }

app.get('/', async (req, res) => {
  if (!req.user) return res.redirect(await one('SELECT 1 x FROM users LIMIT 1') ? '/login' : '/signup');
  A.wsRequired(req);
  if (req.user.view_mode !== 'full') return require('./board').board(req, res);   // the simple sticky-note board
  const s = W.scope(req), t = U.today(), wk = weekStart();
  const open = await all(`${W.LIST_SQL} WHERE ${s.sql} AND i.status IN ${W.OPEN} ORDER BY ${W.ORDER}`, ...s.args);
  const risk = await W.risk(req.ws, open);
  const [dToday, dWeek] = [await scoreSql(s, t + ' 00:00:00'), await scoreSql(s, wk + ' 00:00:00')];
  const streak = await streakDays(s);
  const mine = i => req.admin ? !i.owner_person_id : Number(i.owner_person_id) === Number(req.me?.id) || (!i.owner_person_id && Number(i.created_by) === Number(req.user.id));
  const myOpen = open.filter(mine);
  const atRisk = myOpen.filter(i => risk.has(i.id)).concat(req.admin ? open.filter(i => !mine(i) && risk.get(i.id)?.state === 'overdue') : []);
  const riskIds = new Set(atRisk.map(i => i.id));
  const soon = myOpen.filter(i => !riskIds.has(i.id) && i.due_on && i.due_on <= U.addDays(t, 1));
  const week = myOpen.filter(i => !riskIds.has(i.id) && i.due_on && i.due_on > U.addDays(t, 1) && i.due_on <= U.addDays(wk, 6));
  const later = myOpen.filter(i => !riskIds.has(i.id) && (!i.due_on || i.due_on > U.addDays(wk, 6)) && !['tell', 'ask', 'update'].includes(i.kind));
  const endToday = U.addDays(t, 1) + ' 06:00:00';
  const rems = await all('SELECT * FROM reminders WHERE user_id=? AND workspace_id=? AND done_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT 12', req.user.id, req.ws.id, endToday);
  const remCard = rems.length ? html`<section class="card" id="rem"><div class="card-head"><h2>⏰ Reminders</h2><a class="small" href="/notes#reminders">All</a></div><ul class="rows">${rems.map(r => html`<li class="${r.remind_at <= U.nowSql() ? 'due' : ''}"><span><b>${r.text}</b><small class="block muted" data-utc="${r.remind_at}">${U.fmtDateTime(r.remind_at)}</small></span>
    <div class="actions"><form method="post" action="/reminders/${r.id}/done">${csrf(req)}<input type="hidden" name="back" value="/"><button class="btn sm primary">Done</button></form><form method="post" action="/reminders/${r.id}/snooze">${csrf(req)}<input type="hidden" name="back" value="/"><button class="btn sm">Tomorrow</button></form></div></li>`)}</ul></section>` : '';
  const TO = require('../lib/timeoff');
  const outRows = req.admin ? await TO.whoIsOut(req.ws, t, U.addDays(t, 6)) : [];
  const outCard = outRows.length ? html`<section class="card"><div class="card-head"><h2>🌴 Who's out</h2><a class="small" href="/time-off">Time off</a></div><ul class="rows small">${outRows.slice(0, 10).map(r => html`<li><span><b>${r.name || 'Everyone'}</b> · ${TO.KINDS[r.kind][1]} ${TO.KINDS[r.kind][0]}</span><span class="muted">${r.start_on <= t && r.end_on >= t ? 'today' + (r.end_on > t ? ' → ' + U.fmtDate(r.end_on).replace(/, \d{4}$/, '') : '') : U.fmtDate(r.start_on).replace(/, \d{4}$/, '') + (r.end_on !== r.start_on ? ' → ' + U.fmtDate(r.end_on).replace(/, \d{4}$/, '') : '')}</span></li>`)}</ul></section>` : '';
  const certs = req.admin ? await all("SELECT c.*, p.name pn FROM certs c JOIN people p ON p.id=c.person_id WHERE c.workspace_id=? AND p.active=1 AND c.expires_on IS NOT NULL AND c.expires_on <= ? ORDER BY c.expires_on LIMIT 8", req.ws.id, U.addDays(t, 60)) : [];
  const certCard = certs.length ? html`<section class="card"><div class="card-head"><h2>📜 Certs to renew</h2><a class="small" href="/training">Training</a></div><ul class="rows small">${certs.map(c => html`<li><span><b>${c.pn}</b> · ${c.name}</span><span class="chip ${require('./training').certState(c)[1]}">${require('./training').certState(c)[0]}</span></li>`)}</ul></section>` : '';
  const greet = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })();
  const stats = html`<div class="score">
      <div class="stat"><b>${dToday.n}</b><span>knocked out today</span></div>
      <div class="stat"><b>${dWeek.n}</b><span>this week</span></div>
      <div class="stat"><b>${A.hoursText(dWeek.loe) || '0h'}</b><span>LOE done this week</span></div>
      <div class="stat ${atRisk.length ? 'hot' : ''}"><b>${atRisk.length}</b><span>late or at risk</span></div>
      ${streak > 1 ? html`<div class="stat"><b>🔥 ${streak}</b><span>day streak</span></div>` : ''}</div>`;
  const quick = html`<form method="post" action="/items/quick" class="quick-inline">${csrf(req)}${A.kindPicker()}<input type="hidden" name="back" value="/">
      <label class="sr" for="qi">Add something</label><input id="qi" name="text" required autocomplete="off" maxlength="500" placeholder="Add: Ask @john about cutover #gcp p1 2h fri" data-parse>
      <button class="btn primary">Add</button><div class="parse-preview muted small" aria-live="polite"></div></form>`;
  const sec = (title, items, extra = {}) => items.length ? html`<section class="card"><div class="card-head"><h2>${title} <span class="count">${items.length}</span></h2>${extra.link ? html`<a class="small" href="${extra.link[0]}">${extra.link[1]}</a>` : ''}</div>${V.list(req, items, { risk, ...extra })}</section>` : '';

  let body;
  if (req.admin) {
    const waiting = open.filter(i => i.owner_person_id && !['tell'].includes(i.kind)).sort((a, b) => String(a.delegated_at || a.created_at).localeCompare(String(b.delegated_at || b.created_at)));
    const talk = myOpen.filter(i => ['tell', 'ask', 'update'].includes(i.kind) && i.person_id);
    const byPerson = {}; for (const i of talk) (byPerson[i.person_id] = byPerson[i.person_id] || { name: i.person_name, n: 0, kinds: {} }).n++, byPerson[i.person_id].kinds[i.kind] = (byPerson[i.person_id].kinds[i.kind] || 0) + 1;
    const calls = await all("SELECT * FROM meetings WHERE workspace_id=? AND status<>'done' AND (starts_at IS NULL OR starts_at >= ?) ORDER BY starts_at LIMIT 5", req.ws.id, t);
    const people = Number((await one('SELECT count(*) n FROM people WHERE workspace_id=?', req.ws.id)).n);
    body = html`<div class="head"><div><h1>${greet}, ${req.user.name.split(' ')[0]}</h1><p class="muted">${U.fmtDate(t)} · ${myOpen.length} open on your plate${waiting.length ? ` · ${waiting.length} with your team` : ''}</p></div></div>
      ${stats}${quick}
      ${!people ? html`<section class="card callout"><h2>Start here</h2><p>Add the people you work with. Paste a Teams or Zoom participant list, or type names.</p><a class="btn primary" href="/people/import">Add people</a></section>` : ''}
      ${remCard}
      ${atRisk.length ? html`<section class="card hot"><div class="card-head"><h2>Needs a decision <span class="count">${atRisk.length}</span></h2><span class="muted small">Late, or won't fit before the due date. Delegate, move the date, or knock it out.</span></div>${V.list(req, atRisk, { risk })}</section>` : ''}
      <div class="cols">
        <div>
          ${sec('Today & tomorrow', soon)}${sec('This week', week)}
          ${sec('Next up', later.slice(0, 12), { link: later.length > 12 ? ['/items?owner=me', `All ${later.length}`] : null })}
          ${!soon.length && !week.length && !later.length && !atRisk.length ? html`<section class="card">${A.empty('Your plate is clear. 🥊 Add the next thing above.')}</section>` : ''}
        </div>
        <div>
          ${outCard}${certCard}
          ${Object.keys(byPerson).length ? html`<section class="card"><div class="card-head"><h2>To ask & tell</h2></div><ul class="rows">${Object.entries(byPerson).sort((a, b) => b[1].n - a[1].n).map(([id, p]) => html`<li><a href="/people/${id}">${A.avatar(p)}<b>${p.name}</b><span>${Object.entries(p.kinds).map(([k, n]) => `${n} ${A.KIND[k][0].toLowerCase()}${n > 1 && k !== 'ask' ? 's' : ''}`).join(' · ')}</span></a></li>`)}</ul></section>` : ''}
          ${calls.length ? html`<section class="card"><div class="card-head"><h2>Upcoming calls</h2><a class="small" href="/calls/new">New call</a></div><ul class="rows">${calls.map(c => html`<li><a href="/calls/${c.id}"><b>${c.title}</b><span>${c.starts_at ? U.fmtDateTime(c.starts_at) : 'Not scheduled'}</span></a></li>`)}</ul></section>` : ''}
          ${sec('Waiting on others', waiting.slice(0, 10), { link: waiting.length > 10 ? ['/items?owner=others', `All ${waiting.length}`] : null })}
        </div>
      </div>`;
  } else {
    const forMe = open.filter(i => Number(i.person_id) === Number(req.me?.id) && !mine(i));
    const done = await all(`${W.LIST_SQL} WHERE ${s.sql} AND i.status='done' AND i.completed_at >= ? ORDER BY i.completed_at DESC LIMIT 10`, ...s.args, wk + ' 00:00:00');
    body = html`<div class="head"><div><h1>${greet}, ${req.user.name.split(' ')[0]}</h1><p class="muted">${req.ws.name} · ${myOpen.length} open</p></div></div>${stats}${quick}${remCard}
      ${sec('Late or at risk', atRisk)}${sec('Questions & asks for you', forMe, { hide: ['person'] })}${sec('Today & tomorrow', soon)}${sec('This week', week)}${sec('Later', later)}
      ${!myOpen.length && !forMe.length ? html`<section class="card">${A.empty('Nothing on your list. 🥊')}</section>` : ''}
      ${sec('Knocked out this week', done)}`;
  }
  res.send(await page(req, { title: 'Today', body, wide: true }));
});
/** Days in a row (ending today or yesterday) with at least one item knocked out. */
async function streakDays(s) {
  const rows = await all(`SELECT DISTINCT substr(i.completed_at,1,10) d FROM items i WHERE ${s.sql} AND i.status='done' AND i.completed_at >= ? ORDER BY d DESC`, ...s.args, U.addDays(U.today(), -60));
  const set = new Set(rows.map(r => r.d)); let d = set.has(U.today()) ? U.today() : U.addDays(U.today(), -1), n = 0;
  while (set.has(d)) { n++; d = U.addDays(d, -1); }
  return n;
}
module.exports = { weekStart };
