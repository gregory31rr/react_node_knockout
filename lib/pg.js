/**
 * lib/pg.js — talks to PostgreSQL directly over its network protocol, using only Node's built-in modules
 * (net, tls, crypto). No outside packages, like the rest of Knockout.
 *
 * Used by lib/db.js when DATABASE_URL is set:
 *   const pool = new Pool('postgres://user:password@host:5432/db?sslmode=require')
 *   await pool.query('SELECT * FROM users WHERE id=$1', [7])  → { rows: [...], changes: 0 }
 *   await pool.exec('CREATE TABLE …; CREATE INDEX …')         (several statements, no values)
 *   await pool.tx(async () => { … })   everything inside runs on one connection and commits together
 *   await pool.end()
 *
 * Signing in: SCRAM-SHA-256 (PostgreSQL's default and what managed databases use), MD5 and plain password.
 * Encryption (TLS), set by sslmode in the address, the same words PostgreSQL's own tools use:
 *   disable      never encrypt
 *   prefer       encrypt if the server offers it (default)
 *   require      always encrypt; don't check the server's certificate (DigitalOcean's usual setting)
 *   verify-ca / verify-full   always encrypt and check the certificate (PGSSLROOTCERT = CA file)
 *
 * Values are always sent separately from the SQL (never pasted into it), so they can't change the query.
 * Errors carry .sqlstate (PostgreSQL's 5-character error code), which server.js uses for friendly messages.
 *
 * Settings: PG_POOL_MAX (connections per server, default 10), PG_CONNECT_TIMEOUT_MS (default 10000).
 */
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// ───────────── reading the address ─────────────
function parseUrl(url) {
  const u = new URL(url);
  const q = u.searchParams;
  return {
    host: decodeURIComponent(u.hostname || 'localhost'),
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || process.env.PGUSER || 'postgres'),
    password: decodeURIComponent(u.password || process.env.PGPASSWORD || ''),
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || u.username || 'postgres'),
    sslmode: q.get('sslmode') || process.env.PGSSLMODE || 'prefer',
    sslrootcert: q.get('sslrootcert') || process.env.PGSSLROOTCERT || '',
  };
}

// ───────────── turning answers into JavaScript values ─────────────
// PostgreSQL type numbers (OIDs) for the column types Knockout uses. Everything else stays text,
// the same as SQLite gives it (dates are stored as text on purpose; see lib/schema.js).
const INT = new Set([20, 21, 23, 26]);        // bigint, smallint, integer, oid
const FLOAT = new Set([700, 701, 1700]);      // real, double precision, numeric (sum/avg results)
function parseValue(oid, buf) {
  if (buf === null) return null;
  if (oid === 17) return parseBytea(buf.toString('utf8'));
  const s = buf.toString('utf8');
  if (INT.has(oid)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }   // past 2^53 keep text, never lose digits
  if (FLOAT.has(oid)) return s === 'NaN' ? NaN : Number(s);
  if (oid === 16) return s === 't';
  return s;
}
function parseBytea(s) {
  if (s.startsWith('\\x')) return Buffer.from(s.slice(2), 'hex');
  // Old "escape" format (only if a server is set to bytea_output=escape).
  const out = []; for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { if (s[i + 1] === '\\') { out.push(92); i++; } else { out.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; } }
    else out.push(s.charCodeAt(i));
  }
  return Buffer.from(out);
}
/** A value going in: text, or bytes for a Buffer. null/undefined → SQL NULL. */
function encodeParam(v) {
  if (v === null || v === undefined) return { fmt: 0, buf: null };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { fmt: 1, buf: Buffer.from(v) };
  if (typeof v === 'boolean') return { fmt: 0, buf: Buffer.from(v ? '1' : '0') };   // yes/no columns are 0/1 numbers
  if (typeof v === 'number' && !Number.isFinite(v)) return { fmt: 0, buf: null };
  if (v instanceof Date) return { fmt: 0, buf: Buffer.from(v.toISOString()) };
  if (typeof v === 'object') return { fmt: 0, buf: Buffer.from(JSON.stringify(v)) };
  return { fmt: 0, buf: Buffer.from(String(v)) };
}

