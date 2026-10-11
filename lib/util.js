/**
 * lib/util.js — small helpers used everywhere.
 *
 *  - html`...`   safe HTML templates (auto-escapes everything you interpolate)
 *  - money/dates formatting
 *  - passwords (scrypt), random tokens, SHA-256
 *  - encrypt/decrypt for secrets we must store (API keys you paste in Settings)
 *  - form parsing (urlencoded + multipart file uploads)
 *  - reading the date a photo was taken (EXIF), CSV parse/write
 *
 * Python comparison: `html` works like Jinja2 autoescaping. `raw(x)` is like Jinja's `|safe`.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ───────────── HTML templating ─────────────
// A tagged template: html`<p>${name}</p>` escapes `name` so user input can never inject HTML/JS.
// Wrap trusted, already-built HTML in raw() to insert it unescaped. Arrays are joined.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(String(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function val(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  if (typeof v.then === 'function') throw new Error('A page tried to show a value before the database answered (missing await).');
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    try { out += val(v) + strings[i + 1]; }
    catch (e) { if (/missing await/.test(e.message) && !e.near) { e.near = true; e.message += ' Near: …' + strings[i].slice(-80); } throw e; }
  });
  return new Raw(out);
}

// ───────────── formatting ─────────────
/** 12345 → "$123.45" (money is always integer cents) */
const money = c => (c == null ? '' : (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** "$1,234.50" → 123450 (or null if not a number) */
const toCents = s => { const n = Number(String(s || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && String(s ?? '').trim() !== '' ? Math.round(n * 100) : null; };
const today = () => new Date().toISOString().slice(0, 10);
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const TZ = process.env.TZ_DISPLAY || 'America/New_York';
// SQLite timestamps are UTC without a "Z"; add it so JS parses them as UTC.
const parseTs = d => new Date(d.length === 10 ? d + 'T12:00:00' : d.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? '' : 'Z'));
const fmtDate = d => { if (!d) return ''; const x = parseTs(d); return isNaN(x) ? d : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: d.length === 10 ? 'UTC' : TZ }); };
const fmtDateTime = d => { if (!d) return ''; const x = parseTs(d); return isNaN(x) ? d : x.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.floor((parseTs(b) - parseTs(a)) / 864e5);
const firstOfNextMonth = () => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); };

// ───────────── crypto ─────────────
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
/** Passwords are hashed with scrypt + a random salt. We never store or log the password itself. */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, k] = stored.split('$');
  const key = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(k, 'hex'));
}
/** Friendly unique codes: no 0/O/1/I so they're easy to read aloud. */
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code = n => Array.from(crypto.randomBytes(n), b => ALPH[b % ALPH.length]).join('');

/**
 * Encryption for secrets we have to read back later (AppFolio client secret, amenity codes).
 * AES-256-GCM with a key from the ENCRYPTION_KEY variable (set it in the environment variables (DigitalOcean → your app → Settings); any long random string).
 * If ENCRYPTION_KEY is missing (local dev), a random key is created in DATA_DIR/.dev-key.
 * Losing the key means encrypted values can't be read, so keep ENCRYPTION_KEY safe and unchanged.
 */
let KEY;
function encKey() {
  if (KEY) return KEY;
  let secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    const { DATA_DIR } = require('./db');
    const f = path.join(DATA_DIR, '.dev-key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, token(32), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8');
    if (process.env.NODE_ENV === 'production') console.warn('WARNING: ENCRYPTION_KEY is not set. Set it in the environment variables (DigitalOcean → your app → Settings).');
  }
  return (KEY = crypto.createHash('sha256').update(secret).digest());
}
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
function decrypt(stored) {
  if (!stored) return null;
  const [v, iv, tag, data] = stored.split(':'); if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Encrypt / decrypt file bytes (photo IDs). Same key and AES-256-GCM as encrypt(); output = 'KO1' + iv + tag + data. */
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('KO1'), iv, c.getAuthTag(), data]);
}
function decryptBuffer(b) {
  if (!b || b.slice(0, 3).toString('latin1') !== 'KO1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), b.slice(3, 15)); d.setAuthTag(b.slice(15, 31));
  return Buffer.concat([d.update(b.slice(31)), d.final()]);
}

// ───────────── request body parsing ─────────────
/** a=1&b=2 → {a:'1', b:'2'}; repeated keys become arrays (checkbox groups). */
function parseUrlEncoded(buf) {
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
    if (k in out) out[k] = [].concat(out[k], v); else out[k] = v;
  }
  return out;
}
/** multipart/form-data (forms with file uploads) → { fields, files:[{field, filename, type, data:Buffer}] } */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, files: [] };
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}, files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;      // final boundary
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.slice(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd);
    if (next === -1) break;
    const body = buf.slice(headEnd + 4, next - 2);                      // strip trailing \r\n
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
    if (name != null) {
      if (filename != null) { if (body.length) files.push({ field: name, filename, type, data: body }); }
      else { const v = body.toString('utf8'); if (name in fields) fields[name] = [].concat(fields[name], v); else fields[name] = v; }
    }
    pos = next;
  }
  return { fields, files };
}

// ───────────── CSV ─────────────
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');                                   // strip Excel's BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
/** One CSV cell. Text starting with = + - @ (that isn't a plain number) gets a leading ' so Excel/Sheets never run it as a formula. */
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d[\d,]*(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
/** Accepts 2026-01-05, 1/5/2026, 1/5/26 → '2026-01-05' */
function normDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (isDate(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

module.exports = { html, raw, esc, money, toCents, today, nowSql, parseTs, fmtDate, fmtDateTime, isDate, addDays, daysBetween, firstOfNextMonth, token, sha256, hashPassword, checkPassword, code, encrypt, decrypt, encryptBuffer, decryptBuffer, parseUrlEncoded, parseMultipart, parseCSV, toCSV, normDate, median };
