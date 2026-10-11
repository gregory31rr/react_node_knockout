/**
 * lib/metrics.js — the numbers behind Insights, goals and the weekly / monthly / quarterly updates.
 *
 *   range('week'|'month'|'quarter'|'year', back)  → { from, to, label } (back = 0 this period, 1 last period…)
 *   numbers(ws, { from, to, filter })              → knocked out, LOE done, on-time %, days to knock out, time logged,
 *                                                    added, reopened, still open, late now
 *   filter: { person, project, role, owner:'me' } narrows to one person (what they own), one project, one role, or you.
 */
const { one, all } = require('./db');
const U = require('./util');

function range(kind = 'week', back = 0) {
  const t = new Date(U.today() + 'T12:00:00Z');
  if (kind === 'month') { const a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - back, 1)), b = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0)); return { from: iso(a), to: iso(b), label: a.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), kind }; }
  if (kind === 'quarter') { const q = Math.floor(t.getUTCMonth() / 3) - back, a = new Date(Date.UTC(t.getUTCFullYear(), q * 3, 1)), b = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 3, 0)); return { from: iso(a), to: iso(b), label: `Q${Math.floor(a.getUTCMonth() / 3) + 1} ${a.getUTCFullYear()}`, kind }; }
  if (kind === 'year') { const y = t.getUTCFullYear() - back; return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), kind }; }
  const wd = t.getUTCDay() || 7, from = U.addDays(U.today(), 1 - wd - 7 * back), to = U.addDays(from, 6);
  return { from, to, label: `Week of ${U.fmtDate(from).replace(/, \d{4}$/, '')}`, kind: 'week' };
}
const iso = d => d.toISOString().slice(0, 10);
/** SQL to narrow items to a filter. Returns { sql, args } to AND onto "i.workspace_id=?". */
function where(f = {}) {
  const w = [], a = [];
  if (f.person) { w.push('i.owner_person_id=?'); a.push(Number(f.person)); }
  if (f.owner === 'me') w.push('i.owner_person_id IS NULL');
  if (f.project) { w.push('i.project_id=?'); a.push(Number(f.project)); }
  if (f.role) { w.push('i.owner_person_id IN (SELECT id FROM people WHERE role=? AND workspace_id=i.workspace_id)'); a.push(String(f.role)); }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', args: a };
}
async function numbers(ws, { from, to, filter = {} }) {
  const f = where(filter), end = to + ' 23:59:59', start = from + ' 00:00:00';
  const d = await one(`SELECT count(*) n, COALESCE(sum(loe),0) loe, count(CASE WHEN due_on IS NOT NULL AND substr(completed_at,1,10) <= due_on THEN 1 END) ontime, count(CASE WHEN due_on IS NOT NULL THEN 1 END) dated,
      avg(ko_julianday(completed_at) - ko_julianday(created_at)) cycle
    FROM items i WHERE i.workspace_id=? AND i.status='done' AND i.completed_at BETWEEN ? AND ?${f.sql}`, ws.id, start, end, ...f.args);
  const added = await one(`SELECT count(*) n, COALESCE(sum(loe),0) loe FROM items i WHERE i.workspace_id=? AND i.created_at BETWEEN ? AND ?${f.sql}`, ws.id, start, end, ...f.args);
  const reo = await one(`SELECT count(*) n FROM item_events e JOIN items i ON i.id=e.item_id WHERE e.workspace_id=? AND e.kind='reopened' AND e.created_at BETWEEN ? AND ?${f.sql}`, ws.id, start, end, ...f.args);
  const time = await one(`SELECT COALESCE(sum(t.hours),0) h FROM time_logs t JOIN items i ON i.id=t.item_id WHERE t.workspace_id=? AND COALESCE(t.on_day, substr(t.created_at,1,10)) BETWEEN ? AND ?${f.sql}`, ws.id, from, to, ...f.args);
  const open = await one(`SELECT count(*) n, count(CASE WHEN due_on < ko_today() THEN 1 END) late, COALESCE(sum(loe),0) loe FROM items i WHERE i.workspace_id=? AND i.status<>'done'${f.sql}`, ws.id, ...f.args);
  const dated = Number(d.dated);
  return { done: Number(d.n), loe: Number(d.loe), ontime: dated ? Math.round(Number(d.ontime) / dated * 100) : null, dated, cycle: d.cycle == null ? null : Math.round(Number(d.cycle) * 10) / 10,
    added: Number(added.n), addedLoe: Number(added.loe), reopened: Number(reo.n), time: Number(time.h), open: Number(open.n), late: Number(open.late), openLoe: Number(open.loe) };
}
/** Knocked out per week for the last n weeks (for the column chart). */
async function weekly(ws, n = 12, filter = {}, measure = 'n') {
  const f = where(filter), out = [];
  const first = range('week', n - 1).from;
  const rows = await all(`SELECT substr(i.completed_at,1,10) d, count(*) n, COALESCE(sum(loe),0) loe FROM items i WHERE i.workspace_id=? AND i.status='done' AND i.completed_at >= ?${f.sql} GROUP BY substr(i.completed_at,1,10)`, ws.id, first + ' 00:00:00', ...f.args);
  for (let k = n - 1; k >= 0; k--) {
    const r = range('week', k), v = rows.filter(x => x.d >= r.from && x.d <= r.to).reduce((a, x) => a + Number(measure === 'loe' ? x.loe : x.n), 0);
    out.push({ label: r.label, short: U.fmtDate(r.from).replace(/, \d{4}$/, '').replace(/^(\w{3})\w*/, '$1'), value: Math.round(v * 10) / 10 });
  }
  return out;
}
/** Where a goal stands right now: { value, target, pct, label }. */
async function goalStatus(ws, g) {
  const r = g.period === 'custom' && g.start_on && g.end_on ? { from: g.start_on, to: g.end_on, label: `${U.fmtDate(g.start_on)} – ${U.fmtDate(g.end_on)}` } : range(g.period, 0);
  const filter = { person: g.person_id, project: g.project_id };
  if (g.metric === 'project_done') {
    const R = require('./work'); const ro = g.project_id ? await R.rollup(g.project_id) : { pct: 0 };
    return { value: ro.pct, target: 100, pct: ro.pct, unit: '%', label: r.label, good: ro.pct >= 100 };
  }
  if (g.metric === 'open_max') { const n = await numbers(ws, { ...r, filter }); return { value: n.open, target: g.target, pct: n.open <= g.target ? 100 : Math.round(g.target / Math.max(n.open, 1) * 100), unit: 'open', label: 'right now', good: n.open <= g.target, lower: true }; }
  const n = await numbers(ws, { ...r, filter });
  const value = g.metric === 'items_done' ? n.done : g.metric === 'loe_done' ? Math.round(n.loe * 10) / 10 : (n.ontime ?? 0);
  const pct = Math.min(100, Math.round(value / Math.max(g.target, 0.01) * 100));
  return { value, target: g.target, pct, unit: g.metric === 'items_done' ? 'items' : g.metric === 'loe_done' ? 'h' : '%', label: r.label, good: value >= g.target };
}
module.exports = { range, numbers, weekly, goalStatus, where };
