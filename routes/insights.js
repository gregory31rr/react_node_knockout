/**
 * routes/insights.js — what got done: analytics, KPIs and goals, for you, the team, one person, a role or a project.
 *
 *   /insights   pick a period (this/last week, month, quarter, year) and who (everyone, me, a person, a role, a project):
 *               knocked out, LOE done, on-time %, days to knock out, time logged, added vs done, still open, late;
 *               columns for the last 12 weeks; tables by person and by project; your goals with progress.
 *   /goals      add goals: "Knock out 25 items a week", "40h of LOE a month", "90% on time this quarter",
 *               "#gcp done by Dec 15", "No more than 15 open items" — for you, the team, a person or a project.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const M = require('../lib/metrics');
const V = require('../lib/views');

const PERIODS = [['week:0', 'This week'], ['week:1', 'Last week'], ['month:0', 'This month'], ['month:1', 'Last month'], ['quarter:0', 'This quarter'], ['quarter:1', 'Last quarter'], ['year:0', 'This year']];
const METRIC = { items_done: 'Items knocked out', loe_done: 'LOE hours done', on_time: 'On time %', project_done: 'Project done', open_max: 'No more than … open items' };
function pick(req) {
  const [kind, back] = (PERIODS.find(p => p[0] === req.query.period) || PERIODS[0])[0].split(':');
  const filter = {}; const who = String(req.query.who || '');
  if (!req.admin) filter.person = req.me?.id || -1;
  else if (who === 'me') filter.owner = 'me'; else if (/^p\d+$/.test(who)) filter.person = Number(who.slice(1)); else if (/^j\d+$/.test(who)) filter.project = Number(who.slice(1)); else if (who.startsWith('r:')) filter.role = who.slice(2);
  return { r: M.range(kind, Number(back)), filter, who, period: `${kind}:${back}` };
}
const pctText = v => v == null ? '—' : v + '%';
app.get('/insights', async (req, res) => {
  A.wsRequired(req);
  const { r, filter, who, period } = pick(req);
  const n = await M.numbers(req.ws, { ...r, filter });
  const prevR = M.range(r.kind, Number(period.split(':')[1]) + 1), prev = await M.numbers(req.ws, { ...prevR, filter });
  const wk = await M.weekly(req.ws, 12, filter), wkLoe = await M.weekly(req.ws, 12, filter, 'loe');
  const people = req.admin ? await all('SELECT id, name, role FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id) : [];
  const projects = req.admin ? await all('SELECT id, name, tag FROM projects WHERE workspace_id=? ORDER BY status=\'done\', name', req.ws.id) : [];
  const roles = [...new Set(people.map(p => p.role).filter(Boolean))].sort();
  const byPerson = []; if (req.admin && !filter.person) for (const p of people) { const x = await M.numbers(req.ws, { ...r, filter: { person: p.id, project: filter.project } }); if (x.done || x.open || x.time) byPerson.push({ p, x }); }
  const byProject = []; if (req.admin && !filter.project) for (const p of projects) { const x = await M.numbers(req.ws, { ...r, filter: { project: p.id, person: filter.person, owner: filter.owner, role: filter.role } }); if (x.done || x.open) byProject.push({ p, x }); }
  byPerson.sort((a, b) => b.x.loe - a.x.loe || b.x.done - a.x.done); byProject.sort((a, b) => b.x.done - a.x.done);
  const goals = await all('SELECT g.*, p.name pname, pr.name prname FROM goals g LEFT JOIN people p ON p.id=g.person_id LEFT JOIN projects pr ON pr.id=g.project_id WHERE g.workspace_id=? AND g.active=1 ORDER BY g.id', req.ws.id);
  const gs = []; for (const g of goals) if (req.admin || Number(g.person_id) === Number(req.me?.id)) gs.push({ g, s: await M.goalStatus(req.ws, g) });
  const delta = (a, b, better = 'up') => { if (b == null || a == null || a === b) return ''; const up = a > b; return html`<small class="delta ${(up === (better === 'up')) ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${Math.abs(Math.round((a - b) * 10) / 10)} vs last ${r.kind}</small>`; };
  const qs = new URLSearchParams({ period, ...(who ? { who } : {}) }).toString();
  res.send(await page(req, { title: 'Insights', wide: true, body: html`<div class="head"><div><h1>Insights</h1><p class="muted">${r.label} · ${U.fmtDate(r.from)} – ${U.fmtDate(r.to)}</p></div>
      <div class="actions"><a class="btn" href="/insights.csv?${qs}">Spreadsheet</a>${req.admin ? html`<a class="btn" href="/updates?period=${r.kind}">Turn into an update</a>` : ''}</div></div>
    <form method="get" class="filters card"><label>Period<select name="period" data-autosubmit>${PERIODS.map(([k, l]) => html`<option value="${k}" ${period === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      ${req.admin ? html`<label>Who<select name="who" data-autosubmit><option value="">Everyone (team + me)</option><option value="me" ${who === 'me' ? raw('selected') : ''}>Just me</option>
        ${roles.length ? html`<optgroup label="Role">${roles.map(x => html`<option value="r:${x}" ${who === 'r:' + x ? raw('selected') : ''}>${x}</option>`)}</optgroup>` : ''}
        <optgroup label="Person">${people.map(p => html`<option value="p${p.id}" ${who === 'p' + p.id ? raw('selected') : ''}>${p.name}</option>`)}</optgroup>
        <optgroup label="Project">${projects.map(p => html`<option value="j${p.id}" ${who === 'j' + p.id ? raw('selected') : ''}>${p.name}</option>`)}</optgroup></select></label>` : ''}<button class="btn">Show</button></form>
    <div class="score">
      <div class="stat"><b>${n.done}</b><span>knocked out</span>${delta(n.done, prev.done)}</div>
      <div class="stat"><b>${A.hoursText(n.loe) || '0h'}</b><span>LOE done</span>${delta(n.loe, prev.loe)}</div>
      <div class="stat"><b>${pctText(n.ontime)}</b><span>on time${n.dated ? ` (${n.dated} with dates)` : ''}</span>${delta(n.ontime, prev.ontime)}</div>
      <div class="stat"><b>${n.cycle ?? '—'}</b><span>days to knock out (avg)</span>${delta(n.cycle, prev.cycle, 'down')}</div>
      <div class="stat"><b>${A.hoursText(n.time) || '0h'}</b><span>time logged</span></div>
      <div class="stat"><b>${n.added}</b><span>added</span></div>
      <div class="stat"><b>${n.open}</b><span>still open (${A.hoursText(n.openLoe) || '0h'})</span></div>
      <div class="stat ${n.late ? 'hot' : ''}"><b>${n.late}</b><span>late now</span></div>
      ${n.reopened ? html`<div class="stat"><b>${n.reopened}</b><span>reopened</span></div>` : ''}</div>
    <div class="cols">
      <section class="card"><h2>Items knocked out, last 12 weeks</h2>${V.columns(wk, { title: 'Items knocked out per week' })}</section>
      <section class="card"><h2>LOE done, last 12 weeks</h2>${V.columns(wkLoe, { fmt: v => A.hoursText(v) || '0h', title: 'LOE hours done per week' })}</section></div>
    ${gs.length || req.admin ? html`<section class="card" id="goals"><div class="card-head"><h2>Goals & KPIs</h2>${req.admin ? html`<a class="small" href="/goals">Add or change goals</a>` : ''}</div>
      ${gs.length ? html`<ul class="rows goals">${gs.map(({ g, s }) => html`<li><span><b>${g.name}</b><small class="block muted">${g.pname || g.prname || 'Whole team'} · ${s.label}</small></span>
        <div class="loadcell">${V.bar(s.pct)}<small class="${s.good ? 'ok-text' : 'muted'}">${s.good ? '✓ ' : ''}${s.unit === 'h' ? A.hoursText(s.value) || '0h' : s.value}${s.unit === '%' ? '%' : ''} ${s.lower ? '(target ≤ ' + s.target + ')' : 'of ' + (s.unit === 'h' ? A.hoursText(s.target) : s.target + (s.unit === '%' ? '%' : ''))}</small></div></li>`)}</ul>`
        : html`<p class="muted small">No goals yet. Set targets like “25 items a week” or “90% on time this quarter” and watch them here.</p>`}</section>` : ''}
    ${byPerson.length ? html`<section class="card"><h2>By person</h2><div class="tbl"><table class="sheet"><thead><tr><th>Person</th><th class="n">Knocked out</th><th class="n">LOE done</th><th class="n">On time</th><th class="n">Time logged</th><th class="n">Open</th><th class="n">Late</th></tr></thead><tbody>
      ${byPerson.map(({ p, x }) => html`<tr><td><a href="/insights?period=${period}&who=p${p.id}">${p.name}</a>${p.role ? html`<small class="block muted">${p.role}</small>` : ''}</td><td class="n">${x.done}</td><td class="n">${A.hoursText(x.loe) || '0h'}</td><td class="n">${pctText(x.ontime)}</td><td class="n">${A.hoursText(x.time) || '—'}</td><td class="n">${x.open}</td><td class="n">${x.late ? html`<b class="red-text">${x.late}</b>` : '0'}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${byProject.length ? html`<section class="card"><h2>By project</h2><div class="tbl"><table class="sheet"><thead><tr><th>Project</th><th class="n">Knocked out</th><th class="n">LOE done</th><th class="n">On time</th><th class="n">Open</th><th class="n">Late</th></tr></thead><tbody>
      ${byProject.map(({ p, x }) => html`<tr><td><a href="/projects/${p.id}">${p.name}</a> <small class="muted">#${p.tag}</small></td><td class="n">${x.done}</td><td class="n">${A.hoursText(x.loe) || '0h'}</td><td class="n">${pctText(x.ontime)}</td><td class="n">${x.open}</td><td class="n">${x.late ? html`<b class="red-text">${x.late}</b>` : '0'}</td></tr>`)}</tbody></table></div></section>` : ''}` }));
});
app.get('/insights.csv', async (req, res) => {
  A.wsRequired(req); const { r, filter } = pick(req), s = require('../lib/work').scope(req), f = M.where(filter);
  const rows = await all(`SELECT i.*, o.name owner_name, pr.name project_name FROM items i LEFT JOIN people o ON o.id=i.owner_person_id LEFT JOIN projects pr ON pr.id=i.project_id WHERE ${s.sql} AND i.status='done' AND i.completed_at BETWEEN ? AND ?${f.sql} ORDER BY i.completed_at`, ...s.args, r.from + ' 00:00:00', r.to + ' 23:59:59', ...f.args);
  res.setHeader('Content-Disposition', `attachment; filename="knockout-done-${r.from}-to-${r.to}.csv"`);
  res.send(U.toCSV([['Knocked out', 'Title', 'Kind', 'Owner', 'Project', 'LOE hours', 'Due', 'On time', 'Days to knock out'],
    ...rows.map(i => [String(i.completed_at).slice(0, 10), i.title, A.KIND[i.kind][0], i.owner_name || 'Me', i.project_name || '', i.loe ?? '', i.due_on || '', i.due_on ? (String(i.completed_at).slice(0, 10) <= i.due_on ? 'yes' : 'no') : '', Math.round(U.daysBetween(i.created_at, i.completed_at))])]), 200, 'text/csv; charset=utf-8');
});

// ───────────── goals ─────────────
app.get('/goals', async (req, res) => {
  A.adminOnly(req);
  const goals = await all('SELECT g.*, p.name pname, pr.name prname FROM goals g LEFT JOIN people p ON p.id=g.person_id LEFT JOIN projects pr ON pr.id=g.project_id WHERE g.workspace_id=? ORDER BY g.active DESC, g.id', req.ws.id);
  const people = await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id), projects = await all("SELECT id, name FROM projects WHERE workspace_id=? ORDER BY name", req.ws.id);
  res.send(await page(req, { title: 'Goals', body: html`<p class="eyebrow"><a href="/insights">Insights</a></p><h1>Goals & KPIs</h1>
    <section class="card">${goals.length ? html`<ul class="rows">${await Promise.all(goals.map(async g => { const s = await M.goalStatus(req.ws, g); return html`<li class="${g.active ? '' : 'muted'}"><span><b>${g.name}</b><small class="block muted">${METRIC[g.metric]} · target ${g.target} · ${g.period} · ${g.pname || g.prname || 'whole team'}${g.active ? '' : ' · paused'}</small></span>
      <span class="small">${s.value} now</span><form method="post" action="/goals/${g.id}/${g.active ? 'pause' : 'resume'}">${csrf(req)}<button class="btn sm">${g.active ? 'Pause' : 'Resume'}</button></form><form method="post" action="/goals/${g.id}/delete">${csrf(req)}<button class="link small red-text">Delete</button></form></li>`; }))}</ul>` : A.empty('No goals yet.')}</section>
    <section class="card"><h2>Add a goal</h2><form method="post" action="/goals" class="stack">${csrf(req)}
      <label>Name<input name="name" required maxlength="100" placeholder="Team knocks out 30 items a week"></label>
      <div class="two"><label>Measure<select name="metric">${Object.entries(METRIC).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label><label>Target<input name="target" required inputmode="decimal" maxlength="8" placeholder="30"></label></div>
      <div class="two"><label>Each<select name="period"><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="custom">Custom dates</option></select></label>
        <label>For<select name="person_id"><option value="">Whole team</option>${people.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label></div>
      <div class="two"><label>Project <small>(optional)</small><select name="project_id"><option value="">Any project</option>${projects.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label><span></span></div>
      <div class="two"><label>From <small>(custom)</small><input type="date" name="start_on"></label><label>To <small>(custom)</small><input type="date" name="end_on"></label></div>
      <button class="btn primary">Add goal</button></form></section>` }));
});
app.post('/goals', async (req, res) => {
  A.adminOnly(req); const b = req.body, name = String(b.name || '').trim().slice(0, 100); if (!name) bad('Name the goal.');
  if (!METRIC[b.metric]) bad('Pick what to measure.'); const target = Number(String(b.target || '').replace(/[^\d.]/g, '')); if (!(target >= 0) && b.metric !== 'project_done') bad('Enter a target number.');
  const W = require('../lib/work'), person = await W.personIn(req.ws.id, b.person_id), project = await W.projectIn(req.ws.id, b.project_id);
  if (b.metric === 'project_done' && !project) bad('Pick the project.');
  const period = ['week', 'month', 'quarter', 'custom'].includes(b.period) ? b.period : 'week';
  await run('INSERT INTO goals(workspace_id,name,metric,target,period,person_id,project_id,start_on,end_on) VALUES(?,?,?,?,?,?,?,?,?)', req.ws.id, name, b.metric, b.metric === 'project_done' ? 100 : target || 0, period, person?.id || null, project?.id || null, U.isDate(b.start_on) ? b.start_on : null, U.isDate(b.end_on) ? b.end_on : null);
  flash(res, 'Goal added.'); res.redirect('/insights#goals');
});
app.post('/goals/:id/:act', async (req, res) => {
  A.adminOnly(req); const g = await one('SELECT * FROM goals WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  if (req.params.act === 'delete') await run('DELETE FROM goals WHERE id=?', g.id); else if (['pause', 'resume'].includes(req.params.act)) await run('UPDATE goals SET active=? WHERE id=?', req.params.act === 'resume' ? 1 : 0, g.id); else notFound();
  res.redirect('/goals');
});
module.exports = { METRIC };
