/**
 * routes/auth.js — signing up, signing in and out, password resets, team invitations, light/dark mode, notifications.
 *
 *   /signup   The very first account becomes the app owner (you) with your own workspace. After that, new managers can
 *             sign up only while you have sign-ups turned on (Knockout admin → Settings). Otherwise it's invite-only.
 *   /login    Email + password. 5 wrong tries in 15 minutes locks that email for 15 minutes. Every try is logged.
 *   /invite/:token   A team member you invited sets their name and password and lands on their own list.
 */
const A = require('../lib/app');
const { app, bare, page, csrf, flash, bad, notFound } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html } = U;
const E = require('../lib/email');

/** A connect code nobody else has. */
async function uniqueCode() { for (;;) { const c = A.newCode(); if (!(await one('SELECT 1 x FROM users WHERE connect_code=?', c))) return c; } }
const setting = async (k, d) => (await one('SELECT value FROM settings WHERE key=?', k))?.value ?? d;
const signupsOpen = async () => (await setting('signups_open', '0')) === '1';
const isFirst = async () => !(await one('SELECT 1 x FROM users LIMIT 1'));
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;
const nextUrl = n => typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !/[\r\n]/.test(n) ? n : '/';

app.get('/signup', async (req, res) => {
  if (req.user) return res.redirect('/');
  const first = await isFirst();
  if (!first && !(await signupsOpen())) return res.send(bare('Sign up', html`<section class="card"><h1>Knockout is invite-only right now</h1><p>Ask your manager for an invitation, or <a href="/login">sign in</a>.</p></section>`));
  res.send(bare('Sign up', html`<section class="card"><h1>${first ? 'Set up Knockout' : 'Create your Knockout'}</h1>
    <p class="muted">${first ? "You're the first person here, so this account is the app owner: it runs your workspace and the Knockout admin console." : 'Your own private workspace for your projects, people and calls.'}</p>
    <form method="post" action="/signup" class="stack">
      <label>Your name<input name="name" required maxlength="80" autocomplete="name"></label>
      <label>Work email<input type="email" name="email" required maxlength="200" autocomplete="email"></label>
      <label>Password <small>(10 characters or more)</small><input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
      <label>Workspace name <small>(your team)</small><input name="workspace" maxlength="80" placeholder="Platform Engineering"></label>
      <label class="check"><input type="checkbox" name="terms" value="1" required> I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy</a> notes.</label>
      <button class="btn primary">Create my account</button></form></section><p class="center muted">Have an account? <a href="/login">Sign in</a></p>`));
});
app.post('/signup', async (req, res) => {
  const first = await isFirst();
  if (!first && !(await signupsOpen())) A.deny('Sign-ups are closed.');
  const name = String(req.body.name || '').trim().slice(0, 80), email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!name) bad('Enter your name.'); if (!validEmail(email)) bad('Enter a real email.'); if (pw.length < 10) bad('Use a password of 10 characters or more.');
  if (req.body.terms !== '1') bad('Please agree to the Terms and Privacy notes.');
  if (await one('SELECT 1 x FROM users WHERE email=?', email)) bad('That email already has an account. Sign in instead.');
  const user = await tx(async () => {
    const ws = await run('INSERT INTO workspaces(name,plan) VALUES(?,?)', String(req.body.workspace || '').trim().slice(0, 80) || `${name.split(' ')[0]}'s team`, first ? 'pro' : (await setting('default_plan', 'pro')) === 'free' ? 'free' : 'pro');
    const u = await run('INSERT INTO users(email,name,pass_hash,workspace_id,platform_role,connect_code) VALUES(?,?,?,?,?,?)', email, name, U.hashPassword(pw), ws.id, first ? 'owner' : null, await uniqueCode());
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'admin')", u.id, ws.id);
    return one('SELECT * FROM users WHERE id=?', u.id);
  });
  await run('INSERT INTO audit(workspace_id,user_id,action,ip) VALUES(?,?,?,?)', user.workspace_id, user.id, first ? 'app owner account created' : 'signed up', req.ip);
  await A.startSession(req, res, user);
  flash(res, first ? "Welcome! Add your people first (People → Add people), then start knocking things out." : 'Welcome to Knockout!');
  res.redirect(first ? '/people/import' : '/');
});

