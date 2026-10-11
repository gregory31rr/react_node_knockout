/**
 * test/recordings.test.js — call recordings kept in S3-compatible file storage (DigitalOcean Spaces in production),
 * against a test storage server (test/helpers/fakes3.js). Runs on both databases.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = 'test-key-for-recordings-' + crypto.randomBytes(8).toString('hex');   // same key as the servers below
const U = require('../lib/util');
const { startServer } = require('./helpers/server');
const { startFakeS3 } = require('./helpers/fakes3');
const { Client } = require('./helpers/http');

const JSON_H = { accept: 'application/json' };
async function upload(c, base, callId, audio) {
  const fd = new FormData(); fd.append('_csrf', c.csrf); fd.append('secs', '7'); fd.append('audio', new Blob([audio], { type: 'audio/webm' }), 'call.webm');
  const r = await fetch(`${base}/calls/${callId}/recording`, { method: 'POST', body: fd, headers: { cookie: c.cookieHeader(), accept: 'application/json' } });
  return { status: r.status, body: await r.text() };
}
const play = async (c, base, callId) => { const r = await fetch(`${base}/calls/${callId}/recording`, { headers: { cookie: c.cookieHeader() } }); return { status: r.status, data: Buffer.from(await r.arrayBuffer()) }; };
const audioOf = (n, mark) => Buffer.concat([Buffer.from(`PLAINTEXT-MARK-${mark}-`), crypto.randomBytes(n)]);

describe('recordings in file storage', () => {
  let s3, srv, greg, wsId, calls;
  before(async () => {
    s3 = await startFakeS3();
    srv = await startServer({ ...s3.env, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY });
    greg = await new Client(srv.base).login('greg@demo.test');
    wsId = Number((await srv.db().all("SELECT workspace_id FROM users WHERE email='greg@demo.test'"))[0].workspace_id);
    calls = (await srv.db().all('SELECT id FROM meetings WHERE workspace_id=? ORDER BY id', wsId)).map(r => Number(r.id));
    assert.ok(calls.length >= 4, 'demo data should have 4+ calls');
  });
  after(async () => { await srv?.stop(); await s3?.stop(); });
  const row = async id => (await srv.db().all('SELECT object_key, bytes FROM recordings WHERE meeting_id=?', id))[0];

  test('a new recording goes to file storage, encrypted, under its workspace folder', async () => {
    const audio = audioOf(200_000, 'one');
    const r = await upload(greg, srv.base, calls[0], audio); assert.equal(r.status, 200, r.body);
    const rec = await row(calls[0]);
    assert.match(rec.object_key, new RegExp(`^recordings/ws${wsId}/call${calls[0]}-[0-9a-f]+\\.bin$`));
    assert.equal(Number(rec.bytes), audio.length);
    const storedBytes = s3.objects.get(rec.object_key);
    assert.ok(storedBytes, 'file is in storage');
    assert.equal(storedBytes.subarray(0, 3).toString(), 'KO1', 'encrypted by Knockout');
    assert.ok(!storedBytes.includes(Buffer.from('PLAINTEXT-MARK')), 'storage never sees the audio itself');
    const [{ n }] = await srv.db().all('SELECT count(*) AS n FROM recordings WHERE meeting_id=? AND length(data) > 0', calls[0]);
    assert.equal(Number(n), 0, 'the audio is not in the database');
  });
  test('it plays back byte for byte', async () => {
    const audio = audioOf(150_000, 'play');
    await upload(greg, srv.base, calls[1], audio);
    const p = await play(greg, srv.base, calls[1]); assert.equal(p.status, 200); assert.ok(p.data.equals(audio));
  });
  test('recording again replaces the file (the old one is removed)', async () => {
    const first = audioOf(50_000, 'v1'), second = audioOf(60_000, 'v2');
    await upload(greg, srv.base, calls[2], first); const k1 = (await row(calls[2])).object_key;
    await upload(greg, srv.base, calls[2], second); const k2 = (await row(calls[2])).object_key;
    assert.notEqual(k1, k2); assert.ok(!s3.objects.has(k1), 'old file removed'); assert.ok(s3.objects.has(k2));
    assert.ok((await play(greg, srv.base, calls[2])).data.equals(second));
    assert.equal(s3.keys(`recordings/ws${wsId}/call${calls[2]}-`).length, 1);
  });
  test('deleting the recording removes the file', async () => {
    const k = (await row(calls[1])).object_key;
    assert.ok(k && s3.objects.has(k), 'the recording is in file storage to begin with');
    await greg.get(`/calls/${calls[1]}`);
    const r = await greg.post(`/calls/${calls[1]}/recording/delete`); assert.equal(r.status, 303);
    assert.ok(!s3.objects.has(k)); assert.equal(await row(calls[1]), undefined);
    assert.equal((await play(greg, srv.base, calls[1])).status, 404);
  });
  test('deleting the call removes its file', async () => {
    await upload(greg, srv.base, calls[3], audioOf(10_000, 'del'));
    const k = (await row(calls[3])).object_key; assert.ok(s3.objects.has(k));
    await greg.get('/calls'); const r = await greg.post(`/calls/${calls[3]}/delete`); assert.equal(r.status, 303);
    assert.ok(!s3.objects.has(k));
  });
  test('recordings saved in the database before storage was switched on still play', async () => {
    const audio = audioOf(30_000, 'legacy');
    await srv.db().run('DELETE FROM recordings WHERE meeting_id=?', calls[1]);
    await srv.db().run('INSERT INTO recordings(meeting_id, workspace_id, data, type, bytes) VALUES(?,?,?,?,?)', calls[1], wsId, U.encryptBuffer(audio), 'audio/webm', audio.length);
    await srv.db().run("UPDATE meetings SET recording='call.webm', recording_type='audio/webm' WHERE id=?", calls[1]);
    const p = await play(greg, srv.base, calls[1]); assert.equal(p.status, 200); assert.ok(p.data.equals(audio));
  });

  describe('when file storage is down', () => {
    before(() => { s3.down = true; });
    after(() => { s3.down = false; });
    test('a new recording is refused with a clear message, and the old one stays', async () => {
      const before_ = await row(calls[0]);
      const r = await upload(greg, srv.base, calls[0], audioOf(20_000, 'down')); assert.equal(r.status, 503);
      assert.match(JSON.parse(r.body).error, /File storage refused.*Nothing was changed/);
      assert.deepEqual(await row(calls[0]), before_, 'recording unchanged');
    });
    test('playing back says so (no crash)', async () => { assert.equal((await play(greg, srv.base, calls[0])).status, 503); });
    test('deleting the recording is refused and nothing is deleted', async () => {
      const k = (await row(calls[0])).object_key;
      await greg.get(`/calls/${calls[0]}`);
      const r = await greg.post(`/calls/${calls[0]}/recording/delete`, {}, JSON_H); assert.equal(r.status, 503);
      assert.equal((await row(calls[0])).object_key, k); assert.ok(s3.objects.has(k));
    });
  });
});

describe('deleting a workspace removes all of its files', () => {
  let s3, srv, greg, other, otherName;
  before(async () => {
    s3 = await startFakeS3();
    srv = await startServer({ ...s3.env, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY });
    greg = await new Client(srv.base).login('greg@demo.test');
    // Priya's own workspace: Greg (the app owner) can delete it from Knockout admin.
    const w = (await srv.db().all("SELECT id, name FROM workspaces WHERE name LIKE 'Priya%'"))[0]; other = Number(w.id); otherName = w.name;
  });
  after(async () => { await srv?.stop(); await s3?.stop(); });

  test('if storage is down, the workspace is not deleted (nothing half-done)', async () => {
    s3.objects.set(`recordings/ws${other}/call1-a.bin`, Buffer.from('x'));
    s3.down = true;
    await greg.get('/admin/workspaces');
    const r = await greg.post(`/admin/workspaces/${other}/delete`, { confirm: otherName }, JSON_H);
    s3.down = false;
    assert.equal(r.status, 503); assert.match(r.json().error, /Nothing was deleted/);
    assert.equal((await srv.db().all('SELECT id FROM workspaces WHERE id=?', other)).length, 1);
  });
  test('every file under the workspace folder goes (leftovers too, across several pages), others stay', async () => {
    for (const k of ['call1-a.bin', 'call1-old.bin', 'call2-b.bin', 'call3-c.bin', 'call4-d.bin']) s3.objects.set(`recordings/ws${other}/${k}`, Buffer.from('x'));
    s3.objects.set(`recordings/ws${other}0/call9-keep.bin`, Buffer.from('x'));   // a different workspace whose id starts the same
    s3.objects.set('recordings/ws1/call1-keep.bin', Buffer.from('x'));
    await greg.get('/admin/workspaces');
    const r = await greg.post(`/admin/workspaces/${other}/delete`, { confirm: otherName }); assert.equal(r.status, 303);
    assert.deepEqual(s3.keys(`recordings/ws${other}/`), []);
    assert.ok(s3.objects.has(`recordings/ws${other}0/call9-keep.bin`) && s3.objects.has('recordings/ws1/call1-keep.bin'), 'other workspaces untouched');
    assert.equal((await srv.db().all('SELECT id FROM workspaces WHERE id=?', other)).length, 0);
  });
});

describe('a wrong storage secret key', () => {
  test('gives a message that says what to check', async () => {
    const s3 = await startFakeS3();
    const srv = await startServer({ ...s3.env, STORAGE_SECRET: 'not-the-secret', ENCRYPTION_KEY: process.env.ENCRYPTION_KEY });
    try {
      const c = await new Client(srv.base).login('greg@demo.test');
      const id = Number((await srv.db().all('SELECT id FROM meetings ORDER BY id LIMIT 1'))[0].id);
      const r = await upload(c, srv.base, id, audioOf(5000, 'x'));
      assert.equal(r.status, 503); assert.match(JSON.parse(r.body).error, /SignatureDoesNotMatch.*secret key/);
      assert.equal(s3.objects.size, 0);
    } finally { await srv.stop(); await s3.stop(); }
  });
});
