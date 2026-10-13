/**
 * Quo Call Recorder — Google Apps Script (paste into Extensions → Apps Script of your Google Sheet)
 *
 * Receives each call recording from the Chrome extension, together with the caller's name
 * exactly as Quo shows it in the "Call in progress" box, and saves it to Google Drive:
 *   Quo Call Recordings / <Caller> / <Caller> - 2026-10-12 3.05 PM.webm
 * Every call is also logged in the "Call Log" tab.
 */

const TOKEN = 'PUT-THE-SAME-SECRET-AS-config.js-HERE';
const ROOT_FOLDER = 'Quo Call Recordings';
const TIMEZONE = 'America/New_York';

const LOG_HEADERS = ['Date', 'Time', 'Caller', 'Duration', 'Recording', 'Note', 'Call ID'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.token !== TOKEN) return json({ ok: false, error: 'Wrong token' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const log = sheet(ss, 'Call Log', LOG_HEADERS);

    // Already saved (a retry)? Don't make a duplicate.
    const ids = log.getRange(1, 7, Math.max(log.getLastRow(), 1), 1).getValues().flat();
    if (ids.indexOf(b.callId) !== -1) return json({ ok: true, duplicate: true });

    const who = callerName(b.caller, ss);
    const start = new Date(b.startedAt);
    const stamp = Utilities.formatDate(start, TIMEZONE, 'yyyy-MM-dd h.mm a');
    const filename = clean(who) + ' - ' + stamp + (b.partial ? ' (partial)' : '') + '.webm';

    const root = folder(DriveApp.getRootFolder(), ROOT_FOLDER);
    const file = folder(root, clean(who)).createFile(
      Utilities.newBlob(Utilities.base64Decode(b.data), b.mimeType || 'audio/webm', filename)
    );

    log.appendRow([
      Utilities.formatDate(start, TIMEZONE, 'yyyy-MM-dd'),
      Utilities.formatDate(start, TIMEZONE, 'h:mm a'),
      who,
      duration(b.durationSec),
      file.getUrl(),
      b.partial ? 'Tab closed during call (partial)' : '',
      b.callId,
    ]);
    return json({ ok: true, url: file.getUrl() });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json({ ok: true, message: 'Quo Call Recorder is running.' });
}

/** Run once from the editor to create the tabs and approve Drive access. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  sheet(ss, 'Call Log', LOG_HEADERS);
  sheet(ss, 'Drivers', ['Name', 'Phone', 'Status']);
  folder(DriveApp.getRootFolder(), ROOT_FOLDER);
}

/**
 * The name Quo showed for the caller. If Quo only showed a phone number
 * (caller not saved as a Quo contact), look that number up in the Drivers tab.
 */
function callerName(raw, ss) {
  const name = String(raw || '').trim();
  if (!name) return 'Unknown caller';
  const digits = name.replace(/\D/g, '');
  const looksLikeNumber = digits.length >= 10 && !/[a-z]/i.test(name);
  if (!looksLikeNumber) return name;

  const s = ss.getSheetByName('Drivers');
  if (s && s.getLastRow() > 1) {
    const rows = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] && String(rows[i][1]).replace(/\D/g, '').slice(-10) === digits.slice(-10)) {
        return String(rows[i][0]).trim();
      }
    }
  }
  const d = digits.slice(-10);
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); // not a known driver: show the number
}

function sheet(ss, name, headers) {
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(headers);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return s;
}

function folder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function clean(s) {
  return String(s).replace(/[\\\/:*?"<>|#%]+/g, '').trim().slice(0, 80) || 'Unknown caller';
}

function duration(sec) {
  sec = Number(sec) || 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
