// Cloudflare Worker for caldrew.com.
// Static pages are served straight from ./dist. The Worker only runs for the
// routes listed in wrangler.jsonc (run_worker_first):
//   - POST /api/contact  -> emails the contact form to enquiries@caldrew.com
//   - /press, /pt/press  -> private press kit, email + password (see README)
import { EmailMessage } from 'cloudflare:email';
import PRESS_USERS from '../press-users.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      return handleContact(request, env);
    }

    if (isPress(url.pathname)) return handlePress(request, env, url);

    return env.ASSETS.fetch(request);
  },
};

// ---------- Press: email + password ----------
//
//   GET  /press, /pt/press   signed in -> press kit; otherwise the branded sign-in page (401)
//   POST /press/signin       checks email + password, sets a signed session cookie
//   GET  /press/signout      clears the cookie
//
// Users live in press-users.json: {"name@example.com": "pbkdf2$<iterations>$<salt>$<hash>"}.
// Only password hashes are stored. Manage them with scripts/press-user.mjs (see README).
// Sessions are signed with the PRESS_SESSION_SECRET secret; without it nobody gets in.

const COOKIE = 'caldrew_press';
const SESSION_DAYS = 30;

function isPress(path) {
  return /^\/(pt\/)?press(\.html|\/.*)?$/.test(path);
}

async function handlePress(request, env, url) {
  const pt = url.pathname.startsWith('/pt/') || url.searchParams.get('lang') === 'pt';
  const home = pt ? '/pt/press' : '/press';

  if (url.pathname === '/press/signin') {
    if (request.method !== 'POST') return redirect(home);
    let form;
    try { form = await request.formData(); } catch { return redirect(home); }
    const lang = form.get('lang') === 'pt' ? 'pt' : 'en';
    const back = lang === 'pt' ? '/pt/press' : '/press';
    const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 256);
    const password = String(form.get('password') || '').slice(0, 256);

    if (env.LOGIN_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
      if (!success) return redirect(`${back}?error=wait`);
    }

    if (!(await checkPassword(env, email, password))) return redirect(`${back}?error=1`);
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const token = await signSession(env, { e: email, exp });
    return redirect(back, `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  }

  if (url.pathname === '/press/signout') {
    return redirect(pt ? '/pt' : '/', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }

  const session = await readSession(env, readCookie(request, COOKIE));
  const signedIn = Boolean(session && userExists(env, session.e));
  const page = signedIn ? home : pt ? '/pt/press-login' : '/press-login';
  const res = await env.ASSETS.fetch(new Request(new URL(page, url), request));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: signedIn ? res.status : 401, headers });
}

function users() {
  return PRESS_USERS;
}

// Removing someone from press-users.json also ends their existing session.
function userExists(env, email) {
  return Object.prototype.hasOwnProperty.call(users(env), email);
}

async function checkPassword(env, email, password) {
  const stored = users(env)[email];
  // Always do the work, so response time doesn't reveal whether the email exists.
  const [scheme, iter, salt, hash] = (stored || 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').split('$');
  if (scheme !== 'pbkdf2') return false;
  const derived = await pbkdf2(password, b64d(salt), Number(iter));
  return Boolean(stored) && timingSafeEqual(derived, b64d(hash));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.PRESS_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSession(env, data) {
  const body = b64e(new TextEncoder().encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body)));
  return `${body}.${b64e(sig)}`;
}

async function readSession(env, token) {
  if (!token || !env.PRESS_SESSION_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64d(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64d(body)));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function b64e(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64d(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function redirect(location, cookie) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
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
