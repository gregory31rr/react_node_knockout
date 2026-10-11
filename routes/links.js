/**
 * routes/links.js — the page someone outside your team opens from an outside link (paid plan). No account needed.
 *
 *   /l/:token   They see only this one item: what it is, the details, due date and LOE, and the notes so far.
 *               They can add time spent, add a note or an answer, and mark it done. Everything they do is in the item's
 *               history with their name and "(link)". You can turn the link off any time; it also stops on its end date,
 *               and it closes for good the moment they mark it done (so an old link can't be reused).
 */
const A = require('../lib/app');
const { app, bare, bad } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html } = U;
const W = require('../lib/work');

async function linkFor(token) {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const l = await one('SELECT l.*, w.status ws_status, w.name ws_name, w.plan FROM links l JOIN workspaces w ON w.id=l.workspace_id WHERE l.token=?', token);
  if (!l || !l.active || l.ws_status !== 'active' || !['pro', 'team'].includes(l.plan) || (l.expires_on && l.expires_on < U.today())) return null;
  return l;
}
const gone = res => res.send(bare('Link', html`<section class="card"><h1>This link isn't working</h1><p>It was turned off or it ran out. Ask the person who sent it for a new one.</p></section>`), 404);
app.get('/l/:token', async (req, res) => {
  const l = await linkFor(req.params.token); if (!l) return gone(res);
  await run('UPDATE links SET views=views+1, last_viewed_at=ko_now() WHERE id=?', l.id);
  const i = await one(`SELECT i.*, pr.name project_name, (SELECT COALESCE(sum(hours),0) FROM time_logs t WHERE t.item_id=i.id) spent FROM items i LEFT JOIN projects pr ON pr.id=i.project_id WHERE i.id=?`, l.item_id);
  const ev = await all("SELECT * FROM item_events WHERE item_id=? AND kind IN ('note','answered','time','knocked out','reopened') ORDER BY id", i.id);
  const sent = req.query.ok;
  res.send(bare(i.title, html`<section class="card"><p class="eyebrow">${l.ws_name}${i.project_name ? ' · ' + i.project_name : ''}</p><h1>${i.title}</h1>
    <div class="chips"><span class="chip">${A.KIND[i.kind][0]}</span><span class="chip ${A.PRI[i.priority][1]}">${A.PRI[i.priority][2]} priority</span>${i.due_on ? html`<span class="chip">Due ${U.fmtDate(i.due_on)}</span>` : ''}
      ${i.loe ? html`<span class="chip">Estimate ${A.loeText(i.loe)}</span>` : ''}${Number(i.spent) ? html`<span class="chip">${A.loeText(i.spent)} logged</span>` : ''}<span class="chip st-${i.status}">${A.STATUS[i.status]}</span></div>
    ${i.details ? html`<p class="pre">${i.details}</p>` : ''}${i.answer ? html`<h2>Answer so far</h2><p class="pre answer">${i.answer}</p>` : ''}
    ${sent ? html`<div class="flash ok" role="status">${sent === 'done' ? 'Marked done. Thank you!' : 'Saved. Thank you!'}</div>` : ''}</section>
    ${i.status !== 'done' ? html`<section class="card"><h2>Update it</h2><form method="post" action="/l/${l.token}" class="stack">
      <label>Your name<input name="who" required maxlength="80" value="${l.who || ''}" autocomplete="name"></label>
      <div class="two"><label>Time spent <small>(optional, like 1.5h)</small><input name="hours" inputmode="decimal" maxlength="8"></label><span></span></div>
      <label>Notes or answer<textarea name="note" rows="4" maxlength="5000" placeholder="What you did, what you found, what's left…"></textarea></label>
      <div class="actions"><button class="btn" name="act" value="save">Save</button><button class="btn primary" name="act" value="done">Save and mark done</button></div></form></section>` : ''}
    ${ev.length ? html`<section class="card"><h2>History</h2><ol class="timeline">${ev.map(e => html`<li><b>${e.kind}</b>${e.text ? html` · <span class="pre">${e.text}</span>` : ''}<small class="block muted">${e.actor || ''} · ${U.fmtDateTime(e.created_at)}</small></li>`)}</ol></section>` : ''}
    <p class="center muted small">Only this item is shared with you. Sent with Knockout.</p>`));
});
app.post('/l/:token', async (req, res) => {
  const l = await linkFor(req.params.token); if (!l) return gone(res);
  const i = await one('SELECT * FROM items WHERE id=?', l.item_id); if (i.status === 'done') return gone(res);
  const who = String(req.body.who || '').trim().slice(0, 80); if (!who) bad('Enter your name.');
  const note = String(req.body.note || '').trim().slice(0, 5000), h = W.loeHours(req.body.hours);
  if (req.body.hours && !(h > 0 && h <= 200)) bad('Enter time like 1.5h or 45m.');
  if (!note && !h && req.body.act !== 'done') bad('Add a note or the time spent.');
  const r = { linkPerson: who, user: null };
  if (h) { await run("INSERT INTO time_logs(workspace_id,item_id,who,hours,note,on_day,via) VALUES(?,?,?,?,?,?,'link')", i.workspace_id, i.id, who + ' (link)', h, note.slice(0, 300) || null, U.today()); await W.event(i.workspace_id, i.id, 'time', `${A.loeText(h)}`, W.actorName(r)); }
  if (note) {
    if (['ask', 'update', 'decision'].includes(i.kind)) { await run('UPDATE items SET answer=?, answered_at=ko_now() WHERE id=?', (i.answer ? i.answer + '\n\n' : '') + note, i.id); await W.event(i.workspace_id, i.id, 'answered', note, W.actorName(r)); }
    else await W.event(i.workspace_id, i.id, 'note', note, W.actorName(r));
  }
  if (!l.who) await run('UPDATE links SET who=? WHERE id=?', who, l.id);
  for (const m of await A.managers(i.workspace_id)) await A.notify(m.id, `${who} (outside link) ${req.body.act === 'done' ? 'marked done' : 'updated'}: ${i.title}`, '/items/' + i.id, 'vendor');
  if (req.body.act === 'done') { await W.knockOut({ ...r, admin: true }, i, 'via outside link'); await run('UPDATE links SET active=0 WHERE id=?', l.id); }   // done: the link closes for good
  else await run('UPDATE items SET updated_at=ko_now() WHERE id=?', i.id);
  if (req.body.act === 'done') return res.send(bare('Thank you', html`<section class="card"><h1>Thank you, ${who.split(' ')[0]}!</h1><p>It's marked done and your notes were saved. For security, this link is now closed.</p></section>`));
  res.redirect(`/l/${l.token}?ok=saved`);
});
