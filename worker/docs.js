// Deal documents for the reserved area, uploaded from Google Drive by the Apps Script in the
// Deal Flow Pipeline sheet (scripts/apps-script/dealflow-sync.gs).
//
//   GET    /api/docs/<dataset>          what is stored: { files: { <driveId>: <modified> } }
//   PUT    /api/docs/<dataset>/<id>     one file's bytes (?modified=...); max 25 MB
//   POST   /api/docs/<dataset>          the full list the website should show (JSON). Files not in
//                                       the list are deleted; listed files without stored bytes
//                                       wait until they are uploaded.
// All with Authorization: Bearer <the dataset's sync key>.
//
// Visitors download through /reserved/files/<dataset>/<id>/<name> (worker/reserved.js), which
// checks the section permission first and logs every download.
//
// Storage: KV. Bytes under doc:<dataset>:<id> (with { modified, type } as metadata), the list
// under docs:<dataset>.
import { DATASETS } from './sync.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2000;
const str = (v, n) => String(v ?? '').slice(0, n);

export async function handleDocs(request, env, dataset, id) {
  const cfg = DATASETS[dataset];
  if (!cfg || !cfg.docs) return json({ ok: false, error: 'unknown dataset' }, 404);
  const secret = env[cfg.secret] || env.SYNC_SECRET;
  if (!secret || !safeEqual(request.headers.get('Authorization') || '', `Bearer ${secret}`)) return json({ ok: false }, 401);

  if (id) {
    if (request.method !== 'PUT') return json({ ok: false }, 405);
    if (!/^[\w-]{10,100}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
    const modified = str(new URL(request.url).searchParams.get('modified'), 40);
    const type = str(request.headers.get('Content-Type') || 'application/octet-stream', 120);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ ok: false, error: 'empty file' }, 400);
    if (bytes.byteLength > MAX_BYTES) return json({ ok: false, error: 'file over 25 MB' }, 413);
    await env.RESERVED_KV.put(blobKey(dataset, id), bytes, { metadata: { modified, type, size: bytes.byteLength } });
    return json({ ok: true, size: bytes.byteLength });
  }

  if (request.method === 'GET') {
    const files = {};
    for (const k of await listBlobs(env, dataset)) files[k.name.slice(blobKey(dataset, '').length)] = k.metadata?.modified || '';
    return json({ ok: true, files });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid json' }, 400);
    }
    if (!Array.isArray(body.files) || body.files.length > MAX_FILES) return json({ ok: false, error: 'invalid payload' }, 400);
    const blobs = new Map((await listBlobs(env, dataset)).map((k) => [k.name.slice(blobKey(dataset, '').length), k.metadata || {}]));
    const wanted = new Set();
    const list = [];
    let waiting = 0;
    for (const f of body.files) {
      const id = str(f.id, 100);
      if (!/^[\w-]{10,100}$/.test(id)) continue;
      wanted.add(id);
      const stored = blobs.get(id);
      // Only list a file once the stored bytes are the version Drive has.
      if (!stored || stored.modified !== str(f.modified, 40)) {
        waiting++;
        continue;
      }
      const deals = (Array.isArray(f.deals) ? f.deals : []).map((d) => str(d, 20).trim()).filter(Boolean).slice(0, 20);
      if (!deals.length) continue;
      list.push({ id, deals, name: str(f.name, 200), group: str(f.group, 120), size: stored.size || 0, type: stored.type || '', modified: str(f.modified, 40) });
    }
    let removed = 0;
    for (const id of blobs.keys()) {
      if (!wanted.has(id)) {
        await env.RESERVED_KV.delete(blobKey(dataset, id));
        removed++;
      }
    }
    await env.RESERVED_KV.put(listKey(dataset), JSON.stringify({ files: list, updatedAt: new Date().toISOString() }));
    console.log(JSON.stringify({ docs: dataset, listed: list.length, waiting, removed }));
    return json({ ok: true, listed: list.length, waiting, removed });
  }
  return json({ ok: false }, 405);
}

// The list shown on the page (no bytes).
export async function getDocs(env, dataset) {
  const raw = await env.RESERVED_KV.get(listKey(dataset));
  return raw ? JSON.parse(raw).files : [];
}

// A visitor's download: { file, response }. Permission is checked by the caller.
export async function serveDoc(env, dataset, id, request) {
  const files = await getDocs(env, dataset);
  const f = files.find((x) => x.id === id);
  if (!f) return null;
  const { value, metadata } = await env.RESERVED_KV.getWithMetadata(blobKey(dataset, id), { type: 'stream' });
  if (!value) return null;
  const type = metadata?.type || 'application/octet-stream';
  // PDFs and images open in the browser; everything else downloads.
  const inline = /^(application\/pdf|image\/)/.test(type);
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const response = new Response(value, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    },
  });
  return { file: f, response };
}

const blobKey = (dataset, id) => `doc:${dataset}:${id}`;
const listKey = (dataset) => `docs:${dataset}`;

async function listBlobs(env, dataset) {
  const out = [];
  let cursor;
  do {
    const page = await env.RESERVED_KV.list({ prefix: blobKey(dataset, ''), cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
