/**
 * routes/notes.js — your sticky notes and reminders (private to you), so the paper ones stop getting lost.
 *
 *   /notes   Sticky notes: jot anything, pick a color, pin the important ones, tie a note to a person or project
 *            (it shows on their page), turn a note into an item with one tap, archive when done.
 *            Reminders: "Call the vendor back" at 3pm Thursday, or every Monday at 9. When one comes due it shows
 *            on Today and in your notifications. Done, snooze a day, or delete.
 *   Quick add also understands "remind me tomorrow 9am to call Dana".
 *   Don't keep passwords here: use your company's password manager. Knockout warns you if a note looks like one.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');
const V = require('../lib/views');

const COLORS = ['yellow', 'blue', 'green', 'purple', 'teal'];
const REPEAT = { none: 'Once', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
const looksLikePassword = t => /\b(password|passwd|pwd|passcode|pin)\b\s*[:=]|\b(api[_ -]?key|secret|token)\s*[:=]/i.test(t);
/** "YYYY-MM-DD" + "14:30" (in the browser's time) → UTC text. The browser sends its offset in minutes. */
function toUtc(day, time, offsetMin) {
  if (!U.isDate(day)) return null; const tm = /^\d{2}:\d{2}$/.test(time || '') ? time : '09:00';
  const d = new Date(`${day}T${tm}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + (Number(offsetMin) || 0));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
const localParts = (utc, offsetMin) => { const d = new Date(utc.replace(' ', 'T') + 'Z'); d.setUTCMinutes(d.getUTCMinutes() - (Number(offsetMin) || 0)); const s = d.toISOString(); return { day: s.slice(0, 10), time: s.slice(11, 16) }; };
function nextTime(utc, repeat) {
  const d = new Date(utc.replace(' ', 'T') + 'Z'), now = Date.now();
  do {
    if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (repeat === 'weekdays') { do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay())); }
    else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else return null;
  } while (d.getTime() < now);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
const fmtWhen = r => U.fmtDateTime(r.remind_at);

app.get('/notes', async (req, res) => {
  A.wsRequired(req);
  const showArch = req.query.show === 'archived';
  const notes = await all(`SELECT n.*, p.name pname, pr.name prname, pr.tag FROM notes n LEFT JOIN people p ON p.id=n.person_id LEFT JOIN projects pr ON pr.id=n.project_id WHERE n.user_id=? AND n.workspace_id=? AND n.archived=? ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 300`, req.user.id, req.ws.id, showArch ? 1 : 0);
  const rem = await all('SELECT r.*, p.name pname FROM reminders r LEFT JOIN people p ON p.id=r.person_id WHERE r.user_id=? AND r.workspace_id=? AND r.done_at IS NULL ORDER BY r.remind_at LIMIT 200', req.user.id, req.ws.id);
  const L = await W.lookups(req.ws.id), now = U.nowSql();
  const opts = (list, sel, none, lab = x => x.name) => html`<option value="">${none}</option>${list.map(x => html`<option value="${x.id}" ${Number(sel) === Number(x.id) ? raw('selected') : ''}>${lab(x)}</option>`)}`;
  res.send(await page(req, { title: 'Notes', wide: true, body: html`<div class="head"><div><h1>Notes & reminders</h1><p class="muted">Private to you. Pin what matters; tie notes to a person or project.</p></div></div>
    <div class="cols"><div>
      <section class="card"><form method="post" action="/notes" class="stack note-new">${csrf(req)}
        <label class="sr" for="nt">New note</label><textarea id="nt" name="text" rows="3" maxlength="5000" required placeholder="Jot it down…"></textarea>
        <div class="inline-row"><div class="colors" role="radiogroup" aria-label="Color">${COLORS.map((c, k) => html`<label class="sw sw-${c}"><input type="radio" name="color" value="${c}" ${k === 0 ? raw('checked') : ''}><span class="sr">${c}</span></label>`)}</div>
          <label class="grow">Person<select name="person_id">${opts(L.people, null, 'Nobody')}</select></label><label class="grow">Project<select name="project_id">${opts(L.projects, null, 'None', p => p.name)}</select></label>
          <label class="check"><input type="checkbox" name="pinned" value="1"> Pin</label><button class="btn primary">Add note</button></div>
        <p class="muted small">Don't keep passwords here. Use your company's password manager and note where to find it.</p></form></section>
      <nav class="seg"><a href="/notes" ${showArch ? '' : raw('aria-current="page"')}>Notes</a><a href="/notes?show=archived" ${showArch ? raw('aria-current="page"') : ''}>Archived</a></nav>
      ${notes.length ? html`<div class="notes-grid">${notes.map(n => html`<article class="sticky sw-${COLORS.includes(n.color) ? n.color : 'yellow'} ${Number(n.pinned) ? 'pinned' : ''}">
        ${Number(n.pinned) ? html`<span class="pin" title="Pinned">📌</span>` : ''}
        <p class="pre">${n.text}</p>${looksLikePassword(n.text) ? html`<p class="warn-note">⚠ This looks like a password. Move it to your password manager and delete it here.</p>` : ''}
        <p class="small muted">${n.pname ? html`<a href="/people/${n.person_id}">@${n.pname.split(' ')[0]}</a> · ` : ''}${n.tag ? html`<a href="/projects/${n.project_id}">#${n.tag}</a> · ` : ''}${U.fmtDate(n.updated_at)}</p>
        <div class="actions">
          <form method="post" action="/notes/${n.id}/item">${csrf(req)}<button class="btn sm" title="Turn into a task">→ Item</button></form>
          <form method="post" action="/notes/${n.id}/${Number(n.pinned) ? 'unpin' : 'pin'}">${csrf(req)}<button class="btn sm">${Number(n.pinned) ? 'Unpin' : 'Pin'}</button></form>
          <form method="post" action="/notes/${n.id}/${n.archived ? 'restore' : 'archive'}">${csrf(req)}<button class="btn sm">${n.archived ? 'Restore' : 'Archive'}</button></form>
          <details class="note-edit"><summary class="btn sm">Edit</summary><form method="post" action="/notes/${n.id}/edit" class="stack">${csrf(req)}<textarea name="text" rows="4" maxlength="5000" required>${n.text}</textarea><button class="btn sm primary">Save</button></form>
            <form method="post" action="/notes/${n.id}/delete" data-confirm="Delete this note?">${csrf(req)}<button class="link small red-text">Delete</button></form></details></div></article>`)}</div>`
        : html`<section class="card">${A.empty(showArch ? 'Nothing archived.' : 'No notes yet. Throw away the paper ones.')}</section>`}
    </div><div>
      <section class="card" id="reminders"><h2>Reminders</h2>
        <form method="post" action="/reminders" class="stack" data-tz>${csrf(req)}<input type="hidden" name="tz" value="0">
          <label>Remind me to<input name="text" required maxlength="300" placeholder="Call the vendor back"></label>
          <div class="two"><label>Day<input type="date" name="day" value="${U.today()}" required></label><label>Time<input type="time" name="time" value="09:00"></label></div>
          <div class="two"><label>Repeat<select name="repeat">${Object.entries(REPEAT).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label><label>About<select name="person_id">${opts(L.people, null, 'Nobody')}</select></label></div>
          <button class="btn primary">Add reminder</button></form>
        ${rem.length ? html`<ul class="rows">${rem.map(r => html`<li class="${r.remind_at <= now ? 'due' : ''}"><span><b>${r.remind_at <= now ? '🔔 ' : ''}${r.text}</b><small class="block muted"><span data-utc="${r.remind_at}">${fmtWhen(r)}</span>${r.repeat !== 'none' ? ' · ' + REPEAT[r.repeat] : ''}${r.pname ? ' · ' + r.pname : ''}</small></span>
          <div class="actions"><form method="post" action="/reminders/${r.id}/done">${csrf(req)}<button class="btn sm primary">Done</button></form><form method="post" action="/reminders/${r.id}/snooze">${csrf(req)}<button class="btn sm">Tomorrow</button></form>
            <form method="post" action="/reminders/${r.id}/delete">${csrf(req)}<button class="link small" aria-label="Delete reminder">✕</button></form></div></li>`)}</ul>` : html`<p class="muted small">No reminders.</p>`}</section>
    </div></div>` }));
});
async function myNote(req) { return (await one('SELECT * FROM notes WHERE id=? AND user_id=? AND workspace_id=?', req.params.id, req.user.id, req.ws.id)) || notFound(); }
app.post('/notes', async (req, res) => {
  A.wsRequired(req); const text = String(req.body.text || '').trim().slice(0, 5000); if (!text) bad('Write something.');
  const person = await W.personIn(req.ws.id, req.body.person_id), project = await W.projectIn(req.ws.id, req.body.project_id);
  await run('INSERT INTO notes(workspace_id,user_id,text,color,pinned,person_id,project_id) VALUES(?,?,?,?,?,?,?)', req.ws.id, req.user.id, text, COLORS.includes(req.body.color) ? req.body.color : 'yellow', req.body.pinned === '1' ? 1 : 0, person?.id || null, project?.id || null);
  flash(res, looksLikePassword(text) ? '⚠ Saved, but that looks like a password. Please keep passwords in your password manager.' : 'Note added.', looksLikePassword(text) ? 'warn' : 'ok');
  res.redirect(String(req.body.back || '').startsWith('/people/') || String(req.body.back || '').startsWith('/projects/') ? req.body.back.replace(/[^\w/#-]/g, '') : '/notes');
});
app.post('/notes/:id/:act', async (req, res) => {
  A.wsRequired(req); const n = await myNote(req), act = req.params.act;
  if (act === 'pin' || act === 'unpin') await run('UPDATE notes SET pinned=? WHERE id=?', act === 'pin' ? 1 : 0, n.id);
  else if (act === 'archive' || act === 'restore') await run('UPDATE notes SET archived=? WHERE id=?', act === 'archive' ? 1 : 0, n.id);
  else if (act === 'edit') { const t = String(req.body.text || '').trim().slice(0, 5000); if (!t) bad('Write something.'); await run('UPDATE notes SET text=?, updated_at=ko_now() WHERE id=?', t, n.id); }
  else if (act === 'delete') await run('DELETE FROM notes WHERE id=?', n.id);
  else if (act === 'item') {
    const [first, ...rest] = n.text.split('\n'); const id = await W.createItem(req, { title: first.slice(0, 300), details: rest.join('\n').trim() || null, person_id: n.person_id, project_id: n.project_id, via: 'from a note' });
    await run('UPDATE notes SET archived=1 WHERE id=?', n.id); flash(res, 'Turned into an item. The note is archived.'); return res.redirect('/items/' + id);
  } else notFound();
  res.redirect('/notes' + (act === 'restore' ? '?show=archived' : ''));
});

// ───────────── reminders ─────────────
async function addReminder(req, { text, at, repeat = 'none', person_id }) {
  const person = await W.personIn(req.ws.id, person_id);
  return run('INSERT INTO reminders(workspace_id,user_id,text,remind_at,repeat,person_id) VALUES(?,?,?,?,?,?)', req.ws.id, req.user.id, String(text).slice(0, 300), at, REPEAT[repeat] ? repeat : 'none', person?.id || null);
}
app.post('/reminders', async (req, res) => {
  A.wsRequired(req); const text = String(req.body.text || '').trim(); if (!text) bad('What should we remind you about?');
  const at = toUtc(req.body.day, req.body.time, req.body.tz); if (!at) bad('Pick a day.');
  await addReminder(req, { text, at, repeat: req.body.repeat, person_id: req.body.person_id }); flash(res, 'Reminder set.'); res.redirect('/notes#reminders');
});
app.post('/reminders/:id/:act', async (req, res) => {
  A.wsRequired(req); const r = await one('SELECT * FROM reminders WHERE id=? AND user_id=?', req.params.id, req.user.id) || notFound(), act = req.params.act;
  if (act === 'done') { const next = nextTime(r.remind_at, r.repeat); if (next) await run('UPDATE reminders SET remind_at=?, notified_at=NULL WHERE id=?', next, r.id); else await run('UPDATE reminders SET done_at=ko_now() WHERE id=?', r.id); }
  else if (act === 'snooze') { const d = new Date(Math.max(Date.now(), new Date(r.remind_at.replace(' ', 'T') + 'Z').getTime())); d.setUTCDate(d.getUTCDate() + 1); await run('UPDATE reminders SET remind_at=?, notified_at=NULL WHERE id=?', d.toISOString().slice(0, 19).replace('T', ' '), r.id); }
  else if (act === 'delete') await run('DELETE FROM reminders WHERE id=?', r.id);
  else notFound();
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true });
  const back = String(req.body.back || ''); res.redirect(back === '/' ? '/' : '/notes#reminders');
});
/** Every minute: reminders that just came due become a notification (and, if email is set up, an email). */
async function dueReminders() {
  const rows = await all("SELECT r.*, u.email FROM reminders r JOIN users u ON u.id=r.user_id WHERE r.done_at IS NULL AND r.notified_at IS NULL AND r.remind_at <= ? LIMIT 500", U.nowSql());
  for (const r of rows) {
    await A.notify(r.user_id, '⏰ ' + r.text, '/notes#reminders'); await run('UPDATE reminders SET notified_at=ko_now() WHERE id=?', r.id);
    if (process.env.REMINDER_EMAILS === '1') await require('../lib/email').send({ to: r.email, subject: '⏰ ' + r.text, text: `Reminder from Knockout:\n\n${r.text}` });
  }
}
module.exports = { addReminder, dueReminders, toUtc, REPEAT, looksLikePassword };
