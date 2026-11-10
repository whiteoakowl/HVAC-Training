// Outbound email / SMS. Every message is written to outbound_messages
// first (the outbox is the record of what was sent to whom), then
// handed to a provider if one is configured through environment
// variables. Without credentials the message is kept with status
// 'not_configured' - nothing is silently dropped and nothing is faked.
//
// Email: RESEND_API_KEY + MAIL_FROM            (https://resend.com)
// SMS:   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER
const db = require('../db');

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}
function smsConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

async function deliver(channel, to, subject, body) {
  if (channel === 'email') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text: body }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return 'resend';
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: process.env.TWILIO_FROM_NUMBER, To: to, Body: body }).toString(),
  });
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return 'twilio';
}

async function send({ channel, to, subject = null, body, relatedType = null, relatedId = null }) {
  if (!to) return null;
  const configured = channel === 'email' ? emailConfigured() : smsConfigured();
  const info = await db
    .prepare('INSERT INTO outbound_messages (channel, recipient, subject, body, status, related_type, related_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channel, to, subject, body, configured ? 'queued' : 'not_configured', relatedType, relatedId);
  if (!configured) return { id: info.lastInsertRowid, status: 'not_configured' };
  try {
    const provider = await deliver(channel, to, subject, body);
    await db.prepare("UPDATE outbound_messages SET status = 'sent', provider = ?, sent_at = now_text() WHERE id = ?").run(provider, info.lastInsertRowid);
    return { id: info.lastInsertRowid, status: 'sent' };
  } catch (err) {
    await db.prepare("UPDATE outbound_messages SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), info.lastInsertRowid);
    return { id: info.lastInsertRowid, status: 'failed', error: err.message };
  }
}

async function list(limit = 200) {
  return db.prepare(`SELECT * FROM outbound_messages ORDER BY id DESC LIMIT ${Math.min(parseInt(limit, 10) || 200, 1000)}`).all();
}

module.exports = { send, list, emailConfigured, smsConfigured };
