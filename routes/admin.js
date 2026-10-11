/**
 * routes/admin.js — the Knockout admin console for YOU, the app owner. Only platform_role='owner' gets in.
 *
 *   /admin              totals, sign-ups on/off, the plan new workspaces start on
 *   /admin/workspaces   every workspace: plan (free / paid), people, items, last activity; pause, resume, close,
 *                       change plan, delete for good (type its name)
 *   /admin/users        every account: turn off / on, send a password reset, delete for good
 *   /admin/signins      every sign-in attempt (who, when, from where, why it failed)
 *   /admin/log          the activity log (append-only: it can't be edited)
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const E = require('../lib/email');

const setSetting = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
const getSetting = async (k, d) => (await one('SELECT value FROM settings WHERE key=?', k))?.value ?? d;
const sub = cur => html`<nav class="seg">${[['/admin', 'Overview'], ['/admin/workspaces', 'Workspaces'], ['/admin/users', 'Accounts'], ['/admin/signins', 'Sign-ins'], ['/admin/log', 'Activity log']].map(([h, l]) => html`<a href="${h}" ${cur === h ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

app.get('/admin', async (req, res) => {
  A.ownerOnly(req);
  const n = await one(`SELECT (SELECT count(*) FROM workspaces) ws, (SELECT count(*) FROM workspaces WHERE status='active') ws_active, (SELECT count(*) FROM users) users,
      (SELECT count(*) FROM users WHERE last_seen_at >= ko_datetime('now','-7 days')) active7, (SELECT count(*) FROM items) items, (SELECT count(*) FROM items WHERE completed_at >= ko_datetime('now','-7 days')) ko7,
      (SELECT count(*) FROM people) people, (SELECT count(*) FROM meetings) calls, (SELECT count(*) FROM workspaces WHERE plan<>'free') paid`);
  const open = (await getSetting('signups_open', '0')) === '1', plan = await getSetting('default_plan', 'pro');
  const recent = await all("SELECT w.*, (SELECT count(*) FROM memberships mm WHERE mm.workspace_id=w.id) users FROM workspaces w ORDER BY w.id DESC LIMIT 8");
  res.send(await page(req, { title: 'Knockout admin', wide: true, body: html`<h1>Knockout admin</h1>${sub('/admin')}
    <div class="score"><div class="stat"><b>${n.ws}</b><span>workspaces (${n.ws_active} active)</span></div><div class="stat"><b>${n.paid}</b><span>on the paid plan</span></div>
      <div class="stat"><b>${n.users}</b><span>accounts</span></div><div class="stat"><b>${n.active7}</b><span>active in 7 days</span></div>
      <div class="stat"><b>${n.items}</b><span>items</span></div><div class="stat"><b>${n.ko7}</b><span>knocked out in 7 days</span></div></div>
    <div class="cols"><section class="card"><h2>Sign-ups</h2><form method="post" action="/admin/settings" class="stack">${csrf(req)}
      <label class="check"><input type="checkbox" name="signups_open" value="1" ${open ? raw('checked') : ''}> Anyone can sign up and make their own workspace</label>
      <p class="muted small">Off = invite-only: only people you or a manager invite can get in. Keep it off until you're ready.</p>
      <label>New workspaces start on<select name="default_plan"><option value="pro" ${plan === 'pro' ? raw('selected') : ''}>Paid features (early access)</option><option value="free" ${plan === 'free' ? raw('selected') : ''}>Free</option></select></label>
      <p class="muted small">Paid features today: outside links for people without an account. Billing isn't switched on yet; you set each workspace's plan by hand.</p>
      <button class="btn">Save</button></form></section>
      <section class="card"><h2>Newest workspaces</h2><ul class="rows">${recent.map(w => html`<li><a href="/admin/workspaces/${w.id}"><b>${w.name}</b><span>${w.users} account${Number(w.users) === 1 ? '' : 's'} · ${w.plan} · ${w.status} · ${U.fmtDate(w.created_at)}</span></a></li>`)}</ul></section></div>
    <section class="card"><h2>Setup check</h2><ul class="rows small">
      <li><span>Database</span><span>${require('../lib/db').dialect === 'pg' ? A.badge('PostgreSQL', 'ok') : A.badge('SQLite (local only)', 'warn')}</span></li>
      <li><span>Email (Resend)</span><span>${E.configured() ? A.badge('On', 'ok') : A.badge('Off: emails are logged; people use “Open in my email” and Copy')}</span></li>
      <li><span>Transcription</span><span>${process.env.TRANSCRIBE_API_KEY ? A.badge('On', 'ok') : A.badge('Off: recordings are kept without text')}</span></li>
      <li><span>Encryption key</span><span>${process.env.ENCRYPTION_KEY ? A.badge('Set', 'ok') : A.badge('Not set (fine on your computer, required live)', 'warn')}</span></li></ul></section>` }));
});
app.post('/admin/settings', async (req, res) => {
  A.ownerOnly(req); await setSetting('signups_open', req.body.signups_open === '1' ? '1' : '0'); await setSetting('default_plan', req.body.default_plan === 'free' ? 'free' : 'pro');
  await A.audit(req, 'owner settings', { signups_open: req.body.signups_open === '1', default_plan: req.body.default_plan }); flash(res, 'Saved.'); res.redirect('/admin');
});

app.get('/admin/workspaces', async (req, res) => {
  A.ownerOnly(req); const q = String(req.query.q || '').trim();
  const rows = await all(`SELECT w.*, (SELECT count(*) FROM memberships mm WHERE mm.workspace_id=w.id) users, (SELECT count(*) FROM people p WHERE p.workspace_id=w.id) people, (SELECT count(*) FROM items i WHERE i.workspace_id=w.id) items,
      (SELECT max(u.last_seen_at) FROM memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.workspace_id=w.id) seen, (SELECT u.email FROM memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.workspace_id=w.id AND mm.role='admin' ORDER BY mm.id LIMIT 1) mgr
    FROM workspaces w ${q ? "WHERE w.name ILIKE ? OR EXISTS(SELECT 1 FROM memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.workspace_id=w.id AND u.email ILIKE ?)" : ''} ORDER BY w.id DESC LIMIT 500`, ...(q ? ['%' + q + '%', '%' + q + '%'] : []));
  res.send(await page(req, { title: 'Workspaces', wide: true, body: html`<h1>Workspaces</h1>${sub('/admin/workspaces')}
    <form method="get" class="filters card"><label class="grow">Search<input name="q" value="${q}" placeholder="Workspace or email"></label><button class="btn">Search</button></form>
    <section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>Workspace</th><th>Manager</th><th class="n">Accounts</th><th class="n">People</th><th class="n">Items</th><th>Plan</th><th>Status</th><th>Last active</th></tr></thead><tbody>
      ${rows.map(w => html`<tr><td><a href="/admin/workspaces/${w.id}"><b>${w.name}</b></a><small class="block muted">#${w.id} · since ${U.fmtDate(w.created_at)}</small></td><td>${w.mgr || '—'}</td><td class="n">${w.users}</td><td class="n">${w.people}</td><td class="n">${w.items}</td>
        <td>${A.badge(w.plan === 'free' ? 'Free' : 'Paid', w.plan === 'free' ? '' : 'ok')}</td><td>${A.badge(w.status, w.status === 'active' ? 'ok' : 'warn')}</td><td>${w.seen ? U.fmtDate(w.seen) : '—'}</td></tr>`)}</tbody></table></div></section>` }));
});
app.get('/admin/workspaces/:id', async (req, res) => {
  A.ownerOnly(req); const w = await one('SELECT * FROM workspaces WHERE id=?', req.params.id) || notFound();
  const users = await all('SELECT u.*, m.role ws_role, m.status ms FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role, u.name', w.id);
  const n = await one('SELECT (SELECT count(*) FROM items WHERE workspace_id=?) items, (SELECT count(*) FROM items WHERE workspace_id=? AND status=\'done\') done, (SELECT count(*) FROM people WHERE workspace_id=?) people, (SELECT count(*) FROM projects WHERE workspace_id=?) projects, (SELECT count(*) FROM meetings WHERE workspace_id=?) calls', w.id, w.id, w.id, w.id, w.id);
  const mine = !!(await one("SELECT 1 x FROM memberships WHERE user_id=? AND workspace_id=? AND role='admin'", req.user.id, w.id));
  res.send(await page(req, { title: w.name, body: html`<p class="eyebrow"><a href="/admin/workspaces">Workspaces</a></p><h1>${w.name} ${A.badge(w.status, w.status === 'active' ? 'ok' : 'warn')}</h1>
    <p class="muted">${n.people} people · ${n.projects} projects · ${n.items} items (${n.done} knocked out) · ${n.calls} calls · since ${U.fmtDate(w.created_at)}</p>
    <form method="post" action="/admin/workspaces/${w.id}/help" class="card">${csrf(req)}<h2>Help them</h2><p class="muted small">Open this workspace with full manager controls to move, add, fix or delete anything. A yellow bar shows while you're in, and it's written in the activity log.</p><button class="btn primary">Open ${w.name}</button></form>
    <section class="card"><h2>Plan & status</h2><form method="post" action="/admin/workspaces/${w.id}" class="stack">${csrf(req)}
      <div class="two"><label>Plan<select name="plan"><option value="pro" ${w.plan !== 'free' ? raw('selected') : ''}>Paid</option><option value="free" ${w.plan === 'free' ? raw('selected') : ''}>Free</option></select></label>
        <label>Status<select name="status">${['active', 'paused', 'closed'].map(s => html`<option value="${s}" ${w.status === s ? raw('selected') : ''}>${{ active: 'Active', paused: 'Paused (read only)', closed: 'Closed (no access)' }[s]}</option>`)}</select></label></div>
      <label>Note <small>(only you see it)</small><input name="note" value="${w.note || ''}" maxlength="300"></label><button class="btn">Save</button></form></section>
    <section class="card"><h2>Accounts</h2><ul class="rows">${users.map(u => html`<li><span><b>${u.name}</b><small class="block muted">${u.email} · ${u.ws_role === 'admin' ? 'Manager' : 'Member'}${u.platform_role === 'owner' ? ' · app owner' : ''}${u.disabled_at ? ' · turned off' : ''} · last seen ${u.last_seen_at ? U.fmtDate(u.last_seen_at) : 'never'}</small></span><a class="btn sm" href="/admin/users?q=${encodeURIComponent(u.email)}">Manage</a></li>`)}</ul></section>
    ${mine ? '' : html`<section class="card danger-zone"><h2>Delete for good</h2><form method="post" action="/admin/workspaces/${w.id}/delete" class="stack">${csrf(req)}
      <p class="small">Deletes every item, person, project, call, recording and account in ${w.name}. The activity log keeps a line saying you did it. Can't be undone.</p>
      <label>Type <b>${w.name}</b> to confirm<input name="confirm" required autocomplete="off"></label><button class="btn danger">Delete ${w.name}</button></form></section>`}` }));
});
app.post('/admin/workspaces/:id', async (req, res) => {
  A.ownerOnly(req); const w = await one('SELECT * FROM workspaces WHERE id=?', req.params.id) || notFound();
  const status = ['active', 'paused', 'closed'].includes(req.body.status) ? req.body.status : w.status, plan = req.body.plan === 'free' ? 'free' : 'pro';
  if (await one("SELECT 1 x FROM memberships WHERE user_id=? AND workspace_id=? AND role='admin'", req.user.id, w.id) && status !== 'active') bad("You can't pause or close your own workspace.");
  await run("UPDATE workspaces SET plan=?, status=?, note=?, closed_at=CASE WHEN ?='closed' THEN COALESCE(closed_at, ko_now()) ELSE NULL END WHERE id=?", plan, status, String(req.body.note || '').slice(0, 300) || null, status, w.id);
  
  await A.audit(req, 'workspace updated', { id: w.id, plan, status }); flash(res, 'Saved.'); res.redirect('/admin/workspaces/' + w.id);
});
/** Remove a workspace and everything in it (recordings too). One line stays in the activity log. */
async function eraseWorkspace(id, req) {
  const w = await one('SELECT * FROM workspaces WHERE id=?', id); if (!w) return;
  // Recordings in file storage aren't removed by the database, so remove them first. If storage can't be
  // reached, stop here: nothing is deleted, and it can be tried again.
  try { await require('../lib/recordings').eraseWorkspace(id); }
  catch (e) { console.error('erase workspace: recordings:', e.message); throw new A.HttpError(503, `The workspace's call recordings couldn't be deleted from file storage (${e.message}) Nothing was deleted. Try again in a minute.`); }
  await tx(async () => {
    const ppl = (await all('SELECT user_id FROM memberships WHERE workspace_id=?', id)).map(r => r.user_id);
    await run('UPDATE users SET workspace_id=NULL WHERE workspace_id=?', id);
    await run('DELETE FROM workspaces WHERE id=?', id);   // memberships and everything else in the workspace go with it
    // accounts that now belong nowhere (and aren't the app owner) are removed too
    for (const uid of ppl) if (!(await one('SELECT 1 x FROM memberships WHERE user_id=?', uid))) await run('DELETE FROM users WHERE id=? AND platform_role IS NULL', uid);
  });
  await run('INSERT INTO audit(workspace_id,user_id,action,detail,ip) VALUES(NULL,?,?,?,?)', req.user.id, 'deleted a workspace for good', JSON.stringify({ id, name: w.name }), req.ip || null);
}
app.post('/admin/workspaces/:id/help', async (req, res) => {
  A.ownerOnly(req); const w = await one('SELECT * FROM workspaces WHERE id=?', req.params.id) || notFound();
  await run('UPDATE sessions SET help_ws=? WHERE id=?', w.id, req.session.id); await A.audit(req, 'owner opened a workspace to help', { id: w.id, name: w.name });
  flash(res, `You're in ${w.name} with full manager controls. It's logged.`); res.redirect('/');
});
app.post('/admin/help/stop', async (req, res) => { A.ownerOnly(req); await run('UPDATE sessions SET help_ws=NULL WHERE id=?', req.session.id); res.redirect('/admin/workspaces'); });
app.post('/admin/workspaces/:id/delete', async (req, res) => {
  A.ownerOnly(req); const w = await one('SELECT * FROM workspaces WHERE id=?', req.params.id) || notFound();
  if (await one("SELECT 1 x FROM memberships WHERE user_id=? AND workspace_id=? AND role='admin'", req.user.id, w.id)) bad("You can't delete your own workspace.");
  if (String(req.body.confirm || '').trim() !== w.name) bad(`Type the name exactly (${w.name}).`);
  await eraseWorkspace(w.id, req); flash(res, `${w.name} was deleted for good.`); res.redirect('/admin/workspaces');
});