// Sign-in throttle: 5 wrong passwords for one email (or 30 from one address) in 15 minutes → wait 15 minutes.
// Wrong passwords: 5 per email or 30 per address in about 15 minutes, then locked. Counted in the database,
// so every server sees the same count (lib/limits.js).
const L = require('../lib/limits'), LOCK_MS = 15 * 60e3;
const tooMany = async k => (await L.count('login:' + k, LOCK_MS)) >= (k.startsWith('ip:') ? 30 : 5);
const fail = k => L.hit('login:' + k, LOCK_MS);

app.get('/login', async (req, res) => {
  if (req.user) return res.redirect(nextUrl(req.query.next));
  if (await isFirst()) return res.redirect('/signup');
  res.send(bare('Sign in', html`<section class="card"><h1>Sign in</h1>
    <form method="post" action="/login" class="stack"><input type="hidden" name="next" value="${nextUrl(req.query.next)}">
      <label>Email<input type="email" name="email" required autocomplete="email" autofocus></label>
      <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn primary">Sign in</button></form>
    <p class="muted small"><a href="/forgot">Forgot your password?</a></p></section>
    ${await signupsOpen() ? html`<p class="center muted">New here? <a href="/signup">Create an account</a></p>` : ''}`));
});
app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), k = 'e:' + email, ki = 'ip:' + req.ip;
  const log = (ok, why, uid) => run('INSERT INTO login_log(email,user_id,ok,why,ip) VALUES(?,?,?,?,?)', email.slice(0, 200), uid || null, ok ? 1 : 0, why || null, req.ip);
  if (await tooMany(k) || await tooMany(ki)) { await log(false, 'locked'); bad('Too many tries. Wait 15 minutes, or reset your password.'); }
  const u = await one('SELECT * FROM users WHERE email=?', email);
  if (!u || !U.checkPassword(String(req.body.password || ''), u.pass_hash)) { await fail(k); await fail(ki); await log(false, u ? 'wrong password' : 'no account', u?.id); bad('That email and password do not match.'); }
  if (u.disabled_at) { await log(false, 'account turned off', u.id); bad('This account is turned off. Ask your manager or the Knockout owner.'); }
  await L.reset('login:' + k, LOCK_MS); await log(true, null, u.id);
  await A.startSession(req, res, u);
  res.redirect(nextUrl(req.body.next));
});
app.post('/logout', async (req, res) => { await A.endSession(req, res); res.redirect('/login'); });

app.get('/forgot', (req, res) => res.send(bare('Reset password', html`<section class="card"><h1>Reset your password</h1>
  <form method="post" action="/forgot" class="stack"><label>Email<input type="email" name="email" required></label><button class="btn primary">Email me a link</button></form></section>`)));
