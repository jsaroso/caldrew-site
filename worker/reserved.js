// Reserved area: email-only sign-in (link or 6-digit code) and per-email sections.
//
// Pages (English; the same under /pt/...):
//   /reserved                  hub, shows only the sections this person may open
//   /reserved/<section>        press | fundraising | dealflow
//   /reserved/files/<section>/<file>   protected downloads, same permission as the section
// Actions:
//   POST /reserved/signin      email -> if it has access, emails a sign-in link + code.
//                              Always answers the same way, so the page never reveals who has access.
//   GET  /reserved/verify?t=   the link from the email (reusable for 15 minutes, because corporate
//                              mail scanners open links before people do)
//   POST /reserved/code        the 6-digit code, typed on the device that asked for it
//   GET  /reserved/signout
// Old /press URLs redirect to /reserved/press.
//
// Who sees what: reserved-users.json, {"name@example.com": ["press", "dealflow"]}, managed with
// scripts/reserved-user.mjs. Read on every request, so changes apply immediately, even mid-session.
// Everything is signed with the PRESS_SESSION_SECRET secret; without it nobody gets in.
// No database: links, codes and sessions are self-contained signed tokens.
// Every sign-in and page view is logged (Workers Logs): who, what, when.
import USERS from '../reserved-users.json';
import { sendMail, LOGO_CID } from './mail.js';
import { DATASETS, getData } from './sync.js';

export const SECTIONS = ['press', 'fundraising', 'dealflow'];
const SESSION = 'caldrew_reserved';
const PENDING = 'caldrew_reserved_pending';
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

export function isReserved(path) {
  return /^\/(pt\/)?(reserved|press)(\.html|\/.*)?$/.test(path);
}

export async function handleReserved(request, env, url) {
  const path = url.pathname.replace(/\.html$/, '').replace(/\/$/, '');
  const pt = path.startsWith('/pt/');
  const base = pt ? '/pt/reserved' : '/reserved';

  // Old Press URLs
  if (/^\/(pt\/)?press$/.test(path)) return redirect(`${base}/press`, null, 301);
  if (/^\/(pt\/)?press\//.test(path)) return redirect(base, null, 301);

  // Actions
  if (path === '/reserved/signin' && request.method === 'POST') return requestLink(request, env, url);
  if (path === '/reserved/code' && request.method === 'POST') return checkCode(request, env);
  if (path === '/reserved/verify') return verifyLink(env, url);
  if (path === '/reserved/signout') return redirect(pt ? '/pt' : '/', clear(SESSION));

  // Pages and files
  const rest = path.slice(base.length).replace(/^\//, ''); // '', 'press', 'files/press/x.pdf', ...
  const [first, second] = rest.split('/');
  const isFile = first === 'files';
  const section = isFile ? second : first || null;

  const session = await readSigned(env, readCookie(request, SESSION), 'session');
  const sections = session ? sectionsFor(session.e) : [];

  if (!sections.length) {
    if (isFile) return new Response('Not found', { status: 404 });
    return page(env, url, `${base}/sign-in`, 401);
  }
  if (first === 'sign-in' || first === 'no-access') return redirect(base);
  // One section only: skip the hub and open it directly.
  if (!section && !isFile && sections.length === 1) return redirect(`${base}/${sections[0]}`);
  if (section && !SECTIONS.includes(section)) {
    const res = await env.ASSETS.fetch(new Request(new URL('/404', url)));
    return privateResponse(res, 404);
  }
  if (section && !sections.includes(section)) {
    log('denied', session.e, section);
    return isFile ? new Response('Forbidden', { status: 403 }) : page(env, url, `${base}/no-access`, 403, session.e, sections);
  }

  log(isFile ? 'download' : 'view', session.e, isFile ? rest : section || 'hub');
  if (isFile) {
    const res = await env.ASSETS.fetch(new Request(new URL(`/reserved/${rest}`, url), request));
    return privateResponse(res, res.status);
  }
  const data = section && DATASETS[section] ? await getData(env, section) : null;
  return page(env, url, section ? `${base}/${section}` : base, 200, session.e, sections, data);
}

// Serve a built page, hiding sections this person may not open and showing who is signed in.
async function page(env, url, target, status, email, sections = [], data = null) {
  const res = await env.ASSETS.fetch(new Request(new URL(target, url)));
  const out = new HTMLRewriter()
    .on('[data-section]', {
      element(el) {
        if (!sections.includes(el.getAttribute('data-section'))) el.remove();
      },
    })
    .on('[data-tabs]', {
      element(el) {
        // Tabs only make sense with more than one section.
        if (sections.length < 2) el.remove();
      },
    })
    .on('script#reserved-data', {
      element(el) {
        // Synced sheet data for this section, embedded for the page script to render.
        // "<" is escaped so the JSON can never close the script tag.
        const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        el.setInnerContent(safe, { html: true });
      },
    })
    .on('[data-user-email]', {
      element(el) {
        if (email) el.setInnerContent(email);
      },
    })
    .transform(res);
  return privateResponse(out, res.ok ? status : res.status);
}

function privateResponse(res, status) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status, headers });
}

// ---------- sign-in steps ----------

