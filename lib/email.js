/**
 * lib/email.js — sending email (a clean HTML version plus plain text).
 *
 * Uses Resend (resend.com) when RESEND_API_KEY and EMAIL_FROM ("Knockout <updates@yourdomain.com>") are set.
 * Without them, nothing is sent: the email is written to the server log, and every "send" screen in Knockout also
 * offers "Open in my email" (your own Outlook/Gmail opens with everything filled in) and "Copy", so you are never stuck.
 * To use a different provider (Postmark, SendGrid, your company's SMTP relay), change only send() below.
 */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toHtml(subject, text) {
  const body = esc(text).split(/\n{2,}/).map(par => {
    const lines = par.split('\n');
    if (lines.every(l => /^\s*[-•]/.test(l))) return `<ul style="margin:0 0 14px;padding-left:20px">${lines.map(l => `<li>${l.replace(/^\s*[-•]\s*/, '')}</li>`).join('')}</ul>`;
    return `<p style="margin:0 0 14px">${par.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#e2413b">$1</a>').replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;background:#f4f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14182b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #dfe2ec;border-radius:14px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #eceef4"><b style="font-size:17px">🥊 Knockout</b></td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 16px">${esc(subject)}</h1>${body}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #eceef4;font-size:12px;color:#5b6178">Sent with Knockout.</td></tr></table></td></tr></table></body></html>`;
}
const configured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
async function send({ to, cc, subject, text, replyTo }) {
  const list = [].concat(to || []).filter(Boolean); if (!list.length) return { ok: false };
  if (!configured()) { console.log(`EMAIL (not sent, no RESEND_API_KEY) to=${list.join(', ')} subject="${subject}"\n${text}\n`); return { ok: false, logged: true }; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: list, cc: [].concat(cc || []).filter(Boolean), subject, text, html: toHtml(subject, text), reply_to: replyTo || undefined }) });
    if (!r.ok) console.error('Email failed', r.status, await r.text());
    return { ok: r.ok };
  } catch (e) { console.error('Email error', e.message); return { ok: false }; }
}
/** mailto: link that opens the person's own email app with everything filled in (works with no email setup at all). */
function mailto({ to, cc, subject, text }) {
  const q = new URLSearchParams(); if (cc) q.set('cc', [].concat(cc).join(',')); q.set('subject', subject || ''); q.set('body', String(text || '').slice(0, 1800));
  return `mailto:${encodeURIComponent([].concat(to || []).join(','))}?${q.toString().replace(/\+/g, '%20')}`;
}
module.exports = { send, mailto, toHtml, configured };
