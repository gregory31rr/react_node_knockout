/**
 * routes/board.js — the simple view: your desk of sticky notes. Big print, few words, no training needed.
 *
 *   /                 My board. Five columns: Do today · This week · Ask or tell someone · Waiting · Later.
 *                     Every note shows who owns it (and anyone sharing it), its due date, and one big “✓ Done”.
 *   Drag and drop     Drag a note to another column: Today / This week set the due date, Later clears it, Waiting
 *                     marks it waiting (blocked). Drop it on the “Move…” box above the columns (or tap Move on the note)
 *                     to pick exactly where it goes: a day, a date, waiting or not, Task / Ask / Update / Tell.
 *   /?person=ID       Talking to someone? Everything for that person.
 *   /?team=ID         (manager) That person's own board: drag something into their Today to make it their priority,
 *                     comment on a blocker (“I'm removing the blocker”, “Here's a way around it”), add a note for them.
 *   /?call=ID         A call: what to ask and tell each person on it.
 *   /search?q=        Find notes, projects and people.
 *   /view             switch between this board and the full view (account menu). Each person keeps their choice.
 */
const A = require('../lib/app');
const { app, page, csrf, flash, bad, notFound } = A;
const { one, all, run } = require('../lib/db');
const U = require('../lib/util');
const { html, raw } = U;
const W = require('../lib/work');

const TYPES = [['task', 'Task', 'Something I need to do'], ['ask', 'Ask someone', 'A question for someone'], ['update', 'Need an update', 'Find out where something stands'], ['tell', 'Tell someone', 'Something to let them know']];
const WAITING = ['waiting', 'blocked'];
const nextFriday = (t, plus = 0) => { const wd = new Date(t + 'T12:00:00Z').getUTCDay(); return U.addDays(t, ((5 - wd + 7) % 7) + plus); };
const weekEnd = () => U.addDays(nextFriday(U.today()), 2);
function whenFor(key) { const t = U.today(); return { today: t, tomorrow: U.addDays(t, 1), week: nextFriday(t), next: nextFriday(t, 7) }[key] || null; }
function whenLabel(i) {
  if (!i.due_on) return null;
  const d = U.daysBetween(U.today(), i.due_on), date = U.fmtDate(i.due_on).replace(/, \d{4}$/, '');
  if (d < 0) return [`Late ${-d} day${d === -1 ? '' : 's'} (was due ${date})`, 'late'];
  if (d === 0) return ['Due today', 'soon']; if (d === 1) return ['Due tomorrow', 'soon'];
  if (d < 7) return [`Due ${new Date(i.due_on + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${date}`, ''];
  return [`Due ${date}`, ''];
}
const first = n => String(n || '').split(' ')[0];
function heading(i) {
  const f = first(i.person_name);
  return { task: 'To do', ask: f ? `Ask ${f}` : 'Ask', update: f ? `Update from ${f}` : 'Need an update', tell: f ? `Tell ${f}` : 'Tell', decision: 'Decide' }[i.kind];
}
/** Who owns it, in plain words: "Me", "Jane", "Jane + Sam". */
function owners(req, i) {
  const main = i.owner_person_id ? (Number(i.owner_person_id) === Number(req.me?.id) ? 'Me' : first(i.owner_name)) : (req.admin || Number(i.created_by) === Number(req.user.id) ? 'Me' : first(i.owner_name) || 'Me');
  const shared = String(i.shared_names || '').split(', ').filter(Boolean).map(first);
  return [main, ...shared.filter(n => n !== main)].join(' + ');
}

/** Which column a note belongs in. view = { team: personId | null } */
function columnFor(req, i, view = {}) {
  const t = U.today(), wk = weekEnd();
  const dated = () => i.due_on && i.due_on <= t ? 'today' : i.due_on && i.due_on <= wk ? 'week' : i.priority === 1 ? 'today' : 'later';
  if (view.team) {   // a team member's board, as the manager sees it
    if (Number(i.person_id) === Number(view.team) && Number(i.owner_person_id) !== Number(view.team) && !String(i.shared_ids || '').split(',').includes(String(view.team))) return 'talk';
    if (WAITING.includes(i.status)) return 'wait';
    return dated();
  }
  const mine = req.admin ? !i.owner_person_id : (Number(i.owner_person_id) === Number(req.me?.id) || (!i.owner_person_id && Number(i.created_by) === Number(req.user.id)));
  if (!mine) return req.admin ? 'wait' : 'talk';
  if (WAITING.includes(i.status)) return 'wait';
  if (['ask', 'update', 'tell', 'decision'].includes(i.kind) && (!i.due_on || i.due_on > t)) return 'talk';
  return dated();
}
function columnsFor(req, view) {
  return view.team ? [['Do today', 'today'], ['This week', 'week'], ['From you', 'talk'], ['Waiting / blocked', 'wait'], ['Later', 'later']]
    : [['Do today', 'today'], ['This week', 'week'], [req.admin ? 'Ask or tell someone' : 'Questions for you', 'talk'], [req.admin ? 'Waiting on others' : 'Waiting / blocked', 'wait'], ['Later', 'later']];
}

