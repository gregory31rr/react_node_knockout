/**
 * server.js — starts Knockout. Run with `node server.js` (DigitalOcean runs `npm start` for you).
 *
 * On every request, top to bottom:
 *   1. /health, the phone-app files and /static files are served directly.
 *   2. Find the page (routes/*.js registered them), load the sign-in cookie and work out who this is.
 *   3. For forms (POST): read the body, check the hidden CSRF token and the Origin, and limit floods.
 *   4. Run the page. Errors become friendly error pages (and real crashes are logged).
 *
 * No outside packages: only Node's built-in modules (Node 22.13+). Database: PostgreSQL via DATABASE_URL (lib/db.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const A = require('./lib/app');
const U = require('./lib/util');

for (const f of ['auth', 'home', 'items', 'people', 'projects', 'calls', 'insights', 'updates', 'links', 'settings', 'admin', 'timeoff', 'notes', 'training', 'board', 'connect']) require('./routes/' + f);

const PORT = process.env.PORT || 3000;
const STATIC = path.join(__dirname, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
const MANIFEST = { name: 'Knockout', short_name: 'Knockout', description: 'Track, delegate and knock out your work.', start_url: '/', scope: '/', display: 'standalone', background_color: '#14182b', theme_color: '#14182b', icons: [{ src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml' }] };

// Flood protection: at most RATE_PER_MIN form posts a minute per person (or per address when signed out).
// Counted in the database, so the limit holds across every server (lib/limits.js).
const RATE = Number(process.env.RATE_PER_MIN || 120);
async function rateLimit(key) {
  if (await require('./lib/limits').hit('rate:' + key, 60e3, { sliding: false }) > RATE) throw new A.HttpError(429, 'Too many changes in a minute. Wait a moment and try again.');
}
/** The visitor's address. Behind DigitalOcean's proxy the LAST X-Forwarded-For entry is the real one. */
const clientIp = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return x.length && process.env.TRUST_PROXY !== '0' ? x[x.length - 1] : req.socket.remoteAddress; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  req.path = url.pathname; req.query = Object.fromEntries(url.searchParams); req.ip = clientIp(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.send = (body, code = 200, type = 'text/html; charset=utf-8') => {
    if (res.writableEnded) return;
    if (type.startsWith('text/html') && req.user?.theme) body = String(body).replace(/<html(?![^>]*data-theme)/i, `<html data-theme="${req.user.theme === 'dark' ? 'dark' : 'light'}"`);
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(String(body));
  };
  res.redirect = (to, code = 303) => { if (res.writableEnded) return; res.writeHead(code, { Location: to }); res.end(); };
  res.json = (o, code = 200) => res.send(JSON.stringify(o), code, 'application/json; charset=utf-8');

  try {
    if (req.path === '/health') { try { await require('./lib/db').one('SELECT 1 x'); return res.send('ok', 200, 'text/plain'); } catch { return res.send('database unavailable', 503, 'text/plain'); } }
    if (req.path === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(JSON.stringify(MANIFEST)); }
    if (req.path.startsWith('/static/') && req.method === 'GET') {
      const f = path.normalize(path.join(STATIC, req.path.slice(8)));
      if (!f.startsWith(STATIC + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) throw new A.HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
      return fs.createReadStream(f).pipe(res);
    }
    const route = A.routes.find(r => r.method === req.method && r.re.test(req.path));
    if (!route) throw new A.HttpError(404, 'That page does not exist.');
    req.params = {}; const m = route.re.exec(req.path); route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });

    req.session = await A.loadSession(req);
    await A.buildContext(req);
    req.cookies = A.parseCookies(req.headers.cookie);
    if (req.cookies.flash) { try { req.flashMsg = JSON.parse(req.cookies.flash); } catch { } A.setCookie(res, 'flash', '', 0); }

    req.body = {}; req.files = [];
    if (req.method === 'POST') {
      const buf = await A.readBody(req), ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) { const p = U.parseMultipart(buf, ct); req.body = p.fields; req.files = p.files; }
      else if (ct.startsWith('application/json')) { try { req.body = JSON.parse(buf.toString('utf8') || '{}'); } catch { req.body = {}; } }
      else req.body = U.parseUrlEncoded(buf);
      // Outside links carry their own secret in the address, so they don't need a session token.
      const exempt = req.path.startsWith('/l/');
      const token = req.body._csrf || req.headers['x-csrf-token'];
      if (req.session && !exempt && token !== req.session.csrf) throw new A.HttpError(403, 'This form expired. Go back, refresh the page and try again.');
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && new URL(origin).host !== req.headers.host) throw new A.HttpError(403, 'Forms from other websites are not allowed.');
      await rateLimit(req.user ? 'u' + req.user.id : 'ip' + req.ip);
      if (req.ws && req.ws.status === 'paused' && !req.owner && !['/logout', '/theme', '/settings/export'].includes(req.path)) throw new A.HttpError(403, 'This workspace is paused, so it is read only. Nothing was changed.');
    }
    for (const h of route.handlers) { await h(req, res); if (res.writableEnded || res.headersSent) break; }
    if (!res.writableEnded && !res.headersSent) res.send('', 204);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    if (e.code === 401) return req.method === 'GET' ? res.redirect('/login?next=' + encodeURIComponent(req.url)) : res.redirect('/login');
    if (e.code === 409) return res.redirect('/admin');
    if (e.sqlstate && /^(22|23)/.test(e.sqlstate)) { console.warn('database refused values:', req.method, req.path, e.message); e = new A.HttpError(400, e.sqlstate === '23505' ? 'That already exists.' : 'Some values in the form are not valid. Please check them.'); }
    const code = e instanceof A.HttpError ? e.code : 500;
    if (code === 500) console.error(new Date().toISOString(), req.method, req.path, e);
    const msg = code === 500 ? 'Something went wrong on our side. The error was logged.' : e.message;
    if ((req.headers.accept || '').includes('application/json')) return res.json({ error: msg }, code);
    const back = req.headers.referer && new URL(req.headers.referer, 'http://x').pathname !== req.path ? req.headers.referer : '/';
    const body = U.html`<section class="card narrow-card"><h1>${code === 404 ? 'Not found' : code === 403 ? 'No access' : code === 400 ? 'Check the form' : code === 429 ? 'Slow down' : 'Error'}</h1><p>${msg}</p><p><a class="btn" href="${back}">Go back</a></p></section>`;
    try { res.send(req.user ? await A.page(req, { title: 'Error', body }) : A.bare('Error', body), code); } catch { res.send(msg, code, 'text/plain'); }
  }
});

server.ready = (async () => {
  if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) throw new Error('Set ENCRYPTION_KEY (a long random secret) before starting in production.');
  await require('./lib/db').ready;
  if (process.env.SEED_DEMO === '1') await require('./seed').seedIfEmpty();
  require('./lib/jobs').start();
  await new Promise(r => server.listen(PORT, r));
  console.log(`Knockout on :${PORT}`);
})().catch(e => { console.error('Knockout could not start:', e.message); process.exit(1); });
module.exports = server;
