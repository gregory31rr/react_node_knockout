/**
 * lib/jobs.js — chores that run by themselves every hour: remove expired sign-ins, reset links and old notifications.
 * Set NO_JOBS=1 to turn this off (tests).
 */
const { run } = require('./db');
async function hourly() {
  try {
    await run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    await run('DELETE FROM password_resets WHERE expires_at < ?', Date.now());
    await run('DELETE FROM invites WHERE expires_at < ? AND used_at IS NULL', Date.now() - 30 * 864e5);
    await run("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ko_datetime('now','-90 days')");
    await require('../routes/training').certWarnings();
  } catch (e) { console.error('hourly chores failed:', e.message); }
}
async function everyMinute() { try { await require('../routes/notes').dueReminders(); await require('../routes/board').callReminders(); } catch (e) { console.error('reminders failed:', e.message); } }
function start() { if (process.env.NO_JOBS === '1') return; setTimeout(hourly, 10e3).unref(); setInterval(hourly, 3600e3).unref(); setInterval(everyMinute, 60e3).unref(); setTimeout(everyMinute, 5e3).unref(); }
module.exports = { start, hourly, everyMinute };
