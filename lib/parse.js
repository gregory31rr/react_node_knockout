/**
 * lib/parse.js — turns one typed line into an item.
 *
 *   "Ask @john about cutover date #gcp p1 2h fri"
 *     → kind: ask, person: John, project: #gcp, priority 1, LOE 2 hours, due this Friday, title "About cutover date"
 *
 * Words it understands (anywhere in the line):
 *   kind       Ask: starts with ask / question, or ends with "?"   Update: "update from", "get an update from", "status on", "check in with", "follow up"
 *              Tell: tell / let … know / remind   Decision: decide   Task: everything else
 *   @name      the person it's for or about (first name, full name with dots, or their @handle)
 *   for @name  hands it to that person to do (they own it); "delegate to @name" works too
 *   #tag       the project
 *   p1..p4     priority (also !1..!4, "urgent", "asap" = P1)
 *   2h 30m 1.5h 1d 3pts   LOE (a day = 8 hours, a point = 1 hour)
 *   due        today, tomorrow, tmrw, mon..sun, this week, next week, eow, eom, 10/15, 2026-10-15, "in 3 days"
 * Nothing is lost: anything it doesn't understand stays in the title.
 */
const U = require('./util');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_RE = /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|sday|urday)?$/i;
function nextWeekday(today, wd, strictlyAfter = false) {
  const d = new Date(today + 'T12:00:00Z'); let add = (wd - d.getUTCDay() + 7) % 7; if (add === 0 && strictlyAfter) add = 7;
  return U.addDays(today, add);
}
function dueFrom(words, today) {
  const w = words.map(x => x.toLowerCase());
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[i + 1] || '';
    const take = (n, d) => ({ i, n, d });
    if (a === 'today' || a === 'eod') return take(1, today);
    if (a === 'tomorrow' || a === 'tmrw' || a === 'tmr') return take(1, U.addDays(today, 1));
    if (a === 'eow' || (a === 'this' && b === 'week')) return take(a === 'eow' ? 1 : 2, nextWeekday(today, 5));
    if (a === 'next' && b === 'week') return take(2, U.addDays(nextWeekday(today, 1, true), 4));
    if (a === 'next' && DAY_RE.test(b)) return take(2, nextWeekday(today, DAYS.indexOf(b.slice(0, 3)), true));
    if (a === 'eom') { const d = new Date(today + 'T12:00:00Z'); return take(1, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)); }
    if (a === 'in' && /^\d+$/.test(b) && /^(day|days|week|weeks)$/.test(w[i + 2] || '')) return { i, n: 3, d: U.addDays(today, Number(b) * (/week/.test(w[i + 2]) ? 7 : 1)) };
    if (DAY_RE.test(a)) return take(1, nextWeekday(today, DAYS.indexOf(a.slice(0, 3))));
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) return take(1, a);
    const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(a);
    if (m) {
      let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(today.slice(0, 4));
      let d = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      if (!m[3] && d < today) d = `${y + 1}-${d.slice(5)}`;   // "1/5" in October means next January
      if (U.isDate(d) && !isNaN(new Date(d))) return take(1, d);
    }
  }
  return null;
}
const KIND_WORDS = [
  [/^(get\s+an?\s+update\s+(from|on)|update\s+from|status\s+(from|on)|check\s+in\s+with|follow[\s-]?up(\s+with)?|f\/u|ping|update)\b/i, 'update'],
  [/^(ask|question|q:|request)\b/i, 'ask'], [/^(tell|let\s+\S+\s+know|remind|inform|share\s+with)\b/i, 'tell'],
  [/^(decide|decision)\b/i, 'decision'], [/^(todo|task)\b:?/i, 'task']];

/**
 * parse(text, { people, projects, today }) → { kind, title, person, owner, project, priority, loe, due, unknown:[] }
 * people: [{id, name, handle}], projects: [{id, tag, name}]
 */