// ───────────── building messages ─────────────
const cstr = s => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
function msg(type, ...parts) {
  const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  const head = Buffer.alloc(type ? 5 : 4);
  if (type) { head.write(type, 0, 'latin1'); head.writeInt32BE(body.length + 4, 1); } else head.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([head, body]);
}
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'PostgreSQL error');
    this.name = 'PgError'; this.sqlstate = fields.C; this.severity = fields.S; this.detail = fields.D; this.hint = fields.H;
    this.table = fields.t; this.column = fields.c; this.constraint = fields.n;
  }
}
function errorFields(body) {
  const f = {}; let i = 0;
  while (i < body.length && body[i] !== 0) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.toString('utf8', i + 1, end); i = end + 1; }
  return f;
}

// ───────────── one connection ─────────────
class Connection {
  constructor(cfg) { this.cfg = cfg; this.chunks = []; this.have = 0; this.queue = Promise.resolve(); this.dead = false; this.params = {}; }

  async connect() {
    const { cfg } = this, timeoutMs = Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000);
    const plain = await new Promise((resolve, reject) => {
      const s = net.connect({ host: cfg.host, port: cfg.port });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`Could not reach the database at ${cfg.host}:${cfg.port} within ${timeoutMs / 1000}s.`)); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', e => { clearTimeout(t); reject(new Error(`Could not reach the database at ${cfg.host}:${cfg.port}: ${e.message}`)); });
    });
    plain.setNoDelay(true); plain.setKeepAlive(true, 30000);
    this.sock = cfg.sslmode === 'disable' ? plain : await this.startTls(plain);
    this.sock.on('data', d => this.onData(d));
    this.sock.on('error', e => this.fail(e));
    this.sock.on('close', () => this.fail(new Error('The database connection closed.')));
    await this.startup();
  }

  /** Ask the server to switch to TLS. */
  async startTls(sock) {
    const { cfg } = this;
    sock.write(Buffer.concat([i32(8), i32(80877103)]));
    const answer = await new Promise((resolve, reject) => {
      sock.once('data', d => resolve(String.fromCharCode(d[0])));
      sock.once('error', reject);
    });
    if (answer !== 'S') {
      if (cfg.sslmode === 'prefer' || cfg.sslmode === 'allow') return sock;
      sock.destroy(); throw new Error(`The database does not accept encrypted connections, but sslmode=${cfg.sslmode} requires one.`);
    }
    const verify = /^verify-(ca|full)$/.test(cfg.sslmode);
    const opts = { socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: verify };
    if (verify && cfg.sslrootcert) opts.ca = fs.readFileSync(cfg.sslrootcert);
    if (cfg.sslmode === 'verify-ca') opts.checkServerIdentity = () => undefined;   // check the CA, not the host name
    return new Promise((resolve, reject) => {
      const t = tls.connect(opts, () => resolve(t));
      t.once('error', e => reject(new Error(`Encrypted connection to the database failed: ${e.message}`)));
    });
  }

  // Incoming bytes → complete messages → whoever is waiting.
  // Big answers (a recording) arrive in thousands of small pieces. Keep the pieces and join them once,
  // when a whole message is here; joining on every piece would copy the data over and over.
  onData(d) {
    this.chunks.push(d); this.have += d.length;
    while (this.have >= 5) {
      if (this.chunks[0].length < 5) this.chunks = [Buffer.concat(this.chunks)];
      const head = this.chunks[0], len = head.readInt32BE(1);
      if (this.have < len + 1) break;
      const all = this.chunks.length === 1 ? head : Buffer.concat(this.chunks, this.have);
      const type = String.fromCharCode(all[0]), body = all.subarray(5, len + 1);
      const rest = all.subarray(len + 1);
      this.chunks = rest.length ? [rest] : []; this.have = rest.length;
      if (type === 'N' || type === 'A') continue;          // notices and notifications: ignore
      if (type === 'S') { const [k, v] = body.toString('utf8').split('\0'); this.params[k] = v; if (!this.handler) continue; }
      if (this.handler) this.handler(type, Buffer.from(body));
      else if (type === 'E') this.fail(new PgError(errorFields(body)));   // e.g. the server shutting down
    }
  }
  fail(err) {
    if (this.dead) return; this.dead = true; this.error = err;
    if (this.handler) this.handler('__dead', err);
    try { this.sock?.destroy(); } catch { }
  }

  /** Run fn(type, body) for each message until it returns a value (≠ undefined); resolve with it. */
  receive(fn) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.error);
      this.handler = (type, body) => {
        if (type === '__dead') { this.handler = null; return reject(body); }
        let r; try { r = fn(type, body); } catch (e) { this.handler = null; return reject(e); }
        if (r !== undefined) { this.handler = null; r instanceof Error ? reject(r) : resolve(r); }
      };
    });
  }
  write(b) { if (this.dead) throw this.error; this.sock.write(b); }

  async startup() {
    const { cfg } = this;
    const params = ['user', cfg.user, 'database', cfg.database, 'client_encoding', 'UTF8', 'application_name', 'knockout', 'TimeZone', 'UTC'];
    const done = this.receive((type, body) => {
      if (type === 'R') return this.auth(body);
      if (type === 'K') return undefined;
      if (type === 'E') return new PgError(errorFields(body));
      if (type === 'Z') return true;
    });
    this.sock.write(msg('', i32(196608), ...params.map(cstr), Buffer.from([0])));
    await done;
  }

  // Signing in. Returns undefined so receive() keeps listening until the server says it's ready.
  auth(body) {
    const kind = body.readInt32BE(0), { cfg } = this;
    if (kind === 0) return undefined;                                   // signed in
    if (kind === 3) { this.write(msg('p', cstr(cfg.password))); return undefined; }   // plain password (only over TLS, ideally)
    if (kind === 5) {                                                   // MD5
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(cfg.password + cfg.user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.write(msg('p', cstr('md5' + outer))); return undefined;
    }
    if (kind === 10) {                                                  // SASL: start SCRAM-SHA-256
      const mechs = body.subarray(4).toString('utf8').split('\0').filter(Boolean);
      if (!mechs.includes('SCRAM-SHA-256')) return new Error('The database asked for a sign-in method Knockout does not support: ' + mechs.join(', '));
      this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
      this.scram.firstBare = `n=*,r=${this.scram.nonce}`;
      const first = Buffer.from('n,,' + this.scram.firstBare);
      this.write(msg('p', cstr('SCRAM-SHA-256'), i32(first.length), first)); return undefined;
    }
    if (kind === 11) {                                                  // SASL continue: prove we know the password
      const s = this.scram, server = body.subarray(4).toString('utf8');
      const a = Object.fromEntries(server.split(',').map(x => [x[0], x.slice(2)]));
      if (!a.r || !a.r.startsWith(s.nonce)) return new Error('The database sign-in reply was not valid.');
      const salted = crypto.pbkdf2Sync(cfg.password.normalize('NFKC'), Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
      const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
      const clientKey = hmac(salted, 'Client Key'), storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalBare = `c=biws,r=${a.r}`, authMsg = `${s.firstBare},${server},${finalBare}`;
      const sig = hmac(storedKey, authMsg), proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
      s.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
      this.write(msg('p', Buffer.from(`${finalBare},p=${proof.toString('base64')}`))); return undefined;
    }
    if (kind === 12) {                                                  // SASL final: check the server knew it too
      const v = (body.subarray(4).toString('utf8').match(/v=([^,]+)/) || [])[1];
      if (v !== this.scram?.serverSig) return new Error('The database could not prove its identity during sign-in.');
      return undefined;
    }
    return new Error(`The database asked for a sign-in method Knockout does not support (${kind}).`);
  }

  /** One statement with values ($1, $2…), one at a time per connection. */
  query(text, values = []) { return this.serial(() => this.extended(text, values)); }
  /** Several statements, no values. */
  simple(text) { return this.serial(() => this.simpleQuery(text)); }
  serial(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => { }); return run; }

  extended(text, values) {
    const ps = values.map(encodeParam);
    const bind = [cstr(''), cstr(''), i16(ps.length), ...ps.map(p => i16(p.fmt)), i16(ps.length)];
    for (const p of ps) bind.push(p.buf === null ? i32(-1) : Buffer.concat([i32(p.buf.length), p.buf]));
    bind.push(i16(1), i16(0));   // all results as text
    let cols = null, rows = [], changes = 0, err = null;
    const done = this.receive((type, body) => {
      if (type === 'T') cols = readRowDescription(body);
      else if (type === 'D') rows.push(readDataRow(body, cols));
      else if (type === 'C') changes = tagCount(body);
      else if (type === 'E') err = new PgError(errorFields(body));
      else if (type === 'Z') return err || { rows, changes };
    });
    this.write(Buffer.concat([msg('P', cstr(''), cstr(text), i16(0)), msg('B', ...bind), msg('D', 'P', Buffer.from([0])), msg('E', cstr(''), i32(0)), msg('S')]));
    return done;
  }
  simpleQuery(text) {
    let err = null;
    const done = this.receive((type, body) => {
      if (type === 'E') err = new PgError(errorFields(body));
      else if (type === 'Z') return err || true;
    });
    this.write(msg('Q', cstr(text)));
    return done;
  }
  end() { if (this.dead) return; try { this.sock.write(msg('X')); } catch { } this.fail(new Error('closed')); }
}

