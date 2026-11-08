// Sends email through the Gmail API as one Google Workspace mailbox.
//
// Credentials (Worker secrets, set in the Cloudflare dashboard, see README):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// The refresh token is limited to the gmail.send scope for a single mailbox, so it can
// only send email as that address. Revoke it from that account's Google security settings.
//
// For local development, set DEV_PRINT_EMAILS=1 in .dev.vars to log emails instead.

let cached = { token: null, exp: 0 };

async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`google token: ${res.status} ${data.error || ''}`);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

export async function sendGmail(env, { from, to, subject, text, html }) {
  const raw = buildMime({ from, to, subject, text, html });
  if (env.DEV_PRINT_EMAILS) {
    console.log(`--- email (not sent) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---`);
    return;
  }
  if (!env.GOOGLE_REFRESH_TOKEN) throw new Error('gmail not configured');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  if (!res.ok) throw new Error(`gmail send: ${res.status} ${await res.text()}`);
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = `b_${crypto.randomUUID()}`;
  const part = (type, body) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap(b64(body))].join('\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
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
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const b64url = (s) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function encodeHeader(s) {
  const clean = s.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
}
