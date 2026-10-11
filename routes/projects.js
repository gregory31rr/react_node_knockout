/**
 * routes/projects.js — projects (#tags), LOE rollups, who is on each project and how busy they are, and v2s.
 *
 *   /projects          every project: progress (LOE done / total), open, late, LOE left, people, due date
 *   /projects/:id      rollup, the TEAM on it with their workload (so you know who to pull or add), people with room
 *                      who could join, all items, and actions: on hold, done, reopen, start v2
 *   v2                 "Start v2" makes a new project linked to this one (same goal and people, its own #tag) and can move
 *                      the unfinished items over. The finished one stays as the record; each links to the other.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');
const V = require('../lib/views');
const P = require('../lib/parse');

const PST = { active: ['Active', 'ok'], on_hold: ['On hold', 'mark'], done: ['Done', ''] };
async function uniqueTag(wsId, base, except = 0) { base = P.tagFor(base); let t = base, n = 2; while (await one('SELECT 1 x FROM projects WHERE workspace_id=? AND tag=? AND id<>?', wsId, t, except)) t = `${base}-${n++}`; return t; }
const getProject = async (req, id) => (await one('SELECT * FROM projects WHERE id=? AND workspace_id=?', id, req.ws.id)) || notFound();

app.get('/projects', async (req, res) => {
  A.wsRequired(req);
  const show = req.query.show === 'done' ? 'done' : req.query.show === 'all' ? 'all' : 'active';
  const s = W.scope(req);
  let list = await all(`SELECT pr.*, o.name owner_name FROM projects pr LEFT JOIN people o ON o.id=pr.owner_person_id WHERE pr.workspace_id=? ${show === 'done' ? "AND pr.status='done'" : show === 'active' ? "AND pr.status<>'done'" : ''} ORDER BY pr.status='done', COALESCE(pr.due_on,'9999'), pr.name`, req.ws.id);
  if (!req.admin) { const mine = new Set((await all(`SELECT DISTINCT i.project_id id FROM items i WHERE ${s.sql} AND i.project_id IS NOT NULL`, ...s.args)).map(r => Number(r.id))); list = list.filter(p => mine.has(Number(p.id))); }
  const rows = []; for (const p of list) rows.push({ ...p, r: await W.rollup(p.id), team: Number((await one('SELECT count(DISTINCT owner_person_id) n FROM items WHERE project_id=? AND owner_person_id IS NOT NULL', p.id)).n) });
  res.send(await page(req, { title: 'Projects', wide: true, body: html`<div class="head"><div><h1>Projects</h1><p class="muted">Every item tagged #project rolls up here.</p></div>${req.admin ? html`<a class="btn primary" href="/projects/new">New project</a>` : ''}</div>
    <nav class="seg">${[['active', 'Active'], ['done', 'Done'], ['all', 'All']].map(([k, l]) => html`<a href="/projects?show=${k}" ${show === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    <section class="card">${rows.length ? html`<div class="tbl"><table class="sheet"><thead><tr><th>Project</th><th>Progress</th><th class="n">Open</th><th class="n">Late</th><th class="n">LOE left</th><th class="n">People</th><th>Due</th><th>Status</th></tr></thead><tbody>
      ${rows.map(p => html`<tr><td><a href="/projects/${p.id}"><b>${p.name}</b></a><small class="block muted">#${p.tag}${p.version > 1 ? ` · v${p.version}` : ''}${p.owner_name ? ' · ' + p.owner_name : ''}</small></td>
        <td class="loadcell">${V.bar(p.r.pct)}<small class="muted">${p.r.pct}% · ${p.r.done}/${p.r.n} items</small></td><td class="n">${p.r.n - p.r.done}</td><td class="n">${p.r.overdue ? html`<b class="red-text">${p.r.overdue}</b>` : '0'}</td>
        <td class="n">${A.hoursText(p.r.loeLeft) || '—'}</td><td class="n">${p.team}</td><td>${p.due_on ? U.fmtDate(p.due_on) : html`<span class="muted">—</span>`}</td><td>${A.badge(...PST[p.status])}</td></tr>`)}
      </tbody></table></div>` : A.empty(show === 'done' ? 'No finished projects yet.' : 'No projects yet.', req.admin ? html`<a class="btn primary" href="/projects/new">New project</a>` : '')}</section>` }));
});

async function form(req, p = {}, action) {
  const people = await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id);
  return html`<form method="post" action="${action}" class="stack">${csrf(req)}
    <div class="two"><label>Name<input name="name" required maxlength="100" value="${p.name || ''}" placeholder="GCP migration"></label><label>#tag <small>(short, for quick add)</small><input name="tag" maxlength="24" value="${p.tag || ''}" placeholder="gcp"></label></div>
    <label>Goal / what done looks like<textarea name="goal" rows="2" maxlength="2000">${p.goal || ''}</textarea></label>
    <div class="two"><label>Lead<select name="owner_person_id">${V.peopleOptions(people, p.owner_person_id, 'Me')}</select></label><label>Status<select name="status">${Object.entries(PST).map(([k, v]) => html`<option value="${k}" ${(p.status || 'active') === k ? raw('selected') : ''}>${v[0]}</option>`)}</select></label></div>
    <div class="two"><label>Start<input type="date" name="start_on" value="${p.start_on || ''}"></label><label>Due<input type="date" name="due_on" value="${p.due_on || ''}"></label></div>
    <button class="btn primary">${p.id ? 'Save' : 'Create project'}</button></form>`;
}
app.get('/projects/new', async (req, res) => { A.adminOnly(req); res.send(await page(req, { title: 'New project', body: html`<p class="eyebrow"><a href="/projects">Projects</a></p><h1>New project</h1><section class="card">${await form(req, {}, '/projects/new')}</section>` })); });
async function save(req, p) {
  const b = req.body, name = String(b.name || '').trim().slice(0, 100); if (!name) bad('Name the project.');
  const tag = await uniqueTag(req.ws.id, String(b.tag || '').trim() || name, p?.id || 0);
  const owner = await W.personIn(req.ws.id, b.owner_person_id), status = PST[b.status] ? b.status : 'active';
  const vals = [name, tag, String(b.goal || '').slice(0, 2000) || null, owner?.id || null, status, U.isDate(b.start_on) ? b.start_on : null, U.isDate(b.due_on) ? b.due_on : null];
  if (p) { await run(`UPDATE projects SET name=?, tag=?, goal=?, owner_person_id=?, status=?, start_on=?, due_on=?, completed_at=CASE WHEN ?='done' THEN COALESCE(completed_at, ko_now()) ELSE NULL END WHERE id=?`, ...vals, status, p.id); return p.id; }
  return (await run('INSERT INTO projects(workspace_id,name,tag,goal,owner_person_id,status,start_on,due_on) VALUES(?,?,?,?,?,?,?,?)', req.ws.id, ...vals)).id;
}
app.post('/projects/new', async (req, res) => { A.adminOnly(req); const id = await save(req, null); flash(res, 'Project created. Tag items with its #tag to roll them up here.'); res.redirect('/projects/' + id); });
app.post('/projects/:id/edit', async (req, res) => { A.adminOnly(req); const p = await getProject(req, req.params.id); await save(req, p); flash(res, 'Saved.'); res.redirect('/projects/' + p.id); });

app.get('/projects/:id', async (req, res) => {
  A.wsRequired(req);
  const p = await getProject(req, req.params.id), s = W.scope(req);
  const items = await all(`${W.LIST_SQL} WHERE ${s.sql} AND i.project_id=? ORDER BY i.status='done', ${W.ORDER}`, ...s.args, p.id);
  if (!req.admin && !items.length) A.deny();
  const risk = await W.risk(req.ws, items), r = await W.rollup(p.id);
  const open = items.filter(i => i.status !== 'done'), done = items.filter(i => i.status === 'done');
  const cap = Object.fromEntries((await W.capacity(req.ws)).map(c => [c.id, c]));
  const team = await all(`SELECT o.id, o.name, o.title, o.team, count(CASE WHEN i.status IN ${W.OPEN} THEN 1 END) open_n, count(CASE WHEN i.status='done' THEN 1 END) done_n,
      COALESCE(sum(CASE WHEN i.status IN ${W.OPEN} THEN i.loe END),0) loe_left, count(CASE WHEN i.status IN ${W.OPEN} AND i.due_on < ko_today() THEN 1 END) late
    FROM items i JOIN people o ON o.id=i.owner_person_id WHERE i.project_id=? GROUP BY o.id, o.name, o.title, o.team ORDER BY open_n DESC, o.name`, p.id);
  const onIds = new Set(team.map(t => Number(t.id)));
  const couldAdd = Object.values(cap).filter(c => !onIds.has(Number(c.id)) && !['boss', 'peer'].includes(c.relation)).sort((a, b) => b.free - a.free).slice(0, 5);
  const fam = await all('SELECT id, name, tag, version, status FROM projects WHERE workspace_id=? AND (id=? OR parent_id=? OR id=(SELECT parent_id FROM projects WHERE id=?)) AND id<>? ORDER BY version', req.ws.id, p.parent_id || 0, p.id, p.id, p.id);
  const owner = p.owner_person_id ? await one('SELECT name FROM people WHERE id=?', p.owner_person_id) : null;
  const daysLeft = p.due_on ? U.daysBetween(U.today(), p.due_on) : null, hoursLeft = p.due_on ? W.workdays(U.today(), p.due_on, req.ws.workdays) * team.reduce((a, t) => a + ((cap[t.id]?.hours_per_day) || req.ws.hours_per_day), 0) : null;
  res.send(await page(req, { title: p.name, wide: true, body: html`<p class="eyebrow"><a href="/projects">Projects</a> · #${p.tag}${p.version > 1 ? ` · v${p.version}` : ''}</p>
    <div class="head"><div><h1>${p.name} ${A.badge(...PST[p.status])}</h1><p class="muted">${owner ? 'Lead: ' + owner.name + ' · ' : ''}${p.due_on ? `Due ${U.fmtDate(p.due_on)} (${daysLeft >= 0 ? daysLeft + ' days left' : -daysLeft + ' days late'})` : 'No due date'}${fam.length ? ' · ' : ''}${fam.map(f => html`<a href="/projects/${f.id}">v${f.version} #${f.tag}</a> `)}</p>${p.goal ? html`<p class="pre">${p.goal}</p>` : ''}</div>
      ${req.admin ? html`<div class="actions">${p.status === 'done' ? html`<form method="post" action="/projects/${p.id}/status">${csrf(req)}<button class="btn" name="status" value="active">Reopen</button></form>` : html`<form method="post" action="/projects/${p.id}/status" data-confirm="Mark ${p.name} done?${open.length ? ` ${open.length} items are still open (they stay open).` : ''}">${csrf(req)}<button class="btn primary" name="status" value="done">🥊 Mark project done</button></form>`}
        <a class="btn" href="#v2">Start v2</a></div>` : ''}</div>
    <div class="score"><div class="stat"><b>${r.pct}%</b><span>done (by LOE)</span></div><div class="stat"><b>${r.n - r.done}</b><span>open of ${r.n}</span></div>
      <div class="stat"><b>${A.hoursText(r.loeLeft) || '0h'}</b><span>LOE left</span></div><div class="stat"><b>${A.hoursText(r.spent) || '0h'}</b><span>time logged</span></div>
      <div class="stat ${r.overdue ? 'hot' : ''}"><b>${r.overdue}</b><span>late</span></div>
      ${hoursLeft != null && team.length ? html`<div class="stat ${r.loeLeft > hoursLeft ? 'hot' : ''}"><b>${A.hoursText(hoursLeft) || '0h'}</b><span>team hours until due</span></div>` : ''}</div>
    ${V.bar(r.pct, r.pct + '% done')}
    <div class="cols"><div>
      <section class="card"><div class="card-head"><h2>Open items <span class="count">${open.length}</span></h2></div>
        <form method="post" action="/items/quick" class="quick-inline">${csrf(req)}${A.kindPicker()}<input type="hidden" name="back" value="/projects/${p.id}"><input type="hidden" name="project_id" value="${p.id}">
          <input name="text" required maxlength="500" placeholder="Write runbook for @sam 4h fri" aria-label="Add to ${p.name}" data-parse><button class="btn">Add</button><div class="parse-preview muted small"></div></form>
        ${V.list(req, open, { risk, hide: ['project'], empty: 'No open items.' })}</section>
      ${done.length ? html`<section class="card"><details><summary><h2 class="inline">Knocked out <span class="count">${done.length}</span></h2></summary>${V.list(req, done, { hide: ['project'] })}</details></section>` : ''}
    </div><div>
      <section class="card" id="team"><div class="card-head"><h2>Who's on it</h2>${req.admin ? html`<a class="small" href="/people/capacity?project=${p.id}">Who has room?</a>` : ''}</div>
        ${team.length ? html`<ul class="rows team-rows">${team.map(t => { const c = cap[t.id] || { pct: 0, free: 0 }; return html`<li><a href="${req.admin ? '/people/' + t.id : '#team'}" class="person-cell">${A.avatar(t)}<span><b>${t.name}</b><small class="block muted">${t.open_n} open here · ${A.hoursText(t.loe_left) || '0h'} left${Number(t.late) ? html` · <span class="red-text">${t.late} late</span>` : ''}</small></span></a>
          <div class="loadcell">${V.bar(c.pct)}<small class="${c.free < 0 ? 'red-text' : 'muted'}">${c.pct}% booked overall · ${c.free >= 0 ? A.hoursText(c.free) + ' free' : A.hoursText(-c.free) + ' over'}</small></div></li>`; })}</ul>`
          : html`<p class="muted small">Nobody yet. Hand items to people (for @name) and they show up here.</p>`}
        ${req.admin && couldAdd.length ? html`<h3>Could join (most free time)</h3><ul class="rows small">${couldAdd.map(c => html`<li><a href="/people/${c.id}"><b>${c.name}</b><span>${A.hoursText(Math.max(c.free, 0)) || '0h'} free · ${c.pct}% booked</span></a></li>`)}</ul>` : ''}</section>
      ${req.admin ? html`<section class="card" id="v2"><h2>Start v2</h2><p class="muted small">A new project linked to this one, with the same goal and lead. ${p.name} stays as the record.</p>
        <form method="post" action="/projects/${p.id}/v2" class="stack">${csrf(req)}<label>Name<input name="name" value="${p.name.replace(/\s+v\d+$/i, '')} v${p.version + 1}" required maxlength="100"></label>
          <label class="check"><input type="checkbox" name="move" value="1" checked> Move the ${open.length} unfinished item${open.length === 1 ? '' : 's'} to v2</label>
          <label class="check"><input type="checkbox" name="close" value="1" ${p.status === 'done' ? raw('checked disabled') : ''}> Mark this one done</label><button class="btn">Start v2</button></form></section>
      <section class="card"><h2>Edit</h2>${await form(req, p, `/projects/${p.id}/edit`)}
        <form method="post" action="/projects/${p.id}/delete" data-confirm="Delete ${p.name}? Its items stay but lose the project tag.">${csrf(req)}<button class="link red-text">Delete project</button></form></section>` : ''}
    </div></div>` }));
});
app.post('/projects/:id/status', async (req, res) => {
  A.adminOnly(req); const p = await getProject(req, req.params.id), st = PST[req.body.status] ? req.body.status : 'active';
  await run("UPDATE projects SET status=?, completed_at=CASE WHEN ?='done' THEN ko_now() ELSE NULL END WHERE id=?", st, st, p.id);
  await A.audit(req, 'project ' + st, { id: p.id, name: p.name }); flash(res, st === 'done' ? `🥊 ${p.name} is done!` : `${p.name} is ${PST[st][0].toLowerCase()}.`); res.redirect('/projects/' + p.id);
});
app.post('/projects/:id/v2', async (req, res) => {
  A.adminOnly(req); const p = await getProject(req, req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 100) || `${p.name} v${p.version + 1}`;
  const id = await tx(async () => {
    const tag = await uniqueTag(req.ws.id, p.tag.replace(/-v\d+$/, '') + '-v' + (p.version + 1));
    const r = await run('INSERT INTO projects(workspace_id,name,tag,goal,owner_person_id,status,start_on,parent_id,version) VALUES(?,?,?,?,?,?,?,?,?)', req.ws.id, name, tag, p.goal, p.owner_person_id, 'active', U.today(), p.id, p.version + 1);
    if (req.body.move === '1') {
      const moving = await all(`SELECT id FROM items WHERE project_id=? AND status IN ${W.OPEN}`, p.id);
      for (const m of moving) { await run('UPDATE items SET project_id=? WHERE id=?', r.id, m.id); await W.event(req.ws.id, m.id, 'moved', `From ${p.name} to ${name}`, W.actorName(req)); }
    }
    if (req.body.close === '1') await run("UPDATE projects SET status='done', completed_at=COALESCE(completed_at, ko_now()) WHERE id=?", p.id);
    return r.id;
  });
  await A.audit(req, 'started v2', { from: p.id, to: id }); flash(res, `${name} started. It links back to ${p.name}.`); res.redirect('/projects/' + id);
});
app.post('/projects/:id/delete', async (req, res) => {
  A.adminOnly(req); const p = await getProject(req, req.params.id); await run('DELETE FROM projects WHERE id=?', p.id);
  await A.audit(req, 'deleted project', { id: p.id, name: p.name }); flash(res, 'Project deleted. Its items are kept.'); res.redirect('/projects');
});
module.exports = { PST, uniqueTag };