async function requestLink(request, env, url) {
  const form = await request.formData().catch(() => null);
  if (!form) return redirect('/reserved');
  const lang = form.get('lang') === 'pt' ? 'pt' : 'en';
  const next = safeNext(form.get('next'), lang);
  const back = lang === 'pt' ? '/pt/reserved' : '/reserved';
  const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 256);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(`${back}?error=email`);

  if (!(await allowed(env.LOGIN_LIMITER, `ip:${ip(request)}`))) return redirect(`${back}?error=wait`);
  if (!(await allowed(env.MAIL_LIMITER, `mail:${email}`))) return redirect(`${back}?error=wait`);

  const exp = now() + LINK_MINUTES * 60;
  const pending = await sign(env, { t: 'pending', e: email, exp, l: lang, n: next });

  if (sectionsFor(email).length) {
    const link = `${url.origin}/reserved/verify?t=${await sign(env, { t: 'link', e: email, exp, l: lang, n: next })}`;
    try {
      await sendMail(env, signInEmail(env, { to: email, lang, link, code: await codeFor(env, email, exp) }));
      log('link-sent', email);
    } catch (err) {
      console.error('reserved sign-in email failed', err);
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
  const back = lang === 'pt' ? '/pt/reserved' : '/reserved';
  if (!pending) return redirect(`${back}?error=expired`);
  if (!(await allowed(env.LOGIN_LIMITER, `ip:${ip(request)}`))) return redirect(`${back}?sent=1&error=wait`);

  const code = String(form?.get('code') || '').replace(/\D/g, '');
  const expected = await codeFor(env, pending.e, pending.exp);
  if (!sectionsFor(pending.e).length || code.length !== 6 || !safeEqual(code, expected)) {
    log('code-failed', pending.e);
    return redirect(`${back}?sent=1&error=code`);
  }
  return startSession(env, pending.e, pending.n || back, true);
}

async function verifyLink(env, url) {
  const link = await readSigned(env, url.searchParams.get('t'), 'link');
  const back = link?.l === 'pt' ? '/pt/reserved' : '/reserved';
  if (!link || !sectionsFor(link.e).length) return redirect(`${back}?error=expired`);
  return startSession(env, link.e, link.n || back, false);
}

async function startSession(env, email, next, clearPending) {
  log('signin', email);
  const token = await sign(env, { t: 'session', e: email, exp: now() + SESSION_DAYS * 86400 });
  const headers = new Headers({ Location: next, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(SESSION, token, SESSION_DAYS * 86400));
  if (clearPending) headers.append('Set-Cookie', clear(PENDING));
  return new Response(null, { status: 303, headers });
}

// Only allow returning to a reserved page on this site.
function safeNext(value, lang) {
  const v = String(value || '');
  if (/^\/(pt\/)?reserved(\/[a-z0-9-]+)?$/.test(v) && !/(sign-in|no-access|signin|signout|verify|code)$/.test(v)) return v;
  return lang === 'pt' ? '/pt/reserved' : '/reserved';
}

// ---------- email ----------

function signInEmail(env, { to, lang, link, code }) {
  const pt = lang === 'pt';
  const t = pt
    ? {
        subject: 'O seu acesso à área reservada da Caldrew',
        intro: 'Use o botão abaixo para entrar na área reservada da Caldrew.',
        button: 'Entrar',
        or: 'Ou introduza este código na página onde o pediu:',
        valid: `O link e o código são válidos durante ${LINK_MINUTES} minutos.`,
        ignore: 'Se não pediu este acesso, pode ignorar este email.',
      }
    : {
        subject: 'Your sign-in link for Caldrew',
        intro: 'Use the button below to open the Caldrew reserved area.',
        button: 'Sign in',
        or: 'Or enter this code on the page where you asked for it:',
        valid: `The link and code are valid for ${LINK_MINUTES} minutes.`,
        ignore: 'If you did not ask for this, you can ignore this email.',
      };
  const text = `${t.intro}\n\n${link}\n\n${t.or} ${code}\n\n${t.valid}\n${t.ignore}\n\nCaldrew, S.A.\nRua Castilho, 32 - 4, 1250-070 Lisboa`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F7F4EE">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 0 36px"><img src="cid:${LOGO_CID}" width="168" height="39" alt="Caldrew Capital" style="display:block;width:168px;height:auto;border:0;outline:none;color:#354D73;font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:.3em"></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#213951;padding:0 0 28px">${t.intro}</td></tr>
<tr><td style="padding:0 0 32px"><a href="${link}" style="display:inline-block;background:#354D73;color:#F0EEE9;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;padding:16px 36px">${t.button}</a></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#4F6577;padding:0 0 8px">${t.or}</td></tr>
<tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:32px;letter-spacing:.25em;color:#354D73;padding:0 0 32px">${code}</td></tr>
<tr><td style="border-top:1px solid #D6D3CC;padding:20px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#7A8794">${t.valid}<br>${t.ignore}<br><br>Caldrew, S.A. · Rua Castilho, 32 - 4, 1250-070 Lisboa</td></tr>
</table></td></tr></table></body></html>`;
  return { from: env.PRESS_MAIL_FROM, fromName: 'Caldrew', replyTo: 'enquiries@caldrew.com', to, subject: t.subject, text, html };
}

// ---------- access list, tokens, codes ----------

export function usersWithSection(section) {
  return Object.keys(USERS).filter((e) => sectionsFor(e).includes(section));
}

function sectionsFor(email) {
  const list = Object.prototype.hasOwnProperty.call(USERS, email) ? USERS[email] : [];
  return Array.isArray(list) ? list.filter((s) => SECTIONS.includes(s)) : [];
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

function log(event, email, detail) {
  console.log(JSON.stringify({ reserved: event, email, detail, at: new Date().toISOString() }));
}

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

function redirect(location, setCookie, status = 303) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return new Response(null, { status, headers });
}
