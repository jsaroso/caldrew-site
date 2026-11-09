/**
 * Caldrew website sync: publishes the Deal Flow Pipeline to the reserved area of
 * caldrew.com (Dealflow section). Lives in the spreadsheet: Extensions > Apps Script.
 *
 * 1. Sheet: sends the Pipeline tab, plus the Activity Log, Questions & Decisions and Lists tabs.
 *    Every 15 minutes once set up, and on demand from the "Caldrew" menu. Only sends changes.
 * 2. Documents: uploads the files in the "Investment Opportunities" Drive folder to the deal
 *    they belong to. Which folder or file goes to which deal is set in the "Documents" tab
 *    (Drive path | Deal ID). New files without a match are added there with an empty Deal ID.
 *    Every hour, and on demand. Only new or changed files are uploaded.
 *
 * Access (appsscript.json): this spreadsheet, read-only Google Drive, and calls to the website.
 * The website key is stored in Script properties, not in this code.
 */

const CONFIG = {
  url: 'https://www.caldrew.com/api/sync/dealflow',
  docs: {
    url: 'https://www.caldrew.com/api/docs/dealflow',
    folderId: '1y1g-HFlGFq8pHK3QcDYQl5uvBW9fKmyQ', // Investment Opportunities
    tab: 'Documents',
    skip: /\.(py|url|webloc|lnk|tmp|ds_store)$|^~\$|^Caldrew - Deal Flow Pipeline/i, // code, shortcuts, temporary files, pipeline snapshots
    maxBytes: 25 * 1024 * 1024,
    budgetMs: 4.5 * 60 * 1000, // stop uploading after this; the next run continues
  },
  main: { tab: 'Pipeline', headerRow: 4 },
  extra: {
    activity: { tab: 'Activity Log', headerRow: 4 },
    questions: { tab: 'Questions & Decisions', headerRow: 4 },
    lists: { tab: 'Lists', headerRow: 1 },
  },
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Caldrew')
    .addItem('Publish to website now', 'publishNow')
    .addItem('Publish documents now', 'publishDocsNow')
    .addSeparator()
    .addItem('Set up automatic publishing', 'setup')
    .addToUi();
}

/** One-time setup: stores the website key and schedules publishing every 15 minutes. */
function setup() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const answer = ui.prompt('Caldrew website', 'Paste the website sync key:', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK || !answer.getResponseText().trim()) return;
  props.setProperty('SYNC_SECRET', answer.getResponseText().trim());
  props.deleteProperty('LAST_HASH');

  ScriptApp.getProjectTriggers()
    .filter((t) => ['scheduledPublish', 'scheduledDocs'].includes(t.getHandlerFunction()))
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledPublish').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('scheduledDocs').timeBased().everyHours(1).create();

  const result = publish_(true);
  ui.alert(
    'Caldrew website',
    `Automatic publishing is on: the sheet every 15 minutes, documents every hour.\n\n${result}\n\n` +
      'Use Caldrew > Publish documents now for the first upload (it continues by itself every hour if there is a lot).',
    ui.ButtonSet.OK,
  );
}

function publishNow() {
  SpreadsheetApp.getActive().toast(publish_(true), 'Caldrew website', 8);
}

function scheduledPublish() {
  publish_(false);
}

/** Reads one tab as { columns, rows } (display values, so dates and numbers look as in the sheet). */
function readTab_(spec) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(spec.tab);
  if (!sheet) throw new Error(`Tab "${spec.tab}" not found.`);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(spec.headerRow, 1, 1, lastCol).getDisplayValues()[0];
  let width = header.length;
  while (width > 0 && !String(header[width - 1]).trim()) width--;
  const columns = header.slice(0, width).map((h) => String(h).trim());
  if (lastRow <= spec.headerRow || !width) return { columns, rows: [] };
  const rows = sheet
    .getRange(spec.headerRow + 1, 1, lastRow - spec.headerRow, width)
    .getDisplayValues()
    .map((cells) => ({ cells }))
    .filter((r) => r.cells.some((c) => String(c).trim()));
  return { columns, rows };
}

