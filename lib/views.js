/**
 * lib/views.js — pieces of pages used in many places: an item row (with its Knock out button), chips, simple bars.
 */
const A = require('./app');
const U = require('./util');
const { html, raw } = U;

const today = () => U.today();
function dueChip(i) {
  if (!i.due_on) return '';
  const t = today(), d = U.daysBetween(t, i.due_on);
  const label = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : d < 0 ? `${-d} days late` : d < 7 ? new Date(i.due_on + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) : U.fmtDate(i.due_on).replace(/, \d{4}$/, '');
  return html`<span class="chip due ${i.status !== 'done' && d < 0 ? 'late' : d <= 1 && i.status !== 'done' ? 'soon' : ''}" title="Due ${U.fmtDate(i.due_on)}">📅 ${label}</span>`;
}
/** One item in a list. opts: { risk (Map), hide: ['person','project'], back } */
function itemRow(req, i, opts = {}) {
  const r = opts.risk?.get(i.id), hide = opts.hide || [], done = i.status === 'done';
  const [kname, kicon] = A.KIND[i.kind] || A.KIND.task, [pl, pc] = A.PRI[i.priority] || A.PRI[3];
  return html`<li class="item ${done ? 'is-done' : ''} ${r ? 'risk-' + r.state : ''}" data-item="${i.id}">
    ${done ? html`<form method="post" action="/items/${i.id}/reopen" class="ko-form">${A.csrf(req)}<button class="ko done" title="Reopen" aria-label="Reopen ${i.title}">✓</button></form>`
      : html`<form method="post" action="/items/${i.id}/ko" class="ko-form" data-ko>${A.csrf(req)}<input type="hidden" name="back" value="${opts.back || req.url}"><button class="ko" title="Knock it out" aria-label="Knock out ${i.title}"><span aria-hidden="true">🥊</span></button></form>`}
    <div class="item-main">
      <a class="item-title" href="/items/${i.id}"><span class="kind k-${i.kind}" title="${kname}" aria-label="${kname}">${kicon}</span> ${i.title}</a>
      <div class="chips">
        ${Number(i.private) ? html`<span class="chip" title="Private: only managers see it">🔒</span>` : ''}${Number(i.exec) ? html`<span class="chip exec" title="Goes in your boss's update">★ Exec</span>` : ''}
        ${i.priority <= 2 && !done ? html`<span class="chip ${pc}">${pl}</span>` : ''}
        ${dueChip(i)}
        ${r ? html`<span class="chip ${r.state === 'overdue' ? 'late' : 'warn'}">${r.state === 'overdue' ? 'Overdue' : `At risk · ${A.loeText(r.short)} short`}</span>` : ''}
        ${i.person_name && !hide.includes('person') ? (req.admin ? html`<a class="chip person" href="/people/${i.person_id}">@${i.person_name.split(' ')[0]}</a>` : html`<span class="chip person">@${i.person_name.split(' ')[0]}</span>`) : ''}
        ${i.owner_name && !hide.includes('owner') ? html`<span class="chip owner" title="${i.owner_name} owns this">→ ${i.owner_name.split(' ')[0]}</span>` : ''}
        ${i.project_tag && !hide.includes('project') ? html`<a class="chip project" href="/projects/${i.project_id}">#${i.project_tag}</a>` : ''}
        ${i.loe ? html`<span class="chip loe" title="Level of effort">${Number(i.spent) ? `${A.loeText(i.spent)} / ` : ''}${A.loeText(i.loe)}</span>` : Number(i.spent) ? html`<span class="chip loe">${A.loeText(i.spent)} logged</span>` : ''}
        ${i.status === 'waiting' || i.status === 'blocked' || i.status === 'doing' ? html`<span class="chip st-${i.status}">${A.STATUS[i.status]}</span>` : ''}
        ${i.answer ? html`<span class="chip ok">Answered</span>` : ''}
        ${done && i.completed_at ? html`<span class="chip">Knocked out ${U.fmtDate(i.completed_at)}</span>` : ''}
      </div>
    </div></li>`;
}
const list = (req, items, opts = {}) => items.length ? html`<ul class="items">${items.map(i => itemRow(req, i, opts))}</ul>` : (opts.empty === false ? '' : A.empty(opts.empty || 'Nothing here. Nice.'));
/** A plain bar (percent 0–100). */
const bar = (pct, label = '') => html`<div class="bar" role="img" aria-label="${label || pct + '%'}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
const peopleOptions = (people, sel, none = 'Nobody') => html`<option value="">${none}</option>${people.map(p => html`<option value="${p.id}" ${Number(sel) === Number(p.id) ? raw('selected') : ''}>${p.name}</option>`)}`;
const projectOptions = (projects, sel) => html`<option value="">No project</option>${projects.map(p => html`<option value="${p.id}" ${Number(sel) === Number(p.id) ? raw('selected') : ''}>${p.name} (#${p.tag})</option>`)}`;
/**
 * A simple column chart (one series, so no legend: the card title names it). Thin columns with 4px rounded tops, a 2px
 * gap, a recessive baseline, a value label only on the latest column, and a hover tooltip on every column. data: [{label, value}].
 */
function columns(data, { fmt = v => String(v), title = '' } = {}) {
  if (!data.length) return '';
  const W = 640, H = 170, pad = 22, base = H - 22, max = Math.max(1, ...data.map(d => Number(d.value) || 0));
  const bw = (W - pad * 2) / data.length, colW = Math.max(6, Math.min(36, bw - 2));
  const ticks = [0, max / 2, max];
  return html`<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid meet">
    ${ticks.map(t => { const y = base - (t / max) * (base - 14); return raw(`<line x1="${pad}" x2="${W - 6}" y1="${y}" y2="${y}" class="grid"/>`); })}
    ${data.map((d, i) => { const v = Number(d.value) || 0, h = v ? Math.max(2, (v / max) * (base - 14)) : 0, x = pad + i * bw + (bw - colW) / 2, y = base - h, r = Math.min(4, colW / 2, h);
      const path = h ? `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + colW - r} Q${x + colW},${y} ${x + colW},${y + r} V${base} Z` : '';
      return raw(`<g class="col${i === data.length - 1 ? ' last' : ''}"><rect class="hit" x="${pad + i * bw}" y="0" width="${bw}" height="${base}"><title>${U.esc(d.label)}: ${U.esc(fmt(v))}</title></rect>${path ? `<path d="${path}"/>` : ''}
        ${i === data.length - 1 && v ? `<text x="${x + colW / 2}" y="${y - 5}" class="val">${U.esc(fmt(v))}</text>` : ''}
        ${data.length <= 14 || i % 2 === data.length % 2 ? `<text x="${x + colW / 2}" y="${H - 6}" class="lbl">${U.esc(d.short || d.label)}</text>` : ''}</g>`); })}
    <line x1="${pad}" x2="${W - 6}" y1="${base}" y2="${base}" class="axis"/></svg>
    <details class="chart-table"><summary class="small muted">Show as a table</summary><table class="sheet small"><tbody>${data.map(d => html`<tr><td>${d.label}</td><td class="n">${fmt(Number(d.value) || 0)}</td></tr>`)}</tbody></table></details></figure>`;
}
module.exports = { itemRow, list, dueChip, bar, peopleOptions, projectOptions, columns };
