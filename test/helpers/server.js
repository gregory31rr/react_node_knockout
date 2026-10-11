/**
 * test/helpers/server.js — starts a real Knockout server with a fresh SQLite database and demo data.
 * Every test file gets its own server and its own empty data folder, so tests never touch real data.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-test-'));
  const log = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SEED_DEMO: '1', NO_JOBS: '1', DATA_DIR: dataDir, DATABASE_URL: '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => log.push(String(d)));
  proc.stderr.on('data', d => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error('Server exited early:\n' + log.join(''));
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch { }
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error('Server did not start in 10s:\n' + log.join(''));
  }
  return {
    base, port, dataDir, log,
    /** Lines the server printed that look like crashes (500s are logged with a timestamp and the request). */
    errors: () => log.join('').split('\n').filter(l => /Error|could not start|failed/i.test(l)),
    async stop() {
      proc.kill('SIGTERM');
      await new Promise(r => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, ROOT };
