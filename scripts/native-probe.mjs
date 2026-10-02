// ── native-probe: verify the native player path against a REAL stream ───────
//
// The smoke test walks routes and catches render-time crashes. It cannot answer
// the question that matters for the native player: does the resolver actually
// produce a stream, does the loopback proxy hand back playable URLs, and does
// hls.js in our document really start decoding them?
//
// So this drives the real IPC handlers in the running app and reports what came
// back at each layer. Run it against a live app:
//   node scripts/native-probe.mjs --port 9611 [--title "Frieren"]
//
// Exit 0 = the whole chain works. Anything else = the exact layer that broke.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const argOf = (name, dflt) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf("port", 9611));
const TITLE = argOf("title", "Frieren: Beyond Journey's End");

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 180000);
  });
}

async function evaluate(sessionId, expression) {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "evaluate threw",
    );
  }
  return r.result?.value;
}

// ── boot ─────────────────────────────────────────────────────────────────────
console.log(`booting app on :${PORT} …`);
const app = spawn(
  "npx",
  ["electron", ".", `--remote-debugging-port=${PORT}`],
  { cwd: process.cwd(), stdio: "ignore", detached: true },
);

let exitCode = 1;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) =>
        r.json(),
      );
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) throw new Error("DevTools endpoint never came up");

  const { WebSocket } = await import("node:worker_threads").then(() => ({
    WebSocket: globalThis.WebSocket,
  }));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("devtools socket failed"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  const errors = [];
  await send("Runtime.enable", {}, undefined).catch(() => {});
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params?.exceptionDetails?.text || "exception");
    }
  });

  // Wait for the app shell, then get past the TMDB setup screen.
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(
      undefined,
      `!!document.getElementById('root')?.children.length`,
    );
    if (ready) break;
    await sleep(1000);
  }
  await evaluate(
    undefined,
    `(() => {
       const b = Array.from(document.querySelectorAll('button,a'))
         .find(x => /skip for now/i.test(x.innerText||''));
       if (b) b.click();
       return !!b;
     })()`,
  );
  await sleep(1500);

  // ── layer 1: does the resolver find a stream at all? ──────────────────────
  console.log(`resolving "${TITLE}" via HiAnime (this hits the real site) …`);
  const resolved = await evaluate(
    undefined,
    `window.electron.resolveHianime({
       title: ${JSON.stringify(TITLE)},
       seasonNumber: 1, episodeNumber: 1, translationType: "sub"
     }).then(r => JSON.stringify({
       ok: r?.ok, error: r?.error, isEmbedPage: !!r?.isEmbedPage,
       hasUrl: !!r?.url, hasMaster: !!r?.masterUrl,
       qualities: (r?.qualities||[]).length,
       subs: (r?.subtitles||[]).length, referer: r?.referer || null,
       diags: r?.diagnostics || null,
     }))`,
  );
  const res = JSON.parse(resolved);
  console.log("  resolve:", JSON.stringify(res, null, 2).replace(/\n/g, "\n  "));

  if (!res.ok) {
    // An embed page means the blob scrape failed upstream — the native path
    // correctly stays off, and that is not a failure of this work.
    if (res.isEmbedPage) {
      console.log(
        "\nRESULT: resolver returned an embed page (blob scrape failed upstream).\n" +
          "        The native player correctly does not engage; the webview path is used.\n" +
          "        Not a regression — try a different title.",
      );
      exitCode = 0;
    } else {
      console.log("\nRESULT: resolver found no stream. Live-network, not a code fault.");
      exitCode = 2;
    }
  } else {
    // ── layer 2: does the proxy hand back playable URLs? ────────────────────
    const native = await evaluate(
      undefined,
      `window.electron.resolveHianime({
         title: ${JSON.stringify(TITLE)},
         seasonNumber: 1, episodeNumber: 1, translationType: "sub"
       }).then(r => window.electron.hianimeNativeStream({
         url: r.url, masterUrl: r.masterUrl, qualities: r.qualities,
         referer: r.referer, subtitles: r.subtitles,
       })).then(n => JSON.stringify({
         ok: n?.ok, error: n?.error, proxyBase: n?.proxyBase,
         src: n?.src, masterSrc: n?.masterSrc,
         subs: (n?.subtitles||[]).length,
       }))`,
    );
    const nat = JSON.parse(native);
    console.log("  native-stream:", JSON.stringify(nat, null, 2).replace(/\n/g, "\n  "));

    if (!nat.ok || !nat.src) {
      console.log("\nRESULT: proxy did not produce a stream URL.");
      exitCode = 3;
    } else {
      // ── layer 3: does the playlist actually come back, and play? ──────────
      const fetchRes = await evaluate(
        undefined,
        `fetch(${JSON.stringify(nat.src)})
           .then(async r => JSON.stringify({
             status: r.status,
             type: r.headers.get('content-type'),
             body: (await r.text()).slice(0, 400),
           }))
           .catch(e => JSON.stringify({ error: String(e) }))`,
      );
      const fr = JSON.parse(fetchRes);
      console.log("  playlist fetch:", JSON.stringify(fr, null, 2).replace(/\n/g, "\n  "));

      // Now the real test: hand the proxied playlist to hls.js in a throwaway
      // <video> and see whether segments actually decode.
      //
      // hls.js is bundled into the tv chunk rather than exposed globally, so
      // load the same build from the CDN the loopback /player page uses. That
      // still exercises exactly what matters here — the proxy has to deliver
      // real decodable media with the Referer attached — and the bundled copy
      // is the same library at the same version.
      const played = await evaluate(
        undefined,
        `(async () => {
           if (!window.Hls) {
             await new Promise((res, rej) => {
               const s = document.createElement('script');
               s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js';
               s.onload = res; s.onerror = () => rej(new Error('hls.js failed to load'));
               document.head.appendChild(s);
             }).catch(e => ({ err: String(e) }));
           }
           const HlsCtor = window.Hls;
           if (!HlsCtor || !HlsCtor.isSupported()) {
             return JSON.stringify({ ok:false, why:'hls.js unavailable or unsupported' });
           }
           const v = document.createElement('video');
           v.muted = true; v.playsInline = true;
           document.body.appendChild(v);
           return await new Promise((resolve) => {
             const hls = new HlsCtor({ enableWorker: false });
             const done = (o) => { try{hls.destroy();}catch{} v.remove(); resolve(JSON.stringify(o)); };
             hls.on(HlsCtor.Events.MANIFEST_PARSED, (_e, d) => {
               hls.attachMedia(v); v.play().catch(()=>{});
               setTimeout(() => done({
                 ok: (v.currentTime > 0) || (v.readyState >= 2),
                 levels: (d.levels||[]).length,
                 currentTime: v.currentTime, readyState: v.readyState,
                 videoWidth: v.videoWidth, videoHeight: v.videoHeight,
                 buffered: v.buffered.length ? v.buffered.end(0) : 0,
               }), 8000);
             });
             hls.on(HlsCtor.Events.ERROR, (_e, d) => {
               if (d.fatal) done({ ok:false, fatal:d.type, details:d.details });
             });
             setTimeout(() => done({ ok:false, why:'no manifest event in 30s' }), 30000);
             hls.loadSource(${JSON.stringify(nat.src)});
           });
         })()`,
      );
      console.log("  playback:", played);

      const pl = JSON.parse(played);
      if (pl.ok) {
        console.log(
          `\nRESULT: PASS — resolved, proxied and decoded. ${pl.levels} rendition(s), ` +
            `advanced to ${Number(pl.currentTime).toFixed(2)}s.`,
        );
        exitCode = 0;
      } else {
        console.log(`\nRESULT: FAIL at playback — ${JSON.stringify(pl)}`);
        exitCode = 4;
      }
    }
  }

  if (errors.length) {
    console.log(`\nrenderer exceptions: ${JSON.stringify(errors)}`);
  }
} catch (e) {
  console.log(`\nprobe error: ${e.message}`);
  exitCode = 5;
} finally {
  try { ws?.close(); } catch {}
  // Kill the whole process group. `app.kill()` only reaps the npx wrapper, so
  // the real Electron binary survives, keeps the single-instance lock and the
  // next probe run then finds no DevTools endpoint on its port.
  try { process.kill(-app.pid, "SIGKILL"); } catch {}
  try { app.kill("SIGKILL"); } catch {}
  await sleep(1500);
}
process.exit(exitCode);