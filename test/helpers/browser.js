/**
 * test/helpers/browser.js — drives a real headless Chrome through its built-in debugging protocol (CDP),
 * using only Node's own WebSocket. No outside packages, same as the rest of Knockout.
 *
 * Chrome is found from CHROME_PATH, then common install locations. If none is found, browser tests are
 * skipped and say so loudly (they are never reported as passed).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...(() => { try { return fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+/.test(d)).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`); } catch { return []; } })(),
].filter(Boolean);
const chromePath = () => CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    this.consoleErrors = []; this.dialogs = []; this.acceptDialogs = true;
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.listeners.forEach(l => l(msg));
    });
    this.on(m => {
      if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push({ type: m.params.type, message: m.params.message });
        this.send('Page.handleJavaScriptDialog', { accept: this.acceptDialogs }).catch(() => { });
      }
      if (m.method === 'Runtime.exceptionThrown') this.consoleErrors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.consoleErrors.push('console: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.consoleErrors.push('log: ' + m.params.entry.text + (m.params.entry.url ? ' ' + m.params.entry.url : ''));
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async init() {
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map(m => this.send(m)));
  }
  /** Run JavaScript in the page and return the (JSON-able) result. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n' + expr);
    return r.result.value;
  }
  async waitFor(expr, { timeout = 8000, what = expr } = {}) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await this.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(50); }
    throw new Error(`Timed out waiting for: ${what} (last: ${JSON.stringify(last)})`);
  }
  async goto(url) {
    await this.eval('window.__ko_nav = 1').catch(() => { });
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
  }
  async waitForLoad() {
    await this.waitFor(`!window.__ko_nav && document.readyState === 'complete'`, { what: 'page load' });
    await this.eval('window.__ko_nav = 1');
  }
  /** Click something that makes the browser load a new page, and wait for that page. */
  async clickAndWait(selector) { await this.eval('window.__ko_nav = 1'); await this.click(selector); await this.waitForLoad(); }
  async click(selector) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
    if (!ok) throw new Error('Nothing to click: ' + selector);
  }
  async type(selector, text) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ''; })()`);
    await this.send('Input.insertText', { text });
  }
  text(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`); }
  count(selector) { return this.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`); }
  exists(selector) { return this.eval(`!!document.querySelector(${JSON.stringify(selector)})`); }
  async login(base, email, password = 'demo1234') {
    await this.goto(base + '/login');
    await this.type('input[name=email]', email);
    await this.type('input[name=password]', password);
    await this.clickAndWait('main form button');
    const url = await this.eval('location.pathname');
    if (url === '/login') throw new Error('Login failed for ' + email);
  }
  async close() { try { this.ws.close(); } catch { } }
}

async function launch({ timezone = 'America/New_York' } = {}) {
  const bin = chromePath(); if (!bin) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''; const t = setTimeout(() => reject(new Error('Chrome did not start:\n' + buf)), 15000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.once('exit', c => { clearTimeout(t); reject(new Error('Chrome exited ' + c + '\n' + buf)); });
  });
  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/devtools\/browser\/.*/, '');
  const pages = [];
  return {
    async newPage() {
      const t = await (await fetch(httpBase + '/json/new?about:blank', { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      const p = new Page(ws); await p.init();
      await p.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await p.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', 'audioCapture'] }).catch(() => { });
      pages.push(p); return p;
    },
    async close() {
      for (const p of pages) await p.close();
      proc.kill('SIGKILL'); await new Promise(r => proc.exitCode !== null ? r() : proc.once('exit', r));
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

module.exports = { launch, chromePath, sleep };
