/**
 * lib/jobs.js — chores that run by themselves every hour: remove expired sign-ins, reset links and old notifications.
 * Set NO_JOBS=1 to turn this off (tests).
 */
const { run, one, tx, dialect } = require('./db');
/**
 * With several servers, each one runs these chores. Only one may run a given chore at a time, or
 * reminders and warnings would go out once per server. PostgreSQL's advisory lock decides: the first
 * server to ask gets it for the length of the chore; the others skip this round. (SQLite is always a
 * single server, so it just runs.)
 */
const LOCKS = { hourly: 4815162342001, everyMinute: 4815162342002 };
async function onlyOne(name, fn) {
  if (dialect !== 'pg') return fn();
  return tx(async () => {
    const r = await one('SELECT pg_try_advisory_xact_lock(CAST(? AS BIGINT)) AS got', LOCKS[name]);
    if (!r.got) return false;     // another server is doing it right now
    await fn(); return true;
  });
}
async function hourly() { return onlyOne('hourly', hourlyChores); }
async function everyMinute() { return onlyOne('everyMinute', minuteChores); }
async function hourlyChores() {
  try {
    await require('./limits').sweep();
    await run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    await run('DELETE FROM password_resets WHERE expires_at < ?', Date.now());
    await run('DELETE FROM invites WHERE expires_at < ? AND used_at IS NULL', Date.now() - 30 * 864e5);
    await run("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ko_datetime('now','-90 days')");
    await require('../routes/training').certWarnings();
  } catch (e) { console.error('hourly chores failed:', e.message); }
}
async function minuteChores() { try { await require('../routes/notes').dueReminders(); await require('../routes/board').callReminders(); } catch (e) { console.error('reminders failed:', e.message); } }
// A chore that can't even start (database unreachable) must never crash the server: log it, try next round.
const safe = (name, fn) => () => fn().catch(e => console.error(`${name} chores could not run:`, e.message));
function start() {
  if (process.env.NO_JOBS === '1') return;
  const h = safe('hourly', hourly), m = safe('every-minute', everyMinute);
  setTimeout(h, 10e3).unref(); setInterval(h, 3600e3).unref(); setInterval(m, 60e3).unref(); setTimeout(m, 5e3).unref();
}
module.exports = { start, hourly, everyMinute };
