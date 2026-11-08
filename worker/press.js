// Private Press area: email-only sign-in with a link or a 6-digit code.
//
//   GET  /press, /pt/press   signed in -> press kit; otherwise the branded sign-in page (401)
//   POST /press/signin       email -> if it is on the list, emails a sign-in link + code.
//                            Always answers the same way, so the page never reveals who has access.
//   GET  /press/verify?t=    the link from the email (reusable for 15 minutes, because corporate
//                            mail scanners open links before people do)
//   POST /press/code         the 6-digit code, typed on the device that asked for it
//   GET  /press/signout      clears the session
//
// Who has access: press-users.json (a list of emails), managed with scripts/press-user.mjs.
// Everything is signed with the PRESS_SESSION_SECRET secret; without it nobody gets in.
// No database: links, codes and sessions are self-contained signed tokens.
import PRESS_USERS from '../press-users.json';
import { sendMail } from './mail.js';

const SESSION = 'caldrew_press';
const PENDING = 'caldrew_press_pending';
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

export function isPress(path) {
  return /^\/(pt\/)?press(\.html|\/.*)?$/.test(path);
}

export async function handlePress(request, env, url) {
  const pt = url.pathname.startsWith('/pt/') || url.searchParams.get('lang') === 'pt';
  const home = pt ? '/pt/press' : '/press';
  const p = url.pathname;

  if (p === '/press/signin' && request.method === 'POST') return requestLink(request, env, url);
  if (p === '/press/code' && request.method === 'POST') return checkCode(request, env);
  if (p === '/press/verify') return verifyLink(env, url);
  if (p === '/press/signout') return redirect(pt ? '/pt' : '/', clear(SESSION));
  if (p.startsWith('/press/')) return redirect(home);

  const session = await readSigned(env, readCookie(request, SESSION), 'session');
  const signedIn = Boolean(session && hasAccess(session.e));
  const page = signedIn ? home : pt ? '/pt/press-login' : '/press-login';
  const res = await env.ASSETS.fetch(new Request(new URL(page, url), request));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: signedIn ? res.status : 401, headers });
}

// ---------- steps ----------

async function requestLink(request, env, url) {
  const form = await request.formData().catch(() => null);
  if (!form) return redirect('/press');
  const lang = form.get('lang') === 'pt' ? 'pt' : 'en';
  const back = lang === 'pt' ? '/pt/press' : '/press';
  const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 256);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(`${back}?error=email`);

  if (!(await allowed(env.LOGIN_LIMITER, `ip:${ip(request)}`))) return redirect(`${back}?error=wait`);
  if (!(await allowed(env.MAIL_LIMITER, `mail:${email}`))) return redirect(`${back}?error=wait`);

  const exp = now() + LINK_MINUTES * 60;
  const pending = await sign(env, { t: 'pending', e: email, exp, l: lang });

  if (hasAccess(email)) {
    const link = `${url.origin}/press/verify?t=${await sign(env, { t: 'link', e: email, exp, l: lang })}`;
    try {
      await sendMail(env, signInEmail(env, { to: email, lang, link, code: await codeFor(env, email, exp) }));
    } catch (err) {
      console.error('press sign-in email failed', err);
      return redirect(`${back}?error=send`);
    }
  }
  // Same answer whether or not the address has access.
  return redirect(`${back}?sent=1`, cookie(PENDING, pending, LINK_MINUTES * 60));
}

async function checkCode(request, env) {
  const form = await request.formData().catch(() => null);
  const pending = await readSigned(env, readCookie(request, PENDING), 'pending');
  const lang = pending?.l === 'pt' || form?.get('lang') === 'pt' ? 'pt' : 'en';
  const back = lang === 'pt' ? '/pt/press' : '/press';
  if (!pending) return redirect(`${back}?error=expired`);
  if (!(await allowed(env.LOGIN_LIMITER, `ip:${ip(request)}`))) return redirect(`${back}?sent=1&error=wait`);

  const code = String(form?.get('code') || '').replace(/\D/g, '');
  const expected = await codeFor(env, pending.e, pending.exp);
  if (!hasAccess(pending.e) || code.length !== 6 || !safeEqual(code, expected)) {
    return redirect(`${back}?sent=1&error=code`);
  }
  return startSession(env, pending.e, back, true);
}

