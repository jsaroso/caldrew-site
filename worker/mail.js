// Sends the Press sign-in emails through Cloudflare Email Sending.
//
// Binding PRESS_EMAIL (wrangler.jsonc) may only send from PRESS_MAIL_FROM
// (noreply@notify.caldrew.com). notify.caldrew.com has its own DKIM key and a DMARC
// "reject" policy, so nobody else can send as that address. No personal mailbox involved.
import { EmailMessage } from 'cloudflare:email';

export async function sendMail(env, { from, fromName, replyTo, to, subject, text, html }) {
  const raw = buildMime({ from: `${fromName} <${from}>`, replyTo, to, subject, text, html, domain: from.split('@')[1] });
  await env.PRESS_EMAIL.send(new EmailMessage(from, to, raw));
}

function buildMime({ from, replyTo, to, subject, text, html, domain }) {
  const boundary = `b_${crypto.randomUUID()}`;
  const part = (type, body) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap(b64(body))].join('\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', text),
    part('text/html', html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function b64(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

function encodeHeader(s) {
  const clean = s.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
}
