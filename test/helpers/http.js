/**
 * test/helpers/http.js — a tiny signed-in HTTP client: keeps cookies, finds the CSRF token on pages.
 */
class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.csrf = null; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  keep(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async get(path, headers = {}) {
    const res = await fetch(this.base + path, { redirect: 'manual', headers: { cookie: this.cookieHeader(), ...headers } });
    this.keep(res); const body = await res.text();
    const m = body.match(/name="_csrf" value="([^"]+)"/); if (m) this.csrf = m[1];
    return { status: res.status, headers: res.headers, body, location: res.headers.get('location') };
  }
  async post(path, fields = {}, headers = {}) {
    const form = new URLSearchParams(); if (this.csrf && !('_csrf' in fields)) form.append('_csrf', this.csrf);
    for (const [k, v] of Object.entries(fields)) [].concat(v).forEach(x => form.append(k, x));
    const res = await fetch(this.base + path, { method: 'POST', redirect: 'manual', body: form, headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    this.keep(res); const body = await res.text();
    return { status: res.status, headers: res.headers, body, location: res.headers.get('location'), json: () => JSON.parse(body) };
  }
  async login(email, password = 'demo1234') {
    await this.get('/login');
    const r = await this.post('/login', { email, password });
    if (r.status !== 303 && r.status !== 302) throw new Error(`Login failed for ${email}: ${r.status}`);
    await this.get('/');   // picks up the session's CSRF token
    return this;
  }
}
module.exports = { Client };
