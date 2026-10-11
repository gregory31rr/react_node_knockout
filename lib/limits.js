/**
 * lib/limits.js — counters every server shares, kept in the database (table ko_counters).
 *
 * Used for "too many tries" limits: sign-in lockout and flood protection on changes. With several
 * servers behind a load balancer, counts kept in one server's memory would let each server allow the full
 * limit, so the real limit would grow with the number of servers. The database is the one thing they share.
 *
 * Time is cut into windows (for example 15 minutes). A count covers the current window plus the one before,
 * so a limit can't be dodged by waiting for a window to roll over: it's a sliding limit of about one window.
 *
 *   await hit('login:e:greg@x.com', 15 * 60e3)   → adds one try, returns tries in the last ~window
 *   await count('login:e:greg@x.com', 15 * 60e3) → tries in the last ~window, without adding one
 *   await reset('login:e:greg@x.com')            → forget this key (after a successful sign-in)
 *   await sweep()                                → delete old windows (hourly job)
 */
const { one, run } = require('./db');

const win = (windowMs, now = Date.now()) => Math.floor(now / windowMs) * windowMs;
// The window length is part of the key, so different limits on the same key never mix.
const k = (key, windowMs) => `${windowMs}:${String(key).slice(0, 300)}`;

/** sliding=false counts only the current window (flood protection's "per minute"). */
async function hit(key, windowMs, { sliding = true } = {}) {
  const w = win(windowMs), kk = k(key, windowMs);
  const r = await one('INSERT INTO ko_counters(key, win, n) VALUES(?, ?, 1) ON CONFLICT(key, win) DO UPDATE SET n = ko_counters.n + 1 RETURNING n', kk, w);
  if (!sliding) return Number(r.n);
  const prev = await one('SELECT n FROM ko_counters WHERE key=? AND win=?', kk, w - windowMs);
  return Number(r.n) + Number(prev?.n || 0);
}
async function count(key, windowMs) {
  const w = win(windowMs);
  const r = await one('SELECT COALESCE(SUM(n), 0) AS n FROM ko_counters WHERE key=? AND win IN (?, ?)', k(key, windowMs), w, w - windowMs);
  return Number(r.n);
}
async function reset(key, windowMs) { await run('DELETE FROM ko_counters WHERE key=?', k(key, windowMs)); }
/** Windows older than two hours can't matter to any limit we use (the longest window is 15 minutes). */
async function sweep() { await run('DELETE FROM ko_counters WHERE win < ?', Date.now() - 2 * 3600e3); }

module.exports = { hit, count, reset, sweep };
