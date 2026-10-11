/**
 * test/limits.test.js — limits and chores that must hold across several servers:
 *   sign-in lockout, flood protection, and background chores (reminders) running only once.
 *
 * Single-server tests run on both databases. The "two servers, one database" tests need PostgreSQL
 * (TEST_DATABASE_URL); production runs several servers on one PostgreSQL database.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { startServer, ROOT } = require('./helpers/server');
const { Client } = require('./helpers/http');

const PG = !!process.env.TEST_DATABASE_URL;
let ipN = 0;
/** Each test signs in from its own made-up address, so address-based limits from one test don't affect another. */
const freshIp = () => `203.0.113.${++ipN}`;
/** Counts per minute reset when the minute changes; wait for a fresh minute if we're near the end of one. */
async function awayFromMinuteEdge() { const s = new Date().getSeconds(); if (s > 45) await new Promise(r => setTimeout(r, (61 - s) * 1000)); }

async function tryLogin(base, email, password, ip) {
  const c = new Client(base); await c.get('/login');
  const r = await c.post('/login', { email, password }, { 'x-forwarded-for': ip });
  return { ok: r.status === 303 || r.status === 302, locked: /Too many tries/.test(r.body), status: r.status, client: c };
}

describe('sign-in lockout and flood protection (one server)', () => {
  // Normal flood limit here: with a low one, sign-in tries (they're changes too) would hit it before the lockout.
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv?.stop(); });

  test('5 wrong passwords lock that email, even with the right password next', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) { const r = await tryLogin(srv.base, 'dana@demo.test', 'wrong' + i, ip); assert.equal(r.ok, false); assert.equal(r.locked, false, `try ${i + 1} should not be locked yet`); }
    const r = await tryLogin(srv.base, 'dana@demo.test', 'demo1234', freshIp());
    assert.equal(r.ok, false); assert.equal(r.locked, true, 'locked out after 5 wrong tries, from any address');
  });
  test('a successful sign-in clears the wrong tries for that email', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await tryLogin(srv.base, 'priya@demo.test', 'wrong', ip);
    assert.equal((await tryLogin(srv.base, 'priya@demo.test', 'demo1234', ip)).ok, true);
    for (let i = 0; i < 4; i++) await tryLogin(srv.base, 'priya@demo.test', 'wrong', ip);
    assert.equal((await tryLogin(srv.base, 'priya@demo.test', 'demo1234', ip)).ok, true, 'count started over after the success');
  });
  test('30 wrong tries from one address lock that address for every email', async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) await tryLogin(srv.base, `nobody${i}@demo.test`, 'x', ip);
    assert.equal((await tryLogin(srv.base, 'greg@demo.test', 'demo1234', ip)).locked, true);
    assert.equal((await tryLogin(srv.base, 'greg@demo.test', 'demo1234', freshIp())).ok, true, 'other addresses still sign in');
  });
  test('flood protection: the 11th change in a minute is refused (limit set to 10)', async () => {
    const flood = await startServer({ RATE_PER_MIN: '10' });
    try {
      await awayFromMinuteEdge();
      const { client: c } = await tryLogin(flood.base, 'greg@demo.test', 'demo1234', freshIp()); await c.get('/');
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await c.post('/items/parse', { text: 'x' }, { accept: 'application/json' })).status);
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(200)); assert.equal(codes[10], 429);
    } finally { await flood.stop(); }
  });
  test('old counts are cleaned up by the hourly chore', async () => {
    const db = srv.db();
    await db.run('INSERT INTO ko_counters(key, win, n) VALUES(?, ?, ?)', 'test:old', Date.now() - 5 * 3600e3, 3);
    await db.run('INSERT INTO ko_counters(key, win, n) VALUES(?, ?, ?)', 'test:new', Date.now(), 3);
    await runChore(srv.dbUrl, srv.dataDir, 'hourly');
    const keys = (await db.all("SELECT key FROM ko_counters WHERE key LIKE 'test:%'")).map(r => r.key);
    assert.deepEqual(keys, ['test:new']);
  });
});

