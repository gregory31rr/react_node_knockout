/**
 * lib/work.js — the rules of Knockout: who sees what, creating and changing items, knocking them out,
 * reopening, delegating, timeline risk and LOE rollups.
 *
 * WHO SEES WHAT
 *   The manager (workspace admin) sees everything in the workspace.
 *   A team member with an account sees items they own, items that are for/about them, and items they created.
 *   Someone with an outside link (paid plan) sees only that one item.
 *
 * TIMELINE RISK (risk())
 *   For each owner (you, or a person) take their open items with a due date, in due-date order, and add up the LOE
 *   still left (estimate minus time already logged). If that total is more than the working hours they have until
 *   the due date (workdays × hours per day), the item is "at risk": it will be missed unless something moves.
 *   Past-due items are "overdue". Knockout then suggests who could take it (the person with the most free hours).
 */
const { one, all, run, tx } = require('./db');
const U = require('./util');
const A = require('./app');

const OPEN = "('open','doing','waiting','blocked')";
/**
 * SQL (with ? values) limiting items to what this person may see. Use as: WHERE ${s.sql} … with ...s.args
 * A team member's access (set on their People page): own = their items · projects = plus everything on projects they work on ·
 * team = plus everything owned by people on their team · all = everything (but no manager controls). Private items are
 * never shown to members (only managers and whoever wrote them).
 */
function scope(req, alias = 'i') {
  const a = alias;
  if (req.admin) return { sql: `${a}.workspace_id=?`, args: [req.ws.id] };
  const me = req.me?.id || -1, uid = req.user?.id || -1, access = req.me?.access || 'own';
  const own = `${a}.owner_person_id=? OR ${a}.person_id=? OR ${a}.created_by=? OR ${a}.id IN (SELECT ip.item_id FROM item_people ip WHERE ip.person_id=?)`, args = [req.ws.id, me, me, uid, me];
  let more = '';
  if (access === 'projects') { more = ` OR ${a}.project_id IN (SELECT x.project_id FROM items x WHERE x.owner_person_id=? AND x.project_id IS NOT NULL)`; args.push(me); }
  if (access === 'team') { more = ` OR ${a}.owner_person_id IN (SELECT y.id FROM people y WHERE y.workspace_id=? AND y.team IS NOT NULL AND y.team=(SELECT z.team FROM people z WHERE z.id=?))`; args.push(req.ws.id, me); }
  if (access === 'all') more = ' OR 1=1';
  args.push(uid);
  return { sql: `${a}.workspace_id=? AND (${own}${more}) AND (${a}.private=0 OR ${a}.created_by=?)`, args };
}
async function canSee(req, item) {
  if (!item || Number(item.workspace_id) !== Number(req.ws.id)) return false;
  if (req.admin) return true;
  const s = scope(req);
  return !!(await one(`SELECT 1 x FROM items i WHERE i.id=? AND ${s.sql}`, item.id, ...s.args));
}
async function getItem(req, id) {
  const it = await one(`SELECT i.*, p.name person_name, p.handle person_handle, o.name owner_name, o.handle owner_handle, o.email owner_email, o.user_id owner_user_id,
      (SELECT string_agg(sp.name, ', ') FROM item_people ip JOIN people sp ON sp.id=ip.person_id WHERE ip.item_id=i.id) shared_names,
      pr.name project_name, pr.tag project_tag, (SELECT COALESCE(sum(hours),0) FROM time_logs t WHERE t.item_id=i.id) spent
    FROM items i LEFT JOIN people p ON p.id=i.person_id LEFT JOIN people o ON o.id=i.owner_person_id LEFT JOIN projects pr ON pr.id=i.project_id WHERE i.id=?`, id);
  if (!(await canSee(req, it))) A.notFound();
  return it;
}
/** The columns every list shows, with names joined in. */
const LIST_SQL = `SELECT i.*, p.name person_name, p.handle person_handle, o.name owner_name, o.handle owner_handle, pr.name project_name, pr.tag project_tag,
    (SELECT COALESCE(sum(hours),0) FROM time_logs t WHERE t.item_id=i.id) spent,
    (SELECT string_agg(sp.name, ', ') FROM item_people ip JOIN people sp ON sp.id=ip.person_id WHERE ip.item_id=i.id) shared_names
  FROM items i LEFT JOIN people p ON p.id=i.person_id LEFT JOIN people o ON o.id=i.owner_person_id LEFT JOIN projects pr ON pr.id=i.project_id`;
