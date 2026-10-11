/**
 * test/pg.test.js — the PostgreSQL connection (lib/pg.js) against a real PostgreSQL server.
 * Runs when TEST_DATABASE_URL is set (postgres://user:pass@host:port/db). Skipped otherwise, and in CI
 * REQUIRE_PG=1 makes a missing database a failure instead of a skip.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool, PgError, _internal } = require('../lib/pg');

const URL0 = process.env.TEST_DATABASE_URL || '';
const NO_PG = !URL0 && 'Set TEST_DATABASE_URL to run the PostgreSQL tests';
if (NO_PG && process.env.REQUIRE_PG === '1') test('PostgreSQL is available (REQUIRE_PG=1)', () => assert.fail(NO_PG));

const withParams = (url, set) => { const u = new URL(url); for (const [k, v] of Object.entries(set)) v === null ? u.searchParams.delete(k) : u.searchParams.set(k, v); return u.toString(); };
const withAuth = (url, user, pass) => { const u = new URL(url); u.username = user; u.password = pass; return u.toString(); };
const T = (name, fn) => test(name, { timeout: 30_000 }, fn);

describe('lib/pg.js on a real PostgreSQL', { skip: NO_PG }, () => {
  let pool, table;
  before(async () => {
    pool = new Pool(URL0, { max: 3 });
    table = 'ko_pg_' + crypto.randomBytes(4).toString('hex');
    await pool.exec(`CREATE TABLE ${table}(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT UNIQUE, n BIGINT, x DOUBLE PRECISION, data BYTEA, note TEXT)`);
  });
  after(async () => { try { await pool.exec(`DROP TABLE IF EXISTS ${table}`); } finally { await pool.end(); } });

  describe('signing in and encryption', () => {
    T('connects with the address as given', async () => {
      const r = await pool.query('SELECT 1 AS one, current_user AS who', []);
      assert.equal(r.rows[0].one, 1); assert.equal(typeof r.rows[0].who, 'string');
    });
    T('sslmode=require: the connection is encrypted', async () => {
      const p = new Pool(withParams(URL0, { sslmode: 'require' }), { max: 1 });
      try { assert.equal((await p.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()', [])).rows[0].ssl, true); } finally { await p.end(); }
    });
    T('sslmode=disable: works unencrypted where the server allows it', async () => {
      const p = new Pool(withParams(URL0, { sslmode: 'disable' }), { max: 1 });
      try { assert.equal((await p.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()', [])).rows[0].ssl, false); }
      catch (e) { assert.match(e.message, /no pg_hba|SSL|encrypt/i, 'only acceptable failure: server insists on encryption'); }
      finally { await p.end(); }
    });
    T('sslmode=verify-full refuses a server certificate it cannot verify', async () => {
      const p = new Pool(withParams(URL0, { sslmode: 'verify-full' }), { max: 1 });
      try { await assert.rejects(p.query('SELECT 1', []), /certificate|self.signed|verify/i); } finally { await p.end(); }
    });
    T('wrong password is refused with PostgreSQL\'s error code', async () => {
      const u = new URL(URL0); const p = new Pool(withAuth(URL0, decodeURIComponent(u.username), 'definitely-wrong'), { max: 1 });
      try { await assert.rejects(p.query('SELECT 1', []), e => e instanceof PgError && e.sqlstate === '28P01'); } finally { await p.end(); }
    });
    T('an unreachable database gives a clear message quickly', async () => {
      const u = new URL(URL0); u.port = '1'; const p = new Pool(u.toString(), { max: 1 });
      const t0 = Date.now();
      try { await assert.rejects(p.query('SELECT 1', []), /Could not reach the database/); } finally { await p.end(); }
      assert.ok(Date.now() - t0 < 11000);
    });
  });

  describe('values in and out', () => {
    T('numbers, text, empty and missing values come back as the same JavaScript values', async () => {
      const r = await pool.query(`SELECT $1::bigint AS big, $2::double precision AS dbl, $3::text AS txt, $4::text AS nothing, $5::text AS empty,
        count(*) AS cnt, sum(v) AS total, avg(v) AS mean FROM (VALUES (1),(2),(4)) t(v)`, [42, 2.5, "It's \"quoted\" ✓ émoji 🥊", null, '']);
      assert.deepEqual(r.rows[0], { big: 42, dbl: 2.5, txt: "It's \"quoted\" ✓ émoji 🥊", nothing: null, empty: '', cnt: 3, total: 7, mean: 7 / 3 });
    });
    T('numbers too big for JavaScript stay exact (as text)', async () => {
      assert.equal((await pool.query('SELECT 9007199254740993::bigint AS n', [])).rows[0].n, '9007199254740993');
    });
    T('yes/no values go in as 1/0 (Knockout\'s yes/no columns are numbers)', async () => {
      assert.deepEqual((await pool.query('SELECT $1::bigint AS y, $2::bigint AS n', [true, false])).rows[0], { y: 1, n: 0 });
    });
    T('files (a 5 MB recording) round-trip byte for byte', async () => {
      const blob = crypto.randomBytes(5 * 1024 * 1024);
      const { rows: [{ id }] } = await pool.query(`INSERT INTO ${table}(name, data) VALUES($1, $2) RETURNING id`, ['blob', blob]);
      const back = (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0].data;
      assert.ok(Buffer.isBuffer(back)); assert.equal(back.length, blob.length); assert.ok(back.equals(blob));
    });
    T('a 20 MB recording reads back quickly (guards against slow handling of big answers)', async () => {
      const blob = crypto.randomBytes(20 * 1024 * 1024);
      const { rows: [{ id }] } = await pool.query(`INSERT INTO ${table}(name, data) VALUES($1, $2) RETURNING id`, ['big', blob]);
      const t0 = Date.now(), back = (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0].data, ms = Date.now() - t0;
      assert.ok(back.equals(blob)); assert.ok(ms < 5000, `took ${ms} ms (was 48 s before the fix; ~0.3 s after)`);
    });
    T('values never change the query (SQL injection)', async () => {
      const evil = `x'); DROP TABLE ${table}; --`;
      await pool.query(`INSERT INTO ${table}(name) VALUES($1)`, [evil]);
      assert.equal((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE name=$1`, [evil])).rows[0].n, 1);
    });
    T('changes and new ids are reported', async () => {
      const ins = await pool.query(`INSERT INTO ${table}(name, n) VALUES('a', 1), ('b', 2) RETURNING id`, []);
      assert.equal(ins.rows.length, 2); assert.equal(ins.changes, 2); assert.ok(ins.rows.every(r => Number.isInteger(r.id)));
      assert.equal((await pool.query(`UPDATE ${table} SET n = n + 1 WHERE name IN ('a','b')`, [])).changes, 2);
      assert.equal((await pool.query(`DELETE FROM ${table} WHERE name = 'nope'`, [])).changes, 0);
    });
  });

  describe('errors', () => {
    T('duplicate value → 23505 (the app shows "That already exists.")', async () => {
      await pool.query(`INSERT INTO ${table}(name) VALUES('dup')`, []);
      await assert.rejects(pool.query(`INSERT INTO ${table}(name) VALUES('dup')`, []), e => e.sqlstate === '23505' && !!e.constraint);
    });
    T('a value of the wrong type → 22P02, and the connection keeps working', async () => {
      await assert.rejects(pool.query('SELECT $1::bigint', ['abc']), e => e.sqlstate === '22P02');
      assert.equal((await pool.query('SELECT 1 AS ok', [])).rows[0].ok, 1);
    });
    T('bad SQL → 42601 syntax error with the message', async () => {
      await assert.rejects(pool.query('SELEC 1', []), e => e.sqlstate === '42601' && /syntax/.test(e.message));
    });
  });

  describe('transactions', () => {
    T('commit: everything inside is saved together', async () => {
      await pool.tx(async () => { await pool.query(`INSERT INTO ${table}(name) VALUES('t1')`, []); await pool.query(`INSERT INTO ${table}(name) VALUES('t2')`, []); });
      assert.equal((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE name IN ('t1','t2')`, [])).rows[0].n, 2);
    });
    T('rollback: an error inside undoes every change', async () => {
      await assert.rejects(pool.tx(async () => {
        await pool.query(`INSERT INTO ${table}(name) VALUES('r1')`, []);
        await pool.query(`INSERT INTO ${table}(name) VALUES('dup')`, []);   // fails: already exists
      }), e => e.sqlstate === '23505');
      assert.equal((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE name='r1'`, [])).rows[0].n, 0);
    });
    T('a transaction inside a transaction joins it (one commit, one rollback)', async () => {
      await assert.rejects(pool.tx(async () => {
        await pool.query(`INSERT INTO ${table}(name) VALUES('n1')`, []);
        await pool.tx(async () => { await pool.query(`INSERT INTO ${table}(name) VALUES('n2')`, []); });
        throw new Error('stop');
      }), /stop/);
      assert.equal((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE name IN ('n1','n2')`, [])).rows[0].n, 0);
    });
    T('other requests during a transaction don\'t see its changes until it commits', async () => {
      let seenOutside;
      await pool.tx(async () => {
        await pool.query(`INSERT INTO ${table}(name) VALUES('iso')`, []);
        // A separate request (not inside this transaction) runs on another connection.
        seenOutside = await new Promise(r => setImmediate(() => pool.als.exit(() => pool.query(`SELECT count(*) AS n FROM ${table} WHERE name='iso'`, []).then(x => r(x.rows[0].n)))));
      });
      assert.equal(seenOutside, 0);
      assert.equal((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE name='iso'`, [])).rows[0].n, 1);
    });
  });

  describe('busy and broken connections', () => {
    T('200 requests at once share 3 connections and all succeed', async () => {
      const results = await Promise.all(Array.from({ length: 200 }, (_, i) => pool.query('SELECT $1::bigint * 2 AS v, pg_backend_pid() AS pid', [i])));
      results.forEach((r, i) => assert.equal(r.rows[0].v, i * 2));
      assert.ok(new Set(results.map(r => r.rows[0].pid)).size <= 3, 'never more than the pool size');
    });
    T('if the database drops a connection, the next request gets a fresh one', async () => {
      const pids = (await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_backend_pid() AS pid, pg_sleep(0.05)', [])))).map(r => r.rows[0].pid);
      const killer = new Pool(URL0, { max: 1 });
      try { for (const pid of new Set(pids)) await killer.query('SELECT pg_terminate_backend($1)', [pid]); } finally { await killer.end(); }
      await new Promise(r => setTimeout(r, 200));
      const after = await Promise.allSettled(Array.from({ length: 6 }, () => pool.query('SELECT 1 AS ok', [])));
      // At most the requests that were already on a dropped connection fail; the pool must recover.
      const again = await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT 1 AS ok', [])));
      assert.ok(again.every(r => r.rows[0].ok === 1), 'pool recovered');
      assert.ok(after.filter(x => x.status === 'fulfilled').length >= 3);
    });
  });

  describe('small helpers', () => {
    T('reads both formats PostgreSQL uses for files', () => {
      assert.deepEqual(_internal.parseBytea('\\x00ff10'), Buffer.from([0, 255, 16]));
      assert.deepEqual(_internal.parseBytea('a\\\\b\\001'), Buffer.from([97, 92, 98, 1]));
    });
    T('reads the number of changed rows', () => {
      for (const [tag, n] of [['UPDATE 3\0', 3], ['INSERT 0 1\0', 1], ['SELECT 12\0', 12], ['BEGIN\0', 0]]) assert.equal(_internal.tagCount(Buffer.from(tag)), n, tag);
    });
  });
});
