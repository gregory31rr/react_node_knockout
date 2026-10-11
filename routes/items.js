/**
 * routes/items.js — everything you track.
 *
 *   /items                 all items with filters (person, project, owner, kind, status, priority, due) + spreadsheet
 *   /items/quick           the one-line add ("Ask @john about cutover #gcp p1 2h fri")
 *   /items/:id             details: edit, answer, notes, time spent, history, delegate, outside link, knock out / reopen
 *   /items/:id/ko          knock it out        /items/:id/reopen   bring it back
 *   /items/:id/delegate    hand it to someone with everything they need (in-app notice, email or copy for Teams)
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');
const V = require('../lib/views');
const P = require('../lib/parse');
const E = require('../lib/email');

const backTo = (req, d) => { const b = String(req.body?.back || ''); return b.startsWith('/') && !b.startsWith('//') && !/[\r\n]/.test(b) ? b : d; };
const wantsJson = req => (req.headers.accept || '').includes('application/json');

// ───────────── quick add ─────────────
async function parseFor(req, text) { const L = await W.lookups(req.ws.id); return P.parse(text, { ...L, today: U.today() }); }
function preview(p) {
  const bits = [A.KIND[p.kind][0], `“${p.title}”`];
  if (p.person) bits.push('for ' + p.person.name); if (p.owner) bits.push('→ ' + p.owner.name + ' does it'); if (p.project) bits.push('#' + p.project.tag);
  if (p.priority) bits.push('P' + p.priority); if (p.loe) bits.push(A.loeText(p.loe)); if (p.due) bits.push('due ' + U.fmtDate(p.due));
  return bits.join(' · ') + (p.unknown.length ? ` (not found: ${p.unknown.join(', ')})` : '');
}
app.post('/items/parse', async (req, res) => { A.wsRequired(req); if (/^remind\s+me\b/i.test(String(req.body.text || ''))) return res.json({ preview: '⏰ A reminder for you (try: remind me fri 3pm to call Dana)', unknown: [] }); const p = await parseFor(req, String(req.body.text || '').slice(0, 500)); if (A.KIND[req.body.kind]) p.kind = req.body.kind; res.json({ preview: preview(p), unknown: p.unknown }); });
app.post('/items/quick', async (req, res) => {
  A.wsRequired(req);
  const text = String(req.body.text || '').trim().slice(0, 500); if (!text) bad('Type what you need to do.');
  if (/^remind\s+me\b/i.test(text)) return remindFromText(req, res, text);
  const p = await parseFor(req, text); if (A.KIND[req.body.kind]) p.kind = req.body.kind;
  const id = await W.createItem(req, { kind: A.KIND[req.body.kind] ? req.body.kind : p.kind, title: p.title, person_id: p.person?.id || req.body.person_id, owner_person_id: p.owner?.id, project_id: p.project?.id || req.body.project_id,
    priority: p.priority, loe: p.loe, due_on: p.due, meeting_id: req.body.meeting_id || null, via: req.body.meeting_id ? 'during a call' : null });
  if (req.body.meeting_id) { const m = await one('SELECT id FROM meetings WHERE id=? AND workspace_id=?', req.body.meeting_id, req.ws.id); if (!m) await run('UPDATE items SET meeting_id=NULL WHERE id=?', id); }
  if (wantsJson(req)) return res.json({ id, preview: preview(p) });
  flash(res, `Added: ${preview(p)}`); res.redirect(backTo(req, '/'));
});

/** "remind me tomorrow 9am to call Dana" / "remind me fri at 3:30pm about the budget" / "remind me every monday 9am to send the update" */
async function remindFromText(req, res, text) {
  let t = text.replace(/^remind\s+me\s*/i, ''), repeat = 'none', time = '09:00';
  const rep = /\bevery\s+(day|weekday|week|month|monday|tuesday|wednesday|thursday|friday)\b/i.exec(t);
  if (rep) { const w = rep[1].toLowerCase(); repeat = w === 'day' ? 'daily' : w === 'weekday' ? 'weekdays' : w === 'month' ? 'monthly' : 'weekly'; t = t.replace(rep[0], /day$/.test(w) && w.length > 3 && w !== 'weekday' ? w : ' '); }
  const tm = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i.exec(t);
  if (tm) { let h = Number(tm[1] || tm[4]), m = Number(tm[2] || tm[5] || 0); if (tm[3]) { if (/pm/i.test(tm[3]) && h < 12) h += 12; if (/am/i.test(tm[3]) && h === 12) h = 0; } time = `${String(Math.min(h, 23)).padStart(2, '0')}:${String(Math.min(m, 59)).padStart(2, '0')}`; t = t.replace(tm[0], ' '); }
  const words = t.trim().split(/\s+/), d = P.dueFrom(words, U.today());
  let day = U.today(); if (d) { day = d.d; words.splice(d.i > 0 && /^(on|by)$/i.test(words[d.i - 1]) ? d.i - 1 : d.i, d.n + (d.i > 0 && /^(on|by)$/i.test(words[d.i - 1]) ? 1 : 0)); }
  const what = words.join(' ').replace(/^(to|about|that)\s+/i, '').trim() || 'Reminder';
  const N = require('./notes'); let at = N.toUtc(day, time, req.body.tz);
  if (!d && new Date(at.replace(' ', 'T') + 'Z') < new Date()) { day = U.addDays(day, 1); at = N.toUtc(day, time, req.body.tz); }   // that time already passed today: tomorrow
  await N.addReminder(req, { text: what[0].toUpperCase() + what.slice(1), at, repeat });
  if (wantsJson(req)) return res.json({ reminder: true });
  flash(res, `⏰ Reminder set: ${what} · ${U.fmtDate(day)} ${time}${repeat !== 'none' ? ' · ' + N.REPEAT[repeat].toLowerCase() : ''}`); res.redirect(backTo(req, '/'));
}

