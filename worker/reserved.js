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
import STAGING_USERS from '../staging-users.json';
import { sendMail, LOGO_CID, EMAIL_HEAD, emailColumn, emailButton } from './mail.js';
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
  return privateResponse(personalise(res, email, sections, data), res.ok ? status : res.status);
}

// Hide sections this person may not open, show who is signed in, embed synced data.
function personalise(res, email, sections, data = null) {
  return new HTMLRewriter()
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
        // Synced data for this section, embedded for the page script to render.
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
}

// Public pages: when someone is signed in, keep the reserved-area bar under the main navigation.
// Signed out (or no access any more): the page is served exactly as built.
export async function withReservedBar(request, env, url) {
  const token = readCookie(request, SESSION);
  const session = token ? await readSigned(env, token, 'session') : null;
  const sections = session ? sectionsFor(session.e) : [];
  if (!sections.length) return env.ASSETS.fetch(request);

  // Never answer from the browser's copy of the signed-out page.
  const fresh = new Request(request);
  fresh.headers.delete('If-None-Match');
  fresh.headers.delete('If-Modified-Since');
  const res = await env.ASSETS.fetch(fresh);
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return res;

  const pt = url.pathname === '/pt' || url.pathname.startsWith('/pt/');
  const barRes = await env.ASSETS.fetch(new Request(new URL(pt ? '/pt/reserved/bar' : '/reserved/bar', url)));
  if (!barRes.ok) return res;
  const bar = (await personalise(barRes, session.e, sections).text()).replace(/^\s*<!doctype[^>]*>/i, '');

  const out = new HTMLRewriter()
    .on('#caldrew-nav', {
      element(el) {
        el.after(bar, { html: true });
      },
    })
    .transform(res);
  const headers = new Headers(out.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('ETag');
  return new Response(out.body, { status: res.status, headers });
}

function privateResponse(res, status) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status, headers });
}

// ---------- staging gate ----------

// On the staging site (next.caldrew.com) every page needs a signed-in reviewer
// (staging-users.json). Same sign-in page and email as the reserved area, worded as a preview.
// Returns a response to send instead of the page, or null to carry on.
export async function stagingGate(request, env, url) {
  if (!env.STAGING) return null;
  if (/^\/reserved\/(signin|code|verify|signout)$/.test(url.pathname)) return null;
  const session = await readSigned(env, readCookie(request, SESSION), 'session');
  if (session && STAGING_USERS.includes(session.e)) return null;
  if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
  const pt = url.pathname === '/pt' || url.pathname.startsWith('/pt/');
  const res = await env.ASSETS.fetch(new Request(new URL(pt ? '/pt/reserved/preview-sign-in' : '/reserved/preview-sign-in', url)));
  return privateResponse(res, 401);
}

// Live site: anyone with a reserved section. Staging: the reviewer list only.
function canSignIn(env, email) {
  return env.STAGING ? STAGING_USERS.includes(email) : sectionsFor(email).length > 0;
}

// ---------- sign-in steps ----------

async function requestLink(request, env, url) {
  const form = await request.formData().catch(() => null);
  if (!form) return redirect('/reserved');
  const lang = form.get('lang') === 'pt' ? 'pt' : 'en';
  const next = safeNext(form.get('next'), lang, env);
  const back = lang === 'pt' ? '/pt/reserved' : '/reserved';
  const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 256);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(`${back}?error=email`);

  if (!(await allowed(env.LOGIN_LIMITER, `ip:${ip(request)}`))) return redirect(`${back}?error=wait`);
  if (!(await allowed(env.MAIL_LIMITER, `mail:${email}`))) return redirect(`${back}?error=wait`);

  const exp = now() + LINK_MINUTES * 60;
  const pending = await sign(env, { t: 'pending', e: email, exp, l: lang, n: next });

  if (canSignIn(env, email)) {
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
  if (!canSignIn(env, pending.e) || code.length !== 6 || !safeEqual(code, expected)) {
    log('code-failed', pending.e);
    return redirect(`${back}?sent=1&error=code`);
  }
  return startSession(env, pending.e, pending.n || back, true);
}

