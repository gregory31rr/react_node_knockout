/**
 * routes/training.js — certifications that expire, and the training people are taking.
 *
 *   /training     Expiring soon (next 90 days) and already expired, every certification by person, courses in progress
 *                 with % done, hours and target date (behind schedule is flagged), and a spreadsheet.
 *   Certs:        name, who issued it, earned, expires, "required for the job". You're told 90, 30 and 7 days before one
 *                 expires (notification + Today), so renewals never sneak up on you.
 *   Training:     a course for someone (provider, total hours, start, target date). They (or you) log progress: hours,
 *                 % done and a note. Finishing a course can add the certification it leads to.
 *   Team members with an account see and update their own certs and training.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');
const V = require('../lib/views');

const TST = { planned: 'Planned', in_progress: 'In progress', completed: 'Completed', dropped: 'Dropped' };
function certState(c) {
  if (!c.expires_on) return ['No expiry', ''];
  const d = U.daysBetween(U.today(), c.expires_on);
  return d < 0 ? [`Expired ${-d} day${d === -1 ? '' : 's'} ago`, 'late'] : d <= 30 ? [`Expires in ${d} day${d === 1 ? '' : 's'}`, 'late'] : d <= 90 ? [`Expires in ${d} days`, 'warn'] : [`Valid to ${U.fmtDate(c.expires_on)}`, 'ok'];
}
/** Is a course behind? Compare % done with % of the time between start and target that has passed. */
function behind(t) {
  if (t.status !== 'in_progress' || !t.target_on) return false;
  const start = t.started_on || String(t.created_at).slice(0, 10), total = Math.max(1, U.daysBetween(start, t.target_on)), gone = U.daysBetween(start, U.today());
  return U.today() > t.target_on || Number(t.progress) + 10 < Math.round(gone / total * 100);
}
const canSeePerson = (req, pid) => req.admin || Number(req.me?.id) === Number(pid);

