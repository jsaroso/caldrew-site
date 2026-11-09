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

// ---------- building blocks that also render in Outlook for Windows (Word engine) ----------

// <head>: light mode only, and no gaps or hairlines between table cells in Outlook.
export const EMAIL_HEAD = `<head><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<!--[if mso]><style>table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}td{mso-line-height-rule:exactly}</style><![endif]-->
</head>`;

// A centred column of fixed width. Outlook ignores max-width, so it gets a fixed-width table.
export function emailColumn(width, inner, style = '') {
  return `<!--[if mso]><table role="presentation" width="${width}" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${width}px;border-collapse:collapse;${style}">${inner}</table>
<!--[if mso]></td></tr></table><![endif]-->`;
}

// "Bulletproof" button: colour and padding sit on the table cell, which Outlook respects
// (it ignores padding on links).
export function emailButton(href, label) {
  const sans = 'Helvetica,Arial,sans-serif';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
<td bgcolor="#354D73" style="background:#354D73;padding:17px 44px;mso-padding-alt:17px 44px">
<a href="${href}" style="display:inline-block;font-family:${sans};font-size:12px;line-height:16px;letter-spacing:.2em;text-transform:uppercase;color:#F0EEE9;text-decoration:none">${label}</a>
</td></tr></table>`;
}

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