// ───────────── the list ─────────────
const FILTERS = ['q', 'kind', 'status', 'person', 'owner', 'project', 'priority', 'due', 'period', 'sort'];
/**
 * Period: for reviewing work. Done items count by when they were knocked out; open items by when they were added.
 * '' = any time (no limit). 'all' = all time, which for reviews means the last 13 months.
 */
const PERIODS = [['', 'Any time'], ['30', 'Last 30 days'], ['60', 'Last 60 days'], ['90', 'Last 90 days'], ['all', 'All time (13 months)']];
function periodStart(p) {
  if (/^(30|60|90)$/.test(p)) return U.addDays(U.today(), -Number(p));
  if (p === 'all') { const d = new Date(U.today() + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 13); return d.toISOString().slice(0, 10); }
  return null;
}
async function query(req, over = {}) {
  const s = W.scope(req), f = { ...Object.fromEntries(FILTERS.map(k => [k, String(req.query[k] || '')])), ...over }, where = [s.sql], args = [...s.args];
  if (f.status === 'done') where.push("i.status='done'"); else if (f.status === 'all') { } else if (A.STATUS[f.status]) { where.push('i.status=?'); args.push(f.status); } else where.push(`i.status IN ${W.OPEN}`);
  const since = periodStart(f.period);
  if (since) { where.push("((i.status='done' AND i.completed_at >= ?) OR (i.status<>'done' AND i.created_at >= ?))"); args.push(since, since); }
  if (A.KIND[f.kind]) { where.push('i.kind=?'); args.push(f.kind); }
  if (f.person) { where.push('i.person_id=?'); args.push(Number(f.person) || 0); }
  if (f.owner === 'me') { if (req.admin) where.push('i.owner_person_id IS NULL'); else { where.push('i.owner_person_id=?'); args.push(req.me?.id || 0); } }
  else if (f.owner === 'others') where.push('i.owner_person_id IS NOT NULL');
  else if (f.owner) { where.push('i.owner_person_id=?'); args.push(Number(f.owner) || 0); }
  if (f.project) { where.push('i.project_id=?'); args.push(Number(f.project) || 0); }
  if (/^[1-4]$/.test(f.priority)) { where.push('i.priority=?'); args.push(Number(f.priority)); }
  if (f.due === 'overdue') where.push("i.due_on < ko_today()"); else if (f.due === 'week') { where.push('i.due_on <= ?'); args.push(U.addDays(U.today(), 7)); } else if (f.due === 'none') where.push('i.due_on IS NULL');
  if (f.q) { where.push('(i.title ILIKE ? OR i.details ILIKE ? OR i.answer ILIKE ?)'); const q = '%' + f.q.replace(/[%_]/g, '') + '%'; args.push(q, q, q); }
  const order = { priority: 'i.priority, ' + W.ORDER, new: 'i.id DESC', done: 'i.completed_at DESC', loe: 'COALESCE(i.loe,0) DESC, ' + W.ORDER }[f.sort] || (f.status === 'done' ? 'i.completed_at DESC' : W.ORDER);
  const rows = await all(`${W.LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 2000`, ...args);
  return { f, rows };
}
app.get('/items', async (req, res) => {
  A.wsRequired(req);
  const { f, rows } = await query(req), L = await W.lookups(req.ws.id), risk = await W.risk(req.ws, rows);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const sel = (name, opts) => html`<label>${opts[0]}<select name="${name}" data-autosubmit>${opts.slice(1).map(([v, l]) => html`<option value="${v}" ${f[name] === String(v) ? raw('selected') : ''}>${l}</option>`)}</select></label>`;
  const loe = rows.reduce((a, i) => a + Number(i.loe || 0), 0), spent = rows.reduce((a, i) => a + Number(i.spent || 0), 0);
  // Reviewing a period: completed vs remaining for the same filters, whichever status is showing.
  let review = '';
  if (periodStart(f.period)) {
    const done = (await query(req, { status: 'done' })).rows.length, open = (await query(req, { status: '' })).rows.length, total = done + open;
    const link = status => '/items?' + new URLSearchParams(Object.entries({ ...f, status }).filter(([, v]) => v)).toString();
    const label = PERIODS.find(p => p[0] === f.period)[1].replace(/^Last /, 'the last ').replace(/^All time/, 'all time');
    review = html`<section class="card review" aria-label="Completed versus remaining">
      <div class="card-head"><h2>Work in ${label}</h2><span class="muted small">${total} item${total === 1 ? '' : 's'}</span></div>
      <div class="score">
        <a class="stat ${f.status === 'done' ? 'hot' : ''}" href="${link('done')}" data-review="done"><b>${done}</b><span>Completed</span></a>
        <a class="stat ${!f.status ? 'hot' : ''}" href="${link('')}" data-review="open"><b>${open}</b><span>Remaining</span></a>
        <a class="stat ${f.status === 'all' ? 'hot' : ''}" href="${link('all')}" data-review="all"><b>${total ? Math.round(done / total * 100) : 0}%</b><span>Done · see all</span></a></div>
      <div class="bar" role="img" aria-label="${done} completed, ${open} remaining"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>
      <p class="muted small">Completed = knocked out in this period. Remaining = still open, added in this period. Tap a number to list those items.</p></section>`;
  }
  res.send(await page(req, { title: 'Items', wide: true, body: html`<div class="head"><div><h1>Items</h1><p class="muted">${rows.length} shown${loe ? ` · ${A.loeText(loe)} LOE` : ''}${spent ? ` · ${A.loeText(spent)} logged` : ''}</p></div>
      <div class="actions"><a class="btn" href="/items/new">New item</a><a class="btn" href="/items.csv${qs ? '?' + qs : ''}">Spreadsheet</a></div></div>
    <form method="get" class="filters card">
      <label class="grow">Search<input name="q" value="${f.q}" placeholder="Words in the title, details or answer"></label>
      ${sel('status', ['Status', ['', 'Open'], ['doing', 'In progress'], ['waiting', 'Waiting'], ['blocked', 'Blocked'], ['done', 'Knocked out'], ['all', 'Everything']])}
      ${sel('kind', ['Kind', ['', 'All kinds'], ...Object.entries(A.KIND).map(([k, v]) => [k, v[0]])])}
      ${req.admin ? sel('owner', ['Who does it', ['', 'Anyone'], ['me', 'Me'], ['others', 'My team'], ...L.people.map(p => [p.id, p.name])]) : ''}
      ${sel('person', ['For / about', ['', 'Anyone'], ...L.people.map(p => [p.id, p.name])])}
      ${sel('project', ['Project', ['', 'All projects'], ...(await all('SELECT id, name FROM projects WHERE workspace_id=? ORDER BY name', req.ws.id)).map(p => [p.id, p.name])])}
      ${sel('priority', ['Priority', ['', 'Any'], ['1', 'P1 Urgent'], ['2', 'P2 High'], ['3', 'P3 Normal'], ['4', 'P4 Low']])}
      ${sel('due', ['Due', ['', 'Any time'], ['overdue', 'Late'], ['week', 'Within 7 days'], ['none', 'No date']])}
      ${sel('period', ['Period', ...PERIODS])}
      ${sel('sort', ['Sort', ['', 'Due date'], ['priority', 'Priority'], ['loe', 'Biggest LOE'], ['new', 'Newest'], ['done', 'Recently knocked out']])}
      <button class="btn">Show</button>${qs ? html`<a class="link" href="/items">Clear</a>` : ''}</form>
    ${review}
    <section class="card">${V.list(req, rows, { risk, empty: 'No items match.' })}</section>` }));
});
app.get('/items.csv', async (req, res) => {
  A.wsRequired(req); const { rows } = await query(req);
  res.setHeader('Content-Disposition', `attachment; filename="knockout-items-${U.today()}.csv"`);
  res.send(U.toCSV([['ID', 'Kind', 'Title', 'Project', 'For/about', 'Owner', 'Priority', 'LOE hours', 'Hours logged', 'Status', 'Due', 'Created', 'Knocked out', 'Answer', 'Details'],
    ...rows.map(i => [i.id, A.KIND[i.kind][0], i.title, i.project_name || '', i.person_name || '', i.owner_name || 'Me', 'P' + i.priority, i.loe ?? '', Number(i.spent) || '', A.STATUS[i.status], i.due_on || '', String(i.created_at).slice(0, 10), String(i.completed_at || '').slice(0, 10), i.answer || '', i.details || ''])]), 200, 'text/csv; charset=utf-8');
});

