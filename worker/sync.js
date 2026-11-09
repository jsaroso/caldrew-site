// Google Sheet -> website sync for the reserved area, plus the daily change digest.
//
//   POST /api/sync/<dataset>    from the Apps Script in the Google Sheet (scripts/apps-script/).
//                               Authorization: Bearer <SYNC_SECRET>. Stores the latest version
//                               in KV and records what changed since the previous one.
//   scheduled (cron, daily)     emails everyone with access to that section a digest of the
//                               changes since the last digest, then clears the log. Nothing is
//                               sent if nothing changed.
//
// Datasets map 1:1 to reserved sections. A dataset can carry extra tabs (e.g. an activity log)
// next to its main table; only the main table is compared for the digest.
import { sendMail } from './mail.js';
import { usersWithSection } from './reserved.js';

export const DATASETS = {
  fundraising: {
    title: 'Fundraising',
    // Fields whose changes the team hears about, by sheet header.
    watch: ['Stage', 'First contact'],
  },
  dealflow: {
    title: 'Dealflow',
    watch: ['Furthest stage reached', 'Status', 'Ball with', 'Next step'],
    // Rows are matched on the ID column; the digest names them by the Opportunity column.
    nameColumn: 'Opportunity',
    // Its own upload key (falls back to SYNC_SECRET).
    secret: 'SYNC_SECRET_DEALFLOW',
  },
};

const MAX_ROWS = 2000;
const MAX_CELL = 10000;
const MAX_LOG = 1000;

