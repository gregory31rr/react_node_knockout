/**
 * test/http.test.js — regression tests for the server, over plain HTTP against a real server + database.
 * Covers sign-in, every main page for each role, permissions, CSRF, bad input, and every endpoint
 * that public/app.js calls (with the JSON answers it expects).
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { Client } = require('./helpers/http');

let srv, greg, priya;
before(async () => {
  srv = await startServer();
  greg = await new Client(srv.base).login('greg@demo.test');
  priya = await new Client(srv.base).login('priya@demo.test');
});
after(async () => { await srv?.stop(); });

const ids = (html, re) => [...html.matchAll(re)].map(m => Number(m[1]));
const JSON_H = { accept: 'application/json' };

describe('basics', () => {
  test('health check answers ok', async () => {
    const r = await fetch(srv.base + '/health'); assert.equal(r.status, 200); assert.equal(await r.text(), 'ok');
  });
  test('sign-in page loads when signed out', async () => {
    const r = await new Client(srv.base).get('/login'); assert.equal(r.status, 200); assert.match(r.body, /name="password"/);
  });
  test('signed-out visitors are sent to sign in', async () => {
    const r = await new Client(srv.base).get('/items'); assert.equal(r.status, 303); assert.match(r.location, /^\/login\?next=/);
  });
  test('wrong password is refused', async () => {
    const c = new Client(srv.base); await c.get('/login');
    const r = await c.post('/login', { email: 'greg@demo.test', password: 'nope' }); assert.equal(r.status, 400); assert.match(r.body, /do not match/);
  });
  test('missing email is refused, not a crash', async () => {
    const c = new Client(srv.base); await c.get('/login');
    const r = await c.post('/login', {}); assert.equal(r.status, 400);
  });
});

describe('static files', () => {
  test('stylesheet is served as CSS', async () => {
    const r = await fetch(srv.base + '/static/app.css'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/css/);
  });
  test('app.js is served as JavaScript (every page loads it)', async () => {
    const r = await fetch(srv.base + '/static/app.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  });
  test('app.js is valid JavaScript', async () => {
    const src = await (await fetch(srv.base + '/static/app.js')).text();
    assert.doesNotThrow(() => new Function(src));
  });
  test('app manifest is valid JSON with the app name and icon', async () => {
    for (let i = 0; i < 20; i++) {   // the same answer every time, not just once
      const r = await fetch(srv.base + '/manifest.webmanifest'); assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /manifest\+json/);
      const m = JSON.parse(await r.text()); assert.equal(m.name, 'Knockout'); assert.ok(m.icons?.length);
    }
  });
  test('path tricks cannot read files outside public/', async () => {
    const r = await fetch(srv.base + '/static/..%2f..%2fserver.js'); assert.equal(r.status, 404);
  });
});

describe('every main page loads for each role', () => {
  const ADMIN_PAGES = ['/', '/items', '/people', '/projects', '/calls', '/insights', '/notes', '/time-off', '/training', '/updates', '/settings', '/search?q=gcp', '/notifications', '/connect', '/goals', '/people/capacity', '/calls/new', '/board/new', '/items/new', '/projects/new'];
  for (const view of ['simple', 'full']) {
    test(`manager, ${view} view`, async () => {
      await greg.post('/view', { mode: view });
      for (const p of ADMIN_PAGES) { const r = await greg.get(p); assert.equal(r.status, 200, `${p} gave ${r.status}`); assert.match(r.body, /\/static\/app\.js/, `${p} should load app.js`); }
    });
  }
  test('team member pages', async () => {
    for (const p of ['/', '/items', '/projects', '/insights', '/notes', '/time-off', '/training', '/settings']) { const r = await priya.get(p); assert.equal(r.status, 200, `${p} gave ${r.status}`); }
  });
  test('team member is kept out of manager-only pages', async () => {
    for (const p of ['/calls', '/updates', '/admin']) { const r = await priya.get(p); assert.equal(r.status, 403, `${p} gave ${r.status}`); }
  });
  test('CSV exports download', async () => {
    for (const p of ['/items.csv', '/insights.csv', '/time-off.csv', '/training.csv']) { const r = await greg.get(p); assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), /csv/, p); }
  });
});

describe('security on changes', () => {
  test('a change without the CSRF token is refused', async () => {
    const r = await greg.post('/items/quick', { text: 'should not save', _csrf: 'wrong' }); assert.equal(r.status, 403);
  });
  test('a change from another website is refused', async () => {
    const r = await greg.post('/items/quick', { text: 'should not save' }, { origin: 'https://evil.example' }); assert.equal(r.status, 403);
  });
  test('the CSRF token in a header works (how app.js sends it)', async () => {
    const r = await greg.post('/items/parse', { text: 'hello', _csrf: '' }, { ...JSON_H, 'x-csrf-token': greg.csrf }); assert.equal(r.status, 200);
  });
  test('empty quick add is refused with a message', async () => {
    const r = await greg.post('/items/quick', { text: '   ' }); assert.equal(r.status, 400); assert.match(r.body, /Type what you need/);
  });
  test('JSON callers get JSON errors', async () => {
    const r = await greg.post('/items/quick', { text: '' }, JSON_H); assert.equal(r.status, 400); assert.ok(r.json().error);
  });
});

describe('endpoints app.js depends on', () => {
  let openIds, boardHtml;
  before(async () => {
    await greg.post('/view', { mode: 'full' });
    openIds = ids((await greg.get('/items')).body, /<li class="item (?!is-done)[^"]*" data-item="(\d+)"/g);
    await greg.post('/view', { mode: 'simple' });
    boardHtml = (await greg.get('/')).body;
  });

  test('parse preview answers with a preview', async () => {
    const r = await greg.post('/items/parse', { text: 'Ask @priya about cutover #gcp p1 fri' }, JSON_H);
    assert.equal(r.status, 200); const j = r.json(); assert.equal(typeof j.preview, 'string'); assert.ok(j.preview.length > 0); assert.ok(Array.isArray(j.unknown));
  });
  test('knock out then reopen (JSON) and it is saved', async () => {
    const id = openIds[0];
    const k = await greg.post(`/items/${id}/ko`, {}, JSON_H); assert.equal(k.status, 200); assert.equal(k.json().ok, true);
    assert.match((await greg.get(`/items/${id}`)).body, /action="\/items\/\d+\/reopen"/);
    const o = await greg.post(`/items/${id}/reopen`, {}, JSON_H); assert.equal(o.status, 200); assert.equal(o.json().ok, true);
    assert.doesNotMatch((await greg.get(`/items/${id}`)).body, /action="\/items\/\d+\/reopen"/);
  });
  test('move (JSON) returns the new column and the note HTML', async () => {
    const id = ids(boardHtml, /<li class="note [^"]*" data-item="(\d+)"/g)[0];
    const r = await greg.post(`/items/${id}/move`, { to: 'later', board: '' }, JSON_H);
    assert.equal(r.status, 200); const j = r.json(); assert.equal(j.ok, true); assert.equal(j.col, 'later'); assert.match(j.html, new RegExp(`data-item="${id}"`));
  });
  test('move to a date with no date is refused', async () => {
    const id = ids(boardHtml, /<li class="note [^"]*" data-item="(\d+)"/g)[0];
    const r = await greg.post(`/items/${id}/move`, { to: 'date', date: '' }, JSON_H); assert.equal(r.status, 400);
  });
  test('move to an unknown place is refused', async () => {
    const id = ids(boardHtml, /<li class="note [^"]*" data-item="(\d+)"/g)[0];
    const r = await greg.post(`/items/${id}/move`, { to: 'nowhere' }, JSON_H); assert.equal(r.status, 400);
  });
  test('nudge (JSON) counts up', async () => {
    const id = ids(boardHtml, /action="\/items\/(\d+)\/nudge"/g)[0]; assert.ok(id, 'board should have a note owned by someone else');
    const a = (await greg.post(`/items/${id}/nudge`, {}, JSON_H)).json(), b = (await greg.post(`/items/${id}/nudge`, {}, JSON_H)).json();
    assert.equal(b.week, a.week + 1); assert.match(b.label, /Nudged/);
  });
  test('team member cannot nudge', async () => {
    const id = ids(boardHtml, /action="\/items\/(\d+)\/nudge"/g)[0];
    const r = await priya.post(`/items/${id}/nudge`, {}, JSON_H); assert.equal(r.status, 403);
  });
  test('comment (JSON) is saved and counted', async () => {
    const id = openIds[1];
    const r = await greg.post(`/items/${id}/comment`, { text: 'Test comment from the suite' }, JSON_H);
    assert.equal(r.status, 200); const j = r.json(); assert.ok(j.n >= 1); assert.equal(j.text, 'Test comment from the suite');
    assert.match((await greg.get(`/items/${id}`)).body, /Test comment from the suite/);
  });
  test('empty comment is refused', async () => {
    const r = await greg.post(`/items/${openIds[1]}/comment`, { text: ' ' }, JSON_H); assert.equal(r.status, 400);
  });
  test('share (JSON) adds the person', async () => {
    const id = openIds[2], page = (await greg.get(`/items/${id}`)).body;
    const pid = ids(page, /<option value="(\d+)">/g).find(Boolean);
    const r = await greg.post(`/items/${id}/share`, { person_id: pid }, JSON_H); assert.equal(r.status, 200); assert.equal(r.json().ok, true);
  });
  test('share with nobody is refused', async () => {
    const r = await greg.post(`/items/${openIds[2]}/share`, { person_id: '' }, JSON_H); assert.equal(r.status, 400);
  });
  test('call notes save (JSON, used by autosave)', async () => {
    const callId = ids((await greg.get('/calls')).body, /href="\/calls\/(\d+)"/g)[0];
    const r = await greg.post(`/calls/${callId}/notes`, { notes: 'Autosave check' }, JSON_H); assert.equal(r.json().ok, true);
    assert.match((await greg.get(`/calls/${callId}`)).body, /Autosave check/);
  });
  test('call recording upload, play back, and too-small upload refused', async () => {
    const callId = ids((await greg.get('/calls')).body, /href="\/calls\/(\d+)"/g)[0];
    const audio = Buffer.alloc(4096, 7), fd = new FormData();
    fd.append('_csrf', greg.csrf); fd.append('secs', '3'); fd.append('audio', new Blob([audio], { type: 'audio/webm' }), 'call.webm');
    const up = await fetch(`${srv.base}/calls/${callId}/recording`, { method: 'POST', body: fd, headers: { cookie: greg.cookieHeader(), accept: 'application/json' } });
    assert.equal(up.status, 200);
    const back = await fetch(`${srv.base}/calls/${callId}/recording`, { headers: { cookie: greg.cookieHeader() } });
    assert.equal(back.status, 200); assert.deepEqual(Buffer.from(await back.arrayBuffer()), audio);
    const fd2 = new FormData(); fd2.append('_csrf', greg.csrf); fd2.append('audio', new Blob([Buffer.alloc(10)], { type: 'audio/webm' }), 'x.webm');
    const small = await fetch(`${srv.base}/calls/${callId}/recording`, { method: 'POST', body: fd2, headers: { cookie: greg.cookieHeader(), accept: 'application/json' } });
    assert.equal(small.status, 400);
  });
  test('reminder time uses the browser time zone offset', async () => {
    // 9:00 in New York in October (UTC-4, offset 240) must be stored as 13:00 UTC.
    const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await greg.post('/reminders', { text: 'TZ check reminder', day, time: '09:00', tz: '240', repeat: 'none' });
    const page = (await greg.get('/notes')).body;
    assert.match(page, new RegExp(`data-utc="${day} 13:00:00"`));
  });
});