async function verifyLink(env, url) {
  const link = await readSigned(env, url.searchParams.get('t'), 'link');
  const back = link?.l === 'pt' ? '/pt/reserved' : '/reserved';
  if (!link || !canSignIn(env, link.e)) return redirect(`${back}?error=expired`);
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

// Only allow returning to a page on this site: a reserved page, or (on staging) any page.
function safeNext(value, lang, env) {
  const v = String(value || '');
  if (env.STAGING && /^\/[a-z0-9\-\/]*$/.test(v) && !v.startsWith('//') && !/(signin|signout|verify|code)$/.test(v)) return v;
  if (/^\/(pt\/)?reserved(\/[a-z0-9-]+)?$/.test(v) && !/(sign-in|no-access|signin|signout|verify|code)$/.test(v)) return v;
  return lang === 'pt' ? '/pt/reserved' : '/reserved';
}

// ---------- email ----------

function signInEmail(env, { to, lang, link, code }) {
  const pt = lang === 'pt';
  const preview = Boolean(env.STAGING);
  const t = pt
    ? {
        subject: preview ? 'O seu acesso à pré-visualização do site da Caldrew' : 'O seu acesso à área reservada da Caldrew',
        eyebrow: preview ? 'Pré-visualização' : 'Área reservada',
        title: 'O seu link de acesso',
        intro: preview
          ? 'Use o botão abaixo para abrir a pré-visualização privada do site da Caldrew.'
          : 'Use o botão abaixo para entrar na área reservada da Caldrew.',
        button: 'Entrar',
        or: 'Ou introduza este código na página onde o pediu',
        valid: `O link e o código são válidos durante ${LINK_MINUTES} minutos.`,
        ignore: 'Se não pediu este acesso, pode ignorar este email.',
      }
    : {
        subject: preview ? 'Your sign-in link for the Caldrew website preview' : 'Your sign-in link for Caldrew',
        eyebrow: preview ? 'Website preview' : 'Reserved area',
        title: 'Your sign-in link',
        intro: preview
          ? 'Use the button below to open the private preview of the Caldrew website.'
          : 'Use the button below to open the Caldrew reserved area.',
        button: 'Sign in',
        or: 'Or enter this code on the page where you asked for it',
        valid: `The link and code are valid for ${LINK_MINUTES} minutes.`,
        ignore: 'If you did not ask for this, you can ignore this email.',
      };
  const text = `${t.title}\n\n${t.intro}\n\n${link}\n\n${t.or}: ${code}\n\n${t.valid}\n${t.ignore}\n\nCaldrew, S.A.\nRua Castilho, 32 - 4, 1250-070 Lisboa`;
  const sans = "Helvetica,Arial,sans-serif";
  const serif = "Georgia,'Times New Roman',serif";
  const card = `
<tr><td style="padding:44px 44px 0">
  <img src="cid:${LOGO_CID}" width="168" height="39" alt="Caldrew Capital" style="display:block;width:168px;height:auto;border:0;outline:none;color:#354D73;font-family:${serif};font-size:20px;letter-spacing:.3em">
</td></tr>
<tr><td style="padding:40px 44px 0;font-family:${sans};font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#9C7A3A">${t.eyebrow}</td></tr>
<tr><td style="padding:12px 44px 0;font-family:${serif};font-size:30px;line-height:36px;color:#354D73">${t.title}</td></tr>
<tr><td style="padding:18px 44px 0;font-family:${sans};font-size:15px;line-height:25px;color:#213951">${t.intro}</td></tr>
<tr><td style="padding:30px 44px 0">${emailButton(link, t.button)}</td></tr>
<tr><td style="padding:36px 44px 10px;font-family:${sans};font-size:13px;line-height:20px;color:#4F6577">${t.or}</td></tr>
<tr><td style="padding:0 44px">
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td bgcolor="#FFFDF9" style="border:1px solid #D6D3CC;background:#FFFDF9;padding:14px 22px;font-family:${serif};font-size:30px;line-height:36px;letter-spacing:.32em;color:#354D73">${code}</td></tr></table>
</td></tr>
<tr><td style="padding:36px 44px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="border-top:1px solid #D6D3CC;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:18px 44px 40px;font-family:${sans};font-size:12px;line-height:20px;color:#7A8794">${t.valid}<br>${t.ignore}</td></tr>`;
  const html = `<!doctype html><html>${EMAIL_HEAD}
<body style="margin:0;padding:0;background:#EFEAE1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#EFEAE1" style="background:#EFEAE1;border-collapse:collapse"><tr><td align="center" style="padding:48px 16px">
${emailColumn(520, card, 'background:#F7F4EE;border-top:3px solid #9C7A3A')}
${emailColumn(520, `<tr><td style="padding:18px 44px 0;font-family:${sans};font-size:11px;line-height:18px;color:#8B95A0">Caldrew, S.A. · Rua Castilho, 32 - 4, 1250-070 Lisboa</td></tr>`)}
</td></tr></table></body></html>`;
  return { from: env.PRESS_MAIL_FROM, fromName: 'Caldrew', replyTo: 'enquiries@caldrew.com', to, subject: t.subject, text, html };
}

// ---------- access list, tokens, codes ----------

// reserved-users.json entries are either a list of sections, or
//   { "sections": [...], "digest": [...] }   where "digest" lists the sections whose daily digest
// this person receives ([] = none). Without "digest", they get it for all their sections.
function entry(email) {
  const v = Object.prototype.hasOwnProperty.call(USERS, email) ? USERS[email] : null;
  if (Array.isArray(v)) return { sections: v, digest: null };
  if (v && typeof v === 'object') return { sections: Array.isArray(v.sections) ? v.sections : [], digest: Array.isArray(v.digest) ? v.digest : null };
  return { sections: [], digest: null };
}

function sectionsFor(email) {
  return entry(email).sections.filter((s) => SECTIONS.includes(s));
}

// Who receives the daily digest for a section: access to it, and the digest not switched off.
export function digestRecipients(section) {
  return Object.keys(USERS).filter((e) => {
    const { digest } = entry(e);
    return sectionsFor(e).includes(section) && (digest === null || digest.includes(section));
  });
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