function sticky(req, i, ctx = {}) {
  const nd = ctx.nudges?.[i.id], cm = ctx.comments?.[i.id], w = whenLabel(i), back = ctx.back || '/';
  const theirs = i.owner_person_id && (req.admin ? !ctx.view?.team : Number(i.owner_person_id) !== Number(req.me?.id));
  const vendor = ctx.vendors?.[i.id];
  return html`<li class="note n-${vendor ? 'vendor' : i.kind} ${w && w[1] === 'late' ? 'is-late' : ''} ${WAITING.includes(i.status) ? 'is-waiting' : ''}" data-item="${i.id}" draggable="true">
    <p class="note-kind">${vendor ? `🔗 Vendor link · ${vendor}` : heading(i)}${WAITING.includes(i.status) ? ' · waiting' : ''}</p>
    <a class="note-title" href="/items/${i.id}" title="${i.title}">${i.title}</a>
    <p class="note-owner">👤 ${owners(req, i)}</p>
    ${w ? html`<p class="note-due ${w[1]}">${w[1] === 'late' ? '⚠ ' : '📅 '}${w[0]}</p>` : ''}
    <p class="note-meta">${i.priority === 1 ? html`<span class="when late">Urgent</span>` : ''}${i.project_tag ? html`<span>#${i.project_tag}</span>` : ''}</p>
    ${nd && nd.total ? html`<p class="nudges" title="Times you nudged them about this">👋 Nudged ${nd.week ? `${nd.week}× this week` : ''}${nd.week && nd.total > nd.week ? ' · ' : ''}${nd.total > nd.week ? `${nd.total}× in all` : ''}</p>` : ''}
    ${cm ? html`<p class="note-comment" title="${cm.text}">💬 <b>${first(cm.actor)}:</b> ${cm.text}</p>` : ''}
    <div class="note-actions">
      <form method="post" action="/items/${i.id}/ko" data-ko>${csrf(req)}<input type="hidden" name="back" value="${back}"><button class="btn done-btn">✓ Done</button></form>
      ${theirs && req.admin ? html`<form method="post" action="/items/${i.id}/nudge" data-nudge>${csrf(req)}<input type="hidden" name="back" value="${back}"><button class="btn">Nudge</button></form>` : ''}
      <a class="btn" href="/items/${i.id}/move?board=${ctx.view?.team || ''}" data-move="${i.id}">Move</a>
      ${req.admin || (i.owner_person_id && Number(i.owner_person_id) === Number(req.me?.id)) ? html`<a class="btn" href="/items/${i.id}#shared" data-share="${i.id}">Share</a>` : ''}
      <details class="note-talk"><summary class="btn">💬${cm ? ' ' + cm.n : ''}</summary><form method="post" action="/items/${i.id}/comment" class="stack-sm" data-comment>${csrf(req)}<input type="hidden" name="back" value="${back}">
        ${req.admin ? html`<div class="quick-picks"><button type="button" class="btn sm" data-fill="I'm removing the blocker.">I'm removing the blocker</button><button type="button" class="btn sm" data-fill="Here's a way around it: ">Here's a way around it</button></div>` : ''}
        <textarea name="text" rows="2" maxlength="1000" required placeholder="Write a comment"></textarea><button class="btn sm primary">Send</button></form></details>
    </div></li>`;
}
const colHtml = (req, items, ctx, key) => items.length ? html`<ul class="notes" data-col="${key}">${items.slice(0, 6).map(i => sticky(req, i, ctx))}</ul>${items.length > 6 ? html`<details class="more-notes"><summary class="btn">Show ${items.length - 6} more</summary><ul class="notes" data-col="${key}">${items.slice(6).map(i => sticky(req, i, ctx))}</ul></details>` : ''}`
  : html`<ul class="notes" data-col="${key}"></ul><p class="col-empty">${key === 'today' ? 'Nothing for today. 🎉' : 'Nothing here.'}</p>`;

function newNoteForm(req, { person = null, people = [], back = '/', forTeam = null } = {}) {
  return html`<form method="post" action="/board/add" class="new-note">${csrf(req)}<input type="hidden" name="back" value="${back}">${forTeam ? html`<input type="hidden" name="owner_person_id" value="${forTeam.id}">` : ''}
    <label class="big-q" for="nn">${forTeam ? `What should ${first(forTeam.name)} do?` : 'What do you need to remember?'}</label>
    <textarea id="nn" name="text" rows="2" required maxlength="300" placeholder="${person ? `Something for ${first(person.name)}…` : 'Call the vendor about the renewal'}"></textarea>
    <p class="muted small">The first line is the title (keep it short). Anything after it is the details.</p>
    ${forTeam ? '' : html`<fieldset class="big-choices"><legend>What is it?</legend>${TYPES.map(([k, l], n) => html`<label class="big-choice"><input type="radio" name="kind" value="${k}" ${(person ? k === 'ask' : n === 0) ? raw('checked') : ''}><span>${l}</span></label>`)}</fieldset>`}
    <div class="two">
      ${forTeam ? html`<span></span>` : html`<label>Who? <small>(if it's for someone)</small><select name="person_id"><option value="">Just me</option>${people.map(p => html`<option value="${p.id}" ${person && Number(person.id) === Number(p.id) ? raw('selected') : ''}>${p.name}</option>`)}</select></label>`}
      <fieldset class="big-choices when-choices"><legend>When?</legend>${[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['next', 'Next week'], ['', 'Later']].map(([k, l]) => html`<label class="big-choice"><input type="radio" name="when" value="${k}" ${(forTeam ? k === 'today' : k === '') ? raw('checked') : ''}><span>${l}</span></label>`)}</fieldset>
    </div>
    ${!forTeam && req.admin && ['pro', 'team'].includes(req.ws.plan) ? html`<details class="vendor-opt"><summary class="btn">🔗 For a vendor? Make them a link</summary><div class="two">
      <label>Vendor or company<input name="vendor" maxlength="80" placeholder="Hector at CloudCo"></label><label>Link stops working in<select name="vendor_days"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label></div>
      <p class="muted small">They get a page for just this note: add details and time, and mark it done. The link closes when they do.</p></details>` : ''}
    <button class="btn primary big">${forTeam ? `Put it on ${first(forTeam.name)}'s board` : 'Put it on my board'}</button></form>`;
}
/** The latest comment and how many, per item. */
async function commentInfo(wsId) {
  const rows = await all("SELECT e.item_id, e.text, e.actor, e.id FROM item_events e WHERE e.workspace_id=? AND e.kind='note' ORDER BY e.id", wsId);
  const out = {}; for (const r of rows) { const o = out[r.item_id] || (out[r.item_id] = { n: 0 }); o.n++; o.text = r.text; o.actor = r.actor; }
  return out;
}

/** Notes with an open vendor link: { itemId: "Hector at CloudCo" } */
async function vendorInfo(wsId) { return Object.fromEntries((await all("SELECT item_id, COALESCE(who, 'outside') who FROM links WHERE workspace_id=? AND active=1 AND (expires_on IS NULL OR expires_on >= ?)", wsId, U.today())).map(r => [Number(r.item_id), r.who])); }
async function board(req, res) {
  const s = W.scope(req), t = U.today(), shareList = await sharePeople(req);
  const openAll = await all(`${W.LIST_SQL.replace('shared_names', "shared_names, (SELECT string_agg(CAST(ip2.person_id AS TEXT), ',') FROM item_people ip2 WHERE ip2.item_id=i.id) shared_ids")} WHERE ${s.sql} AND i.status IN ${W.OPEN} ORDER BY ${W.ORDER}`, ...s.args);
  const people = await all('SELECT id, name, relation FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id);
  const fp = Number(req.query.person) || 0, person = fp ? people.find(p => Number(p.id) === fp) : null;
  const ft = req.admin ? Number(req.query.team) || 0 : 0, team = ft ? people.find(p => Number(p.id) === ft) : null;
  const callId = req.admin ? Number(req.query.call) || 0 : 0, call = callId ? await one('SELECT * FROM meetings WHERE id=? AND workspace_id=?', callId, req.ws.id) : null;
  const callPeople = call ? await all('SELECT p.id, p.name FROM people p JOIN meeting_people mp ON mp.person_id=p.id WHERE mp.meeting_id=? ORDER BY p.name', call.id) : [];
  const callIds = new Set(callPeople.map(p => Number(p.id)));
  const calls = req.admin && !call && !person && !team ? await all("SELECT m.*, (SELECT string_agg(p.name, ', ') FROM meeting_people mp JOIN people p ON p.id=mp.person_id WHERE mp.meeting_id=m.id) names FROM meetings m WHERE m.workspace_id=? AND m.status<>'done' AND m.starts_at BETWEEN ? AND ? ORDER BY m.starts_at LIMIT 8", req.ws.id, t + ' 00:00:00', U.addDays(t, 1) + ' 12:00:00') : [];
  const involves = (i, pid) => Number(i.person_id) === pid || Number(i.owner_person_id) === pid || String(i.shared_ids || '').split(',').includes(String(pid));
  const counts = {}; for (const i of openAll) for (const pid of new Set([i.person_id, i.owner_person_id, ...String(i.shared_ids || '').split(',')].filter(Boolean).map(Number))) counts[pid] = (counts[pid] || 0) + 1;
  const chips = people.filter(p => counts[p.id]).sort((a, b) => counts[b.id] - counts[a.id]).slice(0, 14);
  let list = openAll;
  if (person) list = openAll.filter(i => involves(i, fp));
  if (team) list = openAll.filter(i => involves(i, ft) && !(Number(i.person_id) === ft && i.owner_person_id && Number(i.owner_person_id) !== ft));
  if (call) list = openAll.filter(i => [...callIds].some(pid => involves(i, pid)));
  const view = { team: team ? ft : null };
  const cols = columnsFor(req, view).map(([title, key]) => [title, key, []]);
  for (const i of list) cols.find(c => c[1] === columnFor(req, i, view))[2].push(i);
  const back = call ? `/?call=${call.id}` : person ? `/?person=${person.id}` : team ? `/?team=${team.id}` : '/';
  const ctx = { back, view, nudges: req.admin ? await W.nudgeCounts(req.ws.id) : {}, comments: await commentInfo(req.ws.id), vendors: await vendorInfo(req.ws.id) };
  const pn = (person || team) && req.admin ? await W.personNudges(req.ws.id, (person || team).id) : null;
  const chip = (p, q = 'person') => html`<a class="name-chip ${(q === 'person' ? fp : ft) === Number(p.id) ? 'on' : ''}" href="/?${q}=${p.id}">${A.avatar(p)}<span>${first(p.name)}</span>${q === 'person' ? html`<b>${counts[p.id]}</b>` : ''}</a>`;
  const reports = people.filter(p => p.relation === 'report');
  const doneToday = Number((await one(`SELECT count(*) n FROM items i WHERE ${s.sql} AND i.status='done' AND i.completed_at >= ?`, ...s.args, t + ' 00:00:00')).n);
  const late = list.filter(i => columnFor(req, i, view) === 'today' && i.due_on && i.due_on < t).length;
  const connReqs = !person && !team && !call ? Number((await one("SELECT count(*) n FROM connections WHERE to_user=? AND status='pending'", req.user.id)).n) : 0;
  const rems = !person && !team && !call ? await all('SELECT * FROM reminders WHERE user_id=? AND workspace_id=? AND done_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT 6', req.user.id, req.ws.id, U.addDays(t, 1) + ' 06:00:00') : [];
  const searchBox = html`<form method="get" action="/search" class="board-search" role="search"><label class="sr" for="bs">Search</label><input id="bs" name="q" placeholder="🔍 Find a note, project or person" maxlength="100"><button class="btn">Find</button></form>`;
  const boardHtml = html`<div class="move-tray" data-tray aria-hidden="true">📥 Drop a note here to choose where it goes</div>
    <div class="board ${person ? 'filtered' : ''}" data-board="${team ? team.id : ''}">${cols.filter(c => !person || c[2].length).map(([title, key, items]) => html`<section class="col col-${key}" data-drop="${key}"><h2>${title} <span class="count" data-count>${items.length}</span></h2>${colHtml(req, items, ctx, key)}</section>`)}</div>
    ${mover(req)}${sharer(req, shareList)}`;
  let body;
  if (call) body = html`<div class="board-head"><div><p class="eyebrow">📞 <span data-utc="${call.starts_at || ''}">${call.starts_at ? U.fmtDateTime(call.starts_at) : ''}</span></p><h1>${call.title}</h1>
      <p class="lead">With ${callPeople.map(p => first(p.name)).join(', ') || 'nobody yet'}. Here's what to ask and tell each of them. Tap ✓ Done as you go.</p></div><a class="btn big" href="/">← Back to my whole board</a></div>
      ${callPeople.map(p => { const mine = list.filter(i => involves(i, Number(p.id))); return html`<section class="card call-person"><h2>${A.avatar(p)} ${p.name} <span class="count">${mine.length}</span></h2>
        ${mine.length ? html`<ul class="notes notes-row">${mine.map(i => sticky(req, i, ctx))}</ul>` : html`<p class="muted">Nothing for ${first(p.name)} right now.</p>`}</section>`; })}
      <details class="card new-note-card"><summary class="btn primary big">＋ Add a note from this call</summary>${newNoteForm(req, { person: callPeople[0] || null, people, back })}</details>
      <form method="post" action="/calls/${call.id}/end" class="center">${csrf(req)}<button class="btn big">Call's over: write the summary</button></form>${mover(req)}${sharer(req, shareList)}`;
  else if (team) body = html`<div class="board-head"><div><h1>${A.avatar(team, 'lg')} ${first(team.name)}'s board</h1>
      <p class="lead">What ${first(team.name)} sees. Drag a note into <b>Do today</b> to make it ${first(team.name)}'s priority, or tap 💬 to help with a blocker.${pn && pn.week ? html` You've nudged ${first(team.name)} ${pn.week} time${pn.week === 1 ? '' : 's'} this week.` : ''}</p></div>
      <div class="actions"><a class="btn big" href="/?person=${team.id}">What I need from ${first(team.name)}</a><a class="btn big" href="/">← My board</a></div></div>
      <details class="card new-note-card"><summary class="btn primary big">＋ Give ${first(team.name)} something to do</summary>${newNoteForm(req, { people, back, forTeam: team })}</details>
      ${boardHtml}`;
  else body = html`<div class="board-head"><div><h1>${person ? `Everything for ${first(person.name)}` : `Hi ${first(req.user.name)}`}</h1>
      <p class="lead">${person ? html`Talking to ${first(person.name)}? Here's everything you need. Tap ✓ Done as you go.${pn && pn.week ? html` <b>You've nudged ${first(person.name)} ${pn.week} time${pn.week === 1 ? '' : 's'} this week.</b>` : ''}` : html`${doneToday ? html`You've knocked out <b>${doneToday}</b> today. ` : ''}${late ? html`<b class="red-text">${late} ${late === 1 ? 'note is' : 'notes are'} late.</b> ` : ''}Drag notes between columns (on a tablet or phone, press and hold first), or tap ✓ Done when something's finished.`}</p></div>
      ${person ? html`<div class="actions">${req.admin ? html`<a class="btn big" href="/?team=${person.id}">Open ${first(person.name)}'s board</a>` : ''}<a class="btn big" href="/">← Back to my whole board</a></div>` : searchBox}</div>
    ${connReqs ? html`<a class="card hot conn-banner" href="/connect">🤝 <b>${connReqs} ${connReqs === 1 ? 'person wants' : 'people want'} to connect with you.</b> Tap to accept or decline.</a>` : ''}
    ${rems.length ? html`<section class="card rem-strip"><h2>⏰ Reminders</h2><ul class="rows">${rems.map(r => html`<li><b class="big-text">${r.text}</b><div class="actions"><form method="post" action="/reminders/${r.id}/done">${csrf(req)}<input type="hidden" name="back" value="/"><button class="btn primary">✓ Done</button></form><form method="post" action="/reminders/${r.id}/snooze">${csrf(req)}<input type="hidden" name="back" value="/"><button class="btn">Tomorrow</button></form></div></li>`)}</ul></section>` : ''}
    ${chips.length && !person ? html`<nav class="name-strip" aria-label="Show notes for one person"><span class="strip-label">Talking to someone? Tap their name:</span>
      ${chips.slice(0, 8).map(p => chip(p))}${chips.length > 8 ? html`<details class="more-names"><summary class="name-chip">More names ▾</summary><div class="name-strip">${chips.slice(8).map(p => chip(p))}</div></details>` : ''}</nav>` : ''}
    ${req.admin && reports.length && !person ? html`<details class="team-boards"><summary class="btn">👥 See a team member's board ▾</summary><div class="name-strip">${reports.map(p => chip(p, 'team'))}</div></details>` : ''}
    ${person && !list.length ? html`<section class="card"><p class="big-text">Nothing open for ${first(person.name)}. Write a new note below if something comes up.</p></section>` : ''}
    <details class="card new-note-card" ${!openAll.length ? raw('open') : ''}><summary class="btn primary big">＋ Write a new note</summary>${newNoteForm(req, { person, people, back })}</details>
    ${req.admin && !person ? html`<section class="card calls-today"><div class="card-head"><h2>📞 My calls today</h2></div>
      ${calls.length ? html`<ul class="rows">${calls.map(c => html`<li><a href="/?call=${c.id}"><b class="big-text"><span data-utc="${c.starts_at}" data-fmt="time">${U.fmtDateTime(c.starts_at)}</span> · ${c.title}</b><span>${c.names || 'Add who is on it'}</span></a><a class="btn primary" href="/?call=${c.id}">What to say</a></li>`)}</ul>` : html`<p class="muted">No calls listed for today.</p>`}
      <details class="plan-call"><summary class="btn">＋ List a call</summary><form method="post" action="/board/call" class="stack" data-tz>${csrf(req)}
        <label>What's the call?<input name="title" required maxlength="120" placeholder="GCP migration standup"></label>
        <div class="two"><fieldset class="big-choices"><legend>Day</legend><label class="big-choice"><input type="radio" name="day" value="today" checked><span>Today</span></label><label class="big-choice"><input type="radio" name="day" value="tomorrow"><span>Tomorrow</span></label></fieldset>
          <label>Time<input type="time" name="time" value="14:00" required></label></div>
        <fieldset><legend>Who's on it?</legend><div class="pick-people big-pick">${people.map(p => html`<label class="check"><input type="checkbox" name="person" value="${p.id}"><span>${p.name}</span></label>`)}</div></fieldset>
        <button class="btn primary big">Save the call</button><p class="muted small">At the time of the call, Knockout reminds you with everything to ask and tell.</p></form></details></section>` : ''}
    ${boardHtml}
    <p class="center muted small">Want everything (charts, capacity, calls)? Open your account menu → <b>Full view</b>.</p>`;
  res.send(await page(req, { title: team ? `${first(team.name)}'s board` : 'My board', wide: true, body }));
}
/** The "Share" chooser: tap a name and the note is shared with them (they see it on their board and get a 🔔). */
const sharePeople = req => all("SELECT id, name, relation, user_id FROM people WHERE workspace_id=? AND active=1 AND id<>? ORDER BY CASE relation WHEN 'peer' THEN 0 WHEN 'report' THEN 1 WHEN 'boss' THEN 2 ELSE 3 END, name", req.ws.id, req.me?.id || 0);
function sharer(req, people) {
  const groups = [['peer', 'Peers'], ['report', 'My team'], ['boss', 'My boss'], ['other', 'Others']].map(([k, l]) => [l, people.filter(p => (k === 'other' ? !['peer', 'report', 'boss'].includes(p.relation) : p.relation === k))]).filter(g => g[1].length);
  return html`<dialog class="mover sharer" id="sharer"><form method="dialog" class="stack">${csrf(req)}<p class="big-q">Share “<span data-sharer-title></span>” with…</p>
    ${people.length > 8 ? html`<input type="search" data-sharer-filter placeholder="Type a name" aria-label="Find a person" autocomplete="off">` : ''}
    ${groups.map(([l, ps]) => html`<fieldset class="big-choices"><legend>${l}</legend>${ps.map(p => html`<button type="button" class="btn big-choice-btn" data-share-to="${p.id}" data-name="${p.name}">${A.avatar(p)} ${p.name}${p.user_id ? '' : html` <small class="muted">(no account)</small>`}</button>`)}</fieldset>`)}
    <p class="muted small">They see it on their board with everything on it, and get a 🔔. People without an account will see it once they join.</p>
    <div class="actions"><button class="btn" value="cancel">Cancel</button></div></form></dialog>`;
}
/** The "Move…" chooser: one dialog on the page, filled in for whichever note you drop or tap. */
function mover(req) {
  const b = (to, label, cls = '') => html`<button type="button" class="btn big-choice-btn ${cls}" data-to="${to}">${label}</button>`;
  return html`<dialog class="mover" id="mover"><form method="dialog" class="stack">${csrf(req)}<p class="big-q">Move “<span data-mover-title></span>”</p>
    <fieldset class="big-choices"><legend>When?</legend>${b('today', 'Today')}${b('tomorrow', 'Tomorrow')}${b('week', 'This week')}${b('next', 'Next week')}${b('later', 'Later (no date)')}</fieldset>
    <div class="inline-row"><label class="grow">Or pick a date<input type="date" data-mover-date></label><button type="button" class="btn" data-to="date">Set date</button></div>
    <fieldset class="big-choices"><legend>Is it waiting on something?</legend>${b('waiting', 'Waiting / blocked')}${b('unwait', 'Not waiting')}</fieldset>
    <fieldset class="big-choices"><legend>What is it?</legend>${b('task', 'Task')}${b('ask', 'Ask')}${b('update', 'Update')}${b('tell', 'Tell')}</fieldset>
    <div class="actions"><a class="btn" data-mover-open href="#">Open the note</a><button class="btn" value="cancel">Cancel</button></div></form></dialog>`;
}

// ───────────── moving a note ─────────────
async function canMove(req, i) { return req.admin || Number(i.owner_person_id) === Number(req.me?.id) || (!i.owner_person_id && Number(i.created_by) === Number(req.user.id)) || !!(await one('SELECT 1 x FROM item_people WHERE item_id=? AND person_id=?', i.id, req.me?.id || -1)); }
async function applyMove(req, i, to, date) {
  const set = {}, words = [];
  const reopen = () => { if (WAITING.includes(i.status)) set.status = 'open'; };
  if (['today', 'tomorrow', 'week', 'next'].includes(to)) { set.due_on = whenFor(to); reopen(); words.push(`due ${U.fmtDate(set.due_on)}`); }
  else if (to === 'later') { set.due_on = null; reopen(); words.push('no date (later)'); }
  else if (to === 'date') { if (!U.isDate(date)) bad('Pick a date.'); set.due_on = date; reopen(); words.push(`due ${U.fmtDate(date)}`); }
  else if (to === 'waiting' || to === 'wait') { set.status = 'waiting'; words.push('waiting / blocked'); }
  else if (to === 'unwait') { set.status = 'open'; words.push('not waiting'); }
  else if (['task', 'ask', 'update', 'tell'].includes(to)) { set.kind = to; words.push(A.KIND[to][0].toLowerCase()); }
  else if (to === 'talk') { if (i.kind === 'task') return { needKind: true }; if (i.due_on && i.due_on <= U.today()) set.due_on = null; reopen(); words.push('to talk about'); }
  else bad('Pick where it goes.');
  const keys = Object.keys(set); if (!keys.length) return {};
  await run(`UPDATE items SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=ko_now() WHERE id=?`, ...keys.map(k => set[k]), i.id);
  await W.event(req.ws.id, i.id, 'moved', words.join(', '), W.actorName(req));
  if (set.status === 'waiting' && !req.admin) for (const m of await A.managers(req.ws.id)) await A.notify(m.id, `🚧 ${req.user.name} is blocked / waiting on: ${i.title}`, '/items/' + i.id, 'blocked');
  if (set.status === 'open' && WAITING.includes(i.status)) {
    if (!req.admin) for (const m of await A.managers(req.ws.id)) await A.notify(m.id, `✅ Blocker cleared: ${i.title} (${req.user.name})`, '/items/' + i.id, 'unblocked');
    else if (i.owner_person_id) { const o = await W.personIn(req.ws.id, i.owner_person_id); if (o?.user_id && Number(o.user_id) !== Number(req.user.id)) await A.notify(o.user_id, `✅ ${req.user.name} cleared the blocker on: ${i.title}`, '/items/' + i.id, 'unblocked'); }
  }
  if (req.admin && i.owner_person_id) { const o = await W.personIn(req.ws.id, i.owner_person_id); if (o?.user_id && Number(o.user_id) !== Number(req.user.id)) await A.notify(o.user_id, `${req.user.name} moved “${i.title}”: ${words.join(', ')}`, '/items/' + i.id, 'assigned'); }
  return { changed: words.join(', ') };
}
app.post('/items/:id/move', async (req, res) => {
  A.wsRequired(req); const i = await W.getItem(req, req.params.id); if (!(await canMove(req, i))) A.deny('Only the owner or your manager can move this note.');
  const r = await applyMove(req, i, String(req.body.to || ''), req.body.date);
  const wantsJson = (req.headers.accept || '').includes('application/json');
  if (r.needKind) { if (wantsJson) return res.json({ needKind: true }); bad('Pick whether it’s an Ask, Update or Tell.'); }
  const fresh = (await all(`${W.LIST_SQL.replace('shared_names', "shared_names, (SELECT string_agg(CAST(ip2.person_id AS TEXT), ',') FROM item_people ip2 WHERE ip2.item_id=i.id) shared_ids")} WHERE i.id=?`, i.id))[0];
  const view = { team: req.admin && Number(req.body.board) ? Number(req.body.board) : null }, back = view.team ? `/?team=${view.team}` : '/';
  if (wantsJson) return res.json({ ok: true, col: columnFor(req, fresh, view), html: String(sticky(req, fresh, { back, view, nudges: req.admin ? await W.nudgeCounts(req.ws.id) : {}, comments: await commentInfo(req.ws.id), vendors: await vendorInfo(req.ws.id) })), message: r.changed ? `Moved: ${r.changed}` : 'No change' });
  flash(res, r.changed ? `Moved: ${r.changed}.` : 'No change.'); res.redirect(back);
});
app.get('/items/:id/move', async (req, res) => {
  A.wsRequired(req); const i = await W.getItem(req, req.params.id); if (!(await canMove(req, i))) A.deny();
  const f = (to, label, extra = '') => html`<form method="post" action="/items/${i.id}/move">${csrf(req)}<input type="hidden" name="to" value="${to}"><input type="hidden" name="board" value="${req.query.board || ''}">${raw(extra)}<button class="btn big">${label}</button></form>`;
  res.send(await page(req, { title: 'Move', body: html`<h1>Move “${i.title}”</h1><section class="card stack"><h2>When?</h2><div class="actions">${f('today', 'Today')}${f('tomorrow', 'Tomorrow')}${f('week', 'This week')}${f('next', 'Next week')}${f('later', 'Later (no date)')}</div>
    <form method="post" action="/items/${i.id}/move" class="inline-row">${csrf(req)}<input type="hidden" name="to" value="date"><input type="hidden" name="board" value="${req.query.board || ''}"><label class="grow">Pick a date<input type="date" name="date" required></label><button class="btn big">Set date</button></form>
    <h2>Is it waiting on something?</h2><div class="actions">${f('waiting', 'Waiting / blocked')}${f('unwait', 'Not waiting')}</div>
    <h2>What is it?</h2><div class="actions">${f('task', 'Task')}${f('ask', 'Ask')}${f('update', 'Update')}${f('tell', 'Tell')}</div></section>` }));
});
app.post('/items/:id/comment', async (req, res) => {
  A.wsRequired(req); const i = await W.getItem(req, req.params.id), text = String(req.body.text || '').trim().slice(0, 1000); if (!text) bad('Write a comment.');
  await W.event(req.ws.id, i.id, 'note', text, W.actorName(req)); await run('UPDATE items SET updated_at=ko_now() WHERE id=?', i.id);
  const tell = new Set();
  for (const pid of [i.owner_person_id, i.person_id, ...(await all('SELECT person_id FROM item_people WHERE item_id=?', i.id)).map(r => r.person_id)].filter(Boolean)) { const p = await W.personIn(req.ws.id, pid); if (p?.user_id) tell.add(Number(p.user_id)); }
  if (!req.admin) for (const m of await A.managers(req.ws.id)) tell.add(Number(m.id));
  tell.delete(Number(req.user.id));
  for (const u of tell) await A.notify(u, `💬 ${first(req.user.name)} on “${i.title}”: ${text.slice(0, 120)}`, '/items/' + i.id, 'comments');
  const n = Number((await one("SELECT count(*) n FROM item_events WHERE item_id=? AND kind='note'", i.id)).n);
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true, n, actor: first(req.user.name), text });
  flash(res, 'Comment sent.'); res.redirect(String(req.body.back || '').match(/^\/(\?(person|team|call)=\d+)?$/) ? req.body.back : '/');
});