export async function handleSync(request, env, dataset) {
  if (!DATASETS[dataset]) return json({ ok: false, error: 'unknown dataset' }, 404);
  if (request.method !== 'POST') return json({ ok: false }, 405);
  const auth = request.headers.get('Authorization') || '';
  const secret = env[DATASETS[dataset].secret] || env.SYNC_SECRET;
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return json({ ok: false }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const clean = validate(body);
  if (!clean) return json({ ok: false, error: 'invalid payload' }, 400);

  const previous = await getData(env, dataset);
  const data = { ...clean, updatedAt: new Date().toISOString() };
  await env.RESERVED_KV.put(`data:${dataset}`, JSON.stringify(data));

  // Only compare versions of the same tab (e.g. the demo data never triggers a digest).
  const changes = previous && previous.sheet === data.sheet ? diff(previous, data, DATASETS[dataset]) : [];
  if (changes.length) {
    const log = JSON.parse((await env.RESERVED_KV.get(`changes:${dataset}`)) || '[]');
    await env.RESERVED_KV.put(`changes:${dataset}`, JSON.stringify([...log, ...changes].slice(-MAX_LOG)));
  }
  console.log(JSON.stringify({ sync: dataset, rows: data.rows.length, changes: changes.length }));
  return json({ ok: true, rows: data.rows.length, changes: changes.length });
}

export async function getData(env, dataset) {
  const raw = await env.RESERVED_KV.get(`data:${dataset}`);
  return raw ? JSON.parse(raw) : null;
}

const str = (v) => String(v ?? '').slice(0, MAX_CELL);

function table(t) {
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return null;
  if (t.columns.length > 60 || t.rows.length > MAX_ROWS) return null;
  const columns = t.columns.map(str);
  const rows = t.rows
    .filter((r) => r && Array.isArray(r.cells))
    .map((r) => ({ cells: columns.map((_, i) => str(r.cells[i])), warm: Boolean(r.warm) }))
    .filter((r) => r.cells.some((c) => c.trim()));
  return { columns, rows };
}

function validate(body) {
  const main = table(body);
  if (!main) return null;
  const extra = {};
  for (const [name, t] of Object.entries(body.extra || {}).slice(0, 10)) {
    const clean = table(t);
    if (clean) extra[str(name).slice(0, 40)] = clean;
  }
  return { sheet: str(body.sheet).slice(0, 100), ...main, extra };
}

// Rows are matched on the first column (a name or an ID).
function diff(prev, next, cfg) {
  const watch = cfg.watch;
  const nameAt = cfg.nameColumn ? next.columns.indexOf(cfg.nameColumn) : -1;
  const label = (r) => (nameAt >= 0 && r.cells[nameAt].trim() ? r.cells[nameAt].trim() : r.cells[0].trim());
  const at = next.updatedAt;
  const key = (r) => r.cells[0].trim();
  const idx = (cols, name) => cols.indexOf(name);
  const before = new Map(prev.rows.map((r) => [key(r), r]));
  const after = new Map(next.rows.map((r) => [key(r), r]));
  const out = [];
  for (const [k, row] of after) {
    const old = before.get(k);
    if (!old) {
      out.push({ at, key: label(row), type: 'added' });
      continue;
    }
    for (const field of watch) {
      const i = idx(next.columns, field);
      const j = idx(prev.columns, field);
      if (i < 0 || j < 0) continue;
      const a = old.cells[j].trim();
      const b = row.cells[i].trim();
      if (a === b) continue;
      // For multi-line logs (Stage), report only the lines that are new.
      const oldLines = new Set(a.split('\n').map((l) => l.trim()));
      const added = b.split('\n').map((l) => l.trim()).filter((l) => l && !oldLines.has(l));
      out.push({ at, key: label(row), type: 'changed', field, to: added.length ? added.join('\n') : b, from: a });
    }
  }
  for (const [k, row] of before) if (!after.has(k)) out.push({ at, key: label(row), type: 'removed' });
  return out;
}

// ---------- daily digest ----------

export async function sendDigests(env) {
  for (const [dataset, cfg] of Object.entries(DATASETS)) {
    const log = JSON.parse((await env.RESERVED_KV.get(`changes:${dataset}`)) || '[]');
    if (!log.length) continue;
    const recipients = usersWithSection(dataset);
    let sent = 0;
    for (const to of recipients) {
      try {
        await sendMail(env, digestEmail(env, { to, dataset, title: cfg.title, log }));
        sent++;
      } catch (err) {
        console.error('digest failed', to, err);
      }
    }
    // Keep the log if nothing went out, so the next run retries.
    if (sent) await env.RESERVED_KV.put(`changes:${dataset}`, '[]');
    console.log(JSON.stringify({ digest: dataset, changes: log.length, recipients: recipients.length, sent }));
  }
}

function digestEmail(env, { to, dataset, title, log }) {
  const url = `${env.SITE_URL}/reserved/${dataset}`;
  // Group by decision unit, keep the latest entry per field.
  const groups = new Map();
  for (const c of log) {
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c);
  }
  const describe = (c) =>
    c.type === 'added' ? 'Added to the list' : c.type === 'removed' ? 'Removed from the list' : `${c.field}: ${c.to}`;
  const n = groups.size;
  const subject = `${title}: ${n} ${n === 1 ? 'update' : 'updates'}`;

  const text = [
    `${title} updates since the last digest:`,
    '',
    ...[...groups].map(([k, cs]) => `${k}\n${cs.map((c) => `  - ${describe(c).replace(/\n/g, '\n    ')}`).join('\n')}`),
    '',
    `Open: ${url}`,
  ].join('\n');

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const items = [...groups]
    .map(
      ([k, cs]) => `<tr><td style="padding:14px 0;border-top:1px solid #D6D3CC">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#354D73;padding:0 0 6px">${esc(k)}</div>
${cs.map((c) => `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#213951">${esc(describe(c))}</div>`).join('')}
</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F7F4EE">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 0 36px"><img src="cid:logo@caldrew" width="168" height="39" alt="Caldrew Capital" style="display:block;width:168px;height:auto;border:0"></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#9C7A3A;padding:0 0 10px">${esc(title)}</td></tr>
<tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#354D73;padding:0 0 24px">${n} ${n === 1 ? 'update' : 'updates'} since the last digest</td></tr>
${items}
<tr><td style="padding:28px 0 32px;border-top:1px solid #D6D3CC"><a href="${url}" style="display:inline-block;background:#354D73;color:#F0EEE9;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;padding:16px 36px">Open ${esc(title)}</a></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#7A8794">Confidential. Sent to the Caldrew team members with access to ${esc(title)}.<br>Caldrew, S.A. · Rua Castilho, 32 - 4, 1250-070 Lisboa</td></tr>
</table></td></tr></table></body></html>`;
  return { from: env.PRESS_MAIL_FROM, fromName: 'Caldrew', replyTo: 'enquiries@caldrew.com', to, subject, text, html };
}

// ---------- helpers ----------

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
