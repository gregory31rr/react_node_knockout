/**
 * routes/connect.js — connecting accounts with a code, like adding a friend.
 *
 *   Everyone who signs up gets their own workspace and a connect code (KO-XXXX-XXXX, in Settings and on this page).
 *   /connect   Enter someone's code (or the email they signed up with), pick how they relate to you — they report to
 *              me / peer / my boss — and optionally their role. They get a request and Accept or Decline (they can fix
 *              their role when they accept). Nobody retypes anyone's details.
 *   On accept  Each person appears in the other's People (manager ↔ report, peer ↔ peer), and each can open the other's
 *              workspace to see what involves them. The workspace name at the top switches between them, so people on
 *              several teams keep each team separate and don't get distracted.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run, tx } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;

const REL = { report: 'Reports to me (my team)', peer: 'A peer', boss: 'My boss / director' };
const THEIR_VIEW = { report: 'you report to them', peer: "you're peers", boss: "you're their boss" };
const INVERSE = { report: 'boss', boss: 'report', peer: 'peer' };
const first = n => String(n || '').split(' ')[0];

/** Put `user` into workspace `ws` as a person with this relation (link an existing record if there is one) and let them in. */
async function addToWorkspace(ws, user, relation, role) {
  let p = await one('SELECT * FROM people WHERE workspace_id=? AND user_id=?', ws, user.id)
    || await one("SELECT * FROM people WHERE workspace_id=? AND user_id IS NULL AND lower(email)=lower(?)", ws, user.email);
  if (p) await run('UPDATE people SET user_id=?, relation=?, role=COALESCE(?, role), active=1, email=COALESCE(email, ?) WHERE id=?', user.id, relation, role || null, user.email, p.id);
  else {
    const handle = await require('./people').uniqueHandle(ws, user.name);
    p = { id: (await run('INSERT INTO people(workspace_id,name,handle,email,relation,role,user_id) VALUES(?,?,?,?,?,?,?)', ws, user.name, handle, user.email, relation, role || null, user.id)).id };
  }
  if (relation === 'boss') await run('UPDATE workspaces SET boss_person_id=COALESCE(boss_person_id, ?) WHERE id=?', p.id, ws);
  await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'member') ON CONFLICT(user_id, workspace_id) DO UPDATE SET status='active'", user.id, ws);
  return p.id;
}
const adminWorkspaces = uid => all("SELECT w.* FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.role='admin' AND m.status='active' AND w.status='active' ORDER BY m.id", uid);