// ───────────── search ─────────────
app.get('/search', async (req, res) => {
  A.wsRequired(req); const shareList = await sharePeople(req);
  const q = String(req.query.q || '').trim().slice(0, 100), like = '%' + q.replace(/[%_]/g, '') + '%', s = W.scope(req);
  const items = q ? await all(`${W.LIST_SQL} WHERE ${s.sql} AND (i.title ILIKE ? OR i.details ILIKE ? OR i.answer ILIKE ? OR EXISTS(SELECT 1 FROM item_events e WHERE e.item_id=i.id AND e.kind='note' AND e.text ILIKE ?)) ORDER BY i.status='done', ${W.ORDER} LIMIT 60`, ...s.args, like, like, like, like) : [];
  const ppl = q && req.admin ? await all('SELECT * FROM people WHERE workspace_id=? AND active=1 AND (name ILIKE ? OR email ILIKE ? OR role ILIKE ? OR team ILIKE ? OR handle ILIKE ?) ORDER BY name LIMIT 30', req.ws.id, like, like, like, like, like) : [];
  const projs = q ? await all('SELECT * FROM projects WHERE workspace_id=? AND (name ILIKE ? OR tag ILIKE ? OR goal ILIKE ?) ORDER BY status=\'done\', name LIMIT 30', req.ws.id, like.replace(/^%#/, '%'), like.replace(/^%#/, '%'), like) : [];
  const ctx = { back: '/search?q=' + encodeURIComponent(q), comments: await commentInfo(req.ws.id), vendors: await vendorInfo(req.ws.id), nudges: req.admin ? await W.nudgeCounts(req.ws.id) : {} };
  res.send(await page(req, { title: q ? `“${q}”` : 'Search', wide: true, body: html`<h1>Find</h1>
    <form method="get" action="/search" class="board-search big-search" role="search"><label class="sr" for="sq">Search</label><input id="sq" name="q" value="${q}" placeholder="A note, project or person" autofocus maxlength="100"><button class="btn primary">Find</button></form>
    ${!q ? html`<p class="muted">Type a word from a note, a project name or #tag, or a person's name, role or team.</p>` : !items.length && !ppl.length && !projs.length ? html`<section class="card">${A.empty(`Nothing matches “${q}”.`)}</section>` : ''}
    ${ppl.length ? html`<section class="card"><h2>People</h2><ul class="rows">${ppl.map(p => html`<li><a href="/?person=${p.id}">${A.avatar(p)}<b class="big-text">${p.name}</b><span>${[p.role, p.team].filter(Boolean).join(' · ')}</span></a><div class="actions"><a class="btn" href="/?person=${p.id}">Notes for ${first(p.name)}</a><a class="btn" href="/?team=${p.id}">${first(p.name)}'s board</a></div></li>`)}</ul></section>` : ''}
    ${projs.length ? html`<section class="card"><h2>Projects</h2><ul class="rows">${projs.map(p => html`<li><a href="/projects/${p.id}"><b class="big-text">${p.name}</b><span>#${p.tag}${p.due_on ? ' · due ' + U.fmtDate(p.due_on) : ''}${p.status === 'done' ? ' · done' : ''}</span></a></li>`)}</ul></section>` : ''}
    ${items.length ? html`<section class="card"><h2>Notes <span class="count">${items.length}</span></h2><ul class="notes notes-row">${items.map(i => i.status === 'done' ? html`<li class="note n-${i.kind} is-done-note"><p class="note-kind">Done ${U.fmtDate(i.completed_at)}</p><a class="note-title" href="/items/${i.id}">${i.title}</a><p class="note-owner">👤 ${owners(req, i)}</p></li>` : sticky(req, i, ctx))}</ul></section>` : ''}
    ${mover(req)}${sharer(req, shareList)}` }));
});

// ───────────── adding ─────────────
app.get('/board/new', async (req, res) => {
  A.wsRequired(req);
  const people = await all('SELECT id, name FROM people WHERE workspace_id=? AND active=1 ORDER BY name', req.ws.id);
  res.send(await page(req, { title: 'New note', body: html`<h1>New note</h1><section class="card">${newNoteForm(req, { people, back: '/' })}</section>` }));
});
app.post('/board/add', async (req, res) => {
  A.wsRequired(req);
  const text = String(req.body.text || '').trim(); if (!text) bad('Write what you need to remember.');
  const [firstLine, ...rest] = text.split('\n');
  const forTeam = req.admin && req.body.owner_person_id ? await W.personIn(req.ws.id, req.body.owner_person_id) : null;
  const id = await W.createItem(req, { kind: forTeam ? 'task' : TYPES.some(x => x[0] === req.body.kind) ? req.body.kind : 'task', title: firstLine.slice(0, 140), details: [firstLine.length > 140 ? firstLine.slice(140) : '', rest.join('\n')].join('\n').trim() || null,
    person_id: forTeam ? null : req.body.person_id, owner_person_id: forTeam?.id, due_on: whenFor(req.body.when), via: forTeam ? 'on their board' : 'on the board' });
  const vendor = req.admin && ['pro', 'team'].includes(req.ws.plan) ? String(req.body.vendor || '').trim().slice(0, 80) : '';
  if (vendor) {
    const days = [3, 7, 14, 30].includes(Number(req.body.vendor_days)) ? Number(req.body.vendor_days) : 7;
    await run('INSERT INTO links(workspace_id,token,item_id,who,expires_on) VALUES(?,?,?,?,?)', req.ws.id, U.token(24), id, vendor, U.addDays(U.today(), days));
    await W.event(req.ws.id, id, 'link made', `For ${vendor} · works ${days} days`, W.actorName(req));
    flash(res, `🔗 Link made for ${vendor}. Copy it and send it to them.`); return res.redirect(`/items/${id}#links`);
  }
  flash(res, forTeam ? `📌 On ${first(forTeam.name)}'s board.` : '📌 On your board.');
  const b = String(req.body.back || '/'); res.redirect(/^\/(\?(person|team)=\d+)?$/.test(b) ? b : '/');
});
app.post('/board/call', async (req, res) => {
  A.adminOnly(req);
  const title = String(req.body.title || '').trim().slice(0, 120); if (!title) bad('What is the call?');
  const day = req.body.day === 'tomorrow' ? U.addDays(U.today(), 1) : U.today();
  const at = require('./notes').toUtc(day, req.body.time, req.body.tz);
  const kind = [].concat(req.body.person || []).length === 1 ? 'one_on_one' : 'team';
  const id = (await run("INSERT INTO meetings(workspace_id,title,kind,starts_at,status) VALUES(?,?,?,?,'planned')", req.ws.id, title, kind, at)).id;
  for (const pid of [].concat(req.body.person || []).slice(0, 60)) if (await W.personIn(req.ws.id, pid)) await run('INSERT INTO meeting_people(meeting_id,person_id) VALUES(?,?) ON CONFLICT DO NOTHING', id, pid);
  flash(res, `📞 ${title} is on your list.`); res.redirect('/');
});
/** Every minute: a call starting within 5 minutes → a notification with how many things to ask and tell each person. */
async function callReminders() {
  const soon = new Date(Date.now() + 5 * 60e3).toISOString().slice(0, 19).replace('T', ' '), recent = new Date(Date.now() - 30 * 60e3).toISOString().slice(0, 19).replace('T', ' ');
  for (const m of await all("SELECT * FROM meetings WHERE status='planned' AND reminded_at IS NULL AND starts_at BETWEEN ? AND ? LIMIT 200", recent, soon)) {
    const ppl = await all('SELECT p.id, p.name FROM people p JOIN meeting_people mp ON mp.person_id=p.id WHERE mp.meeting_id=?', m.id);
    const bits = [];
    for (const p of ppl) { const n = Number((await one(`SELECT count(*) n FROM items WHERE workspace_id=? AND status IN ${W.OPEN} AND (person_id=? OR owner_person_id=?)`, m.workspace_id, p.id, p.id)).n); if (n) bits.push(`${first(p.name)} ${n}`); }
    for (const u of await A.managers(m.workspace_id)) await A.notify(u.id, `📞 ${m.title} is starting${bits.length ? ' · notes for ' + bits.join(', ') : ''}`, '/?call=' + m.id, 'calls');
    await run('UPDATE meetings SET reminded_at=ko_now() WHERE id=?', m.id);
  }
}
app.post('/view', async (req, res) => {
  A.loginRequired(req); const mode = req.body.mode === 'full' ? 'full' : 'simple';
  await run('UPDATE users SET view_mode=? WHERE id=?', mode, req.user.id);
  flash(res, mode === 'full' ? 'Full view: everything is here. Switch back any time from your account menu.' : 'Simple view: your board of sticky notes.'); res.redirect('/');
});
module.exports = { board, callReminders, columnFor };
