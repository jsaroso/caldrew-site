// Sends the reserved-area sign-in emails through Cloudflare Email Sending.
//
// Binding PRESS_EMAIL (wrangler.jsonc) may only send from PRESS_MAIL_FROM
// (noreply@notify.caldrew.com). notify.caldrew.com has its own DKIM key and a DMARC
// "reject" policy, so nobody else can send as that address. No personal mailbox involved.
//
// The Caldrew logo travels inside the email (inline image, cid:logo@caldrew), so it shows
// without loading anything from the website.
import { EmailMessage } from 'cloudflare:email';
import LOGO from '../public/images/caldrew-logo.png';

export const LOGO_CID = 'logo@caldrew';

export async function sendMail(env, { from, fromName, replyTo, to, subject, text, html }) {
  const raw = buildMime({ from: `${fromName} <${from}>`, replyTo, to, subject, text, html, domain: from.split('@')[1] });
  await env.PRESS_EMAIL.send(new EmailMessage(from, to, raw));
}

function buildMime({ from, replyTo, to, subject, text, html, domain }) {
  const alt = `alt_${crypto.randomUUID()}`;
  const rel = `rel_${crypto.randomUUID()}`;
  const textPart = (type, body) => [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap(b64Text(body))].join('\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    textPart('text/plain', text),
    `--${alt}`,
    `Content-Type: multipart/related; boundary="${rel}"`,
    '',
    `--${rel}`,
    textPart('text/html', html),
    `--${rel}`,
    'Content-Type: image/png; name="caldrew-logo.png"',
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${LOGO_CID}>`,
    'Content-Disposition: inline; filename="caldrew-logo.png"',
    '',
    wrap(b64Bytes(new Uint8Array(LOGO))),
    `--${rel}--`,
    `--${alt}--`,
    '',
  ].join('\r\n');
}

function b64Bytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const b64Text = (s) => b64Bytes(new TextEncoder().encode(s));
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

function encodeHeader(s) {
  const clean = s.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64Text(clean)}?=`;
}
