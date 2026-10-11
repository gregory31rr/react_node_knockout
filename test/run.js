/**
 * test/run.js — `npm test`. Runs every test/*.test.js with Node's built-in test runner (no outside packages).
 * Browser tests need Chrome; set CHROME_PATH if it isn't found. Without Chrome they are SKIPPED, not passed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && (!only.length || only.some(o => f.includes(o)))).map(f => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