const ORDER = `CASE WHEN i.due_on IS NULL THEN 1 ELSE 0 END, i.due_on, i.priority, i.id`;

const actorName = req => req.linkPerson ? `${req.linkPerson} (link)` : req.user ? req.user.name : 'Someone';
async function event(wsId, itemId, kind, text, actor) { await run('INSERT INTO item_events(item_id,workspace_id,kind,text,actor) VALUES(?,?,?,?,?)', itemId, wsId, kind, text ? String(text).slice(0, 2000) : null, actor || null); }
async function lookups(wsId) {
  return { people: await all('SELECT id, name, handle, email, user_id, relation, role FROM people WHERE workspace_id=? AND active=1 ORDER BY name', wsId),
    projects: await all("SELECT id, name, tag FROM projects WHERE workspace_id=? AND status<>'done' ORDER BY name", wsId) };
}
const num = (v, lo, hi) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : null; };
/** LOE typed as "2", "2h", "30m", "1.5d" → hours */
function loeHours(v) {
  if (v === '' || v == null) return null; const s = String(v).trim().toLowerCase(); const n = parseFloat(s); if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(/d/.test(s) ? n * 8 : /m/.test(s) && !/mo/.test(s) ? Math.round(n / 60 * 100) / 100 : n, 10000);
}
async function personIn(wsId, id) { if (!id) return null; return one('SELECT * FROM people WHERE id=? AND workspace_id=?', id, wsId); }
async function projectIn(wsId, id) { if (!id) return null; return one('SELECT * FROM projects WHERE id=? AND workspace_id=?', id, wsId); }

