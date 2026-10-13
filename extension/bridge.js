// Passes recorded call audio from the Quo page to the extension, in order.
let queue = Promise.resolve();

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__callRecorder !== true) return;
  const msg = e.data;
  if (!["call-start", "chunk", "call-end", "caller-seen"].includes(msg.type)) return;

  queue = queue.then(async () => {
    const out = { target: "background", type: msg.type, callId: msg.callId };
    if (msg.type === "call-start") out.startedAt = msg.startedAt;
    if (msg.type === "caller-seen") out.name = msg.name;
    if (msg.type === "chunk") {
      out.seq = msg.seq;
      out.data = await blobToBase64(msg.blob);
    }
    if (msg.type === "call-end") {
      out.endedAt = msg.endedAt;
      out.total = msg.total;
      out.caller = msg.caller || "";
    }
    await chrome.runtime.sendMessage(out).catch(() => {});
  });
});
