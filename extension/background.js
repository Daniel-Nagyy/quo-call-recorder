// Quo Call Recorder - background service worker
//
// Every Quo call is recorded automatically inside the Quo page (no button, nothing to set up
// on the dispatcher's side). Audio arrives here in 5-second pieces, is kept safely in the
// browser's storage, and when the call ends it's uploaded to Google Drive.
// Failed uploads retry every 5 minutes.

importScripts("config.js");

function badge(tabId, text, color) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ================= Local storage of call audio (IndexedDB) =================

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("callrec", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("calls", { keyPath: "callId" });
        d.createObjectStore("chunks", { keyPath: ["callId", "seq"] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const range = (id) => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

const getCall = (id) => tx("calls", "readonly", (s) => reqP(s.get(id)));
const putCall = (c) => tx("calls", "readwrite", (s) => { s.put(c); });
const allCalls = () => tx("calls", "readonly", (s) => reqP(s.getAll()));
const putChunk = (c) => tx("chunks", "readwrite", (s) => { s.put(c); });
const chunksFor = (id) => tx("chunks", "readonly", (s) => reqP(s.getAll(range(id))));
async function deleteCall(id) {
  await tx("chunks", "readwrite", (s) => { s.delete(range(id)); });
  await tx("calls", "readwrite", (s) => { s.delete(id); });
}

// ================= Messages from the Quo page =================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return;
  if (!["call-start", "chunk", "call-end", "caller-seen"].includes(msg.type)) return;
  handle(msg, sender.tab?.id ?? null).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});

async function handle(msg, tabId) {
  // A name seen in Quo's call box, from any part of the page.
  if (msg.type === "caller-seen") {
    await chrome.storage.session.set({ ["caller_" + tabId]: { name: msg.name, at: Date.now() } });
    for (const c of await allCalls()) {
      if (c.tabId === tabId && c.status === "recording") {
        c.callerSeen = msg.name;
        await putCall(c);
      }
    }
    return;
  }

  if (msg.type === "call-start") {
    // The box often shows the name while it's still ringing, just before the call connects.
    const seen = (await chrome.storage.session.get("caller_" + tabId))["caller_" + tabId];
    const callerSeen = seen && Date.now() - seen.at < 120000 ? seen.name : "";
    await putCall({ callId: msg.callId, tabId, startedAt: msg.startedAt, status: "recording", attempts: 0, callerSeen });
    badge(tabId, "REC", "#d93025");
  }

  if (msg.type === "chunk") {
    await putChunk({ callId: msg.callId, seq: msg.seq, data: msg.data });
  }

  if (msg.type === "call-end") {
    const c = (await getCall(msg.callId)) || { callId: msg.callId, tabId, startedAt: msg.endedAt, attempts: 0 };
    Object.assign(c, { endedAt: msg.endedAt, total: msg.total, caller: msg.caller || c.callerSeen || "", status: "ready" });
    await putCall(c);
    badge(tabId, "", "#000000");
    finalize(msg.callId);
  }
}

// ================= Upload to Google Drive =================

const finalizing = new Set();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function finalize(callId) {
  if (finalizing.has(callId)) return;
  finalizing.add(callId);
  try {
    let c = await getCall(callId);
    if (!c) return;

    // Wait (up to ~15 s) for the last pieces of audio to arrive.
    let chunks = await chunksFor(callId);
    for (let i = 0; i < 15 && c.total != null && chunks.length < c.total; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      chunks = await chunksFor(callId);
    }
    if (!chunks.length) {
      await deleteCall(callId); // too short to contain any audio
      return;
    }
    if (!CONFIG.DRIVE_UPLOAD_URL || !CONFIG.UPLOAD_TOKEN) {
      c.status = "failed"; // keep it until config.js is filled in
      await putCall(c);
      return;
    }

    chunks.sort((a, b) => a.seq - b.seq);
    const parts = chunks.map((ch) => b64ToBytes(ch.data));
    const audio = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }

    const endedAt = c.endedAt || Date.now();
    const body = {
      token: CONFIG.UPLOAD_TOKEN,
      callId,
      startedAt: c.startedAt,
      endedAt,
      durationSec: Math.round((endedAt - c.startedAt) / 1000),
      caller: c.caller || c.callerSeen || "",
      partial: c.status === "partial",
      mimeType: "audio/webm",
      data: bytesToB64(audio),
    };

    let ok = false;
    try {
      const res = await fetch(CONFIG.DRIVE_UPLOAD_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
      });
      ok = !!(await res.json()).ok;
    } catch {}

    if (ok) {
      await deleteCall(callId);
    } else {
      c = (await getCall(callId)) || c;
      if (c.status !== "partial") c.status = "failed";
      c.attempts = (c.attempts || 0) + 1;
      await putCall(c);
    }
  } finally {
    finalizing.delete(callId);
  }
}

// Pick up anything left behind: closed tabs, browser restarts, failed uploads.
async function sweep() {
  for (const c of await allCalls()) {
    if (c.status === "recording") {
      const alive = c.tabId != null && (await chrome.tabs.get(c.tabId).then(() => true, () => false));
      if (alive && Date.now() - c.startedAt < 4 * 3600 * 1000) continue; // still on the call
      c.status = "partial";
      c.endedAt = c.endedAt || Date.now();
      await putCall(c);
    }
    finalize(c.callId);
  }
}

chrome.alarms.create("sweep", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "sweep" && sweep());
chrome.runtime.onStartup.addListener(sweep);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const c of await allCalls()) {
    if (c.tabId === tabId && c.status === "recording") {
      c.status = "partial"; // tab closed mid-call: upload what was recorded
      c.endedAt = Date.now();
      await putCall(c);
      finalize(c.callId);
    }
  }
});
