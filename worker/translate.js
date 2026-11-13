// Portuguese for the notes the team writes in English in the Google Sheets (where it stands,
// next step, activity, comments...). The sheets stay as written; the Portuguese reserved pages
// show a translation.
//
//   - Which columns are translated: `translate` in DATASETS (worker/sync.js).
//   - Translated line by line, so a dated log keeps one entry per line, and a new log line is the
//     only thing sent for translation.
//   - Each line is translated once, with Claude, and kept in KV (tr:<dataset>:pt, keyed by a hash
//     of the English line). Lines no longer in the sheet are dropped from the store.
//   - Runs from the cron trigger (every 10 minutes) and right after each sync. Without
//     ANTHROPIC_API_KEY (a Worker secret) nothing is translated and the pages show the English.
//   - A line that cannot be translated (refusal, bad output) is stored as null: the page shows the
//     English and it is not retried, so nothing is paid twice for it.
import Anthropic from '@anthropic-ai/sdk';
import { DATASETS, getData } from './sync.js';

const MODEL = 'claude-opus-5-5';
const BATCH_CHARS = 8000; // per request: keeps each answer well under max_tokens
const BUDGET_MS = 5 * 60 * 1000;

const SYSTEM = `You translate internal notes of Caldrew, a Lisbon private equity firm, from English into European Portuguese (pt-PT, never Brazilian Portuguese).

The notes come from the team's deal pipeline and fundraising tracker. They are terse working notes, often fragments. Translate each item faithfully and keep it as terse as the original.

Keep exactly as written:
- names of people, companies, funds, projects, places and banks (e.g. "Project Electronix", "Oaklins", "Teak Capital")
- initials of team members (JSA, MQP, MMV, JB, HMC, DCG) and "Caldrew"
- numbers, amounts, percentages, currencies, dates and times (keep "9/11 9:30", "08-Nov", "EUR 1.60M" as they are)
- email addresses, URLs and file names
- finance and deal shorthand that Portuguese professionals use in English: NBO, IM, NDA, LOI, SPA, EBITDA, PF, EV, IRR, MOIC, CDD, VDR, IRL, IC, LP, GP, KPI, SGPS, Lda., S.A., capex, buy-and-build, add-on, pipeline, teaser, due diligence, family office, deal

Use Portuguese business vocabulary: "reunião", "proposta", "sócios", "assessor", "acionista", "faturação" or "receitas", "ponto de situação", "próximo passo".
If an item is already in Portuguese, or is only a name or a code, return it unchanged.
Return every item, with the same id, and nothing else.`;

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

// ---------- reading (page side) ----------

// Data for a Portuguese page: translated lines where a translation exists.
export async function translated(env, dataset, data) {
  const cfg = DATASETS[dataset]?.translate;
  if (!cfg || !data) return data;
  const store = await getStore(env, dataset);
  if (!Object.keys(store).length) return data;
  const swap = async (table, cols) => {
    if (!table || !cols?.length) return table;
    const idx = cols.map((c) => table.columns.indexOf(c)).filter((i) => i >= 0);
    if (!idx.length) return table;
    const rows = [];
    for (const r of table.rows) {
      const cells = r.cells.slice();
      for (const i of idx) cells[i] = await mapLines(cells[i], (line, h) => store[h] || line);
      rows.push({ ...r, cells });
    }
    return { ...table, rows };
  };
  const out = { ...data, ...(await swap(data, cfg.main)) };
  if (cfg.extra && data.extra) {
    out.extra = { ...data.extra };
    for (const [name, cols] of Object.entries(cfg.extra)) out.extra[name] = await swap(data.extra[name], cols);
  }
  return out;
}

// ---------- translating (background) ----------

export async function translateAll(env) {
  for (const [dataset, cfg] of Object.entries(DATASETS)) if (cfg.translate) await translatePending(env, dataset);
}

export async function translatePending(env, dataset) {
  const cfg = DATASETS[dataset]?.translate;
  if (!cfg || !env.ANTHROPIC_API_KEY) return;
  const data = await getData(env, dataset);
  if (!data) return;

  // Every distinct line in the translated columns.
  const wanted = new Map();
  const collect = async (table, cols) => {
    if (!table || !cols?.length) return;
    const idx = cols.map((c) => table.columns.indexOf(c)).filter((i) => i >= 0);
    for (const r of table.rows) for (const i of idx) await mapLines(r.cells[i], (line, h) => (wanted.set(h, line), line));
  };
  await collect(data, cfg.main);
  for (const [name, cols] of Object.entries(cfg.extra || {})) await collect(data.extra?.[name], cols);

  const store = await getStore(env, dataset);
  const missing = [...wanted].filter(([h]) => !(h in store));
  const stale = Object.keys(store).filter((h) => !wanted.has(h));
  if (!missing.length && !stale.length) return;

  // ANTHROPIC_BASE_URL is only for local testing against a stand-in server.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
  const started = Date.now();
  let done = 0;
  for (const batch of batches(missing)) {
    if (Date.now() - started > BUDGET_MS) break;
    const result = await translateBatch(client, batch);
    if (!result) break; // API error: try again on the next run
    Object.assign(store, result);
    done += batch.length;
    await env.RESERVED_KV.put(storeKey(dataset), JSON.stringify(store));
  }
  for (const h of stale) delete store[h];
  if (stale.length) await env.RESERVED_KV.put(storeKey(dataset), JSON.stringify(store));
  console.log(JSON.stringify({ translate: dataset, missing: missing.length, translated: done, dropped: stale.length }));
}

async function translateBatch(client, batch) {
  const items = batch.map(([h, text]) => ({ id: h, text }));
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ items }) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error('translate: invalid ANTHROPIC_API_KEY');
    else if (err instanceof Anthropic.RateLimitError) console.error('translate: rate limited, retrying next run');
    else if (err instanceof Anthropic.APIError) console.error(`translate: API error ${err.status}`, err.message);
    else console.error('translate: request failed', err);
    return null;
  }
  const out = {};
  // Refused or unusable: remember these lines as untranslatable (English is shown, never retried).
  const giveUp = () => (batch.forEach(([h]) => (out[h] = null)), out);
  if (response.stop_reason === 'refusal') {
    console.error('translate: refused', response.stop_details?.category);
    return giveUp();
  }
  if (response.stop_reason === 'max_tokens') return giveUp();
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return giveUp();
  }
  const byId = new Map((parsed.translations || []).map((t) => [t.id, t.text]));
  for (const [h] of batch) {
    const t = byId.get(h);
    // One line in, one line out: a translation that adds line breaks is not used.
    out[h] = typeof t === 'string' && t.trim() && !t.includes('\n') ? t.trim() : null;
  }
  return out;
}

// ---------- helpers ----------

const storeKey = (dataset) => `tr:${dataset}:pt`;

async function getStore(env, dataset) {
  const raw = await env.RESERVED_KV.get(storeKey(dataset));
  return raw ? JSON.parse(raw) : {};
}

// Applies fn(line, hash) to each line that has letters in it; keeps empty lines and pure numbers.
async function mapLines(cell, fn) {
  const lines = String(cell ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    out.push(t && /\p{L}{2}/u.test(t) ? fn(t, await hash(t)) : line);
  }
  return out.join('\n');
}

async function hash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function* batches(list) {
  let cur = [];
  let size = 0;
  for (const item of list) {
    if (cur.length && size + item[1].length > BATCH_CHARS) {
      yield cur;
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += item[1].length;
  }
  if (cur.length) yield cur;
}