function publish_(force) {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return 'Not set up yet: use Caldrew > Set up automatic publishing.';

  let body;
  try {
    const main = readTab_(CONFIG.main);
    const extra = {};
    Object.keys(CONFIG.extra).forEach((k) => (extra[k] = readTab_(CONFIG.extra[k])));
    body = { sheet: CONFIG.main.tab, columns: main.columns, rows: main.rows, extra };
  } catch (err) {
    return String(err.message || err);
  }

  const payload = JSON.stringify(body);
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload));
  const props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('LAST_HASH') === hash) return 'No changes since the last publish.';

  const res = UrlFetchApp.fetch(CONFIG.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${secret}` },
    payload,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    const msg = `Publishing failed (${res.getResponseCode()}). Check the website key.`;
    console.error(msg, res.getContentText());
    return msg;
  }
  props.setProperty('LAST_HASH', hash);
  const out = JSON.parse(res.getContentText());
  return `Published ${out.rows} opportunities (${out.changes} changes since the last version).`;
}


// ---------- documents ----------

function publishDocsNow() {
  // First use also turns on the hourly upload (the sheet's 15-minute publishing stays as it is).
  if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'scheduledDocs')) {
    ScriptApp.newTrigger('scheduledDocs').timeBased().everyHours(1).create();
  }
  SpreadsheetApp.getActive().toast('Uploading documents. This can take a few minutes.', 'Caldrew website', 10);
  SpreadsheetApp.getActive().toast(publishDocs_(), 'Caldrew website', 15);
}

function scheduledDocs() {
  console.log(publishDocs_());
}

/** Rules from the Documents tab: [{ path, deals: [...] | null (do not publish) | [] (not matched yet) }]. */
function readRules_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 2)
    .getDisplayValues()
    .map(([path, deal]) => {
      const d = String(deal).trim();
      return { path: String(path).trim().replace(/\s*\/\s*/g, ' / '), deals: d === '-' ? null : d.split(/[,;\s]+/).filter(Boolean) };
    })
    .filter((r) => r.path);
}

/** Every file under the folder: { id, path, name, folders: [...], file }. */
function listFiles_(folder, folders, out) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    out.push({ file: f, folders, path: folders.concat(f.getName()).join(' / ') });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    listFiles_(sub, folders.concat(sub.getName()), out);
  }
  return out;
}

/** Folder names shown on the website: no numbering, no internal tool names. */
function cleanFolder_(name) {
  if (/^(RE|FW|FWD)__/i.test(name)) return 'Received by email'; // folders saved from an email thread
  const n = String(name).replace(/^(\d+(\.\d+)*\.?\s+)+/, '').replace(/_+/g, ' ').trim();
  return /claude/i.test(n) ? 'Caldrew analysis' : n;
}

function publishDocs_() {
  const cfg = CONFIG.docs;
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return 'Not set up yet: use Caldrew > Set up automatic publishing.';
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(cfg.tab) || ss.insertSheet(cfg.tab);
  if (sheet.getLastRow() === 0) sheet.appendRow(['Drive path', 'Deal ID', 'Notes']);

  const started = Date.now();
  const rules = readRules_(sheet).sort((a, b) => b.path.length - a.path.length); // most specific first
  const all = listFiles_(DriveApp.getFolderById(cfg.folderId), [], []);
  const auth = { Authorization: `Bearer ${secret}` };

  // Which deal each file belongs to.
  const wanted = [];
  const unmatched = {};
  all.forEach((x) => {
    if (cfg.skip.test(x.file.getName())) return;
    const rule = rules.find((r) => x.path === r.path || x.path.indexOf(r.path + ' / ') === 0);
    if (!rule || (rule.deals && !rule.deals.length)) {
      unmatched[x.folders.join(' / ') || x.path] = true;
      return;
    }
    if (!rule.deals) return; // "-": not published
    const below = x.path === rule.path ? x.folders.slice(-1) : rule.path.split(' / ').length > x.folders.length ? [] : x.folders.slice(rule.path.split(' / ').length);
    const group = below.slice(0, 2).map(cleanFolder_).filter(Boolean).join(' / ');
    const google = x.file.getMimeType().indexOf('application/vnd.google-apps.') === 0;
    wanted.push({ x, google, id: x.file.getId(), deals: rule.deals, group, name: x.file.getName() + (google ? '.pdf' : ''), modified: x.file.getLastUpdated().toISOString() });
  });

  // New folders or files nobody has matched yet: add them to the tab for the team to fill in.
  const known = {};
  readRules_(sheet).forEach((r) => (known[r.path] = true));
  const add = Object.keys(unmatched).filter((p) => !known[p]).sort();
  if (add.length) {
    const first = sheet.getLastRow() + 1;
    sheet.getRange(first, 1, add.length, 3).setValues(add.map((p) => [p, '', 'New: which deal? (use - to leave it off the website)']));
    sheet.getRange(first, 1, add.length, 3).setBackground('#fdf3d8');
  }

  // Upload what the website does not have yet (or has an older version of).
  const list = UrlFetchApp.fetch(cfg.url, { headers: auth, muteHttpExceptions: true });
  if (list.getResponseCode() !== 200) return `Publishing documents failed (${list.getResponseCode()}). Check the website key.`;
  const stored = JSON.parse(list.getContentText()).files || {};
  let uploaded = 0;
  let pending = 0;
  const tooBig = [];
  for (const w of wanted) {
    if (stored[w.id] === w.modified) continue;
    if (Date.now() - started > cfg.budgetMs) {
      pending++;
      continue;
    }
    const blob = w.google ? w.x.file.getAs('application/pdf') : w.x.file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length > cfg.maxBytes) {
      tooBig.push(w.name);
      continue;
    }
    const res = UrlFetchApp.fetch(`${cfg.url}/${w.id}?modified=${encodeURIComponent(w.modified)}`, {
      method: 'put',
      contentType: blob.getContentType() || 'application/octet-stream',
      headers: auth,
      payload: bytes,
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 200) uploaded++;
    else console.error(`Upload failed for ${w.x.path}: ${res.getResponseCode()} ${res.getContentText()}`);
  }

  // Tell the website the full list: it shows what it has and deletes files no longer in Drive.
  const res = UrlFetchApp.fetch(cfg.url, {
    method: 'post',
    contentType: 'application/json',
    headers: auth,
    payload: JSON.stringify({ files: wanted.map((w) => ({ id: w.id, deals: w.deals, name: w.name, group: w.group, modified: w.modified })) }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return `Publishing documents failed (${res.getResponseCode()}). Check the website key.`;
  const out = JSON.parse(res.getContentText());
  return [
    `${out.listed} documents on the website (${uploaded} uploaded now).`,
    pending ? `${pending} still to upload: they go up in the next run (every hour), or run it again now.` : '',
    add.length ? `${add.length} new folders or files need a Deal ID in the ${cfg.tab} tab.` : '',
    tooBig.length ? `Over 25 MB, not uploaded: ${tooBig.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