function parse(text, { people = [], projects = [], today = U.today() } = {}) {
  let t = String(text || '').trim().replace(/\s+/g, ' ');
  const out = { kind: 'task', title: '', person: null, owner: null, project: null, priority: null, loe: null, due: null, unknown: [] };
  for (const [re, k] of KIND_WORDS) if (re.test(t)) { out.kind = k; if (k !== 'decision' && (k !== 'tell' || !/^let\s/i.test(t))) t = t.replace(re, '').replace(/^[:\s-]+/, ''); break; }
  if (/\?\s*$/.test(t) && out.kind === 'task') out.kind = 'ask';
  const findPerson = h => {
    const k = h.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (!k) return null;
    return people.find(p => p.handle.toLowerCase() === k) || people.find(p => p.name.toLowerCase().replace(/\s+/g, '.') === k)
      || (people.filter(p => p.name.toLowerCase().split(/\s+/)[0] === k).length === 1 ? people.find(p => p.name.toLowerCase().split(/\s+/)[0] === k) : null)
      || (people.filter(p => p.handle.toLowerCase().startsWith(k)).length === 1 ? people.find(p => p.handle.toLowerCase().startsWith(k)) : null);
  };
  // "for @sam" / "delegate to @sam" / "assign to @sam" → Sam owns it
  t = t.replace(/\b(?:for|delegate\s+to|assign\s+to|owner)\s+@([\w.-]+)/gi, (m, h) => { const p = findPerson(h); if (p) { out.owner = p; return ''; } out.unknown.push('@' + h); return m; });
  t = t.replace(/(^|\s)@([\w.-]+)/g, (m, sp, h) => { const p = findPerson(h); if (p) { if (!out.person) out.person = p; return sp + '\u0001' + p.name.split(' ')[0]; } out.unknown.push('@' + h); return m; });
  t = t.replace(/(^|\s)#([\w-]+)/g, (m, sp, tag) => { const k = tag.toLowerCase(); const p = projects.find(x => x.tag.toLowerCase() === k) || projects.find(x => x.tag.toLowerCase().startsWith(k)); if (p) { out.project = p; return sp; } out.unknown.push('#' + tag); return m; });
  t = t.replace(/(^|\s)(?:p|!)([1-4])\b/gi, (m, sp, n) => { out.priority = Number(n); return sp; });
  t = t.replace(/(^|\s)(urgent|asap)\b/gi, (m, sp) => { out.priority = 1; return sp; });
  t = t.replace(/(^|\s)(\d+(?:\.\d+)?)\s?(h|hr|hrs|hours?|m|min|mins|d|days?|pts?|points?)\b/gi, (m, sp, n, unit) => {
    const u = unit.toLowerCase(), v = Number(n);
    if (/^d/.test(u)) { if (/^days?$/.test(u) && /\bin\s*$/i.test(t.slice(0, t.indexOf(m)))) return m; out.loe = v * 8; }
    else if (/^m/.test(u)) out.loe = Math.round(v / 60 * 100) / 100; else out.loe = v;
    return sp;
  });
  t = t.replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  const d = dueFrom(words, today);
  if (d) { out.due = d.d; let i = d.i, n = d.n; if (i > 0 && /^(by|due|before|on|until)$/i.test(words[i - 1])) { i--; n++; } words.splice(i, n); t = words.join(' '); }
  // a name right at the start ("Ask @john about…", "follow up with @john on…") isn't part of the title
  t = t.replace(/^(?:(?:with|to|from)\s+)?\u0001\S+\s*(?:(?:on|about|re:?|regarding)\s+)?/i, m => /about/i.test(m) ? 'about ' : '').replace(/\u0001/g, '');
  t = t.replace(/\s+([,.;:])/g, '$1').replace(/^(about|re:?|to|that)\s+/i, (m) => /^about/i.test(m) ? 'About ' : '').replace(/\s+(about|to|that|with)\s*$/i, '').trim();
  out.title = t ? t[0].toUpperCase() + t.slice(1) : '';
  if (!out.title) out.title = { ask: 'Question', update: 'Status update', tell: 'Let them know', decision: 'Decision needed', task: 'Task' }[out.kind] + (out.person ? ' from ' + out.person.name.split(' ')[0] : '');
  return out;
}
/** A friendly @handle from a name: "John Smith" → john.smith (made unique by the caller). */
const handleFor = name => String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'person';
/** A #tag from a project name: "GCP Migration" → gcp-migration */
const tagFor = name => String(name || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 24) || 'project';

/**
 * Pasted attendee lists from Teams or Zoom → [{name, email}]. Handles:
 *   "John Smith <john@x.com>; Jane Doe <jane@x.com>"      (Outlook / Teams invite)
 *   one name per line, "John Smith (Guest)", "Jane Doe (Host, me)", "Organizer", "Presenter", mute/camera words
 *   CSV exports from Teams (Full Name, ... Email) and Zoom (Name (original name), User Email, ...)
 */
function attendees(text) {
  const out = [], seen = new Set();
  const push = (name, email) => {
    name = String(name || '').replace(/\((guest|host|co-host|me|external|organizer|presenter|unverified|you)[^)]*\)/gi, '').replace(/\b(organizer|presenter|attendee|host|co-host|muted|unmuted|camera (on|off)|raised hand)\b/gi, '').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
    email = String(email || '').trim().toLowerCase();
    if (!name && email) name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (!name || name.length > 80 || /^(name|full name|participant|participants|attendees?|user email|email|join time|leave time|duration.*)$/i.test(name)) return;
    const k = email || name.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push({ name, email: email || null });
  };
  const src = String(text || '').replace(/\r/g, '');
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1 && /,/.test(lines[0]) && /(name|email)/i.test(lines[0])) {   // a CSV export
    const rows = U.parseCSV(src), head = rows[0].map(h => h.toLowerCase());
    const ni = head.findIndex(h => /name/.test(h)), ei = head.findIndex(h => /e-?mail/.test(h));
    for (const r of rows.slice(1)) push(r[ni], ei >= 0 ? r[ei] : '');
    return out;
  }
  for (const part of src.split(/[;\n]+/)) {
    const p = part.trim(); if (!p) continue;
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(p);
    if (m) { push(m[1], m[2]); continue; }
    const e = /([^\s<>,]+@[^\s<>,]+\.[a-z]{2,})/i.exec(p);
    if (e) { push(p.replace(e[0], '').replace(/[,<>()]/g, ' '), e[1]); continue; }
    for (const n of p.split(/,(?![^()]*\))/)) push(n, '');
  }
  return out;
}
module.exports = { parse, handleFor, tagFor, attendees, dueFrom };
