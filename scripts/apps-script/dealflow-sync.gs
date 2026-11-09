/**
 * Caldrew website sync: publishes the Deal Flow Pipeline to the reserved area of
 * caldrew.com (Dealflow section). Lives in the spreadsheet: Extensions > Apps Script.
 *
 * Sends the Pipeline tab, plus the Activity Log, Questions & Decisions and Lists tabs.
 * - Runs every 15 minutes once set up, and on demand from the "Caldrew" menu.
 * - Only sends when something changed.
 * - @OnlyCurrentDoc: this script can access this spreadsheet and nothing else in your Google account.
 * - The website key is stored in Script properties, not in this code.
 *
 * @OnlyCurrentDoc
 */

const CONFIG = {
  url: 'https://www.caldrew.com/api/sync/dealflow',
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
    .filter((t) => t.getHandlerFunction() === 'scheduledPublish')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledPublish').timeBased().everyMinutes(15).create();

  const result = publish_(true);
  ui.alert('Caldrew website', `Automatic publishing is on (every 15 minutes).\n\n${result}`, ui.ButtonSet.OK);
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
