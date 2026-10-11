/**
 * test/review.test.js — the Items "Period" filter for reviewing work (30 / 60 / 90 days / all time = 13 months),
 * with Open, Knocked out and Everything, and the "completed vs remaining" summary.
 *
 * Demo data is all created today, so these tests backdate a few items in the test's own throwaway database
 * and check exactly which ones each period shows.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { Client } = require('./helpers/http');

let srv, greg, priya;
const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) + ' 12:00:00'; };
const ids = html => new Set([...html.matchAll(/<li class="item[^"]*" data-item="(\d+)"/g)].map(m => Number(m[1])));
const tile = (html, which) => Number((html.match(new RegExp(`data-review="${which}"><b>(\\d+)%?</b>`)) || [])[1]);
// The test items, keyed by what we make them.
const T = {};

before(async () => {
  srv = await startServer();
  greg = await new Client(srv.base).login('greg@demo.test');
  priya = await new Client(srv.base).login('priya@demo.test');
  await greg.post('/view', { mode: 'full' });
  const db = srv.db();
  // Six of Greg's workspace items, made into a known history.
  const ws = (await db.all("SELECT workspace_id FROM users WHERE email='greg@demo.test'"))[0].workspace_id;
  const pick = (await db.all('SELECT id FROM items WHERE workspace_id=? AND private=0 ORDER BY id LIMIT 6', ws)).map(r => Number(r.id));
  assert.equal(pick.length, 6, 'demo data should have 6+ items');
  const plan = { open10: ['open', 10], open45: ['open', 45], open500: ['open', 500], done20: ['done', 20], done75: ['done', 75], done200: ['done', 200] };
  Object.keys(plan).forEach((k, n) => { T[k] = pick[n]; });
  for (const [k, [status, ago]] of Object.entries(plan)) {
    // Done items were added a little before they were finished; open items have no finish date.
    await db.run('UPDATE items SET status=?, created_at=?, completed_at=? WHERE id=?', status, day(status === 'done' ? ago + 5 : ago), status === 'done' ? day(ago) : null, T[k]);
  }
});
after(async () => { await srv?.stop(); });

const list = async (q, who = greg) => { const r = await who.get('/items?' + new URLSearchParams(q)); assert.equal(r.status, 200, JSON.stringify(q)); return r.body; };
const has = (html, ...keys) => keys.forEach(k => assert.ok(ids(html).has(T[k]), `${k} (item ${T[k]}) should be listed`));
const hasNot = (html, ...keys) => keys.forEach(k => assert.ok(!ids(html).has(T[k]), `${k} (item ${T[k]}) should NOT be listed`));

describe('Period filter', () => {
  test('the Period menu offers 30, 60, 90 days and all time (13 months)', async () => {
    const html = await list({});
    const m = html.match(/<select name="period"[^>]*>([\s\S]*?)<\/select>/); assert.ok(m, 'Period menu should be on the Items page');
    for (const label of ['Any time', 'Last 30 days', 'Last 60 days', 'Last 90 days', 'All time (13 months)']) assert.ok(m[1].includes(label), label);
  });
  test('with no period picked, the list is exactly what it was before (no change)', async () => {
    assert.deepEqual(ids(await list({})), ids(await list({ period: '' })));
    const html = await list({}); has(html, 'open10', 'open45', 'open500'); hasNot(html, 'done20');
    assert.doesNotMatch(html, /data-review=/, 'no summary until a period is picked');
  });

  test('open work: 30 days shows only items added in the last 30 days', async () => {
    const html = await list({ period: '30' }); has(html, 'open10'); hasNot(html, 'open45', 'open500', 'done20');
  });
  test('open work: 60 and 90 days', async () => {
    let html = await list({ period: '60' }); has(html, 'open10', 'open45'); hasNot(html, 'open500');
    html = await list({ period: '90' }); has(html, 'open10', 'open45'); hasNot(html, 'open500');
  });
  test('open work: all time means the last 13 months, not forever', async () => {
    const html = await list({ period: 'all' }); has(html, 'open10', 'open45'); hasNot(html, 'open500');
  });

  test('completed work counts by the day it was knocked out', async () => {
    let html = await list({ period: '30', status: 'done' }); has(html, 'done20'); hasNot(html, 'done75', 'done200', 'open10');
    html = await list({ period: '60', status: 'done' }); has(html, 'done20'); hasNot(html, 'done75', 'done200');
    html = await list({ period: '90', status: 'done' }); has(html, 'done20', 'done75'); hasNot(html, 'done200');
    html = await list({ period: 'all', status: 'done' }); has(html, 'done20', 'done75', 'done200'); hasNot(html, 'open10');
  });
  test('everything (all tasks) in a period = completed in it + still-open added in it', async () => {
    let html = await list({ period: '30', status: 'all' }); has(html, 'open10', 'done20'); hasNot(html, 'open45', 'done75', 'done200', 'open500');
    html = await list({ period: '90', status: 'all' }); has(html, 'open10', 'open45', 'done20', 'done75'); hasNot(html, 'done200', 'open500');
  });

  test('completed vs remaining: the numbers match the lists they open', async () => {
    for (const period of ['30', '60', '90', 'all']) {
      const html = await list({ period });
      const done = tile(html, 'done'), open = tile(html, 'open');
      assert.equal(done, ids(await list({ period, status: 'done' })).size, `${period}: Completed`);
      assert.equal(open, ids(await list({ period })).size, `${period}: Remaining`);
      assert.equal(ids(await list({ period, status: 'all' })).size, done + open, `${period}: all = completed + remaining`);
      assert.equal(tile(html, 'all'), done + open ? Math.round(done / (done + open) * 100) : 0, `${period}: % done`);
    }
  });
  test('the summary tiles link to the matching list and keep the other filters', async () => {
    const html = await list({ period: '90', owner: 'others' });
    const href = (html.match(/href="([^"]+)" data-review="done"/) || [])[1].replace(/&amp;/g, '&');
    const q = new URLSearchParams(href.split('?')[1]);
    assert.equal(q.get('status'), 'done'); assert.equal(q.get('period'), '90'); assert.equal(q.get('owner'), 'others');
  });
  test('works together with "Who does it → My team" (reviewing your team)', async () => {
    const team = await list({ period: 'all', owner: 'others', status: 'done' }), everyone = await list({ period: 'all', status: 'done' });
    assert.ok(ids(team).size <= ids(everyone).size);
    for (const id of ids(team)) assert.ok(ids(everyone).has(id), 'team results are a subset');
    const sum = await list({ period: 'all', owner: 'others' });
    assert.equal(tile(sum, 'done'), ids(team).size, 'team summary counts only the team');
  });
  test('the spreadsheet download uses the same period', async () => {
    const r = await greg.get('/items.csv?' + new URLSearchParams({ period: '30', status: 'all' }));
    assert.equal(r.status, 200);
    const rows = r.body.trim().split('\n').slice(1).map(l => Number(l.split(',')[0]));
    assert.deepEqual(new Set(rows), ids(await list({ period: '30', status: 'all' })));
  });
  test('a made-up period value is ignored safely (no error, no limit)', async () => {
    for (const period of ['abc', '-5', '7', "30' OR 1=1 --", '9999']) {
      const html = await list({ period }); assert.deepEqual(ids(html), ids(await list({})), period);
    }
  });
  test('team members can use it, and only see their own work', async () => {
    const mine = await list({ period: 'all', status: 'all' }, priya), all = await list({ period: 'all', status: 'all' });
    assert.ok(ids(mine).size <= ids(all).size);
    assert.match(mine, /data-review="done"/);
  });
  test('a knocked-out item moves from Remaining to Completed right away', async () => {
    const before = await list({ period: '30' });
    const d0 = tile(before, 'done'), o0 = tile(before, 'open');
    const r = await greg.post(`/items/${T.open10}/ko`, {}, { accept: 'application/json' }); assert.equal(r.status, 200);
    const after_ = await list({ period: '30' });
    assert.equal(tile(after_, 'done'), d0 + 1); assert.equal(tile(after_, 'open'), o0 - 1);
    has(await list({ period: '30', status: 'done' }), 'open10');
  });
});