app.post('/forgot', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE email=? AND disabled_at IS NULL', String(req.body.email || '').trim().toLowerCase());
  if (u) {
    const t = U.token(32); await run('DELETE FROM password_resets WHERE user_id=?', u.id);
    await run('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)', U.sha256(t), u.id, Date.now() + 3600e3);
    await E.send({ to: u.email, subject: 'Reset your Knockout password', text: `Use this link to choose a new password (works once, for 1 hour):\n\n${A.baseUrl(req)}/reset/${t}\n\nIf you didn't ask, ignore this email.` });
  }
  res.send(bare('Check your email', html`<section class="card"><h1>Check your email</h1><p>If that email has an account, a reset link is on its way.</p><p><a href="/login">Back to sign in</a></p></section>`));
});
const resetRow = async t => { const r = await one('SELECT * FROM password_resets WHERE token_hash=?', U.sha256(String(t))); return r && !r.used_at && r.expires_at > Date.now() ? r : null; };
app.get('/reset/:token', async (req, res) => {
  if (!(await resetRow(req.params.token))) return res.send(bare('Link expired', html`<section class="card"><h1>That link expired</h1><p><a href="/forgot">Get a new one</a></p></section>`));
  res.send(bare('New password', html`<section class="card"><h1>Choose a new password</h1><form method="post" class="stack"><label>New password <small>(10+ characters)</small><input type="password" name="password" minlength="10" required autocomplete="new-password"></label><button class="btn primary">Save</button></form></section>`));
});
app.post('/reset/:token', async (req, res) => {
  const r = await resetRow(req.params.token); if (!r) bad('That link expired.');
  const pw = String(req.body.password || ''); if (pw.length < 10) bad('Use 10 characters or more.');
  await run('UPDATE users SET pass_hash=? WHERE id=?', U.hashPassword(pw), r.user_id); await run('UPDATE password_resets SET used_at=ko_now() WHERE token_hash=?', r.token_hash);
  await run('DELETE FROM sessions WHERE user_id=?', r.user_id);
  flash(res, 'Password saved. Sign in with it now.'); res.redirect('/login');
});

// ───────────── team invitations ─────────────
const inviteRow = async t => { const r = await one('SELECT i.*, w.name wsname FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=?', U.sha256(String(t))); return r && !r.used_at && r.expires_at > Date.now() ? r : null; };
app.get('/invite/:token', async (req, res) => {
  const r = await inviteRow(req.params.token);
  if (!r) return res.send(bare('Invitation', html`<section class="card"><h1>That invitation expired</h1><p>Ask your manager to send a new one.</p></section>`));
  const p = r.person_id ? await one('SELECT * FROM people WHERE id=?', r.person_id) : null;
  const existing = await one('SELECT 1 x FROM users WHERE email=?', r.email);
  res.send(bare('Join', html`<section class="card"><h1>Join ${r.wsname} on Knockout</h1>
    ${existing ? (req.user && String(req.user.email).toLowerCase() === String(r.email).toLowerCase() ? html`<form method="post" action="/invite/${req.params.token}/join">${csrf(req)}<p>Join as ${req.user.name}?</p><button class="btn primary">Join ${r.wsname}</button></form>`
      : html`<p>${r.email} already has a Knockout account. <a href="/login?next=${encodeURIComponent('/invite/' + req.params.token)}">Sign in</a> to join.</p>`) : html`<form method="post" class="stack">
      <label>Your name<input name="name" required maxlength="80" value="${p?.name || ''}"></label><p class="muted small">Email: ${r.email}</p>
      <label>Password <small>(10+ characters)</small><input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
      <label class="check"><input type="checkbox" name="terms" value="1" required> I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy</a> notes.</label>
      <button class="btn primary">Join</button></form>`}</section>`));
});
app.post('/invite/:token', async (req, res) => {
  const r = await inviteRow(req.params.token); if (!r) bad('That invitation expired.');
  if (await one('SELECT 1 x FROM users WHERE email=?', r.email)) bad('That email already has an account. Sign in to join.');
  const name = String(req.body.name || '').trim().slice(0, 80), pw = String(req.body.password || '');
  if (!name) bad('Enter your name.'); if (pw.length < 10) bad('Use 10 characters or more.'); if (req.body.terms !== '1') bad('Please agree to the Terms.');
  const u = await tx(async () => {
    const x = await run('INSERT INTO users(email,name,pass_hash,workspace_id,connect_code) VALUES(?,?,?,?,?)', r.email, name, U.hashPassword(pw), r.workspace_id, await uniqueCode());
    await run('INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,?)', x.id, r.workspace_id, r.role === 'admin' ? 'admin' : 'member');
    const own = await run('INSERT INTO workspaces(name,plan) VALUES(?,?)', `${name.split(' ')[0]}'s workspace`, 'pro');   // their own space, for their own team later
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'admin')", x.id, own.id);
    if (r.person_id) await run('UPDATE people SET user_id=?, email=COALESCE(email,?) WHERE id=? AND workspace_id=?', x.id, r.email, r.person_id, r.workspace_id);
    await run('UPDATE invites SET used_at=ko_now() WHERE token_hash=?', r.token_hash);
    return one('SELECT * FROM users WHERE id=?', x.id);
  });
  for (const m of await A.managers(r.workspace_id)) await A.notify(m.id, `${name} joined Knockout.`, r.person_id ? '/people/' + r.person_id : '/people');
  await A.startSession(req, res, u); flash(res, `Welcome, ${name.split(' ')[0]}! This is your list.`); res.redirect('/');
});