app.get('/connect', async (req, res) => {
  A.wsRequired(req);
  const incoming = await all("SELECT c.*, u.name fname, u.email femail, w.name wsname FROM connections c JOIN users u ON u.id=c.from_user LEFT JOIN workspaces w ON w.id=c.from_ws WHERE c.to_user=? AND c.status='pending' ORDER BY c.id DESC", req.user.id);
  const outgoing = await all("SELECT c.*, u.name tname FROM connections c JOIN users u ON u.id=c.to_user WHERE c.from_user=? AND c.status='pending' ORDER BY c.id DESC", req.user.id);
  const mine = await adminWorkspaces(req.user.id);
  const linked = req.admin ? await all("SELECT p.*, u.email uemail FROM people p JOIN users u ON u.id=p.user_id WHERE p.workspace_id=? AND p.active=1 ORDER BY p.relation, p.name", req.ws.id) : [];
  const relLabel = { report: 'On my team', peer: 'Peer', boss: 'My boss', partner: 'Partner', other: 'Other' };
  res.send(await page(req, { title: 'Connect', body: html`<h1>Connect with people</h1>
    <section class="card"><h2>Your code</h2><p class="code-box" id="mycode">${req.user.connect_code}</p>
      <p>Give this to your manager, your team or a peer. They type it in here, you accept, and you're connected.</p>
      <textarea class="copy-src sr" readonly>${req.user.connect_code}</textarea><button type="button" class="btn" data-copy>Copy my code</button></section>
    ${incoming.length ? html`<section class="card hot"><h2>Requests for you</h2><ul class="rows stack-rows">${incoming.map(c => html`<li><div class="stack-sm grow"><b class="big-text">${c.fname} wants to connect</b>
        <span>${c.fname} says ${THEIR_VIEW[c.relation]}.${c.role ? html` Your role: <b>${c.role}</b>.` : ''}${c.message ? html` “${c.message}”` : ''}</span>
        <form method="post" action="/connect/${c.id}/accept" class="stack-sm">${csrf(req)}
          <div class="two"><label>Your role <small>(fix it if it's wrong)</small><input name="role" value="${c.role || ''}" maxlength="60" placeholder="Developer, BA, Driver…"></label>
          ${mine.length > 1 ? html`<label>Add ${first(c.fname)} to<select name="to_ws">${mine.map(w => html`<option value="${w.id}">${w.name}</option>`)}</select></label>` : html`<input type="hidden" name="to_ws" value="${mine[0]?.id || ''}"><span></span>`}</div>
          <div class="actions"><button class="btn primary big">Accept</button><button class="btn" formaction="/connect/${c.id}/decline">Decline</button></div></form></div></li>`)}</ul></section>` : ''}
    <section class="card"><h2>Add someone by their code</h2><form method="post" action="/connect" class="stack">${csrf(req)}
      <label>Their code or email<input name="code" required maxlength="200" value="${req.query.email || ''}" placeholder="KO-7F3K-92QX" autocomplete="off"></label>
      <fieldset class="big-choices"><legend>They are…</legend>${Object.entries(REL).map(([k, l], n) => html`<label class="big-choice"><input type="radio" name="relation" value="${k}" ${n === 0 ? raw('checked') : ''}><span>${l}</span></label>`)}</fieldset>
      <div class="two"><label>Their role <small>(optional)</small><input name="role" maxlength="60" list="conn-roles"><datalist id="conn-roles">${require('../lib/industries').of(req.ws).roles.map(r => html`<option value="${r}">`)}</datalist></label><label>A note <small>(optional)</small><input name="message" maxlength="200"></label></div>
      ${req.query.person ? html`<input type="hidden" name="person" value="${req.query.person}">` : ''}
      <button class="btn primary big">Send request</button><p class="muted small">They have to accept. When they do, you each show up in the other's People.</p></form></section>
    ${outgoing.length ? html`<section class="card"><h2>Waiting for them to accept</h2><ul class="rows">${outgoing.map(c => html`<li><span><b>${c.tname}</b> · ${REL[c.relation]}${c.role ? ' · ' + c.role : ''}</span><form method="post" action="/connect/${c.id}/cancel">${csrf(req)}<button class="btn sm">Cancel</button></form></li>`)}</ul></section>` : ''}
    ${linked.length ? html`<section class="card"><h2>Connected in ${req.ws.name}</h2><ul class="rows">${linked.map(p => html`<li><a href="/people/${p.id}">${A.avatar(p)}<b>${p.name}</b><span>${relLabel[p.relation]}${p.role ? ' · ' + p.role : ''}</span></a></li>`)}</ul></section>` : ''}` }));
});
app.post('/connect', async (req, res) => {
  A.wsRequired(req);
  const raw_ = String(req.body.code || '').trim(), relation = REL[req.body.relation] ? req.body.relation : 'report';
  const to = /@/.test(raw_) ? await one('SELECT * FROM users WHERE email=? AND disabled_at IS NULL', raw_.toLowerCase()) : await one('SELECT * FROM users WHERE connect_code=? AND disabled_at IS NULL', raw_.toUpperCase().replace(/\s+/g, ''));
  if (!to) bad("We couldn't find anyone with that code. Check it with them (it looks like KO-7F3K-92QX).");
  if (Number(to.id) === Number(req.user.id)) bad("That's your own code.");
  if (await one("SELECT 1 x FROM connections WHERE from_user=? AND to_user=? AND status='pending'", req.user.id, to.id)) bad('You already sent them a request.');
  // they asked us first? then this is an accept
  const theirs = await one("SELECT * FROM connections WHERE from_user=? AND to_user=? AND status='pending'", to.id, req.user.id);
  if (theirs) bad(`${first(to.name)} already sent you a request. Accept it above.`);
  const fromWs = req.admin ? req.ws.id : (await adminWorkspaces(req.user.id))[0]?.id || req.ws.id;
  await run('INSERT INTO connections(from_user,from_ws,to_user,relation,role,message) VALUES(?,?,?,?,?,?)', req.user.id, fromWs, to.id, relation, String(req.body.role || '').trim().slice(0, 60) || null, String(req.body.message || '').trim().slice(0, 200) || null);
  await A.notify(to.id, `🤝 ${req.user.name} wants to connect (${THEIR_VIEW[relation]}). Tap to accept.`, '/connect');
  await A.audit(req, 'connect request', { to: to.id, relation });
  flash(res, `Request sent to ${to.name}. You'll be connected when they accept.`); res.redirect('/connect');
});
app.post('/connect/:id/:act', async (req, res) => {
  A.loginRequired(req); const c = await one("SELECT * FROM connections WHERE id=? AND status='pending'", req.params.id) || notFound();
  const act = req.params.act;
  if (act === 'cancel') { if (Number(c.from_user) !== Number(req.user.id)) A.deny(); await run("UPDATE connections SET status='canceled', decided_at=ko_now() WHERE id=?", c.id); flash(res, 'Request canceled.'); return res.redirect('/connect'); }
  if (Number(c.to_user) !== Number(req.user.id)) A.deny();
  if (act === 'decline') { await run("UPDATE connections SET status='declined', decided_at=ko_now() WHERE id=?", c.id); await A.notify(c.from_user, `${req.user.name} declined your connect request.`, '/connect'); flash(res, 'Declined.'); return res.redirect('/connect'); }
  if (act !== 'accept') notFound();
  const from = await one('SELECT * FROM users WHERE id=?', c.from_user), me = await one('SELECT * FROM users WHERE id=?', req.user.id);
  const mine = await adminWorkspaces(me.id), toWs = mine.find(w => Number(w.id) === Number(req.body.to_ws)) || mine[0];
  const role = String(req.body.role || '').trim().slice(0, 60) || c.role || null;
  await tx(async () => {
    if (c.from_ws) await addToWorkspace(c.from_ws, me, c.relation, role);          // me in their workspace (e.g. on their team)
    if (toWs) await addToWorkspace(toWs.id, from, INVERSE[c.relation], null);       // them in mine (e.g. as my boss)
    await run("UPDATE connections SET status='accepted', to_ws=?, role=?, decided_at=ko_now() WHERE id=?", toWs?.id || null, role, c.id);
  });
  await A.notify(from.id, `🤝 ${me.name} accepted. You're connected.`, '/people');
  await A.audit(req, 'connect accepted', { with: from.id, relation: c.relation });
  flash(res, `You're connected with ${from.name}. Switch to their workspace from the name at the top.`); res.redirect('/connect');
});
module.exports = { addToWorkspace };