describe('two servers, one database (like production)', { skip: !PG && 'needs PostgreSQL: set TEST_DATABASE_URL' }, () => {
  let a, b;
  before(async () => {
    a = await startServer({ RATE_PER_MIN: '10' });
    b = await startServer({ RATE_PER_MIN: '10' }, { shareDbWith: a });
  });
  after(async () => { await b?.stop(); await a?.stop(); });

  test('both servers really share one database', async () => {
    const { client: c } = await tryLogin(a.base, 'greg@demo.test', 'demo1234', freshIp());
    c.base = b.base;   // same session cookie, other server
    const r = await c.get('/items'); assert.equal(r.status, 200, 'a sign-in on server A works on server B');
  });
  test('wrong passwords spread across servers still lock the email after 5', async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await tryLogin(a.base, 'dana@demo.test', 'wrong', ip);
    for (let i = 0; i < 2; i++) await tryLogin(b.base, 'dana@demo.test', 'wrong', ip);
    assert.equal((await tryLogin(a.base, 'dana@demo.test', 'demo1234', freshIp())).locked, true, 'locked on A');
    assert.equal((await tryLogin(b.base, 'dana@demo.test', 'demo1234', freshIp())).locked, true, 'locked on B');
  });
  test('flood protection counts changes on both servers together', async () => {
    await awayFromMinuteEdge();
    const { client: c } = await tryLogin(a.base, 'greg@demo.test', 'demo1234', freshIp()); await c.get('/');
    const codes = [];
    for (let i = 0; i < 11; i++) { c.base = i % 2 ? b.base : a.base; codes.push((await c.post('/items/parse', { text: 'x' }, { accept: 'application/json' })).status); }
    assert.equal(codes.filter(x => x === 200).length, 10); assert.equal(codes[10], 429);
  });
  test('reminders go out once, even when 4 servers run the chore at the same moment', async () => {
    const db = a.db();
    const [{ id: uid, workspace_id: ws }] = await db.all("SELECT id, workspace_id FROM users WHERE email='greg@demo.test'");
    const due = new Date(Date.now() - 60e3).toISOString().slice(0, 19).replace('T', ' ');
    for (let i = 0; i < 40; i++) await db.run('INSERT INTO reminders(workspace_id, user_id, text, remind_at) VALUES(?, ?, ?, ?)', ws, uid, `Race check ${i}`, due);
    const at = Date.now() + 1500;   // all four start together
    const ran = await Promise.all([1, 2, 3, 4].map(() => runChore(a.dbUrl, a.dataDir, 'everyMinute', at)));
    const rows = await db.all("SELECT text, count(*) AS n FROM notifications WHERE text LIKE '%Race check%' GROUP BY text");
    assert.equal(rows.length, 40, 'every reminder was sent');
    assert.deepEqual(rows.filter(r => Number(r.n) !== 1).map(r => `${r.text} ×${r.n}`), [], 'none sent twice');
    assert.ok(ran.filter(x => x === 'true').length >= 1, 'at least one server ran the chore');
  });
});

/** Run a background chore in its own process (a separate "server"), optionally starting at a set time. */
function runChore(dbUrl, dataDir, which, at = 0) {
  return new Promise((resolve, reject) => {
    const code = `const j = require('./lib/jobs'); require('./lib/db').ready
      .then(() => new Promise(r => setTimeout(r, Math.max(0, ${at} - Date.now()))))
      .then(() => j.${which}()).then(r => { process.stdout.write(String(r)); process.exit(0); }, e => { console.error(e); process.exit(1); });`;
    const p = spawn(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl || '', DATA_DIR: dataDir, NO_JOBS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('exit', c => c === 0 ? resolve(out.trim()) : reject(new Error(`${which} chore failed:\n${err}`)));
  });
}
