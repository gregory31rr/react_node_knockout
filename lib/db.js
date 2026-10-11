/**
 * lib/db.js — the database.
 *
 * PRODUCTION: PostgreSQL. Set DATABASE_URL (DigitalOcean sets it when you attach the database: ${db.DATABASE_URL}):
 *   DATABASE_URL=postgres://user:password@host:5432/railway
 * Add ?sslmode=require when connecting over the public internet.
 *
 * WITHOUT DATABASE_URL (the live demo in the browser, and quick local tries) Knockout uses SQLite
 * instead, with the same tables. Real customers should always run on PostgreSQL.
 *
 * HOW ROUTE CODE TALKS TO THE DATABASE (every call is awaited):
 *   const u = await one('SELECT * FROM users WHERE id=?', id)        → first row or undefined
 *   const rows = await all('SELECT * FROM units WHERE property_id=?', pid) → array of rows
 *   const r = await run('INSERT INTO notes(text) VALUES(?)', text)   → { id: new row id, changes }
 *   await tx(async () => { ... })   → everything inside commits together or not at all
 * `?` marks each value. Values are sent separately from the SQL, so they can never change the query
 * (no SQL injection). Write SQL that PostgreSQL understands; for date math use the ko_ helpers
 * described at the top of lib/schema.js.
 *
 * SCHEMA: lib/schema.js. On startup the tables are created on an empty database, then any new
 * MIGRATIONS run, each in its own transaction. `ready` resolves when that's done.
 */
process.removeAllListeners('warning'); // hide Node's "SQLite is experimental" banner (demo / local only)
const fs = require('fs');
const path = require('path');
const S = require('./schema');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const URL_ = process.env.DATABASE_URL || '';
const dialect = /^postgres(ql)?:/.test(URL_) ? 'pg' : 'sqlite';

// Tables whose rows get a numeric id (so run() can hand back the new id).
const ID_TABLES = new Set([...[S.TABLES, ...S.MIGRATIONS.map(m => m.pg || '')].join('\n').matchAll(/CREATE TABLE (\w+)\(\s*id BIGINT GENERATED/g)].map(m => m[1]));

// ───────────── PostgreSQL ─────────────
let pool = null;
/** `?` → $1, $2 … (skipping anything inside quotes). Cached per SQL text. */
const pgCache = new Map();
function toPg(sql) {
  let out = pgCache.get(sql);
  if (out) return out;
  let n = 0, q = false; out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") q = !q;
    if (ch === '?' && !q) {
      // "? IS NULL" alone doesn't tell PostgreSQL what type the value is; say it's text.
      out += /^\s+IS\s+(NOT\s+)?NULL\b/i.test(sql.slice(i + 1, i + 20)) ? `CAST($${++n} AS TEXT)` : '$' + (++n);
    } else out += ch;
  }
  const ins = out.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (ins && ID_TABLES.has(ins[1]) && !/\bRETURNING\b/i.test(out)) out += ' RETURNING id';
  if (pgCache.size > 5000) pgCache.clear();
  pgCache.set(sql, out);
  return out;
}
/**
 * SQLite let a fraction like 12.5 into a whole-number column; PostgreSQL refuses. Money and counts
 * should already be rounded, but if one slips through we round it and log it instead of failing the page.
 */
async function pgQuery(sql, params) {
  const text = toPg(sql);
  try { return await pool.query(text, params); }
  catch (e) {
    // A lookup with a value that can't be a number ("/units/abc", an empty form field) simply finds
    // nothing, the same as before; the page then shows "not found".
    if (e.sqlstate === '22P02' && /^\s*(SELECT|WITH)\b/i.test(sql) && !/type bigint: "-?\d+\.\d+"/.test(e.message)) return { rows: [], changes: 0 };
    const m = e.sqlstate === '22P02' && /type bigint: "(-?\d+\.\d+)"/.exec(e.message);
    if (!m) { e.stack = `${e.message}\n    SQL: ${sql.replace(/\s+/g, ' ').slice(0, 300)}` + new Error().stack.replace(/^Error\n/, '\n'); throw e; }
    console.warn('db: rounded a fraction going into a whole-number column:', m[1], '\n  ', sql.slice(0, 160));
    return pool.query(text, params.map(v => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v) : v));
  }
}