app.get('/admin/users', async (req, res) => {
  A.ownerOnly(req); const q = String(req.query.q || '').trim();
  const rows = await all(`SELECT u.*, (SELECT string_agg(w2.name, ', ') FROM memberships m2 JOIN workspaces w2 ON w2.id=m2.workspace_id WHERE m2.user_id=u.id) wsname, CASE WHEN EXISTS(SELECT 1 FROM memberships m3 WHERE m3.user_id=u.id AND m3.role='admin') THEN 'admin' ELSE 'member' END ws_role FROM users u ${q ? 'WHERE u.email ILIKE ? OR u.name ILIKE ?' : ''} ORDER BY u.id DESC LIMIT 500`, ...(q ? ['%' + q + '%', '%' + q + '%'] : []));
  res.send(await page(req, { title: 'Accounts', wide: true, body: html`<h1>Accounts</h1>${sub('/admin/users')}
    <form method="get" class="filters card"><label class="grow">Search<input name="q" value="${q}" placeholder="Name or email"></label><button class="btn">Search</button></form>
    <section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>Account</th><th>Workspace</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(u => html`<tr><td><b>${u.name}</b><small class="block muted">${u.email}</small></td><td class="small">${u.wsname || '—'}</td><td>${u.platform_role === 'owner' ? 'App owner' : u.ws_role === 'admin' ? 'Manager' : 'Member'}</td>
        <td>${u.last_login_at ? U.fmtDateTime(u.last_login_at) : 'Never'}</td><td>${u.disabled_at ? A.badge('Off', 'warn') : A.badge('On', 'ok')}</td>
        <td>${u.platform_role === 'owner' ? '' : html`<details class="menu-inline"><summary class="btn sm">Manage ▾</summary><div class="stack-sm">
          <form method="post" action="/admin/users/${u.id}">${csrf(req)}<button class="btn sm" name="act" value="${u.disabled_at ? 'on' : 'off'}">${u.disabled_at ? 'Turn on' : 'Turn off'}</button></form>
          <form method="post" action="/admin/users/${u.id}">${csrf(req)}<button class="btn sm" name="act" value="reset">Email a password reset</button></form>
          <form method="post" action="/admin/users/${u.id}">${csrf(req)}<button class="btn sm" name="act" value="signout">Sign out everywhere</button></form>
          <form method="post" action="/admin/users/${u.id}" class="stack-sm">${csrf(req)}<input name="confirm" placeholder="Type DELETE" aria-label="Type DELETE to delete" autocomplete="off"><button class="btn sm danger" name="act" value="delete">Delete for good</button></form></div></details>`}</td></tr>`)}</tbody></table></div></section>` }));
});
app.post('/admin/users/:id', async (req, res) => {
  A.ownerOnly(req); const u = await one('SELECT * FROM users WHERE id=?', req.params.id) || notFound(); if (u.platform_role === 'owner') bad("The app owner's account can't be changed here.");
  const act = req.body.act; let msg;
  if (act === 'off') { await run("UPDATE users SET disabled_at=ko_now(), disabled_reason='turned off by Knockout' WHERE id=?", u.id); await run('DELETE FROM sessions WHERE user_id=?', u.id); msg = 'turned off'; }
  else if (act === 'on') { await run('UPDATE users SET disabled_at=NULL, disabled_reason=NULL WHERE id=?', u.id); msg = 'turned on'; }
  else if (act === 'signout') { await run('DELETE FROM sessions WHERE user_id=?', u.id); msg = 'signed out everywhere'; }
  else if (act === 'reset') { const t = U.token(32); await run('DELETE FROM password_resets WHERE user_id=?', u.id); await run('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)', U.sha256(t), u.id, Date.now() + 3600e3);
    const r = await E.send({ to: u.email, subject: 'Reset your Knockout password', text: `Knockout support sent you a link to choose a new password (works once, for 1 hour):\n\n${A.baseUrl(req)}/reset/${t}` }); msg = r.ok ? 'reset link emailed' : `email is off, so send them this link: ${A.baseUrl(req)}/reset/${t}`; }
  else if (act === 'delete') {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') bad('Type DELETE to confirm.');
    await tx(async () => { await run('UPDATE people SET user_id=NULL WHERE user_id=?', u.id); await run('DELETE FROM users WHERE id=?', u.id); });
    await A.audit(req, 'deleted an account for good', { id: u.id, email: u.email }); flash(res, `${u.email} was deleted.`); return res.redirect('/admin/users');
  } else bad('Pick an action.');
  await A.audit(req, 'account ' + act, { id: u.id, email: u.email }); flash(res, `${u.email}: ${msg}.`); res.redirect('/admin/users?q=' + encodeURIComponent(u.email));
});
app.get('/admin/signins', async (req, res) => {
  A.ownerOnly(req); const rows = await all('SELECT * FROM login_log ORDER BY id DESC LIMIT 300');
  res.send(await page(req, { title: 'Sign-ins', wide: true, body: html`<h1>Sign-ins</h1>${sub('/admin/signins')}<section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>When</th><th>Email</th><th>Result</th><th>Address</th></tr></thead><tbody>
    ${rows.map(r => html`<tr><td>${U.fmtDateTime(r.created_at)}</td><td>${r.email}</td><td>${Number(r.ok) ? A.badge('Signed in', 'ok') : A.badge(r.why || 'Failed', 'warn')}</td><td class="small">${r.ip || ''}</td></tr>`)}</tbody></table></div></section>` }));
});
app.get('/admin/log', async (req, res) => {
  A.ownerOnly(req); const rows = await all('SELECT a.*, u.email, w.name wsname FROM audit a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN workspaces w ON w.id=a.workspace_id ORDER BY a.id DESC LIMIT 500');
  res.send(await page(req, { title: 'Activity log', wide: true, body: html`<h1>Activity log</h1>${sub('/admin/log')}<p class="muted small">Append-only: nobody can edit or erase it.</p><section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>When</th><th>Who</th><th>Workspace</th><th>What</th><th>Details</th></tr></thead><tbody>
    ${rows.map(r => html`<tr><td class="nowrap">${U.fmtDateTime(r.created_at)}</td><td>${r.email || '—'}</td><td>${r.wsname || '—'}</td><td>${r.action}</td><td class="small mono">${String(r.detail || '').slice(0, 200)}</td></tr>`)}</tbody></table></div></section>` }));
});
module.exports = { eraseWorkspace, getSetting };