async function verifyLink(env, url) {
  const link = await readSigned(env, url.searchParams.get('t'), 'link');
  const back = link?.l === 'pt' ? '/pt/press' : '/press';
  if (!link || !hasAccess(link.e)) return redirect(`${back}?error=expired`);
  return startSession(env, link.e, back, false);
}

async function startSession(env, email, back, clearPending) {
  const token = await sign(env, { t: 'session', e: email, exp: now() + SESSION_DAYS * 86400 });
  const headers = new Headers({ Location: back, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(SESSION, token, SESSION_DAYS * 86400));
  if (clearPending) headers.append('Set-Cookie', clear(PENDING));
  return new Response(null, { status: 303, headers });
}

// ---------- email ----------

function signInEmail(env, { to, lang, link, code }) {
  const pt = lang === 'pt';
  const t = pt
    ? {
        subject: 'O seu acesso à área de imprensa da Caldrew',
        intro: 'Use o botão abaixo para entrar na área de imprensa da Caldrew.',
        button: 'Entrar',
        or: 'Ou introduza este código na página onde o pediu:',
        valid: `O link e o código são válidos durante ${LINK_MINUTES} minutos.`,
        ignore: 'Se não pediu este acesso, pode ignorar este email.',
      }
    : {
        subject: 'Your sign-in link for Caldrew press',
        intro: 'Use the button below to open the Caldrew press area.',
        button: 'Sign in',
        or: 'Or enter this code on the page where you asked for it:',
        valid: `The link and code are valid for ${LINK_MINUTES} minutes.`,
        ignore: 'If you did not ask for this, you can ignore this email.',
      };
  const text = `${t.intro}\n\n${link}\n\n${t.or} ${code}\n\n${t.valid}\n${t.ignore}\n\nCaldrew, S.A.\nRua Castilho, 32 - 4, 1250-070 Lisboa`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F7F4EE">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 0 32px;font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:.3em;color:#354D73">CALDREW</td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#213951;padding:0 0 28px">${t.intro}</td></tr>
<tr><td style="padding:0 0 32px"><a href="${link}" style="display:inline-block;background:#354D73;color:#F0EEE9;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;padding:16px 36px">${t.button}</a></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#4F6577;padding:0 0 8px">${t.or}</td></tr>
<tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:32px;letter-spacing:.25em;color:#354D73;padding:0 0 32px">${code}</td></tr>
<tr><td style="border-top:1px solid #D6D3CC;padding:20px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#7A8794">${t.valid}<br>${t.ignore}<br><br>Caldrew, S.A. · Rua Castilho, 32 - 4, 1250-070 Lisboa</td></tr>
</table></td></tr></table></body></html>`;
  return { from: env.PRESS_MAIL_FROM, fromName: 'Caldrew', replyTo: 'enquiries@caldrew.com', to, subject: t.subject, text, html };
}

// ---------- access list, tokens, codes ----------

function hasAccess(email) {
  return Array.isArray(PRESS_USERS) && PRESS_USERS.includes(email);
}

async function codeFor(env, email, exp) {
  const mac = await hmac(env, `code|${email}|${exp}`);
  const n = new DataView(mac.buffer).getUint32(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

async function sign(env, data) {
  const body = b64e(new TextEncoder().encode(JSON.stringify(data)));
  return `${body}.${b64e(await hmac(env, body))}`;
}

async function readSigned(env, token, type) {
  if (!token || !env.PRESS_SESSION_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    if (!safeEqual(b64e(await hmac(env, body)), sig)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64d(body)));
    return data.t === type && data.exp > now() ? data : null;
  } catch {
    return null;
  }
}

async function hmac(env, message) {
  if (!env.PRESS_SESSION_SECRET) throw new Error('PRESS_SESSION_SECRET not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PRESS_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// ---------- helpers ----------

async function allowed(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

const now = () => Math.floor(Date.now() / 1000);
const ip = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function b64e(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64d(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const clear = (name) => cookie(name, '', 0);

function redirect(location, setCookie) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
}
