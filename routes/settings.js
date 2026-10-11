/**
 * routes/settings.js — your workspace and your account.
 *
 *   /settings   Workspace: name, kind of team (technology, legal, delivery…), hours a day for project work, workdays.
 *               Team accounts: who can sign in, manager or member, turn an account off or on.
 *               Your account: name, email, password.
 *               Your data: download everything (JSON + spreadsheets), or delete the workspace for good.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const IND = require('../lib/industries');
const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];

app.get('/settings', async (req, res) => {
  A.wsRequired(req);
  const users = req.admin ? await all('SELECT u.id, u.name, u.email, u.last_login_at, m.role, m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role, u.name', req.ws.id) : [];
  let prefs = {}; try { prefs = JSON.parse(req.user.notify_prefs || '{}'); } catch { }
  const counts = req.admin ? await one('SELECT (SELECT count(*) FROM items WHERE workspace_id=?) items, (SELECT count(*) FROM people WHERE workspace_id=?) people, (SELECT count(*) FROM meetings WHERE workspace_id=?) calls', req.ws.id, req.ws.id, req.ws.id) : null;
  res.send(await page(req, { title: 'Settings', body: html`<h1>Settings</h1>
    ${req.admin ? html`<section class="card"><h2>Workspace</h2><form method="post" action="/settings/workspace" class="stack">${csrf(req)}
      <label>Name<input name="name" value="${req.ws.name}" required maxlength="80"></label>
      <label>Kind of team <small>(sets the roles you can give people)</small><select name="industry">${Object.entries(IND.INDUSTRIES).map(([k, v]) => html`<option value="${k}" ${req.ws.industry === k ? raw('selected') : ''}>${v.name}</option>`)}</select></label>
      <div class="two"><label>Hours a day for project work <small>(default for everyone)</small><input name="hours_per_day" value="${req.ws.hours_per_day}" inputmode="decimal" maxlength="4" required></label><span></span></div>
      <fieldset class="inline-checks"><legend>Workdays</legend>${DAYS.map(([d, l]) => html`<label class="check"><input type="checkbox" name="day" value="${d}" ${req.ws.workdays.includes(d) ? raw('checked') : ''}> ${l}</label>`)}</fieldset>
      <p class="muted small">Plan: <b>${req.ws.plan === 'free' ? 'Free' : 'Paid'}</b>${req.ws.plan === 'free' ? ' · outside links are part of the paid plan' : ''}</p>
      <button class="btn primary">Save</button></form></section>
    <section class="card"><h2>Who can open this workspace</h2><p class="muted small">People join when you connect with them (People → Connect by code) or invite them. Members see their own items; managers see everything.</p>
      <ul class="rows">${users.map(u => html`<li><span><b>${u.name}</b><small class="block muted">${u.email} · ${u.role === 'admin' ? 'Manager' : 'Member'}${u.status === 'blocked' ? ' · blocked' : ''}${u.last_login_at ? ' · last sign-in ' + U.fmtDate(u.last_login_at) : ''}</small></span>
        ${Number(u.id) !== Number(req.user.id) ? html`<div class="actions"><form method="post" action="/settings/users/${u.id}">${csrf(req)}<button class="btn sm" name="act" value="${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'Make member' : 'Make manager'}</button><button class="btn sm" name="act" value="${u.status === 'blocked' ? 'on' : 'off'}">${u.status === 'blocked' ? 'Let back in' : 'Block'}</button></form></div>` : html`<span class="muted small">You</span>`}</li>`)}</ul></section>` : ''}
    <section class="card"><h2>Your connect code</h2><p class="code-box">${req.user.connect_code || '—'}</p><p class="muted small">Share it with your manager, your team or peers. They enter it under People → Connect, pick how you're related, and you accept. No retyping anyone's details.</p><a class="btn" href="/connect">Connect with someone</a></section>
    <section class="card" id="notifications"><h2>Notifications</h2><p class="muted small">Pick what pops up in your 🔔. Connect requests and reminders always come through.</p>
      <form method="post" action="/settings/notifications" class="stack">${csrf(req)}<div class="pick-people">${Object.entries(A.NOTIFY_KINDS).map(([k, l]) => html`<label class="check"><input type="checkbox" name="on" value="${k}" ${prefs[k] === false ? '' : raw('checked')}> ${l}</label>`)}</div>
      <button class="btn">Save</button></form></section>
    <section class="card"><h2>Your account</h2><form method="post" action="/settings/me" class="stack">${csrf(req)}
      <div class="two"><label>Name<input name="name" value="${req.user.name}" required maxlength="80"></label><label>Email<input type="email" name="email" value="${req.user.email}" required maxlength="200"></label></div>
      <div class="two"><label>Current password <small>(to change email or password)</small><input type="password" name="current" autocomplete="current-password"></label><label>New password <small>(optional)</small><input type="password" name="password" minlength="10" autocomplete="new-password"></label></div>
      <button class="btn">Save</button></form>
      <form method="post" action="/settings/signout-all">${csrf(req)}<button class="link small">Sign out on every other device</button></form></section>
    ${req.admin ? html`<section class="card"><h2>Your data</h2><p class="muted small">${counts.items} items · ${counts.people} people · ${counts.calls} calls</p>
      <div class="actions wrap"><a class="btn" href="/settings/export">Download everything (JSON)</a><a class="btn" href="/items.csv?status=all">Items spreadsheet</a></div>
      <details class="danger-zone"><summary class="red-text">Delete this workspace for good</summary><form method="post" action="/settings/delete" class="stack">${csrf(req)}
        <p class="small">Deletes every item, person, project, call, recording and account in ${req.ws.name}. This can't be undone.</p>
        <label>Type <b>${req.ws.name}</b> to confirm<input name="confirm" required autocomplete="off"></label><button class="btn danger">Delete everything</button></form></details></section>` : ''}` }));
});
app.post('/settings/workspace', async (req, res) => {
  A.adminOnly(req); const b = req.body, name = String(b.name || '').trim().slice(0, 80); if (!name) bad('Name the workspace.');
  const hpd = Number(b.hours_per_day); if (!(hpd > 0 && hpd <= 24)) bad('Hours a day must be between 0 and 24.');
  const days = [].concat(b.day || []).filter(d => /^[1-7]$/.test(d)).sort().join('') || '12345';
  await run('UPDATE workspaces SET name=?, industry=?, hours_per_day=?, workdays=? WHERE id=?', name, IND.INDUSTRIES[b.industry] ? b.industry : 'technology', hpd, days, req.ws.id);
  flash(res, 'Saved.'); res.redirect('/settings');
});
app.post('/settings/users/:id', async (req, res) => {
  A.adminOnly(req); const u = await one('SELECT u.*, m.id mid FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.workspace_id=?', req.params.id, req.ws.id); if (!u || Number(u.id) === Number(req.user.id)) bad('Pick someone else.');
  const act = req.body.act;
  if (act === 'admin' || act === 'member') await run('UPDATE memberships SET role=? WHERE id=?', act, u.mid);
  else if (act === 'off') await run("UPDATE memberships SET status='blocked' WHERE id=?", u.mid);
  else if (act === 'on') await run("UPDATE memberships SET status='active' WHERE id=?", u.mid);
  else bad('Pick an action.');
  await A.audit(req, 'team account ' + act, { user: u.id }); flash(res, `${u.name}: done.`); res.redirect('/settings');
});
app.post('/settings/notifications', async (req, res) => {
  A.loginRequired(req); const on = new Set([].concat(req.body.on || []));
  await run('UPDATE users SET notify_prefs=? WHERE id=?', JSON.stringify(Object.fromEntries(Object.keys(A.NOTIFY_KINDS).map(k => [k, on.has(k)]))), req.user.id);
  flash(res, 'Notifications saved.'); res.redirect('/settings#notifications');
});
app.post('/settings/me', async (req, res) => {
  A.wsRequired(req); const b = req.body, name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase();
  if (!name) bad('Enter your name.'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a real email.');
  const sensitive = email !== String(req.user.email).toLowerCase() || b.password;
  if (sensitive && !U.checkPassword(String(b.current || ''), req.user.pass_hash)) bad('Enter your current password to change your email or password.');
  if (email !== String(req.user.email).toLowerCase() && await one('SELECT 1 x FROM users WHERE email=? AND id<>?', email, req.user.id)) bad('That email is used by another account.');
  if (b.password && String(b.password).length < 10) bad('Use 10 characters or more.');
  await run('UPDATE users SET name=?, email=? WHERE id=?', name, email, req.user.id);
  if (b.password) { await run('UPDATE users SET pass_hash=? WHERE id=?', U.hashPassword(String(b.password)), req.user.id); await run('DELETE FROM sessions WHERE user_id=? AND id<>?', req.user.id, req.session.id); }
  flash(res, 'Saved.'); res.redirect('/settings');
});
app.post('/settings/signout-all', async (req, res) => { A.loginRequired(req); await run('DELETE FROM sessions WHERE user_id=? AND id<>?', req.user.id, req.session.id); flash(res, 'Signed out everywhere else.'); res.redirect('/settings'); });
app.get('/settings/export', async (req, res) => {
  A.adminOnly(req); const w = req.ws.id, q = (t, extra = '') => all(`SELECT * FROM ${t} WHERE workspace_id=? ${extra}`, w);
  const out = { exported_at: new Date().toISOString(), workspace: req.ws, people: await q('people'), projects: await q('projects'), items: await q('items'), item_events: await q('item_events'), time_logs: await q('time_logs'),
    meetings: (await q('meetings')).map(m => ({ ...m, recording: m.recording ? '(audio file not included)' : null })), meeting_people: await all('SELECT mp.* FROM meeting_people mp JOIN meetings m ON m.id=mp.meeting_id WHERE m.workspace_id=?', w),
    goals: await q('goals'), sends: await q('sends'), links: (await q('links')).map(l => ({ ...l, token: '(hidden)' })) };
  await A.audit(req, 'exported data');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="knockout-${U.today()}.json"` }); res.end(JSON.stringify(out, null, 1));
});
app.post('/settings/delete', async (req, res) => {
  A.adminOnly(req); if (String(req.body.confirm || '').trim() !== req.ws.name) bad(`Type the workspace name exactly (${req.ws.name}).`);
  if (req.owner) bad("The app owner's own workspace can't be deleted here. Use Knockout admin.");
  await require('./admin').eraseWorkspace(req.ws.id, req);
  await A.endSession(req, res); res.redirect('/login');
});
