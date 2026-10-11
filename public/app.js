/**
 * public/app.js — the small script every Knockout page loads. No outside packages, no build step.
 *
 * Every page already works without it: forms post and links load. This script makes them quicker and
 * friendlier, and adds what plain HTML can't do. It reads data-* hooks the server puts in the pages:
 *
 *   data-confirm="…"     ask "Are you sure?" before a form sends (deletes, closing a project)
 *   data-ko              🥊 / ✓ Done: knock it out without reloading, with Undo
 *   data-nudge           Nudge without reloading; the note's nudge count updates
 *   data-comment         send a comment from a note; data-fill buttons put a ready-made line in the box
 *   data-move / #mover   the Move chooser (day, date, waiting, kind); also opens on drop or press-and-hold
 *   data-share / #sharer the Share chooser: tap a name to share the note
 *   draggable notes      drag between board columns (data-drop) or onto the Move box (data-tray)
 *   data-open-quick      ＋ Add opens the quick-add box (also the "n" key); data-close closes a dialog
 *   data-parse           live preview of what a quick-add line means (person, project, due, …)
 *   data-autosubmit      filters apply as soon as you pick them
 *   data-filter="sel"    type to narrow a long list of names
 *   data-copy            copy the nearest .copy-src text (for Teams, Slack, email)
 *   data-autosave        call notes save by themselves while you type
 *   data-tz              send the browser's time zone with forms that set a time
 *   data-utc             show a stored UTC time in the viewer's own time zone (data-fmt="time": time only)
 *   data-rec             record a call with the microphone and save it
 *
 * Changes go to the same addresses the forms use, with "Accept: application/json" so the server answers
 * with JSON instead of a new page, and the page's CSRF token in the X-CSRF-Token header.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const isTyping = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const plainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ───────────── talking to the server ─────────────
  const csrfToken = scope => (scope && $('input[name=_csrf]', scope)?.value) || $('input[name=_csrf]')?.value || '';
  class SaveError extends Error { constructor(msg, { gone = false } = {}) { super(msg); this.gone = gone; } }

  /** POST to a Knockout address and get its JSON answer. Throws SaveError with a message for people. */
  async function send(url, data = {}, { scope, multipart = false } = {}) {
    let body;
    if (multipart) body = data;
    else {
      body = new URLSearchParams(data instanceof FormData ? data : Object.entries(data).filter(([, v]) => v != null));
      if (!body.has('_csrf')) body.append('_csrf', csrfToken(scope));
    }
    let res;
    try {
      res = await fetch(url, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken(scope) } });
    } catch {
      throw new SaveError("Couldn't save. Check your connection and try again.");
    }
    const type = res.headers.get('content-type') || '';
    // Signed out (or sent somewhere else): the server redirected to a page instead of answering. Go there.
    if (res.redirected && !type.includes('json')) { location.href = res.url; throw new SaveError('', { gone: true }); }
    const json = type.includes('json') ? await res.json().catch(() => ({})) : {};
    if (!res.ok) throw new SaveError(json.error || `Couldn't save (error ${res.status}). Try again.`);
    return json;
  }

  // ───────────── the little message at the bottom ─────────────
  let toastTimer;
  function hideToast() { clearTimeout(toastTimer); $('.toast')?.remove(); }
  function toast(msg, { action, onAction, error = false } = {}) {
    hideToast();
    const t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', error ? 'alert' : 'status');
    const s = document.createElement('span'); s.textContent = (error ? '⚠ ' : '') + msg; t.append(s);
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = action;
      b.addEventListener('click', () => { hideToast(); onAction(); }); t.append(b);
    }
    // Inside an open dialog, the message has to live in the dialog or it sits behind it.
    ($('dialog[open]') || document.body).append(t);
    toastTimer = setTimeout(hideToast, action ? 8000 : error ? 7000 : 4000);
  }
  const fail = err => { if (!err.gone) toast(err.message || "Couldn't save. Try again.", { error: true }); };

  /** Run a save with the form's buttons switched off, so a double tap doesn't send twice. */
  async function busy(el, fn) {
    if (el.dataset.busy) return; el.dataset.busy = '1';
    const btns = $$('button', el); btns.forEach(b => { b.disabled = true; });
    try { return await fn(); } finally { delete el.dataset.busy; btns.forEach(b => { b.disabled = false; }); }
  }

  // ───────────── board helpers ─────────────
  /** Recount a board column after a note leaves or arrives. */
  function recount(col) {
    if (!col) return;
    const n = $$('li.note', col).length, c = $('[data-count]', col); if (c) c.textContent = String(n);
    const empty = $('.col-empty', col);
    if (n && empty) empty.remove();
    else if (!n && !empty) { const p = document.createElement('p'); p.className = 'col-empty'; p.textContent = col.dataset.drop === 'today' ? 'Nothing for today. 🎉' : 'Nothing here.'; col.append(p); }
  }
  /** For item lists (full view): the "count" chip in the card's heading. */
  function recountList(section) {
    const c = section && $('h2 .count', section); if (!c) return;
    c.textContent = String(Math.max(0, $$('li.item:not(.ko-gone)', section).length));
  }
  const noteEl = id => $(`li.note[data-item="${CSS.escape(String(id))}"]`);
  const noteTitle = id => (noteEl(id) && $('.note-title', noteEl(id))?.textContent.trim()) || 'this note';

  /** Put the server's fresh copy of a note into the column it now belongs in. */
  function placeNote(id, col, html) {
    const old = noteEl(id), oldCol = old?.closest('[data-drop]');
    const tpl = document.createElement('template'); tpl.innerHTML = String(html || '').trim();
    const fresh = tpl.content.firstElementChild;
    if ($('[data-board]')) {
      const target = col && $(`[data-drop="${CSS.escape(col)}"] ul.notes[data-col]`);
      old?.remove();
      if (target && fresh) { target.prepend(fresh); recount(target.closest('[data-drop]')); }
      if (oldCol) recount(oldCol);
    } else if (old && fresh) old.replaceWith(fresh);
  }

  // ───────────── forms ─────────────
  async function knockOut(form) {
    const host = form.closest('li.note, li.item'), id = host?.dataset.item;
    if (!host) return form.submit();
    await busy(form, async () => {
      host.classList.add('ko-hit');
      const stamp = document.createElement('span'); stamp.className = 'ko-stamp'; stamp.textContent = 'KO!'; stamp.setAttribute('aria-hidden', 'true'); host.append(stamp);
      let r;
      try { r = await send(form.action, new FormData(form), { scope: form }); }
      catch (err) { host.classList.remove('ko-hit'); stamp.remove(); return fail(err); }
      // A board note lives in a column (recount the column); a full-view item lives in a card list.
      const col = host.closest('[data-drop]'), list = host.matches('li.item') ? host.closest('section') : null;
      setTimeout(() => {
        host.classList.add('ko-gone');
        setTimeout(() => { host.remove(); if (col) recount(col); if (list) recountList(list); }, 650);
      }, 450);
      toast(`🥊 Knocked out: ${r.title || noteTitle(id)}`, {
        action: 'Undo',
        onAction: async () => { try { await send(`/items/${encodeURIComponent(id)}/reopen`, {}); location.reload(); } catch (err) { fail(err); } },
      });
    });
  }

  async function nudge(form) {
    const host = form.closest('li.note');
    await busy(form, async () => {
      let r; try { r = await send(form.action, new FormData(form), { scope: form }); } catch (err) { return fail(err); }
      if (host) {
        let p = $('.nudges', host);
        if (!p) { p = document.createElement('p'); p.className = 'nudges'; p.title = 'Times you nudged them about this'; ($('.note-comment', host) || $('.note-actions', host)).before(p); }
        p.textContent = r.label;
      }
      toast(`👋 ${r.message || 'Nudged'}`);
    });
  }

  async function comment(form) {
    const host = form.closest('li.note'), box = $('textarea', form);
    if (!box.value.trim()) { box.focus(); return toast('Write a comment first.', { error: true }); }
    await busy(form, async () => {
      let r; try { r = await send(form.action, new FormData(form), { scope: form }); } catch (err) { return fail(err); }
      box.value = '';
      if (host) {
        const details = form.closest('details'), summary = details && $('summary', details);
        if (summary) summary.textContent = `💬 ${r.n}`;
        let p = $('.note-comment', host);
        if (!p) { p = document.createElement('p'); p.className = 'note-comment'; $('.note-actions', host).before(p); }
        const b = document.createElement('b'); b.textContent = `${r.actor}:`;
        p.replaceChildren('💬 ', b, ` ${r.text}`); p.title = r.text;
        if (details) details.open = false;
      }
      toast('💬 Comment sent');
    });
  }

  /** Forms that set a time: send the browser's offset from UTC, for the day and time picked (so summer time is right). */
  function setTimeZone(form) {
    let input = $('input[name=tz]', form);
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'tz'; form.append(input); }
    const now = new Date();
    let day = ($('input[type=date][name=day]', form) || $('input[name=day]:checked', form))?.value || 'today';
    if (day === 'today') day = ymd(now);
    else if (day === 'tomorrow') day = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const [Y, M, D] = day.split('-').map(Number), [h, m] = ($('input[name=time]', form)?.value || '09:00').split(':').map(Number);
    const when = new Date(Y, (M || 1) - 1, D || 1, h || 0, m || 0);
    input.value = String(isNaN(when) ? now.getTimezoneOffset() : when.getTimezoneOffset());
  }

  document.addEventListener('submit', e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute('data-confirm') && !window.confirm(form.dataset.confirm || 'Are you sure?')) { e.preventDefault(); return; }
    if (form.hasAttribute('data-tz')) setTimeZone(form);
    if (form.method.toLowerCase() !== 'post') return;
    const run = form.hasAttribute('data-ko') ? knockOut : form.hasAttribute('data-nudge') ? nudge : form.hasAttribute('data-comment') ? comment : null;
    if (run) { e.preventDefault(); run(form); }
  });

  // ───────────── Move chooser ─────────────
  let moverId = null;
  function moverHint(text) {
    const d = $('#mover'); if (!d) return;
    let p = $('.mover-hint', d);
    if (!p) { p = document.createElement('p'); p.className = 'mover-hint warn-note'; p.setAttribute('role', 'status'); $('.big-q', d).after(p); }
    p.textContent = text || ''; p.hidden = !text;
  }
  function openMover(id, hint) {
    const d = $('#mover');
    if (!d) { location.href = `/items/${encodeURIComponent(id)}/move`; return; }
    moverId = id;
    $('[data-mover-title]', d).textContent = noteTitle(id);
    $('[data-mover-open]', d).setAttribute('href', `/items/${encodeURIComponent(id)}`);
    const date = $('[data-mover-date]', d); if (date) date.value = '';
    moverHint(hint);
    if (!d.open) d.showModal();
  }
  async function moveNote(id, to, date) {
    const data = { to, board: $('[data-board]')?.dataset.board || '' }; if (date) data.date = date;
    const r = await send(`/items/${encodeURIComponent(id)}/move`, data);
    if (r.needKind) { openMover(id, 'To move it there, pick what it is: Ask, Update or Tell.'); return r; }
    placeNote(id, r.col, r.html);
    toast(`↔ ${r.message || 'Moved'}`);
    return r;
  }

  // ───────────── Share chooser ─────────────
  let shareId = null;
  function openSharer(id) {
    const d = $('#sharer'); if (!d) return false;
    shareId = id;
    $('[data-sharer-title]', d).textContent = noteTitle(id);
    const f = $('[data-sharer-filter]', d); if (f) { f.value = ''; filterSharer(''); }
    d.showModal(); return true;
  }
  function filterSharer(q) {
    q = q.trim().toLowerCase();
    $$('#sharer [data-share-to]').forEach(b => { b.hidden = !!q && !b.dataset.name.toLowerCase().includes(q); });
    $$('#sharer fieldset').forEach(fs => { fs.hidden = !$$('[data-share-to]', fs).some(b => !b.hidden); });
  }

  // ───────────── clicks ─────────────
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { }
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { } ta.remove(); return ok;
  }

  document.addEventListener('click', async e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    let el;

    if ((el = t.closest('[data-open-quick]'))) { e.preventDefault(); openQuick(); return; }
    if ((el = t.closest('[data-close]'))) { e.preventDefault(); el.closest('dialog')?.close(); return; }

    if ((el = t.closest('[data-copy]'))) {
      e.preventDefault();
      const src = el.closest('.link-row')?.querySelector('.copy-src') || el.closest('form, section, .card')?.querySelector('.copy-src');
      if (!src) return;
      if (await copyText(src.value ?? src.textContent)) {
        toast('📋 Copied. Paste it into Teams, Slack or an email.');
        const was = el.textContent; el.textContent = 'Copied ✓'; setTimeout(() => { el.textContent = was; }, 1800);
      } else toast('Your browser blocked copying. Select the text and copy it yourself.', { error: true });
      return;
    }

    if ((el = t.closest('[data-fill]'))) {
      e.preventDefault();
      const box = $('textarea', el.closest('form')); if (!box) return;
      box.value = el.dataset.fill; box.focus(); box.setSelectionRange(box.value.length, box.value.length);
      return;
    }

    if ((el = t.closest('a[data-move]')) && plainClick(e)) { e.preventDefault(); openMover(el.dataset.move); return; }
    if ((el = t.closest('#mover [data-to]'))) {
      e.preventDefault();
      const d = $('#mover'), to = el.dataset.to, date = to === 'date' ? $('[data-mover-date]', d)?.value : '';
      if (!moverId) return;
      await busy(d, async () => {
        try { const r = await moveNote(moverId, to, date); if (!r.needKind) d.close(); }
        catch (err) { moverHint(err.gone ? '' : err.message); fail(err); }
      });
      return;
    }

    if ((el = t.closest('a[data-share]')) && plainClick(e)) { if (openSharer(el.dataset.share)) e.preventDefault(); return; }
    if ((el = t.closest('#sharer [data-share-to]'))) {
      e.preventDefault();
      const d = $('#sharer'); if (!shareId) return;
      await busy(d, async () => {
        try { const r = await send(`/items/${encodeURIComponent(shareId)}/share`, { person_id: el.dataset.shareTo }, { scope: d }); d.close(); toast(`🤝 Shared with ${r.full || el.dataset.name}`); }
        catch (err) { fail(err); }
      });
      return;
    }

    if ((el = t.closest('[data-rec-start]'))) { e.preventDefault(); startRecording(el.closest('[data-rec]')); return; }
    if ((el = t.closest('[data-rec-stop]'))) { e.preventDefault(); stopRecording(el.closest('[data-rec]')); return; }
  });

  // ───────────── quick add ─────────────
  function openQuick() {
    const d = $('#quick'); if (!d) { location.href = '/board/new'; return; }
    if (!d.open) d.showModal();
    $('#q-text', d)?.focus();
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || $('dialog[open]') || !$('#quick')) return;
    e.preventDefault(); openQuick();
  });

  // ───────────── typing: previews, filters, autosave ─────────────
  let parseSeq = 0;
  const parseNow = debounce(async input => {
    const form = input.form, out = form && $('.parse-preview', form); if (!out) return;
    const text = input.value.trim(); if (!text) { out.textContent = ''; return; }
    const seq = ++parseSeq;
    try {
      const r = await send('/items/parse', { text, kind: $('input[name=kind]:checked', form)?.value || '' }, { scope: form });
      if (seq === parseSeq) out.textContent = r.preview || '';
    } catch { if (seq === parseSeq) out.textContent = ''; }   // the preview is only a hint; adding still works
  }, 250);

  function filterList(input) {
    const q = input.value.trim().toLowerCase(), scope = input.closest('form') || document;
    $$(input.dataset.filter, scope).forEach(el => { el.hidden = !!q && !el.textContent.toLowerCase().includes(q); });
  }

  const autosaveTimers = new WeakMap();
  function autosaveStatus(box) {
    const form = box.form; let s = $('[data-autosave-status]', form);
    if (!s) { s = document.createElement('span'); s.className = 'muted small'; s.setAttribute('data-autosave-status', ''); s.setAttribute('aria-live', 'polite'); form.append(s); }
    return s;
  }
  async function autosave(box) {
    clearTimeout(autosaveTimers.get(box)); autosaveTimers.delete(box);
    if (box.dataset.saved === box.value) return;
    const s = autosaveStatus(box), value = box.value;
    s.textContent = 'Saving…';
    try {
      await send(box.form.action, new FormData(box.form), { scope: box.form });
      box.dataset.saved = value;
      s.textContent = `Saved ✓ ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    } catch (err) { s.textContent = 'Not saved yet'; fail(err); }
  }

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.matches?.('[data-parse]')) parseNow(t);
    else if (t.matches?.('[data-filter]')) filterList(t);
    else if (t.matches?.('[data-sharer-filter]')) filterSharer(t.value);
    else if (t.matches?.('textarea[data-autosave]')) {
      clearTimeout(autosaveTimers.get(t));
      autosaveStatus(t).textContent = 'Not saved yet';
      autosaveTimers.set(t, setTimeout(() => autosave(t), 1200));
    }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.matches?.('select[data-autosubmit], input[data-autosubmit]') && t.form) { t.form.requestSubmit ? t.form.requestSubmit() : t.form.submit(); }
    else if (t.matches?.('input[name=kind]') && t.form) { const p = $('[data-parse]', t.form); if (p) parseNow(p); }
  });
  document.addEventListener('focusout', e => { if (e.target.matches?.('textarea[data-autosave]') && autosaveTimers.has(e.target)) autosave(e.target); });
  // Leaving the page with unsaved notes: send them on the way out (the form carries its own CSRF token).
  addEventListener('pagehide', () => {
    $$('textarea[data-autosave]').forEach(box => { if (autosaveTimers.has(box)) navigator.sendBeacon?.(box.form.action, new FormData(box.form)); });
  });

  // ───────────── drag and drop on the board ─────────────
  let dragId = null;
  const clearDrag = () => {
    dragId = null; document.body.classList.remove('is-dragging');
    $$('.dragging').forEach(n => n.classList.remove('dragging')); $$('.drop-over').forEach(z => z.classList.remove('drop-over'));
  };
  const dropZone = t => t instanceof Element ? t.closest('[data-drop], [data-tray]') : null;
  document.addEventListener('dragstart', e => {
    const t = e.target instanceof Element ? e.target : null, note = t?.closest('li.note[draggable="true"]');
    if (!note || t.closest('input, textarea, select')) return;
    dragId = note.dataset.item;
    try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch { }
    note.classList.add('dragging'); document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover', e => {
    const z = dropZone(e.target); if (!z || !dragId) return;
    e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { }
    if (!z.classList.contains('drop-over')) { $$('.drop-over').forEach(x => x.classList.remove('drop-over')); z.classList.add('drop-over'); }
  });
  document.addEventListener('dragleave', e => {
    const z = dropZone(e.target); if (z && !(e.relatedTarget instanceof Node && z.contains(e.relatedTarget))) z.classList.remove('drop-over');
  });
  document.addEventListener('drop', async e => {
    const z = dropZone(e.target); if (!z || !dragId) return;
    e.preventDefault();
    const id = dragId; clearDrag();
    if (z.hasAttribute('data-tray')) { openMover(id); return; }
    if (noteEl(id)?.closest('[data-drop]') === z) return;   // dropped where it already was
    try { await moveNote(id, z.dataset.drop); } catch (err) { fail(err); }
  });
  document.addEventListener('dragend', clearDrag);

  // ───────────── press and hold a note (phones and tablets) ─────────────
  let hold = null;
  const endHold = () => { if (hold) clearTimeout(hold.timer); };
  document.addEventListener('touchstart', e => {
    const t = e.target instanceof Element ? e.target : null, note = t?.closest('li.note[data-item]');
    if (!note || e.touches.length !== 1 || t.closest('a, button, input, textarea, select, summary, label, details[open]')) { hold = null; return; }
    const p = e.touches[0];
    hold = { id: note.dataset.item, x: p.clientX, y: p.clientY, fired: false };
    hold.timer = setTimeout(() => { hold.fired = true; navigator.vibrate?.(25); openMover(hold.id); }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!hold) return; const p = e.touches[0];
    if (Math.abs(p.clientX - hold.x) > 10 || Math.abs(p.clientY - hold.y) > 10) { endHold(); hold = null; }
  }, { passive: true });
  document.addEventListener('touchend', e => { endHold(); if (hold?.fired) e.preventDefault(); hold = null; }, { passive: false });
  document.addEventListener('touchcancel', () => { endHold(); hold = null; });
  document.addEventListener('contextmenu', e => { if (hold?.fired) e.preventDefault(); });

  // ───────────── recording a call ─────────────
  const MAX_REC_BYTES = 38 * 1024 * 1024;   // the server takes up to 40 MB
  const fmtSecs = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
  let recording = null;
  async function startRecording(sec) {
    if (!sec || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("This browser can't record. Try Chrome, Edge or Safari.", { error: true });
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return toast("Knockout needs your microphone to record. Allow it in your browser's site settings, then try again.", { error: true }); }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported?.(x)) || '';
    let mr;
    try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch { stream.getTracks().forEach(tr => tr.stop()); return toast("This browser can't record audio here.", { error: true }); }
    const chunks = [], started = Date.now(), time = $('.rec-time', sec), start = $('[data-rec-start]', sec), stop = $('[data-rec-stop]', sec);
    let bytes = 0;
    mr.ondataavailable = ev => {
      if (!ev.data?.size) return; chunks.push(ev.data); bytes += ev.data.size;
      if (bytes > MAX_REC_BYTES && mr.state === 'recording') { toast('The recording reached the size limit, so it stopped. Saving it now.'); mr.stop(); }
    };
    mr.onstop = () => {
      stream.getTracks().forEach(tr => tr.stop()); clearInterval(recording.tick);
      const blob = new Blob(chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
      uploadRecording(sec, blob, Math.round((Date.now() - started) / 1000));
    };
    recording = { mr, tick: setInterval(() => { if (time) time.textContent = `● ${fmtSecs((Date.now() - started) / 1000)}`; }, 250) };
    mr.start(1000);
    sec.classList.add('recording'); start.hidden = true; stop.hidden = false; stop.disabled = false;
    if (time) time.textContent = '● 0:00';
  }
  function stopRecording(sec) {
    if (!recording) return;
    const stop = $('[data-rec-stop]', sec); stop.disabled = true;
    const time = $('.rec-time', sec); if (time) time.textContent = 'Saving…';
    if (recording.mr.state !== 'inactive') recording.mr.stop();
  }
  async function uploadRecording(sec, blob, secs) {
    const ext = { 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[blob.type] || 'webm';
    const fd = new FormData();
    fd.append('_csrf', csrfToken(sec)); fd.append('secs', String(secs)); fd.append('audio', blob, `call.${ext}`);
    try {
      await send(`/calls/${encodeURIComponent(sec.dataset.call)}/recording`, fd, { scope: sec, multipart: true });
      recording = null; location.reload();
    } catch (err) {
      const time = $('.rec-time', sec); if (time) time.textContent = 'Not saved';
      if (err.gone) return;
      toast(err.message, { error: true, action: 'Try again', onAction: () => uploadRecording(sec, blob, secs) });
    }
  }
  addEventListener('beforeunload', e => { if (recording && recording.mr.state === 'recording') { e.preventDefault(); e.returnValue = ''; } });

  // ───────────── on load ─────────────
  function showLocalTimes(root = document) {
    $$('[data-utc]', root).forEach(el => {
      const v = el.dataset.utc; if (!v) return;
      const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(' ', 'T') : v.replace(' ', 'T') + 'Z'); if (isNaN(d)) return;
      el.textContent = el.dataset.fmt === 'time'
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    });
  }
  showLocalTimes();
  $$('form[data-tz]').forEach(setTimeZone);
  $$('textarea[data-autosave]').forEach(b => { b.dataset.saved = b.value; });

  window.Knockout = { send, toast, openMover, showLocalTimes };
})();
