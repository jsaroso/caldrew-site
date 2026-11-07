// Cloudflare Worker for caldrew.com.
// Static pages are served straight from ./dist. The Worker only runs for the
// routes listed in wrangler.jsonc (run_worker_first):
//   - POST /api/contact  -> emails the contact form to enquiries@caldrew.com
//   - /press, /pt/press  -> double-checks the Cloudflare Access token
import { EmailMessage } from 'cloudflare:email';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      return handleContact(request, env);
    }

    if (isPress(url.pathname)) {
      const allowed = await hasValidAccessToken(request, env);
      if (!allowed) return forbidden(url.pathname.startsWith('/pt'));
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(res.body, { status: res.status, headers });
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------- Press: Cloudflare Access ----------

function isPress(path) {
  return /^\/(pt\/)?press(\/|\.html)?$/.test(path) || /^\/(pt\/)?press\//.test(path);
}

let jwks;
async function hasValidAccessToken(request, env) {
  // Fail closed: if Access is not configured, nobody gets in.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  try {
    await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return true;
  } catch {
    return false;
  }
}

function forbidden(pt) {
  const msg = pt
    ? 'Esta área é reservada a imprensa e parceiros da Caldrew. Para pedir acesso, escreva para enquiries@caldrew.com.'
    : 'This area is reserved for press and partners of Caldrew. To request access, write to enquiries@caldrew.com.';
  const html = `<!doctype html><html lang="${pt ? 'pt-PT' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Caldrew</title><body style="font-family:Georgia,serif;background:#F0EEE9;color:#213951;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px"><p style="max-width:32em;font-size:20px;line-height:1.5">${msg}</p></body></html>`;
  return new Response(html, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

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

  const subject = `Website enquiry: ${name}${company ? ` (${company})` : ''}`;
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
