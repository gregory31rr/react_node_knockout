/**
 * routes/timeoff.js — attendance: who's out, PTO balances, sick days, unplanned absences, holidays.
 *
 *   /time-off        Who's out today and the next 4 weeks; add time off for someone (or a holiday for everyone);
 *                    PTO balances for the year (allowance, used, planned, left) with a spreadsheet; attendance counts.
 *   Time off feeds "Who has room?" and timeline risk automatically: someone on PTO has fewer hours that week.
 *   Team members with an account can request PTO for themselves; you approve or decline it.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const T = require('../lib/timeoff');
const W = require('../lib/work');

const fmtRange = r => r.start_on === r.end_on ? U.fmtDate(r.start_on) : `${U.fmtDate(r.start_on).replace(/, \d{4}$/, '')} – ${U.fmtDate(r.end_on)}`;
const label = r => html`${T.KINDS[r.kind][1]} ${T.KINDS[r.kind][0]}`;

app.get('/time-off', async (req, res) => {
  A.wsRequired(req);
  const t = U.today(), end = U.addDays(t, 27), year = Number(t.slice(0, 4));
  if (!req.admin) return mine(req, res);
  const upcoming = await T.whoIsOut(req.ws, t, end), today = upcoming.filter(r => r.start_on <= t && r.end_on >= t);
  const requests = await all("SELECT t.*, p.name FROM time_off t JOIN people p ON p.id=t.person_id WHERE t.workspace_id=? AND t.status='requested' ORDER BY t.start_on", req.ws.id);
  const people = await all("SELECT * FROM people WHERE workspace_id=? AND active=1 AND relation IN ('report','partner','other') ORDER BY name", req.ws.id);
  const bal = []; for (const p of people) bal.push({ p, b: await T.balance(req.ws, p, year) });
  const att = Object.fromEntries((await all("SELECT person_id, kind, count(*) n FROM time_off WHERE workspace_id=? AND kind IN ('sick','absent') AND start_on >= ? GROUP BY person_id, kind", req.ws.id, `${year}-01-01`)).map(r => [r.person_id + r.kind, Number(r.n)]));
  // the next 4 weeks, one row per week
  const weeks = []; let ws0 = U.addDays(t, 1 - (new Date(t + 'T12:00:00Z').getUTCDay() || 7));
  for (let k = 0; k < 4; k++) { const a = U.addDays(ws0, 7 * k), b = U.addDays(a, 6); weeks.push({ a, b, rows: upcoming.filter(r => r.start_on <= b && r.end_on >= a) }); }
  res.send(await page(req, { title: 'Time off', wide: true, body: html`<p class="eyebrow"><a href="/people">People</a></p>
    <div class="head"><div><h1>Time off & attendance</h1><p class="muted">PTO, sick days, absences and holidays. “Who has room?” already takes these out.</p></div><a class="btn" href="/time-off.csv">Spreadsheet</a></div>
    <div class="score"><div class="stat ${today.filter(r => r.kind !== 'remote').length ? 'hot' : ''}"><b>${today.filter(r => r.kind !== 'remote').length}</b><span>out today</span></div><div class="stat"><b>${today.filter(r => r.kind === 'remote').length}</b><span>remote today</span></div>
      <div class="stat"><b>${upcoming.filter(r => r.kind === 'pto').length}</b><span>PTO in the next 4 weeks</span></div><div class="stat ${requests.length ? 'hot' : ''}"><b>${requests.length}</b><span>requests to approve</span></div></div>
    ${requests.length ? html`<section class="card hot"><h2>Requests</h2><ul class="rows">${requests.map(r => html`<li><span><b>${r.name}</b> · ${label(r)} · ${fmtRange(r)}${r.hours != null ? ` · ${A.hoursText(r.hours)}` : ''}${r.note ? html`<small class="block muted">${r.note}</small>` : ''}</span>
      <div class="actions"><form method="post" action="/time-off/${r.id}/approved">${csrf(req)}<button class="btn sm primary">Approve</button></form><form method="post" action="/time-off/${r.id}/declined">${csrf(req)}<button class="btn sm">Decline</button></form></div></li>`)}</ul></section>` : ''}
    <div class="cols"><div>
      ${weeks.map((w, k) => html`<section class="card"><h2>${k === 0 ? 'This week' : k === 1 ? 'Next week' : 'Week of ' + U.fmtDate(w.a).replace(/, \d{4}$/, '')} <span class="muted small">${U.fmtDate(w.a).replace(/, \d{4}$/, '')} – ${U.fmtDate(w.b).replace(/, \d{4}$/, '')}</span></h2>
        ${w.rows.length ? html`<ul class="rows">${w.rows.map(r => html`<li><span><b>${r.name || 'Everyone'}</b>${r.role ? html` <small class="muted">${r.role}</small>` : ''}<small class="block">${label(r)} · ${fmtRange(r)}${r.hours != null ? ` · ${A.hoursText(r.hours)}` : ''}${r.status === 'requested' ? ' · requested' : ''}${r.note ? ' · ' + r.note : ''}</small></span>
          <form method="post" action="/time-off/${r.id}/delete" data-confirm="Remove this time off?">${csrf(req)}<button class="link small">Remove</button></form></li>`)}</ul>` : html`<p class="muted small">Everyone's in.</p>`}</section>`)}
    </div><div>
      <section class="card"><h2>Add time off</h2><form method="post" action="/time-off" class="stack">${csrf(req)}
        <label>Who<select name="person_id" required><option value="">Pick someone</option><option value="all">Everyone (company holiday)</option>${(await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id)).map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
        <label>What<select name="kind">${Object.entries(T.KINDS).map(([k, v]) => html`<option value="${k}">${v[1]} ${v[0]}</option>`)}</select></label>
        <div class="two"><label>From<input type="date" name="start_on" value="${t}" required></label><label>To<input type="date" name="end_on" value="${t}" required></label></div>
        <div class="two"><label>Hours <small>(blank = full days)</small><input name="hours" inputmode="decimal" maxlength="6" placeholder="4 for a half day"></label><span></span></div>
        <label>Note <small>(optional)</small><input name="note" maxlength="200"></label><button class="btn primary">Add</button></form></section>
      <section class="card"><div class="card-head"><h2>PTO balances ${year}</h2></div><p class="muted small">Set each person's yearly PTO hours on their page (Details). Sick and absence counts are for this year.</p>
        <div class="tbl"><table class="sheet"><thead><tr><th>Person</th><th class="n">Allowance</th><th class="n">Used</th><th class="n">Planned</th><th class="n">Left</th><th class="n">Sick</th><th class="n">Absent</th></tr></thead><tbody>
        ${bal.map(({ p, b }) => html`<tr><td><a href="/people/${p.id}#pto">${p.name}</a></td><td class="n">${b.allowance == null ? html`<span class="muted">—</span>` : A.hoursText(b.allowance)}</td><td class="n">${A.hoursText(b.used) || '0h'}</td><td class="n">${A.hoursText(b.planned) || '0h'}</td>
          <td class="n">${b.left == null ? '—' : html`<b class="${b.left < 0 ? 'red-text' : ''}">${b.left < 0 ? '−' + A.hoursText(-b.left) : A.hoursText(b.left) || '0h'}</b>`}</td><td class="n">${att[p.id + 'sick'] || 0}</td><td class="n">${att[p.id + 'absent'] ? html`<b class="red-text">${att[p.id + 'absent']}</b>` : 0}</td></tr>`)}</tbody></table></div></section>
    </div></div>` }));
});
/** A team member's own view: their time off, their balance, and a request form. */
async function mine(req, res) {
  if (!req.me) A.deny('Your account is not linked to a person yet. Ask your manager.');
  const rows = await all('SELECT * FROM time_off WHERE workspace_id=? AND (person_id=? OR person_id IS NULL) AND end_on >= ? ORDER BY start_on', req.ws.id, req.me.id, U.addDays(U.today(), -90));
  const b = await T.balance(req.ws, req.me);
  res.send(await page(req, { title: 'Time off', body: html`<h1>My time off</h1>
    <div class="score"><div class="stat"><b>${b.allowance == null ? '—' : A.hoursText(b.allowance)}</b><span>PTO this year</span></div><div class="stat"><b>${A.hoursText(b.used) || '0h'}</b><span>used</span></div><div class="stat"><b>${A.hoursText(b.planned) || '0h'}</b><span>planned</span></div><div class="stat"><b>${b.left == null ? '—' : A.hoursText(b.left) || '0h'}</b><span>left</span></div></div>
    <section class="card"><h2>Request time off</h2><form method="post" action="/time-off" class="stack">${csrf(req)}<input type="hidden" name="person_id" value="${req.me.id}">
      <label>What<select name="kind"><option value="pto">🌴 PTO</option><option value="sick">🤒 Sick</option><option value="training">🎓 Training</option><option value="remote">🏠 Working remote</option><option value="other">Other</option></select></label>
      <div class="two"><label>From<input type="date" name="start_on" required></label><label>To<input type="date" name="end_on" required></label></div>
      <div class="two"><label>Hours <small>(blank = full days)</small><input name="hours" inputmode="decimal" maxlength="6"></label><span></span></div><label>Note<input name="note" maxlength="200"></label><button class="btn primary">Send request</button></form></section>
    <section class="card"><h2>Coming up & recent</h2>${rows.length ? html`<ul class="rows">${rows.map(r => html`<li><span>${label(r)} · ${fmtRange(r)}${r.person_id ? '' : ' (everyone)'}</span>${A.badge(r.status === 'requested' ? 'Waiting for approval' : r.status === 'declined' ? 'Declined' : 'Approved', r.status === 'approved' ? 'ok' : 'warn')}</li>`)}</ul>` : A.empty('Nothing yet.')}</section>` }));
}
app.post('/time-off', async (req, res) => {
  A.wsRequired(req); const b = req.body;
  const all_ = req.admin && b.person_id === 'all', person = all_ ? null : await W.personIn(req.ws.id, b.person_id);
  if (!all_ && !person) bad('Pick who.');
  if (!req.admin && Number(person.id) !== Number(req.me?.id)) A.deny();
  if (!U.isDate(b.start_on) || !U.isDate(b.end_on) || b.end_on < b.start_on) bad('Check the dates (the end can’t be before the start).');
  if (U.daysBetween(b.start_on, b.end_on) > 366) bad('That is more than a year.');
  const kind = T.KINDS[b.kind] ? b.kind : 'pto', hours = b.hours ? W.loeHours(b.hours) : null;
  const status = req.admin ? 'approved' : kind === 'sick' || kind === 'remote' ? 'approved' : 'requested';
  await run('INSERT INTO time_off(workspace_id,person_id,kind,start_on,end_on,hours,note,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)', req.ws.id, person?.id || null, all_ ? 'holiday' : kind, b.start_on, b.end_on, hours, String(b.note || '').slice(0, 200) || null, status, req.user.id);
  if (status === 'requested') for (const m of await A.managers(req.ws.id)) await A.notify(m.id, `${req.user.name} requested ${T.KINDS[kind][0]}: ${fmtRange(b)}`, '/time-off', 'timeoff');
  flash(res, status === 'requested' ? 'Request sent to your manager.' : 'Time off added.'); res.redirect(req.body.back === 'person' && person ? `/people/${person.id}#pto` : '/time-off');
});
app.post('/time-off/:id/:act', async (req, res) => {
  A.adminOnly(req); const r = await one('SELECT * FROM time_off WHERE id=? AND workspace_id=?', req.params.id, req.ws.id) || notFound();
  if (req.params.act === 'delete') await run('DELETE FROM time_off WHERE id=?', r.id);
  else if (['approved', 'declined'].includes(req.params.act)) {
    await run('UPDATE time_off SET status=? WHERE id=?', req.params.act, r.id);
    const p = r.person_id ? await one('SELECT user_id FROM people WHERE id=?', r.person_id) : null;
    if (p?.user_id) await A.notify(p.user_id, `Your ${T.KINDS[r.kind][0]} for ${fmtRange(r)} was ${req.params.act}.`, '/time-off', 'timeoff');
  } else notFound();
  flash(res, 'Done.'); res.redirect('/time-off');
});
app.get('/time-off.csv', async (req, res) => {
  A.adminOnly(req); const rows = await all('SELECT t.*, p.name FROM time_off t LEFT JOIN people p ON p.id=t.person_id WHERE t.workspace_id=? ORDER BY t.start_on DESC', req.ws.id);
  res.setHeader('Content-Disposition', `attachment; filename="knockout-time-off-${U.today()}.csv"`);
  res.send(U.toCSV([['Person', 'Type', 'From', 'To', 'Hours', 'Status', 'Note'], ...rows.map(r => [r.name || 'Everyone', T.KINDS[r.kind][0], r.start_on, r.end_on, r.hours ?? '', r.status, r.note || ''])]), 200, 'text/csv; charset=utf-8');
});
module.exports = { fmtRange, label };
