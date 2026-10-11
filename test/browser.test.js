/**
 * test/browser.test.js — end-to-end tests in a real Chrome: click → public/app.js → server → database →
 * response → page updated. Each test checks the change survived a reload (it really saved).
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { launch, chromePath, sleep } = require('./helpers/browser');

/** In page scripts: is this element actually shown on screen (not just flagged)? */
const SHOWN = `const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';`;
const NO_CHROME = !chromePath() && 'Chrome not found: set CHROME_PATH to run browser tests';
let srv, chrome, pg;
/** Every browser test gets 60 seconds, so one stuck step fails that test instead of freezing the run. */
const T = (name, fn) => test(name, { timeout: 60_000 }, fn);

const toast = () => pg.eval(`document.querySelector('.toast span')?.textContent || ''`);
const waitToast = (re, p = pg) => p.waitFor(`(() => { const t = document.querySelector('.toast span')?.textContent || ''; return ${re}.test(t) ? t : false; })()`, { what: `toast matching ${re}` });
const noReloadMark = () => pg.eval('window.__ko_still = 1');
const stillSamePage = () => pg.eval('window.__ko_still === 1');
async function setView(mode) {
  await pg.goto(srv.base + '/');
  const has = await pg.exists(`form[action="/view"] button[value="${mode}"]`);
  if (has) await pg.clickAndWait(`form[action="/view"] button[value="${mode}"]`);
}
/** id of a note in a board column */
const noteIn = col => pg.eval(`document.querySelector('[data-drop="${col}"] li.note')?.dataset.item || null`);
const colOf = id => pg.eval(`document.querySelector('li.note[data-item="${id}"]')?.closest('[data-drop]')?.dataset.drop || null`);
const notesIn = col => pg.eval(`document.querySelectorAll('[data-drop="${col}"] li.note').length`);
const countIn = col => pg.eval(`Number(document.querySelector('[data-drop="${col}"] [data-count]')?.textContent)`);

