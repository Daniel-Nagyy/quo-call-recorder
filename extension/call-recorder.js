// Runs inside the Quo page. Records every call automatically, straight from
// the call's own audio (the driver's voice + the dispatcher's microphone).
// No button, no switch: whenever a call connects, it records; when it ends, it hands off the file.
(() => {
  const Orig = window.RTCPeerConnection;
  if (!Orig || Orig.__callRecorderWrapped) return;

  const post = (msg) => window.postMessage({ __callRecorder: true, ...msg }, "*");
  const pcs = new Set();
  let active = 0;
  let rec = null;

  // ---- Caller name: read from Quo's "Call in progress" box ----
  // Each person on the call is a [role=group] with aria-label = their name.
  // Your own entry is the one marked "You", so it is skipped.
  //
  // The box can be dragged, moved into another part of the page, or popped out into its own
  // window, so we look everywhere it can be: this page, the top page and every frame in it,
  // Quo's pop-out (picture-in-picture) window, any window Quo opened, and shadow DOM.
  const BOX_SELECTOR = '[data-testid="ongoing-call-participants"], [role="dialog"][aria-label="Call in progress"]';
  const openedWindows = new Set();

  const origOpen = window.open;
  window.open = function (...args) {
    const w = origOpen.apply(this, args);
    if (w) openedWindows.add(w);
    return w;
  };
  try {
    window.documentPictureInPicture?.addEventListener("enter", (e) => e.window && openedWindows.add(e.window));
  } catch {}

  function allDocuments() {
    const docs = [];
    const seen = new Set();
    const visit = (w) => {
      try {
        if (!w || seen.has(w) || w.closed) return;
        seen.add(w);
        if (w.document) docs.push(w.document);
        for (let i = 0; i < w.frames.length; i++) visit(w.frames[i]);
        visit(w.documentPictureInPicture && w.documentPictureInPicture.window);
      } catch {} // other-origin frames can't be read; skip them
    };
    visit(window);
    try { visit(window.top); } catch {}
    try { visit(window.top.opener); } catch {}
    for (const w of openedWindows) visit(w);
    return docs;
  }

  function findBoxes(root, out, depth = 0) {
    root.querySelectorAll(BOX_SELECTOR).forEach((b) => out.push(b));
    if (out.length || depth > 3) return out;
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) findBoxes(el.shadowRoot, out, depth + 1);
    return out;
  }

  function namesIn(box) {
    const names = [];
    for (const g of box.querySelectorAll('[role="group"][aria-label]')) {
      const isYou = [...g.querySelectorAll("div, span")].some(
        (d) => !d.children.length && d.textContent.trim() === "You"
      );
      const name = (g.getAttribute("aria-label") || "").trim();
      if (!isYou && name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function readCaller() {
    for (const doc of allDocuments()) {
      for (const box of findBoxes(doc, [])) {
        const names = namesIn(box);
        if (names.length) return names.join(" & ");
      }
    }
    return "";
  }

  // Every part of the Quo page (main page and inner frame) watches for the call box on its own
  // and reports the name to the extension, no matter which part is running the call audio.
  let lastReported = "";
  setInterval(() => {
    let name = "";
    try {
      for (const box of document.querySelectorAll(BOX_SELECTOR)) {
        const n = namesIn(box);
        if (n.length) { name = n.join(" & "); break; }
      }
    } catch {}
    if (name && name !== lastReported) post({ type: "caller-seen", name });
    lastReported = name; // resets when the box closes, so the next call is reported again
  }, 1000);

  function trackCaller() {
    if (!rec) return;
    const name = readCaller();
    if (name) rec.caller = name;
  }

  // ---- Recording ----
  function liveAudioTracks() {
    const out = [];
    for (const pc of pcs) {
      try {
        for (const r of pc.getReceivers()) if (r.track?.kind === "audio" && r.track.readyState === "live") out.push(r.track);
        for (const s of pc.getSenders()) if (s.track?.kind === "audio" && s.track.readyState === "live") out.push(s.track);
      } catch {}
    }
    return out;
  }

  function addTracks() {
    if (!rec) return;
    for (const t of liveAudioTracks()) {
      if (rec.sources.has(t.id)) continue;
      const ms = new MediaStream([t]);
      const el = new Audio(); // Chrome needs remote call audio attached to an element to flow
      el.muted = true;
      el.srcObject = ms;
      el.play().catch(() => {});
      const src = rec.ctx.createMediaStreamSource(ms);
      src.connect(rec.dest);
      rec.sources.set(t.id, { src, el });
    }
    if (rec.ctx.state === "suspended") rec.ctx.resume().catch(() => {});
  }

  function startRec() {
    if (rec) return;
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    rec = {
      ctx, dest, sources: new Map(), seq: 0, startedAt: Date.now(), caller: "",
      callId: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    };
    addTracks();
    const r = rec;
    r.mr = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
    r.mr.ondataavailable = (e) => {
      if (e.data.size) post({ type: "chunk", callId: r.callId, seq: r.seq++, blob: e.data });
    };
    post({ type: "call-start", callId: r.callId, startedAt: r.startedAt });
    r.mr.start(5000); // hand off audio every 5 s so nothing is lost if the tab is closed mid-call
    r.timer = setInterval(addTracks, 2000);
    trackCaller();
    r.nameTimer = setInterval(trackCaller, 1000); // keep the latest name while the box is on screen
    r.wake = () => ctx.resume().catch(() => {});
    document.addEventListener("pointerdown", r.wake, true);
    document.addEventListener("keydown", r.wake, true);
  }

  function stopRec() {
    if (!rec) return;
    const r = rec;
    const name = readCaller();
    if (name) r.caller = name;
    rec = null;
    clearInterval(r.timer);
    clearInterval(r.nameTimer);
    document.removeEventListener("pointerdown", r.wake, true);
    document.removeEventListener("keydown", r.wake, true);
    const finish = () => {
      post({ type: "call-end", callId: r.callId, endedAt: Date.now(), total: r.seq, caller: r.caller });
      for (const { el } of r.sources.values()) el.srcObject = null;
      r.ctx.close().catch(() => {});
    };
    if (r.mr.state !== "inactive") {
      r.mr.onstop = finish;
      r.mr.stop();
    } else finish();
  }

  // ---- Detect call start / end ----
  class Wrapped extends Orig {
    constructor(...args) {
      super(...args);
      pcs.add(this);
      let counted = false;
      let dropTimer = null;

      const ended = () => {
        if (!counted) return;
        counted = false;
        active = Math.max(0, active - 1);
        if (active === 0) stopRec();
      };
      const check = () => {
        const s = this.connectionState || this.iceConnectionState;
        if (s === "connected" || s === "completed") {
          clearTimeout(dropTimer);
          if (!counted) {
            counted = true;
            active++;
            if (active === 1) startRec();
            else addTracks();
          }
        } else if (s === "closed" || s === "failed") {
          clearTimeout(dropTimer);
          pcs.delete(this);
          ended();
        } else if (s === "disconnected") {
          clearTimeout(dropTimer);
          dropTimer = setTimeout(() => {
            const now = this.connectionState || this.iceConnectionState;
            if (now !== "connected" && now !== "completed") ended();
          }, 8000);
        }
      };
      this.addEventListener("connectionstatechange", check);
      this.addEventListener("iceconnectionstatechange", check);
      this.addEventListener("track", () => addTracks());

      const origClose = this.close.bind(this);
      this.close = () => {
        origClose();
        clearTimeout(dropTimer);
        pcs.delete(this);
        ended();
      };
    }
  }
  Wrapped.__callRecorderWrapped = true;
  window.RTCPeerConnection = Wrapped;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;

  window.addEventListener("pagehide", () => {
    if (rec) {
      active = 0;
      stopRec();
    }
  });
})();
