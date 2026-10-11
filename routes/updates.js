/**
 * routes/updates.js — weekly, monthly and quarterly updates for your boss and your team, written for you.
 *
 *   /updates?period=week|month|quarter   pick the period (this or last), who it's for (boss or team) and which projects.
 *   Knockout drafts it: the headline numbers (vs the period before), each project's progress, what got done, what's next,
 *   what's late or at risk, and what you need from your boss. Edit anything, then send it by email, open it in your own
 *   email, or copy it into Teams. Every update you send is kept below so you can look back.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const M = require('../lib/metrics');
const W = require('../lib/work');
const E = require('../lib/email');

const NAME = { week: 'Weekly', month: 'Monthly', quarter: 'Quarterly' };
async function draft(req, { kind, back, audience, projectIds }) {
  const ws = req.ws, r = M.range(kind, back), prev = M.range(kind, back + 1);
  const n = await M.numbers(ws, r), p0 = await M.numbers(ws, prev);
  const projects = await all(`SELECT * FROM projects WHERE workspace_id=? AND (status<>'done' OR completed_at >= ?) ${projectIds.length ? `AND id IN (${projectIds.map(Number).join(',')})` : ''} ORDER BY name`, ws.id, r.from);
  const next = { from: U.addDays(r.to, 1), to: kind === 'week' ? U.addDays(r.to, 7) : kind === 'month' ? M.range('month', back - 1).to : M.range('quarter', back - 1).to };
  const chg = (a, b, unit = '') => b == null || a === b ? '' : ` (${a > b ? 'up' : 'down'} from ${b}${unit})`;
  const L = [`${NAME[kind]} update · ${r.label}`, ''];
  L.push('Headline:', `- ${n.done} items knocked out${chg(n.done, p0.done)}, ${A.loeText(n.loe) || '0h'} of LOE done${chg(Math.round(n.loe), Math.round(p0.loe), 'h')}`);
  if (n.ontime != null) L.push(`- ${n.ontime}% on time${chg(n.ontime, p0.ontime, '%')}`);
  L.push(`- ${n.open} open (${A.loeText(n.openLoe) || '0h'} LOE)${n.late ? `, ${n.late} late` : ''}`);
  const priv = audience === 'team' ? ' AND i.private=0' : '';
  const open = await all(`${W.LIST_SQL} WHERE i.workspace_id=? AND i.status IN ${W.OPEN}${priv} ORDER BY ${W.ORDER}`, ws.id);
  if (audience === 'boss') {   // ★ Exec items lead the boss's update
    const ex = await all(`SELECT i.title, i.status, i.answer, i.due_on FROM items i WHERE i.workspace_id=? AND i.exec=1 AND (i.status<>'done' OR i.completed_at BETWEEN ? AND ?) ORDER BY i.status='done' DESC, i.priority`, ws.id, r.from + ' 00:00:00', r.to + ' 23:59:59');
    if (ex.length) L.splice(2, 0, 'Highlights:', ...ex.map(i => `- ${i.title}${i.status === 'done' ? ' (done)' : i.due_on ? ' (due ' + U.fmtDate(i.due_on).replace(/, \d{4}$/, '') + ')' : ' (in progress)'}`), '');
  }
  const risk = await W.risk(ws, open);
  for (const p of projects) {
    const ro = await W.rollup(p.id);
    const done = await all(`SELECT i.title, o.name owner FROM items i LEFT JOIN people o ON o.id=i.owner_person_id WHERE i.project_id=? AND i.status='done' AND i.completed_at BETWEEN ? AND ?${priv} ORDER BY i.priority, i.completed_at LIMIT 8`, p.id, r.from + ' 00:00:00', r.to + ' 23:59:59');
    const pOpen = open.filter(i => Number(i.project_id) === Number(p.id));
    const upcoming = pOpen.filter(i => i.due_on && i.due_on >= next.from && i.due_on <= next.to).slice(0, 6), late = pOpen.filter(i => risk.has(i.id));
    if (!done.length && !upcoming.length && !late.length && p.status !== 'active') continue;
    L.push('', `${p.name}${p.status === 'done' ? ' (done)' : ''}: ${ro.pct}% complete, ${A.loeText(ro.loeLeft) || '0h'} left${p.due_on ? `, due ${U.fmtDate(p.due_on)}` : ''}${ro.overdue ? `, ${ro.overdue} late` : ''}`);
    if (done.length) L.push('  Done:', ...done.map(i => `  - ${i.title}${audience === 'team' && i.owner ? ` (${i.owner.split(' ')[0]})` : ''}`));
    if (upcoming.length) L.push('  Next:', ...upcoming.map(i => `  - ${i.title}${i.due_on ? ', ' + U.fmtDate(i.due_on).replace(/, \d{4}$/, '') : ''}`));
    if (late.length) L.push('  Risks:', ...late.slice(0, 6).map(i => `  - ${i.title}${risk.get(i.id).state === 'overdue' ? ' (late)' : ' (at risk)'}${i.owner_name ? ', ' + i.owner_name.split(' ')[0] : ''}`));
  }
  const loose = await all(`SELECT i.title FROM items i WHERE i.workspace_id=? AND i.project_id IS NULL AND i.status='done' AND i.completed_at BETWEEN ? AND ?${priv} ORDER BY i.priority LIMIT 8`, ws.id, r.from + ' 00:00:00', r.to + ' 23:59:59');
  if (loose.length && !projectIds.length) L.push('', 'Also done:', ...loose.map(i => `- ${i.title}`));
  if (audience === 'team') {
    const shout = await all("SELECT o.name, count(*) n FROM items i JOIN people o ON o.id=i.owner_person_id WHERE i.workspace_id=? AND i.status='done' AND i.completed_at BETWEEN ? AND ? GROUP BY o.name ORDER BY n DESC LIMIT 5", ws.id, r.from + ' 00:00:00', r.to + ' 23:59:59');
    if (shout.length) L.push('', 'Shout-outs:', ...shout.map(s => `- ${s.name}: ${s.n} knocked out`));
  } else {
    const boss = ws.boss_person_id || (await one("SELECT id FROM people WHERE workspace_id=? AND relation='boss' AND active=1 ORDER BY id LIMIT 1", ws.id))?.id;
    const needs = boss ? open.filter(i => Number(i.person_id) === Number(boss) && ['ask', 'decision', 'update'].includes(i.kind)) : [];
    if (needs.length) L.push('', 'What I need from you:', ...needs.map(i => `- ${i.title}${i.due_on ? ' (by ' + U.fmtDate(i.due_on).replace(/, \d{4}$/, '') + ')' : ''}`));
  }
  return { text: L.join('\n'), r };
}
app.get('/updates', async (req, res) => {
  A.adminOnly(req);
  const kind = NAME[req.query.period] ? req.query.period : 'week', back = req.query.back === '1' ? 1 : 0, audience = req.query.for === 'team' ? 'team' : 'boss';
  const projectIds = [].concat(req.query.project || []).filter(Boolean);
  const { text, r } = await draft(req, { kind, back, audience, projectIds });
  const projects = await all("SELECT id, name FROM projects WHERE workspace_id=? AND status<>'done' ORDER BY name", req.ws.id);
  const boss = await one("SELECT * FROM people WHERE workspace_id=? AND (id=? OR relation='boss') AND active=1 ORDER BY id=? DESC LIMIT 1", req.ws.id, req.ws.boss_person_id || 0, req.ws.boss_person_id || 0);
  const team = await all("SELECT name, email FROM people WHERE workspace_id=? AND active=1 AND relation='report' AND email IS NOT NULL ORDER BY name", req.ws.id);
  const past = await all("SELECT * FROM sends WHERE workspace_id=? AND kind='update' ORDER BY id DESC LIMIT 20", req.ws.id);
  const subject = `${NAME[kind]} update · ${r.label}`;
  const to = audience === 'boss' ? (boss?.email ? [boss.email] : []) : team.map(t => t.email);
  const seg = (k, v, l) => html`<a href="/updates?${new URLSearchParams({ period: k === 'period' ? v : kind, back: k === 'back' ? v : back, for: k === 'for' ? v : audience })}" ${(k === 'period' ? kind : k === 'back' ? String(back) : audience) === String(v) ? raw('aria-current="page"') : ''}>${l}</a>`;
  res.send(await page(req, { title: 'Updates', wide: true, body: html`<div class="head"><div><h1>Updates</h1><p class="muted">Drafted from what actually got done. Edit it, then send.</p></div></div>
    <div class="seg-row"><nav class="seg">${seg('period', 'week', 'Weekly')}${seg('period', 'month', 'Monthly')}${seg('period', 'quarter', 'Quarterly')}</nav>
      <nav class="seg">${seg('back', 0, 'This ' + kind)}${seg('back', 1, 'Last ' + kind)}</nav><nav class="seg">${seg('for', 'boss', 'For my boss')}${seg('for', 'team', 'For my team')}</nav></div>
    ${projects.length ? html`<form method="get" class="filters card"><input type="hidden" name="period" value="${kind}"><input type="hidden" name="back" value="${back}"><input type="hidden" name="for" value="${audience}">
      <fieldset class="inline-checks"><legend class="small">Projects <small class="muted">(none ticked = all)</small></legend>${projects.map(p => html`<label class="check"><input type="checkbox" name="project" value="${p.id}" ${projectIds.includes(String(p.id)) ? raw('checked') : ''}> ${p.name}</label>`)}</fieldset><button class="btn sm">Redo draft</button></form>` : ''}
    <form method="post" action="/updates/send" class="card stack">${csrf(req)}
      <label>Subject<input name="subject" value="${subject}" maxlength="200"></label>
      <label>Update<textarea name="body" rows="22" class="copy-src mono" maxlength="50000">${text}</textarea></label>
      <label>To <small>(emails, commas between)</small><input name="to" value="${to.join(', ')}" maxlength="3000" placeholder="${audience === 'boss' ? 'Add your boss on the People page (They are: My boss)' : 'Your team’s emails'}"></label>
      ${E.configured() ? '' : html`<p class="muted small">Email isn't set up yet, so “Send email” only saves it. Use “Open in my email” to send it from your own Outlook or Gmail.</p>`}<div class="actions wrap"><button class="btn primary" name="how" value="email">Send email</button>
        <a class="btn" href="${E.mailto({ to, subject, text })}">Open in my email</a><button type="button" class="btn" data-copy>Copy for Teams</button><button class="btn" name="how" value="save">Save without sending</button></div></form>
    ${past.length ? html`<section class="card"><h2>Updates you've sent</h2><ul class="rows">${past.map(s => html`<li><details><summary><b>${s.subject}</b> <span class="muted small">${s.how} · ${U.fmtDateTime(s.created_at)}${s.to_text ? ' · ' + s.to_text : ''}</span></summary><p class="pre small">${s.body}</p></details></li>`)}</ul></section>` : ''}` }));
});
app.post('/updates/send', async (req, res) => {
  A.adminOnly(req);
  const subject = String(req.body.subject || 'Update').slice(0, 200), body = String(req.body.body || '').slice(0, 50000); if (!body.trim()) bad('The update is empty.');
  const to = [...new Set(String(req.body.to || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 100);
  let how = 'saved';
  if (req.body.how === 'email') { if (!to.length) bad('Add at least one email.'); const r = await E.send({ to, subject, text: body, replyTo: req.user.email }); how = r.ok ? 'emailed' : 'logged (email not set up)'; }
  await run('INSERT INTO sends(workspace_id,kind,to_text,subject,body,how,created_by) VALUES(?,?,?,?,?,?,?)', req.ws.id, 'update', to.join(', '), subject, body, how, req.user.id);
  flash(res, how === 'emailed' ? `Sent to ${to.length}.` : how === 'saved' ? 'Saved.' : 'Email is not set up, so it was saved. Use "Open in my email" or Copy.'); res.redirect('/updates');
});
module.exports = { draft };
