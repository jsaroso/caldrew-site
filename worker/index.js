// Cloudflare Worker for caldrew.com.
// Static pages are served straight from ./dist. The Worker only runs for the
// routes listed in wrangler.jsonc (run_worker_first):
//   - POST /api/contact  -> emails the contact form to enquiries@caldrew.com
//   - /reserved/...      -> reserved area: email sign-in, per-email sections (worker/reserved.js)
//   - POST /api/sync/... -> Google Sheet pushes reserved-area data (worker/sync.js)
//   - public pages       -> reserved-area bar added for signed-in visitors (worker/reserved.js)
// Daily cron: digest of changes to the team (worker/sync.js).
import { EmailMessage } from 'cloudflare:email';
import { isReserved, handleReserved, withReservedBar } from './reserved.js';
import { handleSync, sendDigests } from './sync.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      return handleContact(request, env);
    }

    const sync = url.pathname.match(/^\/api\/sync\/([a-z]+)$/);
    if (sync) return handleSync(request, env, sync[1]);

    if (isReserved(url.pathname)) return handleReserved(request, env, url);

    // Public pages: add the reserved-area bar for signed-in visitors.
    return withReservedBar(request, env, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDigests(env));
  },
};

// ---------- Contact form ----------

async function handleContact(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const field = (k, max) => String(form.get(k) ?? '').trim().slice(0, max);
  const name = field('name', 256);
  const email = field('email', 256);
  const company = field('company', 256);
  const message = field('message', 5000);
  const lang = field('lang', 5) === 'pt' ? 'pt' : 'en';

  // Honeypot: real people never fill this in. Pretend success so bots move on.
  if (field('website', 256)) return json({ ok: true });

  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'invalid' }, 400);
  }

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, field('cf-turnstile-response', 4096), request.headers.get('CF-Connecting-IP'));
    if (!ok) return json({ ok: false, error: 'captcha' }, 400);
  }

  const subject = `${env.STAGING ? '[Staging] ' : ''}Website enquiry: ${name}${company ? ` (${company})` : ''}`;
  const body = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || '-'}`,
    `Language: ${lang === 'pt' ? 'Portuguese' : 'English'}`,
    `Sent: ${new Date().toISOString()}`,
    '',
    message,
    '',
    '--',
    'Sent from the contact form on caldrew.com. Reply to this email to answer the sender directly.',
  ].join('\n');

  const raw = buildMime({
    from: `Caldrew website <${env.CONTACT_FROM}>`,
    to: env.CONTACT_TO,
    replyTo: `${encodeHeader(name)} <${email}>`,
    subject,
    text: body,
    domain: env.CONTACT_FROM.split('@')[1],
  });

  try {
    await env.SEND_EMAIL.send(new EmailMessage(env.CONTACT_FROM, env.CONTACT_TO, raw));
  } catch (err) {
    console.error('contact form send failed', err);
    return json({ ok: false, error: 'send_failed' }, 502);
  }
  return json({ ok: true });
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await r.json();
  return data.success === true;
}

// Minimal RFC 5322 message: UTF-8 plain text, base64 body, encoded headers.
function buildMime({ from, to, replyTo, subject, text, domain }) {
  const id = `<${crypto.randomUUID()}@${domain}>`;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ].join('\r\n');
}

function encodeHeader(s) {
  const clean = s.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean.replace(/[<>"]/g, '');
  const b = btoa(String.fromCharCode(...new TextEncoder().encode(clean)));
  return `=?UTF-8?B?${b}?=`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