// ───────────── new / edit form ─────────────
async function form(req, i = {}, action) {
  const L = await W.lookups(req.ws.id);
  return html`<form method="post" action="${action}" class="stack item-form">${csrf(req)}
    <div class="two"><label>Kind<select name="kind">${Object.entries(A.KIND).map(([k, v]) => html`<option value="${k}" ${(i.kind || 'task') === k ? raw('selected') : ''}>${v[0]}</option>`)}</select></label>
      <label>Priority<select name="priority">${[1, 2, 3, 4].map(n => html`<option value="${n}" ${Number(i.priority || 3) === n ? raw('selected') : ''}>${A.PRI[n][0]} ${A.PRI[n][2]}</option>`)}</select></label></div>
    <label>Title<input name="title" required maxlength="300" value="${i.title || ''}"></label>
    <label>Details <small>(everything someone needs to pick it up)</small><textarea name="details" rows="4" maxlength="20000">${i.details || ''}</textarea></label>
    <div class="two"><label>For / about<select name="person_id">${V.peopleOptions(L.people, i.person_id)}</select></label>
      ${req.admin ? html`<label>Who does it<select name="owner_person_id">${V.peopleOptions(L.people, i.owner_person_id, 'Me')}</select></label>` : ''}</div>
    <div class="two"><label>Project<select name="project_id">${V.projectOptions(L.projects.concat(i.project_id && !L.projects.some(p => Number(p.id) === Number(i.project_id)) ? [{ id: i.project_id, name: i.project_name, tag: i.project_tag }] : []), i.project_id)}</select></label>
      <label>LOE <small>(2h, 30m, 1.5d)</small><input name="loe" value="${i.loe != null ? A.loeText(i.loe) : ''}" inputmode="decimal" maxlength="10"></label></div>
    <div class="two"><label>Start<input type="date" name="start_on" value="${i.start_on || ''}"></label><label>Due<input type="date" name="due_on" value="${i.due_on || ''}"></label></div>
    ${req.admin ? html`<div class="inline-checks"><label class="check"><input type="checkbox" name="private" value="1" ${Number(i.private) ? raw('checked') : ''}> 🔒 Private <small class="muted">(only managers see it, never the person it's about)</small></label>
      <label class="check"><input type="checkbox" name="exec" value="1" ${Number(i.exec) ? raw('checked') : ''}> ★ Exec <small class="muted">(goes in your boss's update)</small></label></div>` : ''}
    ${i.id ? html`<label>Status<select name="status">${Object.entries(A.STATUS).filter(([k]) => k !== 'done' || i.status === 'done').map(([k, v]) => html`<option value="${k}" ${i.status === k ? raw('selected') : ''}>${v}</option>`)}</select></label>` : ''}
    <button class="btn primary">${i.id ? 'Save changes' : 'Add item'}</button></form>`;
}
app.get('/items/new', async (req, res) => {
  A.wsRequired(req);
  res.send(await page(req, { title: 'New item', body: html`<p class="eyebrow"><a href="/items">Items</a></p><h1>New item</h1><section class="card">${await form(req, { person_id: req.query.person, project_id: req.query.project, kind: req.query.kind }, '/items/new')}</section>` }));
});
app.post('/items/new', async (req, res) => { A.wsRequired(req); const id = await W.createItem(req, req.body); flash(res, 'Added.'); res.redirect('/items/' + id); });

// ───────────── one item ─────────────
app.get('/items/:id', async (req, res) => {
  A.wsRequired(req);
  const i = await W.getItem(req, req.params.id);
  const ev = await all('SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC', i.id);
  const time = await all('SELECT * FROM time_logs WHERE item_id=? ORDER BY id DESC', i.id);
  const links = req.admin ? await all('SELECT l.*, COALESCE(l.who, p.name) pname FROM links l LEFT JOIN people p ON p.id=l.person_id WHERE l.item_id=? ORDER BY l.id DESC', i.id) : [];
  const risk = await W.risk(req.ws, [i]), r = risk.get(i.id);
  const sugg = req.admin && i.status !== 'done' ? await W.suggestFor(req.ws, i) : [];
  const L = req.admin ? await W.lookups(req.ws.id) : { people: [] };
  const text = await W.contextText(i, A.baseUrl(req));
  const owner = i.owner_person_id ? await one('SELECT * FROM people WHERE id=?', i.owner_person_id) : null;
  const paid = ['pro', 'team'].includes(req.ws.plan);
  const shared = await all('SELECT p.id, p.name FROM item_people ip JOIN people p ON p.id=ip.person_id WHERE ip.item_id=? ORDER BY p.name', i.id);
  const [kname] = A.KIND[i.kind];
  res.send(await page(req, { title: i.title, wide: true, body: html`
    <p class="eyebrow"><a href="/items">Items</a>${i.project_name ? html` · <a href="/projects/${i.project_id}">#${i.project_tag}</a>` : ''}</p>
    <div class="head item-head"><div><h1>${i.title}</h1>
      <div class="chips"><span class="chip">${kname}</span><span class="chip ${A.PRI[i.priority][1]}">${A.PRI[i.priority][0]} ${A.PRI[i.priority][2]}</span>${V.dueChip(i)}
        <span class="chip st-${i.status}">${A.STATUS[i.status]}</span>${i.loe ? html`<span class="chip loe">LOE ${A.loeText(i.loe)}${Number(i.spent) ? ` · ${A.loeText(i.spent)} logged` : ''}</span>` : ''}
        ${r ? html`<span class="chip ${r.state === 'overdue' ? 'late' : 'warn'}">${r.state === 'overdue' ? 'Overdue' : `At risk: ${A.loeText(r.short)} more than there's time for`}</span>` : ''}
        ${i.reopened ? html`<span class="chip">Reopened ${i.reopened}×</span>` : ''}</div>
      <p class="small"><b>👤 Owner:</b> ${i.owner_name || (req.admin ? 'Me' : 'Your manager')}${shared.length ? html` · <b>Shared with:</b> ${shared.map(p => p.name).join(', ')}` : ''}${i.due_on ? html` · <b>📅 Due ${U.fmtDate(i.due_on)}</b>` : ''}</p>
      <p class="muted small">${i.person_name ? (req.admin ? html`For <a href="/people/${i.person_id}">${i.person_name}</a> · ` : html`For ${i.person_name} · `) : ''}${i.owner_name ? html`<b>${i.owner_name}</b> is doing it` : 'You are doing it'} · added ${U.fmtDate(i.created_at)}</p></div>
      <div class="actions">${i.status === 'done'
        ? html`<form method="post" action="/items/${i.id}/reopen" class="stack-sm">${csrf(req)}<input name="note" placeholder="Why reopen? (optional)" maxlength="300" aria-label="Why reopen"><button class="btn">Reopen</button></form>`
        : html`<form method="post" action="/items/${i.id}/ko">${csrf(req)}<input type="hidden" name="back" value="/items/${i.id}"><button class="btn primary big-ko">🥊 Knock it out</button></form>`}</div></div>
    <div class="cols">
      <div>
        ${i.details ? html`<section class="card prose"><h2>Details</h2><p class="pre">${i.details}</p></section>` : ''}
        ${['ask', 'update', 'decision'].includes(i.kind) || i.answer ? html`<section class="card" id="answer"><h2>${i.kind === 'decision' ? 'Decision' : 'Answer'}</h2>
          ${i.answer ? html`<p class="pre answer">${i.answer}</p><p class="muted small">${U.fmtDateTime(i.answered_at)}</p>` : ''}
          <form method="post" action="/items/${i.id}/answer" class="stack">${csrf(req)}<textarea name="answer" rows="3" maxlength="5000" placeholder="${i.answer ? 'Add to the answer' : 'What did they say?'}" required></textarea>
            <label class="check"><input type="checkbox" name="ko" value="1" ${i.answer ? '' : raw('checked')}> Knock it out too</label><button class="btn">Save answer</button></form></section>` : ''}
        <section class="card"><h2>Notes & time</h2>
          <form method="post" action="/items/${i.id}/note" class="stack">${csrf(req)}<textarea name="note" rows="2" maxlength="5000" placeholder="Add a note or an update" required></textarea><button class="btn sm">Add note</button></form>
          <form method="post" action="/items/${i.id}/time" class="inline-row">${csrf(req)}<label>Time spent<input name="hours" placeholder="1.5h" inputmode="decimal" required maxlength="8" class="w-sm"></label><label class="grow">What was done<input name="note" maxlength="300"></label><button class="btn sm">Log time</button></form>
          ${time.length ? html`<ul class="rows small">${time.map(t => html`<li><span><b>${A.loeText(t.hours)}</b> ${t.who || ''}${t.note ? ' · ' + t.note : ''}</span><span class="muted">${U.fmtDate(t.on_day || t.created_at)}${t.via === 'link' ? ' · via link' : ''}</span></li>`)}</ul>` : ''}</section>
        <section class="card"><h2>History</h2><ol class="timeline">${ev.map(e => html`<li><b>${e.kind}</b>${e.text ? html` · <span class="pre">${e.text}</span>` : ''}<small class="block muted">${e.actor || ''} · ${U.fmtDateTime(e.created_at)}</small></li>`)}</ol></section>
      </div>
      <div>
        ${req.admin && i.status !== 'done' ? html`<section class="card" id="delegate"><h2>Delegate</h2><p class="muted small">Pass it down to your team or across to a peer.</p>
          ${sugg.length ? html`<p class="muted small">Who has room in the next 2 weeks:</p><ul class="rows small">${sugg.map(p => html`<li><span><b>${p.name}</b>${p.onProject ? ' · on this project' : ''}</span><span class="${p.free < 0 ? 'red-text' : ''}">${p.free >= 0 ? `${A.hoursText(p.free)} free` : `${A.hoursText(-p.free)} over`} (${p.pct}% booked)</span></li>`)}</ul>` : ''}
          <form method="post" action="/items/${i.id}/delegate" class="stack">${csrf(req)}
            <label>Pass it down or across<select name="person_id" required><option value="">Pick someone</option>${[['report', 'My team'], ['peer', 'Peers'], ['partner', 'Partner teams'], ['other', 'Others'], ['boss', 'Up to my boss']].map(([rel, l]) => { const g = L.people.filter(p => p.relation === rel); return g.length ? html`<optgroup label="${l}">${g.map(p => html`<option value="${p.id}" ${Number(sugg[0]?.id) === Number(p.id) ? raw('selected') : ''}>${p.name}${p.role ? ' · ' + p.role : ''}</option>`)}</optgroup>` : ''; })}</select></label>
            <label>Note for them<textarea name="note" rows="2" maxlength="2000" placeholder="Context, what done looks like, deadline…"></textarea></label>
            <label>New due date <small>(optional)</small><input type="date" name="due_on" value="${i.due_on || ''}"></label>
            <label class="check"><input type="checkbox" name="email" value="1" checked> Email them everything (if they have an email)</label>
            <button class="btn primary">Delegate</button></form>
          <p class="muted small">They get the title, details, answers and history. People with an account see it on their list right away.</p></section>` : ''}
        ${req.admin || Number(i.owner_person_id) === Number(req.me?.id) ? html`<section class="card" id="shared"><h2>Who's on it</h2>
          <p class="small">Owner: <b>${i.owner_name || 'Me'}</b></p>
          ${shared.length ? html`<ul class="rows small">${shared.map(p => html`<li><span>${p.name}</span><form method="post" action="/items/${i.id}/unshare/${p.id}">${csrf(req)}<button class="link small">Remove</button></form></li>`)}</ul>` : ''}
          <form method="post" action="/items/${i.id}/share" class="inline-row">${csrf(req)}<label class="grow">Add someone to share it<select name="person_id" required><option value="">Pick someone</option>${(await W.lookups(req.ws.id)).people.filter(p => Number(p.id) !== Number(i.owner_person_id) && !shared.some(x => Number(x.id) === Number(p.id))).map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label><button class="btn sm">Add</button></form></section>` : ''}
        <section class="card"><h2>Share</h2>
          <textarea class="copy-src" readonly rows="6" aria-label="Item as text">${text}</textarea>
          <div class="actions wrap"><button type="button" class="btn sm" data-copy>Copy for Teams / Slack</button>
            <a class="btn sm" href="${E.mailto({ to: owner?.email || '', subject: `${kname}: ${i.title}`, text })}">Open in my email</a></div></section>
        ${req.admin ? html`<section class="card" id="links"><h2>Outside link</h2>
          ${paid ? html`<p class="muted small">For someone who isn't on your team and has no account. They see this item, can add time and notes, and mark it done. Your team should use their accounts.</p>
            ${links.map(l => html`<div class="link-row ${l.active ? '' : 'off'}"><input readonly value="${A.baseUrl(req)}/l/${l.token}" aria-label="Link" class="copy-src"><div class="actions"><button type="button" class="btn sm" data-copy>Copy</button>
              <form method="post" action="/items/${i.id}/links/${l.id}/${l.active ? 'off' : 'on'}">${csrf(req)}<button class="btn sm">${l.active ? 'Turn off' : 'Turn on'}</button></form></div>
              <small class="muted">${l.pname ? 'For ' + l.pname + ' · ' : ''}${l.views} view${Number(l.views) === 1 ? '' : 's'}${l.last_viewed_at ? ' · last ' + U.fmtDateTime(l.last_viewed_at) : ''}${l.expires_on ? ' · ends ' + U.fmtDate(l.expires_on) : ''}${l.active ? '' : ' · off'}</small></div>`)}
            <form method="post" action="/items/${i.id}/links" class="stack">${csrf(req)}<label>Who is it for <small>(vendor or company)</small><input name="who" maxlength="80" placeholder="Hector at CloudCo"></label>
              <div class="two"><label>I need it by<input type="date" name="need_by" value="${i.due_on || U.addDays(U.today(), 3)}"></label><label>Link stops working on<input type="date" name="expires_on" value="${U.addDays(U.today(), 7)}"></label></div>
              <p class="muted small">The link also closes the moment they mark it done.</p><button class="btn sm primary">Make a vendor link</button></form>`
            : html`<p class="muted small">Outside links (for people with no account) are part of the paid plan.</p>`}</section>` : ''}
        <section class="card"><h2>Edit</h2>${await form(req, i, `/items/${i.id}/edit`)}
          ${req.admin ? html`<form method="post" action="/items/${i.id}/delete" data-confirm="Delete this item and its history? This can't be undone.">${csrf(req)}<button class="link red-text">Delete item</button></form>` : ''}</section>
      </div></div>` }));
});
async function mine(req) { const i = await W.getItem(req, req.params.id); return i; }
app.post('/items/:id/ko', async (req, res) => {
  A.wsRequired(req); const i = await mine(req); await W.knockOut(req, i);
  if (wantsJson(req)) return res.json({ ok: true, id: i.id, title: i.title });
  flash(res, `🥊 Knocked out: ${i.title}`); res.redirect(backTo(req, '/'));
});
app.post('/items/:id/nudge', async (req, res) => {
  A.adminOnly(req); const i = await mine(req); if (!i.owner_person_id) bad('Nobody else owns this one.');
  const o = await W.personIn(req.ws.id, i.owner_person_id);
  await W.event(req.ws.id, i.id, 'nudged', null, W.actorName(req));
  const n = (await W.nudgeCounts(req.ws.id))[i.id] || { week: 1, total: 1 }, nth = k => k + (k % 100 >= 11 && k % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th');
  if (o?.user_id) await A.notify(o.user_id, `👋 ${req.user.name} is checking on: ${i.title}${n.week > 1 ? ` (${nth(n.week)} nudge this week)` : ''}`, '/items/' + i.id, 'nudges');
  const first = o.name.split(' ')[0];
  if (wantsJson(req)) return res.json({ ok: true, week: n.week, total: n.total, label: `👋 Nudged ${n.week}× this week${n.total > n.week ? ` · ${n.total}× in all` : ''}`, message: `Nudged ${first}: ${n.week} time${n.week === 1 ? '' : 's'} this week` });
  flash(res, `👋 Nudged ${first}: that's ${n.week} time${n.week === 1 ? '' : 's'} this week${n.total > n.week ? ` (${n.total} in all)` : ''} on “${i.title}”.${o?.user_id ? '' : ` ${first} doesn't have an account, so open the note and use Share to send it.`}`); res.redirect(backTo(req, '/'));
});
app.post('/items/:id/share', async (req, res) => {
  A.wsRequired(req); const i = await mine(req); if (!req.admin && Number(i.owner_person_id) !== Number(req.me?.id)) A.deny();
  const p = await W.personIn(req.ws.id, req.body.person_id); if (!p) bad('Pick someone.');
  await run('INSERT INTO item_people(item_id,person_id) VALUES(?,?) ON CONFLICT DO NOTHING', i.id, p.id);
  await W.event(req.ws.id, i.id, 'shared', `With ${p.name}`, W.actorName(req)); await W.tellOwner(req, i, p, 'shared with you');
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true, name: p.name.split(' ')[0], full: p.name });
  flash(res, `Shared with ${p.name}.`); res.redirect(`/items/${i.id}#shared`);
});
app.post('/items/:id/unshare/:pid', async (req, res) => {
  A.wsRequired(req); const i = await mine(req); if (!req.admin && Number(i.owner_person_id) !== Number(req.me?.id)) A.deny();
  await run('DELETE FROM item_people WHERE item_id=? AND person_id=?', i.id, req.params.pid); flash(res, 'Removed.'); res.redirect(`/items/${i.id}#shared`);
});
app.post('/items/:id/reopen', async (req, res) => {
  A.wsRequired(req); const i = await mine(req); if (i.status !== 'done') return res.redirect('/items/' + i.id);
  await W.reopen(req, i, String(req.body.note || '').trim().slice(0, 300) || null);
  if (wantsJson(req)) return res.json({ ok: true });
  flash(res, 'Reopened.'); res.redirect(backTo(req, '/items/' + i.id));
});
app.post('/items/:id/edit', async (req, res) => {
  A.wsRequired(req); const i = await mine(req), b = req.body, ws = req.ws.id;
  const title = String(b.title || '').trim().slice(0, 300); if (!title) bad('Give it a title.');
  const person = await W.personIn(ws, b.person_id), project = await W.projectIn(ws, b.project_id);
  const owner = req.admin ? await W.personIn(ws, b.owner_person_id) : (i.owner_person_id ? { id: i.owner_person_id } : null);
  const status = A.STATUS[b.status] && b.status !== 'done' ? b.status : i.status;
  const changes = [];
  const set = { kind: A.KIND[b.kind] ? b.kind : i.kind, title, details: String(b.details || '').slice(0, 20000) || null, person_id: person?.id || null, owner_person_id: owner?.id || null, project_id: project?.id || null,
    priority: W.num(b.priority, 1, 4) || i.priority, loe: W.loeHours(b.loe), start_on: U.isDate(b.start_on) ? b.start_on : null, due_on: U.isDate(b.due_on) ? b.due_on : null, status };
  const label = { title: 'title', priority: 'priority', due_on: 'due date', loe: 'LOE', owner_person_id: 'owner', status: 'status', project_id: 'project', person_id: 'person', kind: 'kind' };
  for (const [k, l] of Object.entries(label)) if (String(set[k] ?? '') !== String(i[k] ?? '')) changes.push(k === 'due_on' ? `due date → ${set.due_on ? U.fmtDate(set.due_on) : 'none'}` : k === 'priority' ? `priority → P${set.priority}` : k === 'status' ? `status → ${A.STATUS[set.status]}` : k === 'loe' ? `LOE → ${A.loeText(set.loe) || 'none'}` : l);
  await run(`UPDATE items SET kind=?, title=?, details=?, person_id=?, owner_person_id=?, project_id=?, priority=?, loe=?, start_on=?, due_on=?, status=?, updated_at=ko_now() WHERE id=?`,
    set.kind, set.title, set.details, set.person_id, set.owner_person_id, set.project_id, set.priority, set.loe, set.start_on, set.due_on, set.status, i.id);
  if (req.admin) await run('UPDATE items SET private=?, exec=? WHERE id=?', b.private === '1' ? 1 : 0, b.exec === '1' ? 1 : 0, i.id);
  if (changes.length) await W.event(ws, i.id, 'changed', changes.join(', '), W.actorName(req));
  if (set.owner_person_id && Number(set.owner_person_id) !== Number(i.owner_person_id)) await W.tellOwner(req, { id: i.id, title }, await W.personIn(ws, set.owner_person_id), 'assigned you');
  flash(res, 'Saved.'); res.redirect('/items/' + i.id);
});
app.post('/items/:id/answer', async (req, res) => {
  A.wsRequired(req); const i = await mine(req), a = String(req.body.answer || '').trim().slice(0, 5000); if (!a) bad('Type the answer.');
  const full = i.answer ? `${i.answer}\n\n${a}` : a;
  await run('UPDATE items SET answer=?, answered_at=ko_now(), updated_at=ko_now() WHERE id=?', full.slice(0, 20000), i.id);
  await W.event(req.ws.id, i.id, 'answered', a, W.actorName(req));
  if (req.body.ko === '1') await W.knockOut(req, { ...i, answer: full }, 'Answered');
  if (wantsJson(req)) return res.json({ ok: true });
  flash(res, req.body.ko === '1' ? '🥊 Answered and knocked out.' : 'Answer saved.'); res.redirect(backTo(req, '/items/' + i.id));
});
app.post('/items/:id/note', async (req, res) => {
  A.wsRequired(req); const i = await mine(req), n = String(req.body.note || '').trim().slice(0, 5000); if (!n) bad('Type a note.');
  await W.event(req.ws.id, i.id, 'note', n, W.actorName(req)); await run('UPDATE items SET updated_at=ko_now() WHERE id=?', i.id);
  if (!req.admin) for (const m of await A.managers(req.ws.id)) await A.notify(m.id, `${req.user.name} added a note: ${i.title}`, '/items/' + i.id, 'comments');
  flash(res, 'Note added.'); res.redirect(backTo(req, '/items/' + i.id));
});
app.post('/items/:id/time', async (req, res) => {
  A.wsRequired(req); const i = await mine(req), h = W.loeHours(req.body.hours); if (!h || h <= 0 || h > 200) bad('Enter the time, like 1.5h or 45m.');
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  await run('INSERT INTO time_logs(workspace_id,item_id,person_id,who,hours,note,on_day) VALUES(?,?,?,?,?,?,?)', req.ws.id, i.id, req.me?.id || null, req.user.name, h, note, U.today());
  await W.event(req.ws.id, i.id, 'time', `${A.loeText(h)}${note ? ' · ' + note : ''}`, W.actorName(req));
  flash(res, `Logged ${A.loeText(h)}.`); res.redirect(backTo(req, '/items/' + i.id));
});
app.post('/items/:id/delegate', async (req, res) => {
  A.adminOnly(req); const i = await mine(req), to = await W.personIn(req.ws.id, req.body.person_id); if (!to) bad('Pick who to hand it to.');
  const note = String(req.body.note || '').trim().slice(0, 2000);
  if (U.isDate(req.body.due_on) && req.body.due_on !== i.due_on) { await run('UPDATE items SET due_on=? WHERE id=?', req.body.due_on, i.id); await W.event(req.ws.id, i.id, 'changed', `due date → ${U.fmtDate(req.body.due_on)}`, W.actorName(req)); }
  await W.delegate(req, i, to, note);
  const fresh = await W.getItem(req, i.id), text = (note ? `${note}\n\n` : '') + await W.contextText(fresh, to.user_id ? A.baseUrl(req) : null);
  let how = to.user_id ? 'in the app' : 'recorded';
  if (req.body.email === '1' && to.email) { const r = await E.send({ to: to.email, subject: `${req.user.name} handed you: ${i.title}`, text, replyTo: req.user.email }); how += r.ok ? ' + email' : ''; }
  await run('INSERT INTO sends(workspace_id,kind,to_text,subject,body,how,item_id,created_by) VALUES(?,?,?,?,?,?,?,?)', req.ws.id, 'delegate', to.name, i.title, text, how, i.id, req.user.id);
  flash(res, `Handed to ${to.name}${to.user_id ? '. They see it on their list.' : E.configured() && to.email ? ' and emailed.' : '. Use Share to send it to them.'}`); res.redirect('/items/' + i.id + (to.user_id ? '' : '#delegate'));
});
app.post('/items/:id/delete', async (req, res) => {
  A.adminOnly(req); const i = await mine(req); await run('DELETE FROM items WHERE id=?', i.id); await A.audit(req, 'deleted item', { id: i.id, title: i.title });
  flash(res, 'Item deleted.'); res.redirect('/items');
});
app.post('/items/:id/links', async (req, res) => {
  A.paidOnly(req); A.adminOnly(req); const i = await mine(req);
  const who = String(req.body.who || '').trim().slice(0, 80), exp = U.isDate(req.body.expires_on) && req.body.expires_on >= U.today() ? req.body.expires_on : U.addDays(U.today(), 7);
  if (U.isDate(req.body.need_by) && req.body.need_by !== i.due_on) { await run('UPDATE items SET due_on=? WHERE id=?', req.body.need_by, i.id); await W.event(req.ws.id, i.id, 'changed', `due date → ${U.fmtDate(req.body.need_by)}`, W.actorName(req)); }
  const tok = U.token(24);
  await run('INSERT INTO links(workspace_id,token,item_id,who,expires_on) VALUES(?,?,?,?,?)', req.ws.id, tok, i.id, who || null, exp);
  await W.event(req.ws.id, i.id, 'link made', `${who ? 'For ' + who + ' · ' : ''}works until ${U.fmtDate(exp)}`, W.actorName(req));
  await A.audit(req, 'outside link made', { item: i.id, who });
  if (who) await run('INSERT INTO sends(workspace_id,kind,to_text,subject,how,item_id,created_by) VALUES(?,?,?,?,?,?,?)', req.ws.id, 'link', who, i.title, 'link', i.id, req.user.id);
  flash(res, 'Link made. Copy it and send it to them.'); res.redirect('/items/' + i.id + '#links');
});
app.post('/items/:id/links/:lid/:act', async (req, res) => {
  A.adminOnly(req); const i = await mine(req), on = req.params.act === 'on' ? 1 : 0;
  await run('UPDATE links SET active=? WHERE id=? AND item_id=?', on, req.params.lid, i.id); await A.audit(req, on ? 'outside link on' : 'outside link off', { item: i.id });
  flash(res, on ? 'Link turned back on.' : 'Link turned off. It no longer opens.'); res.redirect('/items/' + i.id + '#links');
});
module.exports = { preview };
