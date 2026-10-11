/**
 * lib/timeoff.js — PTO, sick days, absences and holidays, and how they change who has room.
 *
 *   hoursIn(rec, from, to, ws, hpd)  working hours a time-off record takes out of a date range (remote days take none)
 *   outBetween(ws, from, to)          { personId: hours off } for the range (company holidays count for everyone)
 *   whoIsOut(ws, day)                 records covering that day, with names
 *   balance(ws, person, year)         { allowance, used, planned, left } PTO hours for the calendar year
 */
const { one, all } = require('./db');
const U = require('./util');

const KINDS = { pto: ['PTO', '🌴'], sick: ['Sick', '🤒'], absent: ['Unplanned absence', '⚠'], holiday: ['Holiday', '🎉'], training: ['Training', '🎓'], remote: ['Working remote', '🏠'], other: ['Out', '•'] };
function workdays(a, b, days = '12345') { if (!a || !b || b < a) return 0; let n = 0, d = a; for (let i = 0; i < 800 && d <= b; i++) { const wd = new Date(d + 'T12:00:00Z').getUTCDay() || 7; if (days.includes(String(wd))) n++; d = U.addDays(d, 1); } return n; }
function hoursIn(r, from, to, ws, hpd) {
  if (r.kind === 'remote' || r.status === 'declined') return 0;
  const a = r.start_on > from ? r.start_on : from, b = r.end_on < to ? r.end_on : to; if (b < a) return 0;
  const inRange = workdays(a, b, ws.workdays), all = workdays(r.start_on, r.end_on, ws.workdays) || 1;
  if (r.hours != null) return Math.round(Number(r.hours) * inRange / all * 100) / 100;   // a half day etc.
  return inRange * (hpd || ws.hours_per_day);
}
async function outBetween(ws, from, to) {
  const rows = await all("SELECT t.*, p.hours_per_day FROM time_off t LEFT JOIN people p ON p.id=t.person_id WHERE t.workspace_id=? AND t.status<>'declined' AND t.start_on <= ? AND t.end_on >= ?", ws.id, to, from);
  const ppl = await all('SELECT id, hours_per_day FROM people WHERE workspace_id=? AND active=1', ws.id), out = {};
  for (const r of rows) {
    const targets = r.person_id ? [{ id: r.person_id, hours_per_day: r.hours_per_day }] : ppl;
    for (const p of targets) out[p.id] = (out[p.id] || 0) + hoursIn(r, from, to, ws, p.hours_per_day);
  }
  return out;
}
const whoIsOut = (ws, from, to = from) => all("SELECT t.*, p.name, p.role FROM time_off t LEFT JOIN people p ON p.id=t.person_id WHERE t.workspace_id=? AND t.status<>'declined' AND t.start_on <= ? AND t.end_on >= ? ORDER BY t.start_on, p.name", ws.id, to, from);
async function balance(ws, person, year = Number(U.today().slice(0, 4))) {
  const from = `${year}-01-01`, to = `${year}-12-31`, today = U.today();
  const rows = await all("SELECT * FROM time_off WHERE workspace_id=? AND person_id=? AND kind='pto' AND status<>'declined' AND start_on <= ? AND end_on >= ?", ws.id, person.id, to, from);
  let used = 0, planned = 0;
  for (const r of rows) { used += hoursIn(r, from, today < to ? U.addDays(today, -1) : to, ws, person.hours_per_day); planned += hoursIn(r, today > from ? today : from, to, ws, person.hours_per_day); }
  const allowance = person.pto_hours_year == null ? null : Number(person.pto_hours_year);
  return { allowance, used: Math.round(used * 10) / 10, planned: Math.round(planned * 10) / 10, left: allowance == null ? null : Math.round((allowance - used - planned) * 10) / 10 };
}
module.exports = { KINDS, hoursIn, outBetween, whoIsOut, balance, workdays };
