/**
 * test/helpers/server.js — starts a real Knockout server with a fresh database and demo data.
 * Every test file gets its own server and its own empty database, so tests never touch real data.
 *
 * Database: SQLite in a throwaway folder by default. Set TEST_DATABASE_URL to a PostgreSQL address
 * (postgres://user:pass@host:port/anydb) to run the same tests on PostgreSQL: each test file then gets
 * its own new database on that server, which is dropped afterwards.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const PG_URL = process.env.TEST_DATABASE_URL || '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** PostgreSQL: make a new empty database for this test file and return its address. */
async function freshPgDatabase() {
  const { Pool } = require('../../lib/pg');
  const name = 'ko_test_' + crypto.randomBytes(5).toString('hex');
  const admin = new Pool(PG_URL, { max: 1 });
  try { await admin.exec(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const u = new URL(PG_URL); u.pathname = '/' + name;
  return { url: u.toString(), name };
}
async function dropPgDatabase(name) {
  const { Pool } = require('../../lib/pg');
  const admin = new Pool(PG_URL, { max: 1 });
  try { await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch { } finally { await admin.end(); }
}

/** A direct connection to the test database (for tests that set up history, like backdated items). `?` marks values. */
function directDb(dbUrl, dataDir) {
  if (dbUrl) {
    const { Pool } = require('../../lib/pg');
    const pool = new Pool(dbUrl, { max: 1 }); let n;
    const pg = sql => { n = 0; return sql.replace(/\?/g, () => '$' + (++n)); };
    return {
      all: async (sql, ...a) => (await pool.query(pg(sql), a)).rows,
      run: async (sql, ...a) => { await pool.query(pg(sql), a); },
      close: () => pool.end(),
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dataDir, 'knockout.db')); d.exec('PRAGMA busy_timeout = 5000');
  return {
    all: async (sql, ...a) => d.prepare(sql).all(...a),
    run: async (sql, ...a) => { d.prepare(sql).run(...a); },
    close: async () => d.close(),
  };
}

/**
 * startServer(env, { shareDbWith }) — shareDbWith: another test server whose PostgreSQL database this one uses
 * too (two servers, one database, like production behind a load balancer).
 */
async function startServer(env = {}, { shareDbWith } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-test-'));
  if (shareDbWith && shareDbWith.dialect !== 'pg') throw new Error('Sharing a database between servers needs PostgreSQL (TEST_DATABASE_URL)');
  const ownDb = PG_URL && !shareDbWith ? await freshPgDatabase() : null;
  const pgDb = shareDbWith ? { url: shareDbWith.dbUrl } : ownDb;
  const log = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SEED_DEMO: '1', NO_JOBS: '1', DATA_DIR: dataDir, DATABASE_URL: pgDb ? pgDb.url : '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => log.push(String(d)));
  proc.stderr.on('data', d => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error('Server exited early:\n' + log.join(''));
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch { }
    await new Promise(r => setTimeout(r, 100));
    if (i === 149) throw new Error('Server did not start in 15s:\n' + log.join(''));
  }
  let db = null;
  return {
    base, port, dataDir, log, dialect: pgDb ? 'pg' : 'sqlite', dbUrl: pgDb?.url || null,
    /** Lines the server printed that look like crashes (500s are logged with a timestamp and the request). */
    errors: () => log.join('').split('\n').filter(l => /Error|could not start|failed/i.test(l)),
    /** Direct access to this test's database: await srv.db().run('UPDATE … WHERE id=?', 5) */
    db: () => (db ||= directDb(pgDb?.url, dataDir)),
    async stop() {
      if (db) { await db.close(); db = null; }
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise(r => proc.once('exit', r));
        proc.kill('SIGTERM');
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 5000);
        await exited; clearTimeout(t);
      }
      proc.stdout.destroy(); proc.stderr.destroy();
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (ownDb) await dropPgDatabase(ownDb.name);   // a shared database is dropped by the server that made it
    },
  };
}

module.exports = { startServer, ROOT };