describe('browser', { skip: NO_CHROME }, () => {
  before(async () => {
    srv = await startServer();
    chrome = await launch();
    pg = await chrome.newPage();
    await pg.login(srv.base, 'greg@demo.test');
  });
  after(async () => { try { await chrome?.close(); } finally { await srv?.stop(); } });

  T('no browser errors on any main page, in both views', async () => {
    for (const mode of ['simple', 'full']) {
      await setView(mode);
      for (const p of ['/', '/items', '/people', '/projects', '/calls', '/insights', '/notes', '/time-off', '/training', '/updates', '/settings', '/search?q=gcp']) {
        pg.consoleErrors = [];
        await pg.goto(srv.base + p);
        await sleep(150);
        assert.deepEqual(pg.consoleErrors, [], `${mode} ${p}`);
        assert.equal(await pg.eval('!!window.Knockout'), true, `app.js should be running on ${p}`);
      }
    }
  });

  describe('everywhere', () => {
    T('"Are you sure?" before deleting: Cancel keeps it, OK deletes it', async () => {
      await pg.goto(srv.base + '/notes');
      const before = await pg.count('article');
      pg.dialogs = []; pg.acceptDialogs = false; await noReloadMark();
      await pg.click('form[data-confirm][action$="/delete"] button');
      await sleep(400);
      assert.equal(pg.dialogs.length, 1); assert.match(pg.dialogs[0].message, /Delete this note\?/);
      assert.equal(await stillSamePage(), true, 'cancel must not submit'); assert.equal(await pg.count('article'), before);
      pg.acceptDialogs = true;
      await pg.clickAndWait('form[data-confirm][action$="/delete"] button');
      assert.equal(await pg.count('article'), before - 1);
    });

    T('filters apply as soon as you pick them', async () => {
      await pg.goto(srv.base + '/insights');
      await pg.eval(`(() => { const s = document.querySelector('select[name=period]'); s.value = s.options[s.options.length - 1].value; window.__ko_nav = 1; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await pg.waitForLoad();
      assert.match(await pg.eval('location.search'), /period=/);
    });

    T('times show in your own time zone, and reminders are saved in it', async () => {
      const la = await chrome.newPage({ timezone: 'America/Los_Angeles' });
      await la.goto(srv.base + '/notes');
      const day = await la.eval(`(() => { const d = new Date(Date.now() + 2*864e5); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`);
      await la.type('#reminders input[name=text]', 'LA time check');
      await la.eval(`document.querySelector('#reminders input[name=day]').value = '${day}'; document.querySelector('#reminders input[name=time]').value = '09:00'`);
      await la.clickAndWait('#reminders form button.primary');
      const row = await la.eval(`(() => { const li = [...document.querySelectorAll('#reminders li')].find(l => l.textContent.includes('LA time check')); const s = li.querySelector('[data-utc]'); return { utc: s.dataset.utc, shown: s.textContent }; })()`);
      // 9:00 in Los Angeles in October is 16:00 UTC (PDT, UTC-7).
      assert.equal(row.utc, `${day} 16:00:00`);
      assert.match(row.shown, /9:00\s?AM/);
      await la.close();
    });

    T('copy buttons copy the text', async () => {
      await pg.goto(srv.base + '/items');
      const id = await pg.eval(`document.querySelector('[data-item]').dataset.item`);
      await pg.goto(srv.base + '/items/' + id);
      const want = await pg.eval(`document.querySelector('textarea.copy-src').value`);
      // Headless Chrome won't let a page read the clipboard back, so record what app.js hands to it
      // (the clipboard API, or the older copy command it falls back to).
      await pg.eval(`(() => {
        window.__copied = null;
        const w = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = t => { window.__copied = t; return w(t); };
        const ex = document.execCommand.bind(document);
        document.execCommand = c => { if (c === 'copy') window.__copied = document.activeElement?.value ?? window.__copied; return ex(c); };
      })()`);
      await pg.click('section [data-copy]');
      await waitToast('/Copied/');
      assert.equal(await pg.eval('window.__copied'), want);
      assert.ok(want.length > 0);
    });

    T('name filter narrows the list of people', async () => {
      await pg.goto(srv.base + '/calls/new');
      const total = await pg.count('.pick-people label');
      await pg.type('[data-filter]', 'pri');
      await pg.eval(`document.querySelector('[data-filter]').dispatchEvent(new Event('input', {bubbles:true}))`);
      const visible = await pg.eval(`(() => { ${SHOWN} return [...document.querySelectorAll('.pick-people label')].filter(shown).map(l => l.textContent.trim()); })()`);
      assert.ok(visible.length >= 1 && visible.length < total, `${visible.length} of ${total}`);
      assert.ok(visible.every(t => /pri/i.test(t)));
    });
  });

  describe('full view', () => {
    before(async () => { await setView('full'); });

    T('＋ Add opens the quick box, shows a live preview, Cancel closes it, "n" opens it', async () => {
      await pg.goto(srv.base + '/items');
      await pg.click('[data-open-quick]');
      await pg.waitFor(`document.querySelector('#quick').open`);
      await pg.type('#q-text', 'Ask @priya about the cutover #gcp p1 fri');
      await pg.eval(`document.querySelector('#q-text').dispatchEvent(new Event('input', {bubbles:true}))`);
      await pg.waitFor(`document.querySelector('#quick .parse-preview').textContent.trim().length > 0`, { what: 'parse preview' });
      await pg.click('#quick [data-close]');
      assert.equal(await pg.eval(`document.querySelector('#quick').open`), false);
      await pg.eval('document.activeElement.blur()');
      await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', text: 'n' });
      await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n' });
      await pg.waitFor(`document.querySelector('#quick').open`, { what: 'n opens quick add' });
      await pg.eval(`document.querySelector('#quick').close()`);
    });

    T('Period filter: pick 90 days, see completed vs remaining, tap Completed, reload', async () => {
      await pg.goto(srv.base + '/items');
      await pg.eval(`(() => { const s = document.querySelector('select[name=period]'); s.value = '90'; window.__ko_nav = 1; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await pg.waitForLoad();
      assert.match(await pg.eval('location.search'), /period=90/);
      assert.ok(await pg.exists('[data-review="done"]') && await pg.exists('[data-review="open"]'), 'summary shows');
      const done = await pg.eval(`Number(document.querySelector('[data-review="done"] b').textContent)`);
      await pg.clickAndWait('[data-review="done"]');
      assert.match(await pg.eval('location.search'), /status=done/);
      assert.equal(await pg.count('li.item'), done, 'list matches the Completed number');
      assert.equal(await pg.count('li.item:not(.is-done)'), 0, 'only completed items');
      await pg.goto(await pg.eval('location.href'));
      assert.equal(await pg.eval(`document.querySelector('select[name=period]').value`), '90', 'period kept after reload');
      assert.equal(await pg.eval(`document.querySelector('[data-review="done"]').classList.contains('hot')`), true);
      assert.deepEqual(pg.consoleErrors.filter(e => !/Manifest/.test(e)), []);
    });

    T('quick add saves an item', async () => {
      await pg.goto(srv.base + '/items');
      await pg.click('[data-open-quick]');
      await pg.type('#q-text', 'Browser test quick add item');
      await pg.clickAndWait('#quick button.primary');
      await pg.goto(srv.base + '/items');
      assert.ok(await pg.eval(`document.body.textContent.includes('Browser test quick add item')`));
    });

    T('🥊 knock out: no page reload, Undo brings it back, and it is saved', async () => {
      await pg.goto(srv.base + '/items');
      const id = await pg.eval(`document.querySelector('li.item:not(.is-done)').dataset.item`);
      await noReloadMark();
      await pg.click(`li.item[data-item="${id}"] form[data-ko] button`);
      await waitToast('/Knocked out/');
      await pg.waitFor(`!document.querySelector('li.item[data-item="${id}"]') || document.querySelector('li.item[data-item="${id}"]').classList.contains('ko-gone')`);
      assert.equal(await stillSamePage(), true, 'should not reload the page');
      await pg.eval('window.__ko_nav = 1'); await pg.click('.toast button'); await pg.waitForLoad();
      assert.ok(await pg.exists(`li.item[data-item="${id}"]:not(.is-done)`), 'undo should reopen it');
      await pg.click(`li.item[data-item="${id}"] form[data-ko] button`);
      await waitToast('/Knocked out/');
      await pg.goto(srv.base + '/items/' + id);
      assert.ok(await pg.exists(`form[action="/items/${id}/reopen"]`), 'should be saved as done');
    });
  });

  describe('board (simple view)', () => {
    before(async () => { await setView('simple'); });

    T('✓ Done takes the note off the board and updates the count', async () => {
      await pg.goto(srv.base + '/');
      // A column with 2+ notes, so a wrong count (like 0) can't match the right one by chance.
      let col; for (const c of ['today', 'week', 'later', 'talk']) if (await notesIn(c) >= 2) { col = c; break; }
      assert.ok(col, 'demo board should have a column with 2+ notes');
      const id = await noteIn(col), n = await countIn(col);
      await noReloadMark();
      await pg.click(`li.note[data-item="${id}"] form[data-ko] button`);
      await waitToast('/Knocked out/');
      await pg.waitFor(`!document.querySelector('li.note[data-item="${id}"]')`, { what: 'note removed' });
      assert.equal(await countIn(col), n - 1); assert.equal(await stillSamePage(), true);
      assert.equal(await countIn(col), await notesIn(col), 'count matches the notes on screen');
      await pg.goto(srv.base + '/');
      assert.equal(await pg.exists(`li.note[data-item="${id}"]`), false, 'still gone after reload');
    });

    T('Move → Later puts the note in Later and it stays there', async () => {
      await pg.goto(srv.base + '/');
      // A plain, non-urgent task. By design, undated Asks/Updates go under "Ask or tell someone" and
      // undated urgent tasks stay in "Do today", so neither would land in Later.
      const id = await pg.eval(`[...document.querySelectorAll('[data-drop="today"] li.note.n-task, [data-drop="week"] li.note.n-task')].find(n => !n.querySelector('.note-meta .when.late'))?.dataset.item || null`);
      assert.ok(id, 'demo board should have a non-urgent task due today or this week');
      await pg.click(`li.note[data-item="${id}"] [data-move]`);
      await pg.waitFor(`document.querySelector('#mover').open`);
      assert.equal(await pg.text('#mover [data-mover-title]'), await pg.text(`li.note[data-item="${id}"] .note-title`));
      await pg.click('#mover [data-to="later"]');
      await waitToast('/Moved/');
      await pg.waitFor(`document.querySelector('[data-drop="later"] li.note[data-item="${id}"]')`, { what: 'note in Later' });
      for (const c of ['today', 'week', 'later']) assert.equal(await countIn(c), await notesIn(c), `${c} count matches the notes on screen`);
      assert.equal(await pg.eval(`document.querySelector('#mover').open`), false);
      await pg.goto(srv.base + '/');
      assert.equal(await colOf(id), 'later');
    });

    T('Move → Set date with no date shows the error and changes nothing', async () => {
      await pg.goto(srv.base + '/');
      const id = await noteIn('later'), col = await colOf(id);
      await pg.click(`li.note[data-item="${id}"] [data-move]`);
      await pg.click('#mover [data-to="date"]');
      await waitToast('/Pick a date/');
      await pg.eval(`document.querySelector('#mover').close()`);
      await pg.goto(srv.base + '/');
      assert.equal(await colOf(id), col);
    });

    T('drag a note to another column moves it, and it is saved', async () => {
      await pg.goto(srv.base + '/');
      const id = await noteIn('later');
      await pg.eval(`(() => {
        const note = document.querySelector('li.note[data-item="${id}"]'), col = document.querySelector('[data-drop="today"]'), dt = new DataTransfer();
        note.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        col.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        note.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      })()`);
      await waitToast('/Moved/');
      await pg.waitFor(`document.querySelector('[data-drop="today"] li.note[data-item="${id}"]')`, { what: 'note in Today' });
      for (const c of ['today', 'later']) assert.equal(await countIn(c), await notesIn(c), `${c} count matches the notes on screen`);
      assert.equal(await pg.eval(`document.body.classList.contains('is-dragging')`), false);
      await pg.goto(srv.base + '/');
      assert.equal(await colOf(id), 'today');
    });

    T('dropping a note on the "Move" box opens the chooser', async () => {
      await pg.goto(srv.base + '/');
      const id = await noteIn('today');
      await pg.eval(`(() => {
        const note = document.querySelector('li.note[data-item="${id}"]'), tray = document.querySelector('[data-tray]'), dt = new DataTransfer();
        note.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        tray.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tray.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        note.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      })()`);
      await pg.waitFor(`document.querySelector('#mover').open`, { what: 'mover open' });
      assert.equal(await pg.eval(`document.querySelector('#mover [data-mover-open]').getAttribute('href')`), `/items/${id}`);
      await pg.eval(`document.querySelector('#mover').close()`);
    });

    T('press and hold a note on a touch screen opens the chooser', async () => {
      await pg.goto(srv.base + '/');
      await pg.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const id = await noteIn('today');
      const pt = await pg.eval(`(() => { const el = document.querySelector('li.note[data-item="${id}"] .note-owner'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; })()`);
      await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await sleep(700);
      await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pg.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await pg.waitFor(`document.querySelector('#mover').open`, { what: 'mover open after long press' });
      assert.equal(await pg.text('#mover [data-mover-title]'), await pg.text(`li.note[data-item="${id}"] .note-title`));
      await pg.eval(`document.querySelector('#mover').close()`);
    });

    T('Nudge counts up without a reload', async () => {
      await pg.goto(srv.base + '/');
      const id = await pg.eval(`document.querySelector('form[data-nudge]').closest('li.note').dataset.item`);
      await noReloadMark();
      await pg.click(`li.note[data-item="${id}"] form[data-nudge] button`);
      await waitToast('/Nudged/');
      await pg.waitFor(`/Nudged \\d+× this week/.test(document.querySelector('li.note[data-item="${id}"] .nudges')?.textContent || '')`, { what: 'nudge label' });
      assert.equal(await stillSamePage(), true);
    });

    T('comment: quick-pick fills the box, Send saves it and shows it on the note', async () => {
      await pg.goto(srv.base + '/');
      const id = await pg.eval(`document.querySelector('form[data-comment] [data-fill]').closest('li.note').dataset.item`);
      const sel = `li.note[data-item="${id}"]`;
      await pg.eval(`document.querySelector('${sel} details.note-talk').open = true`);
      await pg.click(`${sel} [data-fill]`);
      const filled = await pg.eval(`document.querySelector('${sel} form[data-comment] textarea').value`);
      assert.equal(filled, "I'm removing the blocker.");
      await pg.click(`${sel} form[data-comment] button.primary`);
      await waitToast('/Comment sent/');
      await pg.waitFor(`(document.querySelector('${sel} .note-comment')?.textContent || '').includes("I'm removing the blocker.")`, { what: 'comment shown' });
      await pg.goto(srv.base + '/items/' + id);
      assert.ok(await pg.eval(`document.body.textContent.includes("I'm removing the blocker.")`), 'saved');
    });

    T('Share: pick a person and the note is shared with them', async () => {
      await pg.goto(srv.base + '/');
      const id = await pg.eval(`document.querySelector('[data-share]').closest('li.note').dataset.item`);
      await pg.click(`li.note[data-item="${id}"] [data-share]`);
      await pg.waitFor(`document.querySelector('#sharer').open`);
      if (await pg.exists('[data-sharer-filter]')) {
        await pg.type('[data-sharer-filter]', 'zzzz-nobody');
        await pg.eval(`document.querySelector('[data-sharer-filter]').dispatchEvent(new Event('input', {bubbles:true}))`);
        assert.equal(await pg.eval(`(() => { ${SHOWN} return [...document.querySelectorAll('[data-share-to]')].filter(shown).length; })()`), 0);
        assert.equal(await pg.eval(`(() => { ${SHOWN} return [...document.querySelectorAll('#sharer fieldset')].filter(shown).length; })()`), 0, 'empty groups hide too');
        await pg.type('[data-sharer-filter]', '');
        await pg.eval(`document.querySelector('[data-sharer-filter]').dispatchEvent(new Event('input', {bubbles:true}))`);
      }
      const name = await pg.eval(`document.querySelector('[data-share-to]').dataset.name`);
      await pg.click('[data-share-to]');
      await waitToast('/Shared with/');
      await pg.goto(srv.base + '/items/' + id);
      assert.ok(await pg.eval(`[...document.querySelectorAll('form[action*="/unshare/"]')].some(f => f.closest('li').textContent.includes(${JSON.stringify(name)}))`), 'saved');
    });

    T('a failed save (offline) shows an error and leaves the note in place', async () => {
      await pg.goto(srv.base + '/');
      const id = (await noteIn('today')) || (await noteIn('week'));
      await pg.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        await pg.click(`li.note[data-item="${id}"] form[data-ko] button`);
        await waitToast(`/Couldn.t save/`);
        await sleep(900);
        assert.ok(await pg.exists(`li.note[data-item="${id}"]:not(.ko-gone)`), 'note stays when the save failed');
      } finally {
        await pg.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
      await pg.goto(srv.base + '/');
      assert.ok(await pg.exists(`li.note[data-item="${id}"]`), 'and it was not saved as done');
    });
  });

  describe('calls', () => {
    let callUrl;
    before(async () => {
      await pg.goto(srv.base + '/calls');
      callUrl = srv.base + await pg.eval(`document.querySelector('a[href^="/calls/"]:not([href="/calls/new"])').getAttribute('href')`);
    });

    T('call notes save by themselves as you type', async () => {
      await pg.goto(callUrl);
      await pg.type('textarea[data-autosave]', 'Autosaved by the browser test');
      await pg.eval(`document.querySelector('textarea[data-autosave]').dispatchEvent(new Event('input', {bubbles:true}))`);
      await pg.waitFor(`/Saved/.test(document.querySelector('[data-autosave-status]')?.textContent || '')`, { what: 'Saved status' });
      await pg.goto(callUrl);
      assert.equal(await pg.eval(`document.querySelector('textarea[data-autosave]').value`), 'Autosaved by the browser test');
    });

    T('record a call with the microphone, stop, and it is saved', async () => {
      await pg.goto(callUrl);
      if (await pg.exists('audio')) { await pg.clickAndWait('form[action$="/recording/delete"] button'); }
      const shownRec = () => pg.eval(`(() => { ${SHOWN} return { start: shown(document.querySelector('[data-rec-start]')), stop: shown(document.querySelector('[data-rec-stop]')) }; })()`);
      assert.deepEqual(await shownRec(), { start: true, stop: false }, 'before: only Record shows');
      await pg.click('[data-rec-start]');
      await pg.waitFor(`document.querySelector('[data-rec]').classList.contains('recording')`, { what: 'recording started' });
      assert.deepEqual(await shownRec(), { start: false, stop: true }, 'during: only Stop shows');
      await sleep(1600);
      assert.match(await pg.text('.rec-time'), /0:0[12]/);
      await pg.eval('window.__ko_nav = 1');
      await pg.click('[data-rec-stop]');
      await pg.waitForLoad();
      assert.ok(await pg.exists('audio'), 'recording player shown after saving');
      const ok = await pg.eval(`fetch(document.querySelector('audio').getAttribute('src')).then(r => r.ok && r.headers.get('content-type').startsWith('audio/'))`);
      assert.equal(ok, true);
    });
  });

  describe('team member', () => {
    let c2, p2;
    before(async () => { c2 = await launch(); p2 = await c2.newPage(); await p2.login(srv.base, 'priya@demo.test'); });
    after(async () => { await c2?.close(); });

    T('no Nudge buttons, no browser errors, and Done works on her own note', async () => {
      p2.consoleErrors = [];
      await p2.goto(srv.base + '/');
      assert.equal(await p2.count('form[data-nudge]'), 0);
      const id = await p2.eval(`document.querySelector('li.note form[data-ko]')?.closest('li.note').dataset.item || null`);
      if (id) {
        await p2.click(`li.note[data-item="${id}"] form[data-ko] button`);
        await waitToast('/Knocked out/', p2);
        await p2.goto(srv.base + '/');
        assert.equal(await p2.exists(`li.note[data-item="${id}"]`), false);
      }
      assert.deepEqual(p2.consoleErrors, []);
    });
  });

  T('signed out in another tab: the next click sends you to sign in', async () => {
    await pg.goto(srv.base + '/');
    await pg.send('Network.clearBrowserCookies');
    const id = (await noteIn('today')) || (await noteIn('week')) || (await noteIn('later'));
    await pg.eval('window.__ko_nav = 1');
    await pg.click(`li.note[data-item="${id}"] form[data-ko] button`);
    await pg.waitForLoad();
    assert.equal(await pg.eval('location.pathname'), '/login');
  });

  T('server logged no crashes during the browser tests', () => {
    assert.deepEqual(srv.errors(), []);
  });
});