async function createItem(req, f) {
  const ws = req.ws.id;
  const person = await personIn(ws, f.person_id), owner = await personIn(ws, f.owner_person_id), project = await projectIn(ws, f.project_id);
  const kind = A.KIND[f.kind] ? f.kind : 'task', title = String(f.title || '').trim().slice(0, 300); if (!title) A.bad('Give it a title.');
  if (!req.admin && req.me && !Number(req.me.can_add)) A.deny('Your manager has turned off adding items for your account.');
  // A team member's own new items are theirs unless they hand them to someone.
  const ownerId = owner?.id || (!req.admin && req.me ? req.me.id : null);
  const r = await run(`INSERT INTO items(workspace_id,kind,title,details,project_id,person_id,owner_person_id,priority,loe,due_on,start_on,created_by,meeting_id,status,private,exec)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, kind, title, String(f.details || '').slice(0, 20000) || null, project?.id || null, person?.id || null, ownerId,
    num(f.priority, 1, 4) || 3, loeHours(f.loe), U.isDate(f.due_on) ? f.due_on : null, U.isDate(f.start_on) ? f.start_on : null, req.user?.id || null, f.meeting_id || null, ['waiting', 'doing'].includes(f.status) ? f.status : 'open',
    req.admin && f.private === '1' ? 1 : 0, req.admin && f.exec === '1' ? 1 : 0);
  await event(ws, r.id, 'created', f.via ? `Added ${f.via}` : null, actorName(req));
  if (ownerId && owner) await tellOwner(req, { id: r.id, title, kind }, owner, 'assigned you');
  return r.id;
}
/** Let the owner know (in the app if they have an account). */
async function tellOwner(req, item, owner, verb) {
  if (owner?.user_id && Number(owner.user_id) !== Number(req.user?.id)) await A.notify(owner.user_id, `${actorName(req)} ${verb}: ${item.title}`, '/items/' + item.id, 'assigned');
}
async function knockOut(req, item, how = '') {
  if (item.status === 'done') return;
  await run("UPDATE items SET status='done', completed_at=ko_now(), completed_by=?, updated_at=ko_now() WHERE id=?", actorName(req), item.id);
  await event(item.workspace_id, item.id, 'knocked out', how || null, actorName(req));
  // tell the manager when someone else knocks out an item
  if (!req.admin) for (const m of await A.managers(item.workspace_id)) await A.notify(m.id, `🥊 ${actorName(req)} knocked out: ${item.title}`, '/items/' + item.id, 'done');
}
async function reopen(req, item, note) {
  await run("UPDATE items SET status='open', completed_at=NULL, completed_by=NULL, reopened=reopened+1, updated_at=ko_now() WHERE id=?", item.id);
  await event(item.workspace_id, item.id, 'reopened', note, actorName(req));
}
/** Hand an item to someone: they own it now; the history comes along. */
async function delegate(req, item, to, note) {
  await run("UPDATE items SET owner_person_id=?, status=CASE WHEN status='done' THEN 'open' ELSE status END, delegated_at=ko_now(), updated_at=ko_now() WHERE id=?", to.id, item.id);
  await event(item.workspace_id, item.id, 'delegated', `To ${to.name}${note ? ': ' + note : ''}`, actorName(req));
  await tellOwner(req, item, to, 'handed you');
}

/** Plain-text version of an item with everything someone needs to pick it up (email, Teams paste, link page). */
async function contextText(item, base) {
  const ev = await all('SELECT * FROM item_events WHERE item_id=? ORDER BY id', item.id);
  const lines = [`${A.KIND[item.kind][0]}: ${item.title}`];
  if (item.project_name) lines.push(`Project: ${item.project_name} (#${item.project_tag})`);
  if (item.person_name) lines.push(`For / about: ${item.person_name}`);
  lines.push(`Priority: ${A.PRI[item.priority][2]}${item.due_on ? ` · Due ${U.fmtDate(item.due_on)}` : ''}${item.loe ? ` · LOE ${A.loeText(item.loe)}` : ''}`);
  if (item.details) lines.push('', item.details);
  if (item.answer) lines.push('', `Answer so far: ${item.answer}`);
  const notes = ev.filter(e => ['note', 'answered', 'delegated', 'time'].includes(e.kind) && e.text);
  if (notes.length) lines.push('', 'History:', ...notes.map(e => `- ${U.fmtDate(e.created_at)} ${e.actor || ''}: ${e.text}`));
  if (base) lines.push('', `Open it: ${base}/items/${item.id}`);
  return lines.join('\n');
}

// ───────────── capacity, risk, rollups ─────────────
/** Working days from a to b, both counted (b ≥ a), using the workspace's workdays ("12345" = Mon–Fri). */
function workdays(a, b, days = '12345') {
  if (!a || !b || b < a) return 0;
  let n = 0, d = a; for (let i = 0; i < 730 && d <= b; i++) { const wd = new Date(d + 'T12:00:00Z').getUTCDay() || 7; if (days.includes(String(wd))) n++; d = U.addDays(d, 1); }
  return n;
}
/** risk(ws, items) → Map(itemId → {state:'overdue'|'risk', short: hours missing}) for open items. */
async function risk(ws, items) {
  const today = U.today(), out = new Map();
  const ppl = Object.fromEntries((await all('SELECT id, hours_per_day FROM people WHERE workspace_id=?', ws.id)).map(p => [p.id, p.hours_per_day]));
  const byOwner = {}, offCache = new Map();
  for (const i of items) { if (i.status === 'done') continue; (byOwner[i.owner_person_id || 'me'] = byOwner[i.owner_person_id || 'me'] || []).push(i); }
  for (const [owner, list] of Object.entries(byOwner)) {
    const hpd = owner === 'me' ? ws.hours_per_day : (ppl[owner] || ws.hours_per_day);
    let load = 0;
    for (const i of list.filter(x => x.due_on).sort((a, b) => a.due_on.localeCompare(b.due_on) || a.priority - b.priority)) {
      const left = Math.max(0, Number(i.loe || 0) - Number(i.spent || 0)); load += left;
      if (i.due_on < today) { out.set(i.id, { state: 'overdue', short: left }); continue; }
      if (owner !== 'me' && !offCache.has(i.due_on)) offCache.set(i.due_on, await require('./timeoff').outBetween(ws, today, i.due_on));
      const avail = workdays(today, i.due_on, ws.workdays) * hpd - (owner === 'me' ? 0 : (offCache.get(i.due_on)[owner] || 0));
      if (left > 0 && load > avail + 0.01) out.set(i.id, { state: 'risk', short: Math.round((load - avail) * 10) / 10 });
    }
  }
  return out;
}
/** Everyone's open LOE for the next two weeks vs their hours → who has room. */
async function capacity(ws) {
  const today = U.today(), end = U.addDays(today, 13), hours = workdays(today, end, ws.workdays);
  const rows = await all(`SELECT p.id, p.name, p.handle, p.relation, p.role, p.team, p.hours_per_day, COALESCE(sum(CASE WHEN i.status IN ${OPEN} AND (i.due_on IS NULL OR i.due_on <= ?) THEN GREATEST(COALESCE(i.loe,0) - COALESCE((SELECT sum(t.hours) FROM time_logs t WHERE t.item_id=i.id),0), 0) END),0) load,
      count(CASE WHEN i.status IN ${OPEN} THEN 1 END) open_n
    FROM people p LEFT JOIN items i ON i.owner_person_id=p.id WHERE p.workspace_id=? AND p.active=1 GROUP BY p.id, p.name, p.handle, p.relation, p.role, p.team, p.hours_per_day`, end, ws.id);
  const off = await require('./timeoff').outBetween(ws, today, end);   // PTO, sick days and holidays take hours away
  return rows.map(r => { const off_h = Math.round((off[r.id] || 0) * 10) / 10, cap = Math.max(0, hours * (r.hours_per_day || ws.hours_per_day) - off_h); return { ...r, load: Number(r.load), cap, off: off_h, free: Math.round((cap - Number(r.load)) * 10) / 10, pct: cap ? Math.round(Number(r.load) / cap * 100) : (Number(r.load) ? 999 : 0) }; });
}
/** Who could take this? People (not your boss) with the most free hours, people already on the project first. */
async function suggestFor(ws, item) {
  const cap = (await capacity(ws)).filter(p => !['boss', 'peer'].includes(p.relation) && Number(p.id) !== Number(item.owner_person_id));
  const onProject = item.project_id ? new Set((await all('SELECT DISTINCT owner_person_id id FROM items WHERE project_id=? AND owner_person_id IS NOT NULL', item.project_id)).map(r => Number(r.id))) : new Set();
  return cap.sort((a, b) => (onProject.has(Number(b.id)) - onProject.has(Number(a.id))) || b.free - a.free).slice(0, 4).map(p => ({ ...p, onProject: onProject.has(Number(p.id)) }));
}
/** LOE rollup for a project (and its v1/v2 family when asked). */
async function rollup(projectId) {
  const r = await one(`SELECT count(*) n, count(CASE WHEN status='done' THEN 1 END) done_n, COALESCE(sum(loe),0) loe, COALESCE(sum(CASE WHEN status='done' THEN loe END),0) loe_done,
      COALESCE(sum(CASE WHEN status<>'done' THEN loe END),0) loe_left, count(CASE WHEN status<>'done' AND due_on < ko_today() THEN 1 END) overdue,
      (SELECT COALESCE(sum(t.hours),0) FROM time_logs t JOIN items x ON x.id=t.item_id WHERE x.project_id=?) spent
    FROM items WHERE project_id=?`, projectId, projectId);
  const n = Number(r.n), loe = Number(r.loe);
  return { n, done: Number(r.done_n), loe, loeDone: Number(r.loe_done), loeLeft: Number(r.loe_left), overdue: Number(r.overdue), spent: Number(r.spent),
    pct: loe ? Math.round(Number(r.loe_done) / loe * 100) : n ? Math.round(Number(r.done_n) / n * 100) : 0 };
}
/** Monday of this week (YYYY-MM-DD). */
function weekStart() { const t = U.today(), wd = new Date(t + 'T12:00:00Z').getUTCDay() || 7; return U.addDays(t, 1 - wd); }
/** How many times you nudged someone about each item: { itemId: { week, total } }. */
async function nudgeCounts(wsId) {
  const rows = await all("SELECT item_id, count(*) total, count(CASE WHEN created_at >= ? THEN 1 END) wk FROM item_events WHERE workspace_id=? AND kind='nudged' GROUP BY item_id", weekStart() + ' 00:00:00', wsId);
  return Object.fromEntries(rows.map(r => [Number(r.item_id), { week: Number(r.wk), total: Number(r.total) }]));
}
/** Nudges to one person (on items they own) this week and in total. */
async function personNudges(wsId, personId) {
  const r = await one("SELECT count(*) total, count(CASE WHEN e.created_at >= ? THEN 1 END) wk FROM item_events e JOIN items i ON i.id=e.item_id WHERE e.workspace_id=? AND e.kind='nudged' AND i.owner_person_id=?", weekStart() + ' 00:00:00', wsId, personId);
  return { week: Number(r.wk), total: Number(r.total) };
}
module.exports = { weekStart, nudgeCounts, personNudges, OPEN, scope, canSee, getItem, LIST_SQL, ORDER, event, lookups, createItem, knockOut, reopen, delegate, contextText, workdays, risk, capacity, suggestFor, rollup, loeHours, num, personIn, projectIn, actorName, tellOwner };
