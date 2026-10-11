/**
 * routes/people.js — the people you manage and work with (no account needed), and who has room for more work.
 *
 *   /people            everyone: open work, questions waiting, how booked they are, last 1:1
 *   /people/capacity   WHO HAS ROOM: everyone sorted by free hours in the next 2 weeks (LOE booked vs hours they have),
 *                      with their projects, so you can see who to give the next item to (or pull onto a project)
 *   /people/import     paste a Teams or Zoom participant list (or type names) to add many people at once
 *   /people/:id        their 1:1 page: everything to ask or tell them, their work, recent wins, past 1:1s, invite to an account
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');
const V = require('../lib/views');
const P = require('../lib/parse');
const E = require('../lib/email');
const IND = require('../lib/industries');
const roleInput = (req, v = '', id = 'roles') => html`<input name="role" list="${id}" maxlength="60" value="${v || ''}" placeholder="Developer, BA, Driver…"><datalist id="${id}">${IND.of(req.ws).roles.map(r => html`<option value="${r}">`)}</datalist>`;

const REL = { report: 'Reports to me', boss: 'My boss', peer: 'Peer', partner: 'Partner team', other: 'Other' };
const ACCESS = { own: 'Only their own items (and ones for them)', projects: 'Plus everything on projects they work on', team: 'Plus everything their team owns', all: 'Everything in the workspace (no manager controls)' };
async function uniqueHandle(wsId, name, exceptId = 0) {
  const base = P.handleFor(name); let h = base, n = 2;
  while (await one('SELECT 1 x FROM people WHERE workspace_id=? AND handle=? AND id<>?', wsId, h, exceptId)) h = `${base}${n++}`;
  return h;
}
async function addPerson(req, { name, email, title, team, relation, role }) {
  name = String(name || '').trim().slice(0, 80); if (!name) return null;
  email = String(email || '').trim().toLowerCase().slice(0, 200) || null;
  if (email && await one('SELECT 1 x FROM people WHERE workspace_id=? AND lower(email)=?', req.ws.id, email)) return null;
  if (!email && await one('SELECT 1 x FROM people WHERE workspace_id=? AND lower(name)=?', req.ws.id, name.toLowerCase())) return null;
  const r = await run('INSERT INTO people(workspace_id,name,handle,email,title,role,team,relation) VALUES(?,?,?,?,?,?,?,?)', req.ws.id, name, await uniqueHandle(req.ws.id, name), email,
    String(title || '').trim().slice(0, 80) || null, String(role || '').trim().slice(0, 60) || null, String(team || '').trim().slice(0, 60) || null, REL[relation] ? relation : 'report');
  return r.id;
}

app.get('/people', async (req, res) => {
  A.wsRequired(req);
  const team = String(req.query.team || ''), role = String(req.query.role || ''), rel = REL[req.query.rel] ? req.query.rel : '', cap = Object.fromEntries((await W.capacity(req.ws)).map(c => [c.id, c]));
  const rows = await all(`SELECT p.*, (SELECT count(*) FROM items i WHERE i.owner_person_id=p.id AND i.status IN ${W.OPEN}) work,
      (SELECT count(*) FROM items i WHERE i.person_id=p.id AND i.status IN ${W.OPEN} AND i.owner_person_id IS NULL) ask,
      (SELECT max(m.starts_at) FROM meetings m JOIN meeting_people mp ON mp.meeting_id=m.id WHERE mp.person_id=p.id AND m.kind='one_on_one') last11
    FROM people p WHERE p.workspace_id=? AND p.active=1 ${team ? 'AND p.team=?' : ''} ${role ? 'AND p.role=?' : ''} ${rel ? 'AND p.relation=?' : ''} ORDER BY p.relation='boss' DESC, p.name`, ...[req.ws.id, ...(team ? [team] : []), ...(role ? [role] : []), ...(rel ? [rel] : [])]);
  const roles = (await all("SELECT role, count(*) n FROM people WHERE workspace_id=? AND active=1 AND role IS NOT NULL AND role<>'' GROUP BY role ORDER BY role", req.ws.id));
  const teams = (await all("SELECT DISTINCT team FROM people WHERE workspace_id=? AND team IS NOT NULL AND team<>'' ORDER BY team", req.ws.id)).map(r => r.team);
  res.send(await page(req, { title: 'People', wide: true, body: html`<div class="head"><div><h1>People</h1><p class="muted">${rows.length} people${team ? ' on ' + team : ''}. They don't need an account.</p></div>
      ${req.admin ? html`<div class="actions"><a class="btn primary" href="/people/capacity">Who has room?</a><a class="btn" href="/time-off">Time off</a><a class="btn" href="/training">Certs & training</a><a class="btn" href="/connect">🤝 Connect by code</a><a class="btn" href="/people/import">Add people</a></div>` : ''}</div>
    <nav class="seg">${[['', 'Everyone'], ['report', 'My team'], ['peer', 'Peers'], ['boss', 'My boss'], ['partner', 'Partner teams'], ['other', 'Others']].map(([v, l]) => html`<a href="/people${v ? '?rel=' + v : ''}" ${rel === v ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    ${teams.length ? html`<nav class="seg">${[['', 'Every team'], ...teams.map(t => [t, t])].map(([v, l]) => html`<a href="/people${v ? '?team=' + encodeURIComponent(v) : ''}" ${team === v ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>` : ''}
    ${roles.length ? html`<nav class="seg">${[['', 'All roles'], ...roles.map(r => [r.role, `${r.role} (${r.n})`])].map(([v, l]) => html`<a href="/people?${new URLSearchParams({ ...(team ? { team } : {}), ...(v ? { role: v } : {}) })}" ${role === v ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>` : ''}
    <section class="card">${rows.length ? html`<div class="tbl"><table class="sheet"><thead><tr><th>Person</th><th>Role · team</th><th class="n">Their open work</th><th class="n">To ask / tell</th><th>Next 2 weeks</th><th>Last 1:1</th><th>Account</th></tr></thead><tbody>
      ${rows.map(p => { const c = cap[p.id] || { pct: 0, free: 0 }; return html`<tr><td><a class="person-cell" href="/people/${p.id}">${A.avatar(p)}<span><b>${p.name}</b><small class="block muted">${p.title || REL[p.relation]}</small></span></a></td>
        <td>${p.role || p.team ? [p.role, p.team].filter(Boolean).join(' · ') : html`<span class="muted">—</span>`}</td><td class="n">${p.work}</td><td class="n">${Number(p.ask) ? html`<b>${p.ask}</b>` : '0'}</td>
        <td class="loadcell">${V.bar(c.pct, `${c.pct}% booked`)}<small class="${c.free < 0 ? 'red-text' : 'muted'}">${c.pct}% · ${c.free >= 0 ? A.hoursText(c.free) + ' free' : A.hoursText(-c.free) + ' over'}</small></td>
        <td>${p.last11 ? U.fmtDate(p.last11) : html`<span class="muted">Never</span>`}</td><td>${p.user_id ? A.badge('Has account', 'ok') : A.badge('No account')}</td></tr>`; })}
      </tbody></table></div>` : A.empty('No people yet.', req.admin ? html`<a class="btn primary" href="/people/import">Add people</a>` : '')}</section>` }));
});

// ───────────── who has room ─────────────
app.get('/people/capacity', async (req, res) => {
  A.adminOnly(req);
  const team = String(req.query.team || ''), role = String(req.query.role || ''), proj = Number(req.query.project) || 0;
  let cap = (await W.capacity(req.ws)).filter(c => !['boss', 'peer'].includes(c.relation));
  const meta = Object.fromEntries((await all('SELECT id, team, title FROM people WHERE workspace_id=?', req.ws.id)).map(p => [p.id, p]));
  if (team) cap = cap.filter(c => meta[c.id]?.team === team);
  if (role) cap = cap.filter(c => c.role === role);
  const roles = (await all("SELECT DISTINCT role FROM people WHERE workspace_id=? AND active=1 AND role IS NOT NULL AND role<>'' ORDER BY role", req.ws.id)).map(r => r.role);
  const onProj = proj ? new Set((await all('SELECT DISTINCT owner_person_id id FROM items WHERE project_id=? AND owner_person_id IS NOT NULL', proj)).map(r => Number(r.id))) : null;
  const projs = {}; for (const r of await all(`SELECT i.owner_person_id pid, pr.id, pr.tag, count(*) n, COALESCE(sum(i.loe),0) loe FROM items i JOIN projects pr ON pr.id=i.project_id WHERE i.workspace_id=? AND i.status IN ${W.OPEN} AND i.owner_person_id IS NOT NULL GROUP BY i.owner_person_id, pr.id, pr.tag`, req.ws.id)) (projs[r.pid] = projs[r.pid] || []).push(r);
  const late = Object.fromEntries((await all(`SELECT owner_person_id id, count(*) n FROM items WHERE workspace_id=? AND status IN ${W.OPEN} AND due_on < ko_today() AND owner_person_id IS NOT NULL GROUP BY owner_person_id`, req.ws.id)).map(r => [r.id, Number(r.n)]));
  cap.sort((a, b) => b.free - a.free);
  const teams = (await all("SELECT DISTINCT team FROM people WHERE workspace_id=? AND team IS NOT NULL AND team<>'' ORDER BY team", req.ws.id)).map(r => r.team);
  const projects = await all("SELECT id, name, tag FROM projects WHERE workspace_id=? AND status<>'done' ORDER BY name", req.ws.id);
  const unowned = await all(`${W.LIST_SQL} WHERE i.workspace_id=? AND i.status IN ${W.OPEN} AND i.owner_person_id IS NULL AND i.kind='task' ${proj ? 'AND i.project_id=?' : ''} ORDER BY ${W.ORDER} LIMIT 8`, ...[req.ws.id, ...(proj ? [proj] : [])]);
  const totalFree = cap.reduce((a, c) => a + Math.max(0, c.free), 0), over = cap.filter(c => c.free < 0).length;
  res.send(await page(req, { title: 'Who has room', wide: true, body: html`<p class="eyebrow"><a href="/people">People</a></p>
    <div class="head"><div><h1>Who has room?</h1><p class="muted">Open LOE due in the next 2 weeks (or with no date) vs. the hours each person has. Change someone's hours per day on their page.</p></div></div>
    <div class="score"><div class="stat"><b>${A.hoursText(totalFree) || '0h'}</b><span>free across the team</span></div><div class="stat"><b>${cap.filter(c => c.pct < 70).length}</b><span>under 70% booked</span></div><div class="stat ${over ? 'hot' : ''}"><b>${over}</b><span>over capacity</span></div></div>
    <form method="get" class="filters card">${teams.length ? html`<label>Team<select name="team" data-autosubmit><option value="">Everyone</option>${teams.map(t => html`<option ${team === t ? raw('selected') : ''}>${t}</option>`)}</select></label>` : ''}
      ${roles.length ? html`<label>Role<select name="role" data-autosubmit><option value="">Every role</option>${roles.map(r => html`<option ${role === r ? raw('selected') : ''}>${r}</option>`)}</select></label>` : ''}
      <label>Project<select name="project" data-autosubmit><option value="">Any project</option>${projects.map(p => html`<option value="${p.id}" ${proj === Number(p.id) ? raw('selected') : ''}>${p.name}</option>`)}</select></label><button class="btn">Show</button></form>
    <section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>Person</th><th>Booked (next 2 weeks)</th><th class="n">Free</th><th class="n">Open items</th><th class="n">Late</th><th>Working on</th></tr></thead><tbody>
      ${cap.map(c => html`<tr class="${onProj && onProj.has(Number(c.id)) ? 'hl' : ''}"><td><a class="person-cell" href="/people/${c.id}">${A.avatar(c)}<span><b>${c.name}</b><small class="block muted">${[c.role, meta[c.id]?.team].filter(Boolean).join(' · ') || meta[c.id]?.title || ''}${onProj && onProj.has(Number(c.id)) ? ' · on this project' : ''}</small></span></a></td>
        <td class="loadcell">${V.bar(c.pct, `${c.pct}% booked`)}<small class="muted">${A.hoursText(c.load) || '0h'} of ${A.hoursText(c.cap)} · ${c.pct}%</small></td>
        <td class="n ${c.free < 0 ? 'red-text' : c.free > 8 ? 'ok-text' : ''}"><b>${c.free >= 0 ? A.hoursText(c.free) || '0h' : '−' + A.hoursText(-c.free)}</b></td><td class="n">${c.open_n}</td><td class="n">${late[c.id] ? html`<b class="red-text">${late[c.id]}</b>` : '0'}</td>
        <td class="small">${(projs[c.id] || []).map(p => html`<a class="chip project" href="/projects/${p.id}">#${p.tag} · ${p.n}</a> `)}</td></tr>`)}
    </tbody></table></div></section>
    ${unowned.length ? html`<section class="card"><div class="card-head"><h2>Next items to hand out</h2><span class="muted small">Yours, not started. Open one and use Delegate.</span></div>${V.list(req, unowned)}</section>` : ''}` }));
});

// ───────────── add people ─────────────
app.get('/people/import', async (req, res) => {
  A.adminOnly(req);
  res.send(await page(req, { title: 'Add people', body: html`<p class="eyebrow"><a href="/people">People</a></p><h1>Add people</h1>
    <section class="card"><h2>Paste from Teams, Zoom or Outlook</h2>
      <p class="muted small">In Teams: the meeting's People panel → … → Download attendance list, or copy the names. In Zoom: Participants → copy, or the attendance report. From an Outlook invite: copy the To line. One name per line works too.</p>
      <form method="post" action="/people/import/preview" class="stack">${csrf(req)}<textarea name="text" rows="8" required placeholder="John Smith <john@company.com>; Jane Doe <jane@company.com>&#10;Sam Lee (Guest)&#10;Priya Natarajan"></textarea>
        <div class="two"><label>Team <small>(optional, for everyone)</small><input name="team" maxlength="60"></label><label>Role <small>(optional)</small>${roleInput(req, '', 'roles-a')}</label></div>
        <div class="two"><label>They are<select name="relation">${Object.entries(REL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label><span></span></div>
        <button class="btn primary">Check the list</button></form></section>
    <section class="card"><h2>Add one person</h2><form method="post" action="/people/new" class="stack">${csrf(req)}
      <div class="two"><label>Name<input name="name" required maxlength="80"></label><label>Email <small>(optional)</small><input type="email" name="email" maxlength="200"></label></div>
      <div class="two"><label>Role${roleInput(req, '', 'roles-b')}</label><label>Team<input name="team" maxlength="60"></label></div>
      <div class="two"><label>Title <small>(optional)</small><input name="title" maxlength="80"></label><label>They are<select name="relation">${Object.entries(REL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label></div><button class="btn">Add</button></form></section>` }));
});
app.post('/people/import/preview', async (req, res) => {
  A.adminOnly(req);
  const list = P.attendees(String(req.body.text || '').slice(0, 100000)).slice(0, 500); if (!list.length) bad("We couldn't find any names in that. Try one name per line.");
  const have = await all('SELECT name, email FROM people WHERE workspace_id=?', req.ws.id);
  const known = x => have.some(h => (x.email && h.email && h.email.toLowerCase() === x.email) || h.name.toLowerCase() === x.name.toLowerCase());
  res.send(await page(req, { title: 'Add people', body: html`<p class="eyebrow"><a href="/people/import">Add people</a></p><h1>Found ${list.length} ${list.length === 1 ? 'person' : 'people'}</h1>
    <form method="post" action="/people/import" class="card stack">${csrf(req)}<input type="hidden" name="team" value="${req.body.team || ''}"><input type="hidden" name="role" value="${req.body.role || ''}"><input type="hidden" name="relation" value="${req.body.relation || 'report'}">
      <p class="muted small">Untick anyone you don't want. People already here are skipped.</p>
      <ul class="rows checklist">${list.map((x, n) => html`<li><label class="check"><input type="checkbox" name="pick" value="${n}" ${known(x) ? '' : raw('checked')} ${known(x) ? raw('disabled') : ''}><span><b>${x.name}</b>${x.email ? html` <span class="muted">${x.email}</span>` : ''}${known(x) ? html` ${A.badge('Already added')}` : ''}</span></label>
        <input type="hidden" name="name${n}" value="${x.name}"><input type="hidden" name="email${n}" value="${x.email || ''}"></li>`)}</ul>
      <button class="btn primary">Add them</button></form>` }));
});
app.post('/people/import', async (req, res) => {
  A.adminOnly(req); let n = 0;
  for (const k of [].concat(req.body.pick || []).slice(0, 500)) if (await addPerson(req, { name: req.body['name' + k], email: req.body['email' + k], team: req.body.team, role: req.body.role, relation: req.body.relation })) n++;
  await A.audit(req, 'added people', { n }); flash(res, `Added ${n} ${n === 1 ? 'person' : 'people'}.`); res.redirect('/people');
});
app.post('/people/new', async (req, res) => {
  A.adminOnly(req); const id = await addPerson(req, req.body); if (!id) bad('That person is already here (same name or email).');
  flash(res, 'Added.'); res.redirect(req.body.back === 'call' ? '/calls' : '/people/' + id);
});

// ───────────── one person (their 1:1 page) ─────────────
app.get('/people/:id', async (req, res) => {
  A.wsRequired(req);
  const p = await one('SELECT * FROM people WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  if (!req.admin && Number(req.me?.id) !== Number(p.id)) A.deny();
  const items = await all(`${W.LIST_SQL} WHERE i.workspace_id=? AND (i.person_id=? OR i.owner_person_id=?) AND i.status IN ${W.OPEN} ORDER BY ${W.ORDER}`, req.ws.id, p.id, p.id);
  const risk = await W.risk(req.ws, items);
  const toThem = items.filter(i => Number(i.person_id) === Number(p.id) && !i.owner_person_id), theirs = items.filter(i => Number(i.owner_person_id) === Number(p.id));
  const done = await all(`${W.LIST_SQL} WHERE i.workspace_id=? AND (i.owner_person_id=? OR i.person_id=?) AND i.status='done' ORDER BY i.completed_at DESC LIMIT 10`, req.ws.id, p.id, p.id);
  const calls = await all('SELECT m.* FROM meetings m JOIN meeting_people mp ON mp.meeting_id=m.id WHERE mp.person_id=? ORDER BY COALESCE(m.starts_at,m.created_at) DESC LIMIT 10', p.id);
  const c = (await W.capacity(req.ws)).find(x => Number(x.id) === Number(p.id)) || { pct: 0, free: 0, load: 0, cap: 0 };
  const stats = await one(`SELECT count(*) n, COALESCE(sum(loe),0) loe, count(CASE WHEN due_on IS NOT NULL AND substr(completed_at,1,10) <= due_on THEN 1 END) ontime, count(CASE WHEN due_on IS NOT NULL THEN 1 END) dated
    FROM items WHERE owner_person_id=? AND status='done' AND completed_at >= ?`, p.id, U.addDays(U.today(), -90));
  const pto = { b: await require('../lib/timeoff').balance(req.ws, p), rows: await all('SELECT * FROM time_off WHERE workspace_id=? AND person_id=? AND end_on >= ? ORDER BY start_on LIMIT 8', req.ws.id, p.id, U.addDays(U.today(), -30)) };
  const pnotes = req.admin ? await all('SELECT * FROM notes WHERE user_id=? AND person_id=? AND archived=0 ORDER BY pinned DESC, updated_at DESC LIMIT 6', req.user.id, p.id) : [];
  const growth = { certs: await all('SELECT * FROM certs WHERE person_id=? ORDER BY expires_on IS NULL, expires_on', p.id), courses: await all("SELECT * FROM trainings WHERE person_id=? AND status<>'dropped' ORDER BY status='completed', target_on", p.id) };
  const pnudge = await W.personNudges(req.ws.id, p.id);
  const userOff = p.user_id ? (await one('SELECT status FROM memberships WHERE user_id=? AND workspace_id=?', p.user_id, req.ws.id))?.status === 'blocked' : false;
  const invite = req.admin && !p.user_id ? await one('SELECT * FROM invites WHERE person_id=? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC', p.id, Date.now()) : null;
  res.send(await page(req, { title: p.name, wide: true, body: html`<p class="eyebrow"><a href="/people">People</a></p>
    <div class="head"><div class="hello">${A.avatar(p, 'lg')}<div><h1>${p.name}</h1><p class="muted">${[p.role, p.title, p.team, REL[p.relation]].filter(Boolean).join(' · ')}${p.email ? ' · ' + p.email : ''} · @${p.handle}</p></div></div>
      ${req.admin ? html`<div class="actions"><form method="post" action="/calls/new">${csrf(req)}<input type="hidden" name="kind" value="one_on_one"><input type="hidden" name="person" value="${p.id}"><input type="hidden" name="title" value="1:1 with ${p.name.split(' ')[0]}"><button class="btn primary">Start 1:1 now</button></form>
        <a class="btn" href="/items/new?person=${p.id}">New item</a></div>` : ''}</div>
    <div class="score">${pnudge.total ? html`<div class="stat ${pnudge.week >= 3 ? 'hot' : ''}"><b>👋 ${pnudge.week}</b><span>nudges this week (${pnudge.total} in all)</span></div>` : ''}<div class="stat"><b>${toThem.length}</b><span>to ask or tell</span></div><div class="stat"><b>${theirs.length}</b><span>their open work</span></div>
      <div class="stat"><b>${c.pct}%</b><span>booked next 2 weeks</span></div><div class="stat"><b>${stats.n}</b><span>knocked out (90 days)</span></div>
      <div class="stat"><b>${Number(stats.dated) ? Math.round(stats.ontime / stats.dated * 100) + '%' : '—'}</b><span>on time (90 days)</span></div></div>
    <div class="cols"><div>
      <section class="card"><div class="card-head"><h2>To ask or tell ${p.name.split(' ')[0]} <span class="count">${toThem.length}</span></h2></div>
        <form method="post" action="/items/quick" class="quick-inline">${csrf(req)}${A.kindPicker()}<input type="hidden" name="back" value="/people/${p.id}"><input type="hidden" name="person_id" value="${p.id}">
          <input name="text" required maxlength="500" placeholder="Ask about the cutover date #gcp" aria-label="Add something for ${p.name}" data-parse><button class="btn">Add</button><div class="parse-preview muted small"></div></form>
        ${V.list(req, toThem, { risk, hide: ['person'], empty: 'Nothing waiting for them.' })}</section>
      <section class="card"><div class="card-head"><h2>Their work <span class="count">${theirs.length}</span></h2></div>${V.list(req, theirs, { risk, hide: ['owner'], empty: 'Nothing assigned to them.' })}</section>
      ${done.length ? html`<section class="card"><h2>Recently knocked out</h2>${V.list(req, done, { hide: ['person', 'owner'] })}</section>` : ''}
    </div><div>
      <section class="card"><h2>Workload</h2>${V.bar(c.pct)}<p class="small">${A.hoursText(c.load) || '0h'} of ${A.hoursText(c.cap) || '0h'} booked in the next 2 weeks · <b class="${c.free < 0 ? 'red-text' : ''}">${c.free >= 0 ? A.hoursText(c.free) + ' free' : A.hoursText(-c.free) + ' over'}</b></p></section>
      <section class="card" id="growth"><div class="card-head"><h2>Certs & training</h2><a class="small" href="/training?person=${p.id}">All</a></div>
        ${growth.certs.length ? html`<ul class="rows small">${growth.certs.map(c => html`<li><span><b>${c.name}</b>${c.issuer ? html` <span class="muted">${c.issuer}</span>` : ''}</span><span class="chip ${require('./training').certState(c)[1]}">${require('./training').certState(c)[0]}</span></li>`)}</ul>` : html`<p class="muted small">No certifications yet.</p>`}
        ${growth.courses.length ? html`<ul class="rows small">${growth.courses.map(x => html`<li><span class="grow"><b>${x.name}</b><small class="block muted">${x.status === 'completed' ? 'Completed ' + U.fmtDate(x.completed_on) : x.target_on ? 'Finish by ' + U.fmtDate(x.target_on) : ''}</small>${V.bar(Number(x.progress))}</span><span class="muted">${x.progress}%</span></li>`)}</ul>` : ''}
        ${req.admin ? html`<details><summary class="small">Add a certification or course</summary>
          <form method="post" action="/training/certs" class="stack">${csrf(req)}<input type="hidden" name="person_id" value="${p.id}"><input type="hidden" name="back" value="person"><label>Certification<input name="name" required maxlength="120"></label><div class="two"><label>Earned<input type="date" name="earned_on"></label><label>Expires<input type="date" name="expires_on"></label></div><button class="btn sm">Add certification</button></form>
          <form method="post" action="/training/courses" class="stack">${csrf(req)}<input type="hidden" name="person_id" value="${p.id}"><input type="hidden" name="back" value="person"><label>Course<input name="name" required maxlength="120"></label><div class="two"><label>Finish by<input type="date" name="target_on"></label><label>Leads to cert<input name="cert_name" maxlength="120"></label></div><button class="btn sm">Add course</button></form></details>` : ''}</section>
      <section class="card" id="pto"><div class="card-head"><h2>Time off</h2><a class="small" href="/time-off">All time off</a></div>
        ${pto.b.allowance != null ? html`<p class="small">PTO ${new Date().getFullYear()}: <b>${A.hoursText(pto.b.left) || '0h'} left</b> of ${A.hoursText(pto.b.allowance)} · ${A.hoursText(pto.b.used) || '0h'} used · ${A.hoursText(pto.b.planned) || '0h'} planned</p>` : html`<p class="muted small">Set their yearly PTO hours under Details to track a balance.</p>`}
        ${pto.rows.length ? html`<ul class="rows small">${pto.rows.map(r => html`<li><span>${require('../lib/timeoff').KINDS[r.kind][1]} ${require('../lib/timeoff').KINDS[r.kind][0]} · ${require('./timeoff').fmtRange(r)}${r.status === 'requested' ? ' · requested' : ''}</span></li>`)}</ul>` : ''}
        ${req.admin ? html`<details><summary class="small">Add time off</summary><form method="post" action="/time-off" class="stack">${csrf(req)}<input type="hidden" name="person_id" value="${p.id}"><input type="hidden" name="back" value="person">
          <label>What<select name="kind">${Object.entries(require('../lib/timeoff').KINDS).filter(([k]) => k !== 'holiday').map(([k, v]) => html`<option value="${k}">${v[1]} ${v[0]}</option>`)}</select></label>
          <div class="two"><label>From<input type="date" name="start_on" value="${U.today()}" required></label><label>To<input type="date" name="end_on" value="${U.today()}" required></label></div>
          <label>Hours <small>(blank = full days)</small><input name="hours" inputmode="decimal" maxlength="6"></label><button class="btn sm">Add</button></form></details>` : ''}</section>
      ${req.admin ? html`<section class="card"><div class="card-head"><h2>My notes about ${p.name.split(' ')[0]}</h2><a class="small" href="/notes">All notes</a></div>
        ${pnotes.length ? html`<ul class="rows small">${pnotes.map(n => html`<li><span class="pre">${n.text}</span><span class="muted">${U.fmtDate(n.updated_at)}</span></li>`)}</ul>` : ''}
        <form method="post" action="/notes" class="stack">${csrf(req)}<input type="hidden" name="person_id" value="${p.id}"><input type="hidden" name="back" value="/people/${p.id}"><textarea name="text" rows="2" maxlength="5000" required placeholder="Private note (only you see it)"></textarea><button class="btn sm">Save note</button></form></section>` : ''}
      <section class="card"><h2>1:1s and calls</h2>${calls.length ? html`<ul class="rows">${calls.map(m => html`<li><a href="${req.admin ? '/calls/' + m.id : '#'}"><b>${m.title}</b><span>${U.fmtDate(m.starts_at || m.created_at)}${m.status === 'done' ? '' : ' · ' + m.status}</span></a></li>`)}</ul>` : A.empty('No calls yet.')}</section>
      ${req.admin ? html`<section class="card"><h2>Account & access</h2>${p.user_id ? html`<p>${A.badge('Has an account', 'ok')} They sign in and work their own list.</p>`
        : html`<p class="muted small">Give ${p.name.split(' ')[0]} an account so they see their items, log time and knock things out themselves.</p>
          ${invite ? html`<p class="small">Invitation sent to ${invite.email}. It works until ${U.fmtDate(new Date(Number(invite.expires_at)).toISOString())}.</p>` : ''}
          <form method="post" action="/people/${p.id}/invite" class="stack">${csrf(req)}<label>Their email<input type="email" name="email" value="${p.email || ''}" required maxlength="200"></label><button class="btn">${invite ? 'Send a new invitation' : 'Invite them'}</button></form>`}
        <form method="post" action="/people/${p.id}/access" class="stack">${csrf(req)}
          <label>What they can see <small>(when they sign in)</small><select name="access">${Object.entries(ACCESS).map(([k, v]) => html`<option value="${k}" ${p.access === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
          <label class="check"><input type="checkbox" name="can_add" value="1" ${Number(p.can_add) ? raw('checked') : ''}> They can add their own items</label>
          ${p.user_id ? html`<label class="check"><input type="checkbox" name="blocked" value="1" ${userOff ? raw('checked') : ''}> Block their sign-in</label>` : ''}
          <button class="btn sm">Save access</button><p class="muted small">Items you mark 🔒 Private are never shown to team members, even with “Everything”.</p></form></section>
      <section class="card"><h2>Details</h2><form method="post" action="/people/${p.id}/edit" class="stack">${csrf(req)}
        <label>Name<input name="name" value="${p.name}" required maxlength="80"></label><label>Email<input type="email" name="email" value="${p.email || ''}" maxlength="200"></label>
        <div class="two"><label>Role${roleInput(req, p.role)}</label><label>Team<input name="team" value="${p.team || ''}" maxlength="60"></label></div>
        <label>Title <small>(optional)</small><input name="title" value="${p.title || ''}" maxlength="80"></label>
        <div class="two"><label>They are<select name="relation">${Object.entries(REL).map(([k, v]) => html`<option value="${k}" ${p.relation === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
          <label>Hours a day for project work<input name="hours_per_day" inputmode="decimal" value="${p.hours_per_day ?? ''}" placeholder="${req.ws.hours_per_day}" maxlength="4"></label></div>
        <div class="two"><label>PTO hours a year<input name="pto_hours_year" inputmode="decimal" value="${p.pto_hours_year ?? ''}" placeholder="120" maxlength="5"></label><span></span></div>
        <label>Private notes <small>(only you see these)</small><textarea name="notes" rows="3" maxlength="5000">${p.notes || ''}</textarea></label>
        <button class="btn">Save</button></form>
        <form method="post" action="/people/${p.id}/remove" data-confirm="Remove ${p.name}? Their items stay, unassigned from them.">${csrf(req)}<button class="link red-text">Remove from my people</button></form></section>` : ''}
    </div></div>` }));
});
app.post('/people/:id/edit', async (req, res) => {
  A.adminOnly(req); const p = await one('SELECT * FROM people WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound(), b = req.body;
  const name = String(b.name || '').trim().slice(0, 80); if (!name) bad('Enter a name.');
  const hpd = W.num(b.hours_per_day, 0, 24);
  await run('UPDATE people SET pto_hours_year=? WHERE id=?', W.num(b.pto_hours_year, 0, 2000), p.id);
  await run('UPDATE people SET name=?, handle=?, email=?, title=?, role=?, team=?, relation=?, hours_per_day=?, notes=? WHERE id=?', name, name === p.name ? p.handle : await uniqueHandle(req.ws.id, name, p.id),
    String(b.email || '').trim().toLowerCase().slice(0, 200) || null, String(b.title || '').trim().slice(0, 80) || null, String(b.role || '').trim().slice(0, 60) || null, String(b.team || '').trim().slice(0, 60) || null, REL[b.relation] ? b.relation : p.relation, hpd, String(b.notes || '').slice(0, 5000) || null, p.id);
  if (b.relation === 'boss') await run('UPDATE workspaces SET boss_person_id=? WHERE id=?', p.id, req.ws.id);
  flash(res, 'Saved.'); res.redirect('/people/' + p.id);
});
app.post('/people/:id/access', async (req, res) => {
  A.adminOnly(req); const p = await one('SELECT * FROM people WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  await run('UPDATE people SET access=?, can_add=? WHERE id=?', ACCESS[req.body.access] ? req.body.access : 'own', req.body.can_add === '1' ? 1 : 0, p.id);
  if (p.user_id) {
    const m = await one("SELECT * FROM memberships WHERE user_id=? AND workspace_id=? AND role='member'", p.user_id, req.ws.id);
    if (m) await run('UPDATE memberships SET status=? WHERE id=?', req.body.blocked === '1' ? 'blocked' : 'active', m.id);   // blocks them from this workspace only
  }
  await A.audit(req, 'changed access', { person: p.id, access: req.body.access, blocked: req.body.blocked === '1' }); flash(res, 'Access saved.'); res.redirect('/people/' + p.id);
});
app.post('/people/:id/remove', async (req, res) => {
  A.adminOnly(req); const p = await one('SELECT * FROM people WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  await tx(async () => {
    await run('UPDATE items SET owner_person_id=NULL WHERE owner_person_id=? AND status<>?', p.id, 'done');
    await run('UPDATE people SET active=0 WHERE id=?', p.id);
    if (p.user_id) await run("UPDATE memberships SET status='blocked' WHERE user_id=? AND workspace_id=? AND role='member'", p.user_id, req.ws.id);
  });
  await A.audit(req, 'removed person', { id: p.id, name: p.name }); flash(res, `${p.name} removed. Their open items came back to you.`); res.redirect('/people');
});
app.post('/people/:id/invite', async (req, res) => {
  A.adminOnly(req); const p = await one('SELECT * FROM people WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  if (p.user_id) bad('They already have an account.');
  const email = String(req.body.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter their email.');
  const existing = await one('SELECT id FROM users WHERE email=?', email);
  if (existing) return res.redirect(`/connect?email=${encodeURIComponent(email)}&person=${p.id}`);   // they already have Knockout: connect instead
  const t = U.token(32);
  await run('DELETE FROM invites WHERE person_id=? AND used_at IS NULL', p.id);
  await run('INSERT INTO invites(token_hash,workspace_id,person_id,email,expires_at) VALUES(?,?,?,?,?)', U.sha256(t), req.ws.id, p.id, email, Date.now() + 14 * 864e5);
  await run('UPDATE people SET email=? WHERE id=?', email, p.id);
  const url = `${A.baseUrl(req)}/invite/${t}`;
  const r = await E.send({ to: email, subject: `${req.user.name} invited you to Knockout`, text: `${req.user.name} uses Knockout to track work for ${req.ws.name}. Join to see what's on your plate, log time and knock things out:\n\n${url}\n\nThis link works for 14 days.`, replyTo: req.user.email });
  await A.audit(req, 'invited person', { id: p.id, email });
  flash(res, r.ok ? `Invitation emailed to ${email}.` : `Invitation ready. Email isn't set up, so copy this link and send it to them: ${url}`); res.redirect('/people/' + p.id);
});
module.exports = { addPerson, uniqueHandle, REL };