app.post('/invite/:token/join', async (req, res) => {
  A.loginRequired(req); const r = await inviteRow(req.params.token); if (!r) bad('That invitation expired.');
  if (String(req.user.email).toLowerCase() !== String(r.email).toLowerCase()) A.deny('This invitation is for a different email.');
  await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,?) ON CONFLICT(user_id, workspace_id) DO UPDATE SET status='active'", req.user.id, r.workspace_id, r.role === 'admin' ? 'admin' : 'member');
  if (r.person_id) await run('UPDATE people SET user_id=? WHERE id=? AND workspace_id=?', req.user.id, r.person_id, r.workspace_id);
  await run('UPDATE invites SET used_at=ko_now() WHERE token_hash=?', r.token_hash); await run('UPDATE users SET workspace_id=? WHERE id=?', r.workspace_id, req.user.id);
  for (const m of await A.managers(r.workspace_id)) await A.notify(m.id, `${req.user.name} joined.`, '/people');
  flash(res, `You joined ${r.wsname}. Switch workspaces from the name at the top.`); res.redirect('/');
});
app.post('/switch', async (req, res) => {
  A.loginRequired(req); const m = await one("SELECT * FROM memberships WHERE user_id=? AND workspace_id=? AND status='active'", req.user.id, req.body.ws); if (!m) A.deny();
  await run('UPDATE users SET workspace_id=? WHERE id=?', m.workspace_id, req.user.id); if (req.session.help_ws) await run('UPDATE sessions SET help_ws=NULL WHERE id=?', req.session.id);
  res.redirect('/');
});
app.post('/theme', async (req, res) => { A.loginRequired(req); await run('UPDATE users SET theme=? WHERE id=?', req.body.theme === 'dark' ? 'dark' : 'light', req.user.id); res.redirect(nextUrl(new URL(req.headers.referer || '/', 'http://x').pathname)); });

app.get('/notifications', async (req, res) => {
  A.loginRequired(req);
  const list = await all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', req.user.id);
  await run('UPDATE notifications SET read_at=ko_now() WHERE user_id=? AND read_at IS NULL', req.user.id);
  res.send(await page(req, { title: 'Notifications', body: html`<h1>Notifications</h1><section class="card">${list.length ? html`<ul class="rows">${list.map(n => html`<li class="${n.read_at ? '' : 'unread'}"><a href="${n.link || '#'}"><b>${n.text}</b><span>${U.fmtDateTime(n.created_at)}</span></a></li>`)}</ul>` : A.empty('Nothing yet.')}</section>` }));
});

const legal = (t, body) => (req, res) => res.send(bare(t, html`<section class="card prose"><h1>${t}</h1>${body}</section>`));
app.get('/terms', legal('Terms', html`<p>Knockout is provided as-is, without warranties. You are responsible for what you and your team put in it and for following your company's rules about work information. Don't store passwords, payment cards or health records in Knockout. The owner may pause or close accounts that misuse the service. Fees, if any, are shown before you pay and are not refundable unless required by law.</p>`));
app.get('/privacy', legal('Privacy', html`<p>Your workspace's items, people, notes and recordings are visible only to your workspace (and to anyone you send an outside link). Knockout doesn't sell data or show ads. Passwords are stored only as secure hashes. You can export everything, or delete your workspace, at any time from Settings. Recordings are stored with your workspace and deleted when you delete them or the workspace.</p>`));

module.exports = { signupsOpen, setting, uniqueCode };