function readRowDescription(body) {
  const n = body.readInt16BE(0), cols = []; let i = 2;
  for (let k = 0; k < n; k++) {
    const end = body.indexOf(0, i), name = body.toString('utf8', i, end); i = end + 1;
    const oid = body.readInt32BE(i + 6); i += 18;
    cols.push({ name, oid });
  }
  return cols;
}
function readDataRow(body, cols) {
  const n = body.readInt16BE(0), row = {}; let i = 2;
  for (let k = 0; k < n; k++) {
    const len = body.readInt32BE(i); i += 4;
    const v = len === -1 ? null : body.subarray(i, i + len); if (len > 0) i += len;
    row[cols[k].name] = parseValue(cols[k].oid, v);
  }
  return row;
}
/** "UPDATE 3" → 3, "INSERT 0 1" → 1, "SELECT 5" → 5 */
function tagCount(body) { const m = body.toString('utf8').match(/(\d+)\0?$/); return m ? Number(m[1]) : 0; }

// ───────────── the pool ─────────────
class Pool {
  constructor(url, { max } = {}) {
    this.cfg = parseUrl(url);
    this.max = Number(max || process.env.PG_POOL_MAX || 10);
    this.idle = []; this.count = 0; this.waiting = []; this.closed = false;
    this.als = new AsyncLocalStorage();   // which connection the current transaction is using
  }
  async acquire() {
    if (this.closed) throw new Error('The database pool is closed.');
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.count--; }
    if (this.count < this.max) {
      this.count++;
      const c = new Connection(this.cfg);
      try { await c.connect(); return c; } catch (e) { this.count--; c.fail(e); this.wake(); throw e; }
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  release(c) {
    if (c.dead || this.closed) { this.count--; if (!this.closed) this.wake(); return; }
    const w = this.waiting.shift();
    if (w) w.resolve(c); else this.idle.push(c);
  }
  /** A slot opened up (a connection died): start a fresh one for the next in line. */
  wake() {
    const w = this.waiting.shift(); if (!w) return;
    this.acquire().then(w.resolve, w.reject);
  }
  async use(fn) {
    const inTx = this.als.getStore();
    if (inTx) return fn(inTx.conn);
    const c = await this.acquire();
    try { return await fn(c); } finally { this.release(c); }
  }
  query(text, values = []) { return this.use(c => c.query(text, values)); }
  exec(text) { return this.use(c => c.simple(text)); }
  /** Everything inside fn uses one connection and commits together. A tx inside a tx joins it. */
  async tx(fn) {
    if (this.als.getStore()) return fn();
    const c = await this.acquire();
    try {
      await c.simple('BEGIN');
      const r = await this.als.run({ conn: c }, fn);
      await c.simple('COMMIT');
      return r;
    } catch (e) {
      if (!c.dead) { try { await c.simple('ROLLBACK'); } catch { c.fail(e); } }
      throw e;
    } finally { this.release(c); }
  }
  async end() {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.reject(new Error('The database pool is closed.'));
    for (const c of this.idle.splice(0)) c.end();
  }
}

module.exports = { Pool, PgError, parseUrl, _internal: { parseBytea, encodeParam, tagCount } };