// ───────────── SQLite (demo / local) ─────────────
let lite = null;
/** The few PostgreSQL words SQLite spells differently. */
const liteCache = new Map();
function toLite(sql) {
  let out = liteCache.get(sql);
  if (out) return out;
  out = sql
    .replace(/\bko_now\(\)/g, "datetime('now')").replace(/\bko_today\(\)/g, "date('now')")
    .replace(/\bko_date\(/g, 'date(').replace(/\bko_datetime\(/g, 'datetime(').replace(/\bko_julianday\(/g, 'julianday(')
    .replace(/\bILIKE\b/g, 'LIKE').replace(/\bGREATEST\(/g, 'max(').replace(/\bLEAST\(/g, 'min(').replace(/\bstrpos\(/g, 'instr(')
    .replace(/\bstring_agg\(/g, 'group_concat(')
    .replace(/\bko_int\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, 'CAST($1 AS INTEGER)');
  if (liteCache.size > 5000) liteCache.clear();
  liteCache.set(sql, out);
  return out;
}
const fixParams = a => a.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'number' && !Number.isFinite(v)) ? null : v);
const clean = r => (r ? { ...r } : r);

function openSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'knockout.db'));
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (d.function) d.function('ko_num', { deterministic: true }, l => { const m = /(\d+)\s*$/.exec(String(l ?? '')); return m ? Number(m[1]) : null; });
  return d;
}

// ───────────── schema ─────────────
async function migratePg() {
  await pool.exec('CREATE TABLE IF NOT EXISTS ko_schema(version BIGINT NOT NULL)');
  let row = (await pool.query('SELECT version FROM ko_schema', [])).rows[0];
  if (!row) {
    await pool.tx(async () => { await pool.exec(S.FUNCTIONS); await pool.exec(S.TABLES); await pool.exec(S.TRIGGERS); await pool.query('INSERT INTO ko_schema(version) VALUES(0)', []); });
    row = { version: 0 };
  }
  for (let v = row.version; v < S.MIGRATIONS.length; v++) {
    const m = S.MIGRATIONS[v];
    try { await pool.tx(async () => { if (m.pg) await pool.exec(m.pg); await pool.query('UPDATE ko_schema SET version=$1', [v + 1]); }); }
    catch (e) { throw new Error(`Database migration ${v + 1} failed: ${e.message}`); }
  }
}
function migrateLite() {
  lite.exec('CREATE TABLE IF NOT EXISTS ko_schema(version INTEGER NOT NULL)');
  let row = lite.prepare('SELECT version FROM ko_schema').get();
  if (!row) {
    lite.exec('BEGIN');
    try { lite.exec(S.forSqlite(S.TABLES)); lite.exec(S.SQLITE_TRIGGERS); lite.exec('INSERT INTO ko_schema(version) VALUES(0)'); lite.exec('COMMIT'); }
    catch (e) { lite.exec('ROLLBACK'); throw e; }
    row = { version: 0 };
  }
  for (let v = row.version; v < S.MIGRATIONS.length; v++) {
    const m = S.MIGRATIONS[v], sql = m.sqlite ?? (m.pg && toLite(S.forSqlite(m.pg)));
    lite.exec('BEGIN');
    try { if (sql) lite.exec(sql); lite.exec(`UPDATE ko_schema SET version=${v + 1}`); lite.exec('COMMIT'); }
    catch (e) { lite.exec('ROLLBACK'); throw new Error(`Database migration ${v + 1} failed: ${e.message}`); }
  }
}

let ready;
if (dialect === 'pg') {
  const { Pool } = require('./pg');
  pool = new Pool(URL_);
  ready = migratePg();
} else {
  lite = openSqlite();
  ready = Promise.resolve().then(migrateLite);
}
ready.catch(() => { });   // the server awaits `ready` and reports the error

// Tests run with KO_STRICT=1: using a still-waiting value (forgot `await`) as text, a number or JSON throws.
if (process.env.KO_STRICT === '1' && !Promise.prototype.toJSON) {
  const boom = () => { throw new Error('Used a value before the database answered (missing await).'); };
  Object.defineProperty(Promise.prototype, 'toJSON', { value: boom, configurable: true });
  Object.defineProperty(Promise.prototype, Symbol.toPrimitive, { value: boom, configurable: true });
}

// ───────────── the calls route code uses ─────────────
/** A value that is still "waiting" (a Promise) means someone forgot `await`: stop loudly instead of saving junk. */
function checkParams(sql, a) {
  for (const v of a) if (v && typeof v.then === 'function') throw new Error('A database value was not ready (missing await) in: ' + sql.replace(/\s+/g, ' ').slice(0, 160));
}
/** one(sql, ...params) → first row or undefined */
async function one(sql, ...a) {
  checkParams(sql, a);
  if (pool) return (await pgQuery(sql, a)).rows[0];
  return clean(lite.prepare(toLite(sql)).get(...fixParams(a)));
}
/** all(sql, ...params) → array of rows */
async function all(sql, ...a) {
  checkParams(sql, a);
  if (pool) return (await pgQuery(sql, a)).rows;
  return lite.prepare(toLite(sql)).all(...fixParams(a)).map(clean);
}
/** run(sql, ...params) → { id: new row id (INSERT), changes: rows affected } */
async function run(sql, ...a) {
  checkParams(sql, a);
  if (pool) { const r = await pgQuery(sql, a); return { id: r.rows[0]?.id ?? 0, changes: r.changes }; }
  const r = lite.prepare(toLite(sql)).run(...fixParams(a));
  return { id: Number(r.lastInsertRowid), changes: r.changes };
}
/** tx(async () => …): one transaction. If anything inside throws, every change is undone. */
let liteDepth = 0;
async function tx(fn) {
  if (pool) return pool.tx(fn);
  if (liteDepth) return fn();
  liteDepth++; lite.exec('BEGIN');
  try { const r = await fn(); lite.exec('COMMIT'); return r; }
  catch (e) { lite.exec('ROLLBACK'); throw e; }
  finally { liteDepth--; }
}
/** Several statements, no parameters (maintenance scripts). */
async function exec(sql) { if (pool) return pool.exec(sql); lite.exec(toLite(sql)); }
/** Close connections (tests, shutdown). */
async function close() { if (pool) await pool.end(); }

module.exports = { one, all, run, tx, exec, close, ready, dialect, DATA_DIR, get sqlite() { return lite; }, toPg, toLite };
