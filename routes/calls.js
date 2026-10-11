/**
 * routes/calls.js — calls and 1:1s: everything for the people on the call, in one filtered list.
 *
 *   /calls/new        pick who's on the call (or paste the Teams / Zoom participant list) and which projects
 *   /calls/:id        THE CALL: every open ask, update, tell and task for the people on the call and its projects.
 *                     Tap a name (or #project) to filter: "all my questions for John", "everything on #gcp".
 *                     Answer in place, knock things out, add new items (they're tagged to this call), take notes,
 *                     and record. Ending the call builds the summary.
 *   /calls/:id/summary   what got answered, knocked out, added and handed out; send it to the people on the call
 *                     and/or your boss (email, open in your own email, or copy for Teams).
 *
 * Recording: the browser records the microphone (you press Record; the browser asks permission first). The audio is
 * saved with the call (encrypted, in the database). If TRANSCRIBE_API_KEY is set (OpenAI's speech-to-text), "Transcribe" turns it into text and
 * Knockout suggests answers for your open questions from what was said. Tell people on the call you're recording.
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

const MKIND = { one_on_one: '1:1', team: 'Team call', project: 'Project call', boss: 'With my boss', other: 'Other' };
const getCall = async (req, id) => (await one('SELECT * FROM meetings WHERE id=? AND workspace_id=?', id, req.ws.id)) || notFound();
const callPeople = id => all('SELECT p.* FROM people p JOIN meeting_people mp ON mp.person_id=p.id WHERE mp.meeting_id=? ORDER BY p.name', id);
const callProjects = id => all('SELECT pr.* FROM projects pr JOIN meeting_projects mp ON mp.project_id=pr.id WHERE mp.meeting_id=? ORDER BY pr.name', id);

app.get('/calls', async (req, res) => {
  A.adminOnly(req);
  const rows = await all(`SELECT m.*, (SELECT count(*) FROM meeting_people mp WHERE mp.meeting_id=m.id) n FROM meetings m WHERE m.workspace_id=? ORDER BY m.status='done', COALESCE(m.starts_at, m.created_at) DESC LIMIT 200`, req.ws.id);
  const up = rows.filter(r => r.status !== 'done'), past = rows.filter(r => r.status === 'done');
  const row = m => html`<li><a href="/calls/${m.id}"><b>${m.title}</b><span>${MKIND[m.kind]} · ${m.n} ${Number(m.n) === 1 ? 'person' : 'people'} · ${m.starts_at ? U.fmtDateTime(m.starts_at) : 'not scheduled'}${m.status === 'live' ? ' · LIVE' : ''}${m.recording ? ' · recorded' : ''}</span></a></li>`;
  res.send(await page(req, { title: 'Calls', body: html`<div class="head"><div><h1>Calls & 1:1s</h1><p class="muted">Pull up everything for the people on a call, answer it live, and send the summary.</p></div><a class="btn primary" href="/calls/new">New call</a></div>
    <section class="card"><h2>Coming up & live</h2>${up.length ? html`<ul class="rows">${up.map(row)}</ul>` : A.empty('No calls planned.', html`<a class="btn" href="/calls/new">New call</a>`)}</section>
    ${past.length ? html`<section class="card"><h2>Past calls</h2><ul class="rows">${past.map(row)}</ul></section>` : ''}` }));
});
app.get('/calls/new', async (req, res) => {
  A.adminOnly(req);
  const people = await all('SELECT id, name, team, title FROM people WHERE workspace_id=? AND active=1 ORDER BY team, name', req.ws.id);
  const projects = await all("SELECT id, name, tag FROM projects WHERE workspace_id=? AND status<>'done' ORDER BY name", req.ws.id);
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  res.send(await page(req, { title: 'New call', body: html`<p class="eyebrow"><a href="/calls">Calls</a></p><h1>New call</h1>
    <form method="post" action="/calls/new" class="card stack">${csrf(req)}
      <div class="two"><label>Title<input name="title" required maxlength="120" placeholder="GCP migration standup"></label><label>Kind<select name="kind">${Object.entries(MKIND).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label></div>
      <label>When<input type="datetime-local" name="starts_at" value="${now}"></label>
      <fieldset><legend>Who's on the call</legend>
        <input type="search" placeholder="Filter names" class="filter-box" data-filter=".pick-people label" aria-label="Filter names">
        <div class="pick-people">${people.map(p => html`<label class="check"><input type="checkbox" name="person" value="${p.id}"><span>${p.name}${p.team ? html` <small class="muted">${p.team}</small>` : ''}</span></label>`)}</div>
        <label>Or paste the participant list from Teams / Zoom / the invite<textarea name="paste" rows="3" placeholder="John Smith <john@co.com>; Jane Doe…"></textarea></label>
        <label class="check"><input type="checkbox" name="add_new" value="1" checked> Add anyone new from the pasted list to my people</label></fieldset>
      ${projects.length ? html`<fieldset><legend>Projects on this call</legend><div class="pick-people">${projects.map(p => html`<label class="check"><input type="checkbox" name="project" value="${p.id}"><span>${p.name} <small class="muted">#${p.tag}</small></span></label>`)}</div></fieldset>` : ''}
      <div class="actions"><button class="btn primary" name="start" value="1">Start the call now</button><button class="btn">Save for later</button></div></form>` }));
});
app.post('/calls/new', async (req, res) => {
  A.adminOnly(req);
  const title = String(req.body.title || '').trim().slice(0, 120) || 'Call', kind = MKIND[req.body.kind] ? req.body.kind : 'team';
  const ids = new Set([].concat(req.body.person || []).map(Number).filter(Boolean));
  let added = 0;
  if (req.body.paste) {
    const have = await all('SELECT id, name, email FROM people WHERE workspace_id=? AND active=1', req.ws.id);
    for (const a of P.attendees(String(req.body.paste).slice(0, 50000))) {
      const hit = have.find(h => (a.email && h.email && h.email.toLowerCase() === a.email) || h.name.toLowerCase() === a.name.toLowerCase());
      if (hit) ids.add(Number(hit.id));
      else if (req.body.add_new === '1') { const id = await require('./people').addPerson(req, { name: a.name, email: a.email, relation: 'other' }); if (id) { ids.add(Number(id)); added++; } }
    }
  }
  const projs = [].concat(req.body.project || []).map(Number).filter(Boolean);
  const start = req.body.start === '1' || req.body.kind === 'one_on_one' && !req.body.starts_at;
  const when = start ? U.nowSql() : (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.starts_at || '') ? new Date(req.body.starts_at).toISOString().slice(0, 19).replace('T', ' ') : null);
  const id = await tx(async () => {
    const r = await run('INSERT INTO meetings(workspace_id,title,kind,starts_at,status) VALUES(?,?,?,?,?)', req.ws.id, title, kind, when, start ? 'live' : 'planned');
    for (const pid of ids) if (await W.personIn(req.ws.id, pid)) await run('INSERT INTO meeting_people(meeting_id,person_id) VALUES(?,?) ON CONFLICT DO NOTHING', r.id, pid);
    for (const pid of projs) if (await W.projectIn(req.ws.id, pid)) await run('INSERT INTO meeting_projects(meeting_id,project_id) VALUES(?,?) ON CONFLICT DO NOTHING', r.id, pid);
    return r.id;
  });
  if (added) flash(res, `Added ${added} new ${added === 1 ? 'person' : 'people'} from the list.`);
  res.redirect('/calls/' + id);
});

/** Open items for a call: for/owned by anyone on it, or on its projects. */
async function agenda(req, m, people, projects) {
  const pids = people.map(p => Number(p.id)), prj = projects.map(p => Number(p.id));
  if (!pids.length && !prj.length) return [];
  const conds = []; if (pids.length) conds.push(`i.person_id IN (${pids.join(',')})`, `i.owner_person_id IN (${pids.join(',')})`); if (prj.length) conds.push(`i.project_id IN (${prj.join(',')})`);
  return all(`${W.LIST_SQL} WHERE i.workspace_id=? AND (i.status IN ${W.OPEN} OR (i.completed_at >= ? AND i.meeting_id=?)) AND (${conds.join(' OR ')}) ORDER BY i.status='done', CASE i.kind WHEN 'ask' THEN 0 WHEN 'update' THEN 1 WHEN 'tell' THEN 2 WHEN 'decision' THEN 3 ELSE 4 END, ${W.ORDER}`,
    req.ws.id, m.starts_at || m.created_at, m.id);
}
app.get('/calls/:id', async (req, res) => {
  A.adminOnly(req);
  const m = await getCall(req, req.params.id), people = await callPeople(m.id), projects = await callProjects(m.id);
  const items = await agenda(req, m, people, projects), risk = await W.risk(req.ws, items);
  const fp = Number(req.query.person) || 0, fj = Number(req.query.project) || 0;
  const shown = items.filter(i => (!fp || Number(i.person_id) === fp || Number(i.owner_person_id) === fp) && (!fj || Number(i.project_id) === fj));
  const groups = []; const seen = new Set();
  for (const p of people) { const g = shown.filter(i => !seen.has(i.id) && (Number(i.person_id) === Number(p.id) || Number(i.owner_person_id) === Number(p.id))); g.forEach(i => seen.add(i.id)); if (g.length) groups.push({ title: p.name, href: '/people/' + p.id, items: g }); }
  for (const pr of projects) { const g = shown.filter(i => !seen.has(i.id) && Number(i.project_id) === Number(pr.id)); g.forEach(i => seen.add(i.id)); if (g.length) groups.push({ title: '#' + pr.tag + ' · ' + pr.name, href: '/projects/' + pr.id, items: g }); }
  const counts = Object.fromEntries(people.map(p => [p.id, items.filter(i => i.status !== 'done' && (Number(i.person_id) === Number(p.id) || Number(i.owner_person_id) === Number(p.id))).length]));
  const allPeople = await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id), allProjects = await all("SELECT id, name, tag FROM projects WHERE workspace_id=? AND status<>'done' ORDER BY name", req.ws.id);
  const live = m.status === 'live', canTranscribe = !!process.env.TRANSCRIBE_API_KEY;
  const sugg = m.transcript ? suggestions(m.transcript, items.filter(i => i.status !== 'done' && ['ask', 'update', 'decision'].includes(i.kind))) : [];
  const qbase = k => { const q = new URLSearchParams(); if (k.person) q.set('person', k.person); if (k.project) q.set('project', k.project); const s = q.toString(); return `/calls/${m.id}${s ? '?' + s : ''}`; };
  res.send(await page(req, { title: m.title, wide: true, body: html`<p class="eyebrow"><a href="/calls">Calls</a> · ${MKIND[m.kind]}</p>
    <div class="head"><div><h1>${m.title} ${live ? A.badge('LIVE', 'live') : m.status === 'done' ? A.badge('Done') : ''}</h1><p class="muted">${m.starts_at ? U.fmtDateTime(m.starts_at) : 'Not scheduled'} · ${items.filter(i => i.status !== 'done').length} open for this call</p></div>
      <div class="actions">${m.status === 'planned' ? html`<form method="post" action="/calls/${m.id}/start">${csrf(req)}<button class="btn primary">Start call</button></form>` : ''}
        ${live ? html`<form method="post" action="/calls/${m.id}/end">${csrf(req)}<button class="btn primary">End call & summary</button></form>` : ''}
        ${m.status === 'done' ? html`<a class="btn primary" href="/calls/${m.id}/summary">Summary</a>` : ''}</div></div>
    <nav class="filter-chips" aria-label="Filter the list">
      <a href="${qbase({})}" class="fchip ${!fp && !fj ? 'on' : ''}">Everything <b>${items.filter(i => i.status !== 'done').length}</b></a>
      ${people.map(p => html`<a href="${qbase({ person: p.id })}" class="fchip ${fp === Number(p.id) ? 'on' : ''}">${A.avatar(p, 'sm')} ${p.name.split(' ')[0]} <b>${counts[p.id]}</b></a>`)}
      ${projects.map(p => html`<a href="${qbase({ project: p.id })}" class="fchip proj ${fj === Number(p.id) ? 'on' : ''}">#${p.tag}</a>`)}</nav>
    <div class="cols call-cols"><div>
      <section class="card"><form method="post" action="/items/quick" class="quick-inline">${csrf(req)}${A.kindPicker()}<input type="hidden" name="back" value="${qbase({ person: fp, project: fj })}"><input type="hidden" name="meeting_id" value="${m.id}">
          ${fp ? html`<input type="hidden" name="person_id" value="${fp}">` : ''}${fj ? html`<input type="hidden" name="project_id" value="${fj}">` : ''}
          <input name="text" required maxlength="500" placeholder="${fp ? `New for ${people.find(p => Number(p.id) === fp)?.name.split(' ')[0]}: send the cost sheet fri` : 'New: @jane send the cost sheet #gcp fri'}" aria-label="Add an item from this call" data-parse><button class="btn">Add</button><div class="parse-preview muted small"></div></form></section>
      ${groups.length ? groups.map(g => html`<section class="card"><div class="card-head"><h2><a href="${g.href}">${g.title}</a> <span class="count">${g.items.filter(i => i.status !== 'done').length}</span></h2></div>
        <ul class="items">${g.items.map(i => html`${V.itemRow(req, i, { risk, back: qbase({ person: fp, project: fj }) })}${i.status !== 'done' && ['ask', 'update', 'decision'].includes(i.kind) ? html`<li class="answer-row"><details><summary class="small">Answer</summary>
          <form method="post" action="/items/${i.id}/answer" class="stack">${csrf(req)}<input type="hidden" name="back" value="${qbase({ person: fp, project: fj })}"><textarea name="answer" rows="2" required maxlength="5000" placeholder="What did they say?"></textarea>
          <label class="check"><input type="checkbox" name="ko" value="1" checked> Knock it out</label><button class="btn sm">Save answer</button></form></details></li>` : ''}`)}</ul></section>`)
        : html`<section class="card">${A.empty(people.length || projects.length ? 'Nothing open for the people on this call. Add something above.' : 'Add the people on this call (right side) to pull up everything for them.')}</section>`}
    </div><div>
      <section class="card rec" data-rec data-call="${m.id}"><h2>Recording</h2>
        ${m.recording ? html`<audio controls preload="none" src="/calls/${m.id}/recording"></audio><p class="muted small">${m.recording_secs ? Math.round(m.recording_secs / 60) + ' min · ' : ''}saved with this call.</p>
          <div class="actions">${canTranscribe ? html`<form method="post" action="/calls/${m.id}/transcribe">${csrf(req)}<button class="btn sm">${m.transcript ? 'Transcribe again' : 'Transcribe'}</button></form>` : ''}
          <form method="post" action="/calls/${m.id}/recording/delete" data-confirm="Delete this recording?">${csrf(req)}<button class="btn sm">Delete recording</button></form></div>
          ${!canTranscribe ? html`<p class="muted small">Turning recordings into text needs a speech-to-text key (TRANSCRIBE_API_KEY). Until then, listen back and type answers.</p>` : ''}`
        : html`<p class="muted small">Records your microphone in this browser. Tell everyone on the call first.</p>
          <div class="actions"><button type="button" class="btn rec-btn" data-rec-start>● Record</button><button type="button" class="btn" data-rec-stop hidden>■ Stop & save</button><span class="rec-time muted" aria-live="polite"></span></div>`}</section>
      ${sugg.length ? html`<section class="card"><h2>Answers heard in the recording</h2><ul class="rows">${sugg.map(s => html`<li class="stack-sm"><span><b>${s.item.title}</b><small class="block">“${s.text}”</small></span>
        <form method="post" action="/items/${s.item.id}/answer">${csrf(req)}<input type="hidden" name="back" value="/calls/${m.id}"><input type="hidden" name="answer" value="${s.text}"><input type="hidden" name="ko" value="1"><button class="btn sm">Use as answer & knock out</button></form></li>`)}</ul></section>` : ''}
      ${m.transcript ? html`<section class="card"><details><summary><h2 class="inline">Transcript</h2></summary><p class="pre small">${m.transcript}</p></details></section>` : ''}
      <section class="card"><h2>Notes</h2><form method="post" action="/calls/${m.id}/notes" class="stack">${csrf(req)}<textarea name="notes" rows="7" maxlength="50000" data-autosave placeholder="Anything worth remembering…">${m.notes || ''}</textarea><button class="btn sm">Save notes</button></form></section>
      <section class="card"><h2>On this call</h2><ul class="rows small">${people.map(p => html`<li><a href="/people/${p.id}">${A.avatar(p, 'sm')}<b>${p.name}</b></a><form method="post" action="/calls/${m.id}/people/${p.id}/remove">${csrf(req)}<button class="link small" aria-label="Remove ${p.name}">✕</button></form></li>`)}</ul>
        <form method="post" action="/calls/${m.id}/people" class="stack">${csrf(req)}<label>Add someone<select name="person"><option value="">Pick…</option>${allPeople.filter(p => !people.some(x => Number(x.id) === Number(p.id))).map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
          <label>Or paste names<textarea name="paste" rows="2" placeholder="From the Teams / Zoom participant list"></textarea></label>
          <label>Add a project<select name="project"><option value="">Pick…</option>${allProjects.filter(p => !projects.some(x => Number(x.id) === Number(p.id))).map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label><button class="btn sm">Add</button></form></section>
      <form method="post" action="/calls/${m.id}/delete" data-confirm="Delete this call? Items made during it are kept.">${csrf(req)}<button class="link red-text small">Delete call</button></form>
    </div></div>` }));
});
app.post('/calls/:id/start', async (req, res) => { A.adminOnly(req); const m = await getCall(req, req.params.id); await run("UPDATE meetings SET status='live', starts_at=? WHERE id=?", U.nowSql(), m.id); res.redirect('/calls/' + m.id); });
app.post('/calls/:id/end', async (req, res) => { A.adminOnly(req); const m = await getCall(req, req.params.id); await run("UPDATE meetings SET status='done', ended_at=ko_now(), starts_at=COALESCE(starts_at, ko_now()) WHERE id=?", m.id); res.redirect(`/calls/${m.id}/summary`); });
app.post('/calls/:id/notes', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id); await run('UPDATE meetings SET notes=? WHERE id=?', String(req.body.notes || '').slice(0, 50000) || null, m.id);
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true });
  flash(res, 'Notes saved.'); res.redirect('/calls/' + m.id);
});
app.post('/calls/:id/people', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id);
  const add = async pid => { if (pid && await W.personIn(req.ws.id, pid)) await run('INSERT INTO meeting_people(meeting_id,person_id) VALUES(?,?) ON CONFLICT DO NOTHING', m.id, pid); };
  await add(Number(req.body.person) || 0);
  if (req.body.paste) { const have = await all('SELECT id, name, email FROM people WHERE workspace_id=? AND active=1', req.ws.id);
    for (const a of P.attendees(String(req.body.paste).slice(0, 50000))) { const hit = have.find(h => (a.email && h.email && h.email.toLowerCase() === a.email) || h.name.toLowerCase() === a.name.toLowerCase()); await add(hit ? hit.id : await require('./people').addPerson(req, { name: a.name, email: a.email, relation: 'other' })); } }
  if (req.body.project && await W.projectIn(req.ws.id, req.body.project)) await run('INSERT INTO meeting_projects(meeting_id,project_id) VALUES(?,?) ON CONFLICT DO NOTHING', m.id, req.body.project);
  res.redirect('/calls/' + m.id);
});
app.post('/calls/:id/people/:pid/remove', async (req, res) => { A.adminOnly(req); const m = await getCall(req, req.params.id); await run('DELETE FROM meeting_people WHERE meeting_id=? AND person_id=?', m.id, req.params.pid); res.redirect('/calls/' + m.id); });
app.post('/calls/:id/delete', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id); await removeRecording(m);
  await run('UPDATE items SET meeting_id=NULL WHERE meeting_id=?', m.id); await run('DELETE FROM meetings WHERE id=?', m.id); flash(res, 'Call deleted.'); res.redirect('/calls');
});

// ───────────── recording ─────────────
const MAX_REC = 40 * 1024 * 1024;
// Where recordings are kept (database, or file storage such as DigitalOcean Spaces): lib/recordings.js.
const R = require('../lib/recordings'), { S3Error } = require('../lib/s3');
/** File storage down or refusing: a clear message, and nothing was changed. */
async function stored(fn) {
  try { return await fn(); }
  catch (e) { if (e instanceof S3Error) { console.error('recordings:', e.message); throw new A.HttpError(503, `${e.message} Nothing was changed. Try again in a minute.`); } throw e; }
}
const removeRecording = m => stored(() => R.remove(m.id));
const recordingBytes = m => stored(() => R.load(m.id));
app.post('/calls/:id/recording', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id);
  const f = req.files.find(x => x.field === 'audio'); if (!f || f.data.length < 100) bad('No audio came through.');
  if (f.data.length > MAX_REC) bad('That recording is over 40 MB. Record shorter parts.');
  const type = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)/.test(f.type || '') ? f.type.split(';')[0] : 'audio/webm';
  const name = `call-${m.id}.${{ 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac' }[type] || 'webm'}`;
  await stored(() => tx(async () => {
    await R.save(m.id, req.ws.id, f.data, type);   // stored encrypted; replaces any earlier recording
    await run('UPDATE meetings SET recording=?, recording_type=?, recording_secs=?, transcript=NULL WHERE id=?', name, type, W.num(req.body.secs, 0, 36000), m.id);
  }));
  await A.audit(req, 'recorded a call', { call: m.id });
  res.json({ ok: true });
});
app.get('/calls/:id/recording', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id); if (!m.recording) notFound();
  const buf = await recordingBytes(m); if (!buf) notFound();
  res.writeHead(200, { 'Content-Type': m.recording_type || 'audio/webm', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store' }); res.end(buf);
});
app.post('/calls/:id/recording/delete', async (req, res) => { A.adminOnly(req); const m = await getCall(req, req.params.id); await removeRecording(m); await run('UPDATE meetings SET recording=NULL, recording_secs=NULL WHERE id=?', m.id); flash(res, 'Recording deleted.'); res.redirect('/calls/' + m.id); });
app.post('/calls/:id/transcribe', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id); if (!m.recording) bad('Record the call first.');
  const key = process.env.TRANSCRIBE_API_KEY; if (!key) bad('Transcription is not set up (TRANSCRIBE_API_KEY).');
  const buf = await recordingBytes(m); if (!buf) bad('The recording is missing.');
  if (buf.length > 25 * 1024 * 1024) bad('That recording is longer than the transcription service accepts (25 MB). Record shorter calls.');
  const fd = new FormData(); fd.append('model', process.env.TRANSCRIBE_MODEL || 'whisper-1'); fd.append('file', new Blob([buf], { type: m.recording_type || 'audio/webm' }), m.recording);
  const r = await fetch(process.env.TRANSCRIBE_URL || 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!r.ok) bad(`The transcription service said no (${r.status}). Try again later.`);
  const text = String((await r.json()).text || '').slice(0, 200000);
  await run('UPDATE meetings SET transcript=? WHERE id=?', text, m.id); flash(res, 'Transcribed. Check the suggested answers.'); res.redirect('/calls/' + m.id);
});
/** Sentences from the transcript that share 2+ meaningful words with an open question (or name its person and a key word). */
function suggestions(transcript, items) {
  const STOP = new Set('the a an and or of to in on for with about is are was were be it this that what when how why do does did we you they i our your their from at by as have has get got status update ask question'.split(' '));
  const words = s => String(s).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(w => !STOP.has(w)) || [];
  const sentences = String(transcript).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 15 && s.length < 400);
  const out = [];
  for (const i of items) {
    const key = new Set(words(i.title)), name = (i.person_name || '').split(' ')[0].toLowerCase();
    let best = null, score = 0;
    for (const s of sentences) { const w = words(s), hit = w.filter(x => key.has(x)).length + (name && s.toLowerCase().includes(name) ? 1 : 0); if (hit > score) { score = hit; best = s; } }
    if (best && score >= 2) out.push({ item: i, text: best });
  }
  return out.slice(0, 20);
}

// ───────────── summary ─────────────
async function summaryText(req, m) {
  const people = await callPeople(m.id), since = m.starts_at || m.created_at;
  const ev = await all(`SELECT e.kind, e.text, i.id, i.title, i.kind ikind, i.answer, i.due_on, i.loe, o.name owner, p.name person FROM item_events e JOIN items i ON i.id=e.item_id LEFT JOIN people o ON o.id=i.owner_person_id LEFT JOIN people p ON p.id=i.person_id
    WHERE e.workspace_id=? AND e.created_at >= ? AND e.created_at <= COALESCE(?, ko_now()) AND (i.meeting_id=? OR e.kind IN ('answered','knocked out','delegated')) ORDER BY e.id`, req.ws.id, since, m.ended_at ? U.nowSql() : null, m.id);
  const pset = new Set(people.map(p => p.name)), relevant = e => e.ikind && (pset.has(e.person) || pset.has(e.owner) || true);
  const answered = [...new Map(ev.filter(e => e.kind === 'answered' && relevant(e)).map(e => [e.id, e])).values()];
  const done = [...new Map(ev.filter(e => e.kind === 'knocked out').map(e => [e.id, e])).values()].filter(e => !answered.some(a => a.id === e.id));
  const created = await all(`${W.LIST_SQL} WHERE i.meeting_id=? AND i.workspace_id=? ORDER BY i.id`, m.id, req.ws.id);
  const handed = [...new Map(ev.filter(e => e.kind === 'delegated').map(e => [e.id, e])).values()];
  const projects = await callProjects(m.id), openN = (await agenda(req, m, people, projects)).filter(i => i.status !== 'done');
  const risk = await W.risk(req.ws, openN), late = openN.filter(i => risk.has(i.id));
  const L = [`${m.title} · ${U.fmtDate(m.starts_at || m.created_at)}`, people.length ? `On the call: ${people.map(p => p.name).join(', ')}` : ''].filter(Boolean);
  if (answered.length) L.push('', 'Answered:', ...answered.map(e => `- ${e.title}: ${e.answer || e.text}`));
  if (done.length) L.push('', 'Knocked out:', ...done.map(e => `- ${e.title}`));
  if (created.length) L.push('', 'New action items:', ...created.map(i => `- ${i.title} → ${i.owner_name || (i.person_name && i.kind !== 'task' ? 'me, with ' + i.person_name : 'me')}${i.due_on ? ', due ' + U.fmtDate(i.due_on) : ''}${i.loe ? ' (' + A.loeText(i.loe) + ')' : ''}`));
  if (handed.length) L.push('', 'Handed off:', ...handed.map(e => `- ${e.title}: ${e.text}`));
  if (late.length) L.push('', 'Late or at risk:', ...late.map(i => `- ${i.title}${i.owner_name ? ' (' + i.owner_name + ')' : ''}${i.due_on ? ', due ' + U.fmtDate(i.due_on) : ''}`));
  if (m.notes) L.push('', 'Notes:', m.notes);
  if (L.length <= 2) L.push('', 'Nothing was answered, knocked out or added during this call.');
  return { text: L.join('\n'), people };
}
app.get('/calls/:id/summary', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id), { text, people } = await summaryText(req, m);
  const boss = req.ws.boss_person_id ? await one('SELECT * FROM people WHERE id=?', req.ws.boss_person_id) : await one("SELECT * FROM people WHERE workspace_id=? AND relation='boss' AND active=1 ORDER BY id LIMIT 1", req.ws.id);
  const emails = people.filter(p => p.email).map(p => p.email);
  const sent = await all("SELECT * FROM sends WHERE meeting_id=? ORDER BY id DESC", m.id);
  res.send(await page(req, { title: 'Summary · ' + m.title, body: html`<p class="eyebrow"><a href="/calls/${m.id}">${m.title}</a></p><h1>Call summary</h1>
    <form method="post" action="/calls/${m.id}/send" class="card stack">${csrf(req)}
      <label>Summary <small>(edit anything before sending)</small><textarea name="body" rows="16" class="copy-src mono" maxlength="50000">${text}</textarea></label>
      <fieldset><legend>Send to</legend>
        ${people.map(p => html`<label class="check"><input type="checkbox" name="to" value="${p.email || ''}" ${p.email ? raw('checked') : raw('disabled')}> ${p.name}${p.email ? html` <span class="muted small">${p.email}</span>` : html` <span class="muted small">(no email saved)</span>`}</label>`)}
        ${boss && !people.some(p => Number(p.id) === Number(boss.id)) ? html`<label class="check"><input type="checkbox" name="to" value="${boss.email || ''}" ${boss.email ? '' : raw('disabled')}> ${boss.name} <span class="muted small">(your boss)</span></label>` : ''}
        <label>Others <small>(emails, commas between)</small><input name="extra" maxlength="1000"></label></fieldset>
      ${E.configured() ? '' : html`<p class="muted small">Email isn't set up yet, so “Send email” only saves it. Use “Open in my email” to send it from your own Outlook or Gmail.</p>`}<div class="actions wrap"><button class="btn primary" name="how" value="email">Send email</button>
        <a class="btn" href="${E.mailto({ to: emails, subject: `Summary: ${m.title}`, text })}">Open in my email</a>
        <button type="button" class="btn" data-copy>Copy for Teams</button><button class="btn" name="how" value="save">Just save it</button></div></form>
    ${sent.length ? html`<section class="card"><h2>Sent</h2><ul class="rows small">${sent.map(s => html`<li><span>${s.how} · ${s.to_text || ''}</span><span class="muted">${U.fmtDateTime(s.created_at)}</span></li>`)}</ul></section>` : ''}` }));
});
app.post('/calls/:id/send', async (req, res) => {
  A.adminOnly(req); const m = await getCall(req, req.params.id), body = String(req.body.body || '').slice(0, 50000);
  const to = [...new Set([].concat(req.body.to || []).concat(String(req.body.extra || '').split(/[,;\s]+/)).map(s => s.trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 50);
  await run('UPDATE meetings SET summary=? WHERE id=?', body, m.id);
  let how = 'saved';
  if (req.body.how === 'email') { if (!to.length) bad('Pick at least one person with an email.'); const r = await E.send({ to, subject: `Summary: ${m.title}`, text: body, replyTo: req.user.email }); how = r.ok ? 'emailed' : 'logged (email not set up)'; }
  await run('INSERT INTO sends(workspace_id,kind,to_text,subject,body,how,meeting_id,created_by) VALUES(?,?,?,?,?,?,?,?)', req.ws.id, 'summary', to.join(', '), `Summary: ${m.title}`, body, how, m.id, req.user.id);
  flash(res, how === 'emailed' ? `Summary emailed to ${to.length} ${to.length === 1 ? 'person' : 'people'}.` : how === 'saved' ? 'Summary saved.' : 'Email is not set up, so it was saved. Use "Open in my email" or Copy.');
  res.redirect(`/calls/${m.id}/summary`);
});
module.exports = { MKIND, summaryText };