app.get('/training', async (req, res) => {
  A.wsRequired(req);
  const mine = !req.admin, pid = mine ? (req.me?.id || -1) : Number(req.query.person) || 0;
  const filt = pid ? ' AND c.person_id=?' : '', args = pid ? [req.ws.id, pid] : [req.ws.id];
  const certs = await all(`SELECT c.*, p.name person_name, p.role FROM certs c JOIN people p ON p.id=c.person_id WHERE c.workspace_id=?${filt} ORDER BY c.expires_on IS NULL, c.expires_on, p.name`, ...args);
  const courses = await all(`SELECT t.*, p.name person_name, p.role, (SELECT COALESCE(sum(hours),0) FROM training_logs l WHERE l.training_id=t.id) logged FROM trainings t JOIN people p ON p.id=t.person_id WHERE t.workspace_id=?${filt.replace('c.', 't.')} ORDER BY t.status='completed', t.status='dropped', t.target_on IS NULL, t.target_on`, ...args);
  const soon = certs.filter(c => c.expires_on && c.expires_on <= U.addDays(U.today(), 90));
  const people = req.admin ? await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id) : [];
  const active = courses.filter(t => t.status === 'in_progress'), late = active.filter(behind);
  const certForm = html`<form method="post" action="/training/certs" class="stack">${csrf(req)}
      ${req.admin ? html`<label>Who<select name="person_id" required>${V.peopleOptions(people, pid, 'Pick someone')}</select></label>` : html`<input type="hidden" name="person_id" value="${req.me?.id || ''}">`}
      <label>Certification or license<input name="name" required maxlength="120" placeholder="AWS Solutions Architect, PMP, CDL…"></label>
      <div class="two"><label>Issued by<input name="issuer" maxlength="80"></label><label class="check"><input type="checkbox" name="required" value="1"> Required for the job</label></div>
      <div class="two"><label>Earned<input type="date" name="earned_on"></label><label>Expires<input type="date" name="expires_on"></label></div><button class="btn">Add certification</button></form>`;
  const courseForm = html`<form method="post" action="/training/courses" class="stack">${csrf(req)}
      ${req.admin ? html`<label>Who<select name="person_id" required>${V.peopleOptions(people, pid, 'Pick someone')}</select></label>` : html`<input type="hidden" name="person_id" value="${req.me?.id || ''}">`}
      <label>Course<input name="name" required maxlength="120" placeholder="Google Cloud Architect prep"></label>
      <div class="two"><label>Provider<input name="provider" maxlength="80" placeholder="Coursera, Udemy, in-house…"></label><label>Total hours<input name="hours_total" inputmode="decimal" maxlength="6"></label></div>
      <div class="two"><label>Start<input type="date" name="started_on" value="${U.today()}"></label><label>Finish by<input type="date" name="target_on"></label></div>
      <label>Leads to certification <small>(optional)</small><input name="cert_name" maxlength="120"></label><button class="btn">Add course</button></form>`;
  res.send(await page(req, { title: 'Certs & training', wide: true, body: html`${req.admin ? html`<p class="eyebrow"><a href="/people">People</a></p>` : ''}
    <div class="head"><div><h1>${mine ? 'My certs & training' : 'Certs & training'}</h1><p class="muted">Know before a certification lapses, and see who's learning what.</p></div>${req.admin ? html`<a class="btn" href="/training.csv">Spreadsheet</a>` : ''}</div>
    <div class="score"><div class="stat ${soon.some(c => c.expires_on < U.addDays(U.today(), 31)) ? 'hot' : ''}"><b>${soon.length}</b><span>expired or expiring in 90 days</span></div><div class="stat"><b>${certs.length}</b><span>certifications</span></div>
      <div class="stat"><b>${active.length}</b><span>courses in progress</span></div><div class="stat ${late.length ? 'hot' : ''}"><b>${late.length}</b><span>behind schedule</span></div></div>
    ${req.admin && people.length ? html`<form method="get" class="filters card"><label>Person<select name="person" data-autosubmit><option value="">Everyone</option>${people.map(p => html`<option value="${p.id}" ${pid === Number(p.id) ? raw('selected') : ''}>${p.name}</option>`)}</select></label><button class="btn">Show</button></form>` : ''}
    <div class="cols"><div>
      ${soon.length ? html`<section class="card hot"><h2>Renew soon</h2><ul class="rows">${soon.map(c => certRow(req, c))}</ul></section>` : ''}
      <section class="card"><h2>Training <span class="count">${active.length} in progress</span></h2>${courses.length ? html`<ul class="rows stack-rows">${courses.map(t => courseRow(req, t))}</ul>` : A.empty('No courses yet.')}</section>
      <section class="card"><h2>All certifications</h2>${certs.length ? html`<ul class="rows">${certs.map(c => certRow(req, c))}</ul>` : A.empty('None yet.')}</section>
    </div><div>
      <section class="card"><h2>Add a certification</h2>${certForm}</section><section class="card"><h2>Add a course</h2>${courseForm}</section>
    </div></div>` }));
});
function certRow(req, c) {
  const [txt, tone] = certState(c);
  return html`<li><span><b>${c.name}</b>${Number(c.required) ? html` ${A.badge('Required', 'warn')}` : ''}
      <small class="block muted">${req.admin ? html`<a href="/people/${c.person_id}">${c.person_name}</a> · ` : ''}${c.issuer ? c.issuer + ' · ' : ''}${c.earned_on ? 'earned ' + U.fmtDate(c.earned_on) : ''}</small></span>
    <span class="actions"><span class="chip ${tone}">${txt}</span>
      <details class="menu-inline"><summary class="btn sm">Update</summary><div><form method="post" action="/training/certs/${c.id}" class="stack">${csrf(req)}
        <label>Renewed — new expiry<input type="date" name="expires_on" value="${c.expires_on || ''}"></label><label>Earned<input type="date" name="earned_on" value="${c.earned_on || ''}"></label><button class="btn sm primary" name="act" value="save">Save</button></form>
        <form method="post" action="/training/certs/${c.id}" data-confirm="Remove ${c.name}?">${csrf(req)}<button class="link small red-text" name="act" value="delete">Remove</button></form></div></details></span></li>`;
}
function courseRow(req, t) {
  const late = behind(t), done = t.status === 'completed';
  return html`<li><span class="grow"><b>${t.name}</b> ${A.badge(TST[t.status], done ? 'ok' : late ? 'warn' : '')}${late ? html` ${A.badge('Behind schedule', 'warn')}` : ''}
      <small class="block muted">${req.admin ? html`<a href="/people/${t.person_id}">${t.person_name}</a> · ` : ''}${t.provider ? t.provider + ' · ' : ''}${t.target_on ? (done ? 'finished ' + U.fmtDate(t.completed_on) : 'finish by ' + U.fmtDate(t.target_on)) : ''}${Number(t.logged) ? ` · ${A.hoursText(t.logged)}${t.hours_total ? ' of ' + A.hoursText(t.hours_total) : ''} logged` : ''}${t.cert_name ? ' · leads to ' + t.cert_name : ''}</small>
      ${V.bar(Number(t.progress), t.progress + '% done')}<small class="muted">${t.progress}% done</small></span>
    ${!done && t.status !== 'dropped' ? html`<details class="menu-inline"><summary class="btn sm">Log progress</summary><div><form method="post" action="/training/courses/${t.id}/log" class="stack">${csrf(req)}
      <div class="two"><label>Hours<input name="hours" inputmode="decimal" maxlength="6" placeholder="1.5"></label><label>% done now<input name="progress" type="number" min="0" max="100" value="${t.progress}"></label></div>
      <label>Note<input name="note" maxlength="200" placeholder="Finished module 3"></label><button class="btn sm primary">Save</button></form>
      <form method="post" action="/training/courses/${t.id}/log">${csrf(req)}<input type="hidden" name="progress" value="100"><input type="hidden" name="done" value="1"><button class="btn sm">🥊 Completed${t.cert_name ? ' (add the cert)' : ''}</button></form>
      ${req.admin ? html`<form method="post" action="/training/courses/${t.id}/log">${csrf(req)}<input type="hidden" name="drop" value="1"><button class="link small">Mark dropped</button></form>` : ''}</div></details>` : ''}</li>`;
}
async function personFor(req, id) {
  const p = await W.personIn(req.ws.id, id); if (!p) bad('Pick who.');
  if (!canSeePerson(req, p.id)) A.deny(); return p;
}
app.post('/training/certs', async (req, res) => {
  A.wsRequired(req); const p = await personFor(req, req.body.person_id), b = req.body, name = String(b.name || '').trim().slice(0, 120); if (!name) bad('Name the certification.');
  await run('INSERT INTO certs(workspace_id,person_id,name,issuer,earned_on,expires_on,required) VALUES(?,?,?,?,?,?,?)', req.ws.id, p.id, name, String(b.issuer || '').trim().slice(0, 80) || null, U.isDate(b.earned_on) ? b.earned_on : null, U.isDate(b.expires_on) ? b.expires_on : null, b.required === '1' ? 1 : 0);
  flash(res, 'Certification added.'); res.redirect(b.back === 'person' && req.admin ? `/people/${p.id}#growth` : '/training');
});
app.post('/training/certs/:id', async (req, res) => {
  A.wsRequired(req); const c = await one('SELECT * FROM certs WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound(); if (!canSeePerson(req, c.person_id)) A.deny();
  if (req.body.act === 'delete') await run('DELETE FROM certs WHERE id=?', c.id);
  else await run('UPDATE certs SET expires_on=?, earned_on=?, warned=CASE WHEN ? <> COALESCE(expires_on, \'\') THEN NULL ELSE warned END WHERE id=?', U.isDate(req.body.expires_on) ? req.body.expires_on : null, U.isDate(req.body.earned_on) ? req.body.earned_on : c.earned_on, req.body.expires_on || '', c.id);
  flash(res, 'Saved.'); res.redirect('/training');
});
app.post('/training/courses', async (req, res) => {
  A.wsRequired(req); const p = await personFor(req, req.body.person_id), b = req.body, name = String(b.name || '').trim().slice(0, 120); if (!name) bad('Name the course.');
  await run('INSERT INTO trainings(workspace_id,person_id,name,provider,hours_total,started_on,target_on,cert_name,status) VALUES(?,?,?,?,?,?,?,?,?)', req.ws.id, p.id, name, String(b.provider || '').trim().slice(0, 80) || null, W.num(b.hours_total, 0, 5000),
    U.isDate(b.started_on) ? b.started_on : U.today(), U.isDate(b.target_on) ? b.target_on : null, String(b.cert_name || '').trim().slice(0, 120) || null, U.isDate(b.started_on) && b.started_on > U.today() ? 'planned' : 'in_progress');
  if (p.user_id && Number(p.user_id) !== Number(req.user.id)) await A.notify(p.user_id, `${req.user.name} added a course for you: ${name}`, '/training', 'training');
  flash(res, 'Course added.'); res.redirect(b.back === 'person' && req.admin ? `/people/${p.id}#growth` : '/training');
});
app.post('/training/courses/:id/log', async (req, res) => {
  A.wsRequired(req); const t = await one('SELECT * FROM trainings WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound(); if (!canSeePerson(req, t.person_id)) A.deny();
  const b = req.body;
  if (b.drop === '1') { if (!req.admin) A.deny(); await run("UPDATE trainings SET status='dropped' WHERE id=?", t.id); flash(res, 'Marked dropped.'); return res.redirect('/training'); }
  const h = b.hours ? W.loeHours(b.hours) : null, pct = b.progress !== undefined && b.progress !== '' ? Math.max(0, Math.min(100, Math.round(Number(b.progress) || 0))) : null;
  if (!h && pct == null && !b.note) bad('Add hours, % done or a note.');
  await run('INSERT INTO training_logs(training_id,hours,progress,note,who,on_day) VALUES(?,?,?,?,?,?)', t.id, h, pct, String(b.note || '').slice(0, 200) || null, req.user.name, U.today());
  const done = b.done === '1' || pct === 100;
  await run("UPDATE trainings SET progress=COALESCE(?, progress), status=CASE WHEN ? THEN 'completed' WHEN status='planned' THEN 'in_progress' ELSE status END, completed_on=CASE WHEN ? THEN ? ELSE completed_on END WHERE id=?", pct, done ? 1 : 0, done ? 1 : 0, U.today(), t.id);
  if (done && t.cert_name && !(await one('SELECT 1 x FROM certs WHERE person_id=? AND name=?', t.person_id, t.cert_name))) await run('INSERT INTO certs(workspace_id,person_id,name,issuer,earned_on) VALUES(?,?,?,?,?)', req.ws.id, t.person_id, t.cert_name, t.provider, U.today());
  if (!req.admin) for (const m of await A.managers(req.ws.id)) await A.notify(m.id, `${req.user.name} ${done ? 'completed' : 'logged progress on'}: ${t.name}${pct != null && !done ? ` (${pct}%)` : ''}`, '/training', 'training');
  flash(res, done ? `🥊 ${t.name} completed${t.cert_name ? ' and ' + t.cert_name + ' added' : ''}.` : 'Progress saved.'); res.redirect('/training');
});
app.get('/training.csv', async (req, res) => {
  A.adminOnly(req);
  const c = await all('SELECT c.*, p.name pn FROM certs c JOIN people p ON p.id=c.person_id WHERE c.workspace_id=? ORDER BY p.name', req.ws.id), t = await all('SELECT t.*, p.name pn FROM trainings t JOIN people p ON p.id=t.person_id WHERE t.workspace_id=? ORDER BY p.name', req.ws.id);
  res.setHeader('Content-Disposition', `attachment; filename="knockout-certs-training-${U.today()}.csv"`);
  res.send(U.toCSV([['Person', 'Type', 'Name', 'Issuer / provider', 'Earned / started', 'Expires / finish by', 'Status', '% done', 'Required'],
    ...c.map(x => [x.pn, 'Certification', x.name, x.issuer || '', x.earned_on || '', x.expires_on || '', certState(x)[0], '', Number(x.required) ? 'yes' : '']),
    ...t.map(x => [x.pn, 'Training', x.name, x.provider || '', x.started_on || '', x.target_on || '', TST[x.status], x.progress, ''])]), 200, 'text/csv; charset=utf-8');
});
/** Daily: warn managers (and the person) 90, 30 and 7 days before a certification expires, and the day it lapses. */
async function certWarnings() {
  const rows = await all("SELECT c.*, p.name pn, p.user_id FROM certs c JOIN people p ON p.id=c.person_id WHERE c.expires_on IS NOT NULL AND c.expires_on <= ? AND p.active=1", U.addDays(U.today(), 90));
  for (const c of rows) {
    const d = U.daysBetween(U.today(), c.expires_on), step = d < 0 ? 'expired' : d <= 7 ? '7' : d <= 30 ? '30' : '90';
    if (c.warned === step) continue;
    const text = d < 0 ? `⚠ ${c.pn}'s ${c.name} has expired` : `📜 ${c.pn}'s ${c.name} expires in ${d} day${d === 1 ? '' : 's'} (${U.fmtDate(c.expires_on)})`;
    for (const m of await A.managers(c.workspace_id)) await A.notify(m.id, text, '/training', 'training');
    if (c.user_id) await A.notify(c.user_id, d < 0 ? `⚠ Your ${c.name} has expired` : `📜 Your ${c.name} expires in ${d} days`, '/training', 'training');
    await run('UPDATE certs SET warned=? WHERE id=?', step, c.id);
  }
}
module.exports = { certWarnings, certState, behind };
