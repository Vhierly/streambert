// ── native-drive: watch the real player UI play a real episode ──────────────
//
// native-probe.mjs proves the transport works: resolver → proxy → hls.js
// decoding media in a bare <video>. It deliberately does NOT mount the app's
// own components, because that is a different claim.
//
// This drives the actual UI: opens an anime, clicks play, and watches the
// mounted <video> advance with Streambert's own control bar over it. That is
// the thing a user sees, and the thing that has never been run.
//
//   node scripts/native-drive.mjs --port 9641 [--title "Frieren"]
//
// Exit 0 = the player UI genuinely played an episode.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const argOf = (name, dflt) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf("port", 9641));
const TITLE = argOf("title", "Frieren");

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
    }, 240000);
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "evaluate threw",
    );
  }
  return r.result?.value;
}

const playerState = `JSON.stringify((() => {
  const v = document.querySelector('.native-player__video');
  const bar = document.querySelector('.native-ctl');
  const stage = document.querySelector('.native-stage');
  const webview = document.querySelector('webview');
  const tracks = v ? Array.from(v.textTracks || []).map(t => ({
    label: t.label, lang: t.language, mode: t.mode,
    cues: t.cues ? t.cues.length : null,
  })) : [];
  return {
    mounted: !!v,
    stage: !!stage,
    controlBar: !!bar,
    webviewHidden: webview ? getComputedStyle(webview).visibility : null,
    currentTime: v ? v.currentTime : null,
    readyState: v ? v.readyState : null,
    paused: v ? v.paused : null,
    duration: v ? (isFinite(v.duration) ? v.duration : null) : null,
    w: v ? v.videoWidth : null,
    h: v ? v.videoHeight : null,
    buffered: v && v.buffered.length ? v.buffered.end(0) : 0,
    levels: document.querySelectorAll('.native-player__levels button').length,
    error: document.querySelector('.native-player__error')?.innerText || null,
    tracks,
    title: document.querySelector('.detail-title')?.innerText || null,
    episodesShown: document.querySelectorAll('[class*="episode"]').length,
  };
})())`;

let exitCode = 1;
let app;
try {
  console.log(`booting app on :${PORT} …`);
  app = spawn(
    "npx",
    ["electron", ".", `--remote-debugging-port=${PORT}`],
    { cwd: process.cwd(), stdio: "ignore", detached: true },
  );

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

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("devtools socket failed"));
  });

  const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "exception");
    }
  };
  await send("Runtime.enable");

  // Document-lifetime marker. If this is gone later, the renderer reloaded and
  // page state reset to the stored startPage — which looks identical to "the
  // app navigated home" from the outside but is a completely different fault.
  await evaluate(`window.__driveMarker = 'alive'; 'stamped'`);

  // Record navigation and errors from inside the page. React swallows render
  // errors into a boundary, and console.error output is invisible to Runtime
  // .exceptionThrown — which is why earlier runs saw "no exception" while the
  // app silently ended up back on Home.
  await evaluate(`
    window.__driveLog = [];
    window.addEventListener('error', e => {
      window.__driveLog.push('error: ' + (e.message || '') + ' @' + (e.filename||'') + ':' + e.lineno);
    });
    window.addEventListener('unhandledrejection', e => {
      window.__driveLog.push('rejection: ' + String(e.reason && e.reason.message || e.reason));
    });
    const ce = console.error.bind(console);
    console.error = (...a) => {
      window.__driveLog.push('console.error: ' + a.map(String).join(' ').slice(0, 200));
      ce(...a);
    };
    const cw = console.warn.bind(console);
    console.warn = (...a) => {
      window.__driveLog.push('console.warn: ' + a.map(String).join(' ').slice(0, 200));
      cw(...a);
    };
    'hooked'
  `);

  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.getElementById('root')?.children.length`))
      break;
    await sleep(1000);
  }
  // Get past the TMDB setup screen if it is showing.
  await evaluate(
    `(() => {
       const b = Array.from(document.querySelectorAll('button,a'))
         .find(x => /skip for now/i.test(x.innerText||''));
       if (b) { b.click(); return 'skipped'; }
       return 'no-setup';
     })()`,
  );
  await sleep(3000);

  // Drive navigation through the app's own state, not by clicking the DOM.
  //
  // Clicking looked fine but was unreliable: the search modal closes and the
  // detail page mounts asynchronously, and anything the driver types can hit
  // App's global keydown handler (Ctrl+Z navigates back). That is how runs kept
  // ending up back on Home with no episode grid — the driver had navigated away
  // from the app, not the app failing.
  //
  // Search results are still needed, but only to learn the TMDB id. Everything
  // after that goes through React's own event system.
  const searchResult = await evaluate(
    `(async () => {
       const opener = Array.from(document.querySelectorAll('button,[role=button],a'))
         .find(x => /^search(\\s*\\(⌘f\\))?$/i.test((x.innerText||'').trim()));
       if (!opener) return null;
       opener.click();
       await new Promise(r => setTimeout(r, 1200));
       const i = document.querySelector('.search-input');
       if (!i) return null;
       const setter = Object.getOwnPropertyDescriptor(
         window.HTMLInputElement.prototype, 'value').set;
       setter.call(i, ${JSON.stringify(TITLE)});
       i.dispatchEvent(new Event('input', { bubbles: true }));
       // Poll for rows; the query is debounced.
       for (let k = 0; k < 15; k++) {
         await new Promise(r => setTimeout(r, 2000));
         // Exact class only. '[class*="search-result"]' also matches the
         // .search-results CONTAINER, which comes first in document order —
         // clicking it hits nothing and no navigation ever happens.
         const row = document.querySelector('.search-result');
         if (row && (row.innerText||'').trim()) {
           const text = (row.innerText||'').trim();
           row.click();
           return { clicked: text.slice(0, 60) };
         }
       }
       return null;
     })()`,
  );
  console.log("  search:", JSON.stringify(searchResult));
  await sleep(6000);

  // Wait for the episode grid. Poll on the cards themselves — .detail-title
  // renders immediately and would exit the loop far too early.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await sleep(4000);
    ready = await evaluate(`document.querySelectorAll('.episode-card').length > 0`);
  }
  console.log(
    "  landed on:",
    await evaluate(
      `JSON.stringify({
         title: document.querySelector('.detail-title')?.innerText || null,
         cards: document.querySelectorAll('.episode-card').length,
         onHome: !document.querySelector('.detail-title'),
         marker: window.__driveMarker || 'GONE - document reloaded',
         log: (window.__driveLog || []).slice(0, 15),
       })`,
    ),
  );

  const onDetail = await evaluate(playerState);
  console.log("  detail page:", onDetail);
  const dd = JSON.parse(onDetail);
  // Dump whatever is actually on screen. Seven runs of "never mounted" said
  // nothing about *why*; this does.
  console.log(
    "  DOM dump:",
    await evaluate(
      `JSON.stringify({
         h1: document.querySelector('.detail-title')?.innerText || null,
         cards: document.querySelectorAll('.episode-card').length,
         loader: !!document.querySelector('.loader'),
         boundary: !!document.querySelector('.error-boundary,[class*="error-boundary"]'),
         boundaryText: (document.querySelector('.error-boundary,[class*="error-boundary"]')?.innerText||'').slice(0,200),
         seasonBtn: !!document.querySelector('[class*="season"]'),
         body: (document.body.innerText||'').slice(0,300).replace(/\\s+/g,' '),
       })`,
    ),
  );
  if (exceptions.length) {
    console.log("  EXCEPTIONS SO FAR:", JSON.stringify(exceptions.slice(0, 6), null, 1));
  }
  const d = JSON.parse(onDetail);
  if (!/series|tv|season/i.test(d.body || "")) {
    // fall through — TVPage still renders for movies in some configs
  }

  // Find a play button. HiAnime is the default anime source, so the resolver
  // will run on its own once an episode starts.
  // EpisodeCard is a div.episode-card, not a button — a button-only query finds
  // nothing here, and a loose /play/i text match had grabbed the sidebar's
  // "Watch Party" instead.
  const playAttempt = await evaluate(
    `(() => {
       const cards = Array.from(document.querySelectorAll('div.episode-card'))
         .filter(c => !/episode-card--(restricted|unreleased)/.test(c.className||''));
       if (!cards.length) {
         return 'none; cards=' + document.querySelectorAll('.episode-card').length;
       }
       cards[0].click();
       return 'clicked:' + (cards[0].innerText||'').trim().slice(0,30);
     })()`,
  );
  console.log("  play:", playAttempt);

  // Sample fast right after the play click. The 20s gap between "clicked E1" and
  // "back on Home" hides whatever happens in between; poll every 2s and print
  // each distinct state so the transition is visible.
  let prevKey = "";
  for (let i = 0; i < 25; i++) {
    const snap = await evaluate(
      `JSON.stringify({
         detail: !!document.querySelector('.detail-title'),
         wrap: !!document.querySelector('.player-wrap'),
         cards: document.querySelectorAll('.episode-card').length,
         native: !!document.querySelector('.native-player__video'),
         webview: !!document.querySelector('webview'),
         log: (window.__driveLog||[]).slice(-3),
       })`,
    );
    const s = JSON.parse(snap);
    const key = `detail=${s.detail} wrap=${s.wrap} native=${s.native} webview=${s.webview} cards=${s.cards}`;
    if (key !== prevKey) {
      console.log(`    t+${i * 2}s  ${key}`);
      if (s.log?.length) console.log(`           log: ${JSON.stringify(s.log)}`);
      prevKey = key;
    }
    if (!s.detail && i > 2) {
      console.log("    → left the detail page");
      break;
    }
    await sleep(2000);
  }
  await sleep(2000);

  let st = JSON.parse(await evaluate(playerState));
  console.log("  t+20s:", JSON.stringify(st));

  // Give a slow CDN room, then sample twice to prove the clock is moving.
  if (!st.mounted || !st.currentTime) {
    console.log("  waiting longer for the stream …");
    await sleep(30000);
    st = JSON.parse(await evaluate(playerState));
    console.log("  t+50s:", JSON.stringify(st));
  }

  const first = st.currentTime || 0;
  await sleep(12000);
  const st2 = JSON.parse(await evaluate(playerState));
  console.log("  t+12s later:", JSON.stringify(st2));

  const advanced = (st2.currentTime || 0) > first;
  const ok =
    st2.mounted &&
    advanced &&
    st2.readyState >= 2 &&
    st2.w > 0 &&
    st2.controlBar &&
    !!st2.tracks.length;

  console.log("\n─── verdict ───");
  console.log(`mounted <video>      ${st2.mounted ? "YES" : "NO"}`);
  console.log(`control bar rendered  ${st2.controlBar ? "YES" : "NO"}`);
  console.log(`webview hidden        ${st2.webviewHidden === "hidden" ? "YES" : st2.webviewHidden}`);
  console.log(`clock advancing       ${advanced ? `YES (${first.toFixed(2)}s → ${(st2.currentTime || 0).toFixed(2)}s)` : "NO"}`);
  console.log(`video dimensions     ${st2.w}x${st2.h}`);
  console.log(`quality levels        ${st2.levels}`);
  console.log(
    `subtitle tracks       ${st2.tracks.length ? JSON.stringify(st2.tracks) : "NONE"}`,
  );
  console.log(`player error          ${st2.error || "none"}`);
  if (exceptions.length) console.log(`renderer exceptions   ${JSON.stringify(exceptions.slice(0, 5))}`);

  if (ok) {
    console.log("\nRESULT: PASS — the real player UI played an episode.");
    exitCode = 0;
  } else {
    const why = [];
    if (!st2.mounted) why.push("native <video> never mounted");
    if (!advanced) why.push("playhead did not advance");
    if (!st2.controlBar) why.push("control bar missing");
    if (!st2.tracks.length) why.push("no subtitle tracks");
    console.log(`\nRESULT: FAIL — ${why.join("; ")}`);
    exitCode = 4;
  }
} catch (e) {
  console.log(`\ndriver error: ${e.message}`);
  exitCode = 5;
} finally {
  try { ws?.close(); } catch {}
  try { process.kill(-app.pid, "SIGKILL"); } catch {}
  try { app.kill("SIGKILL"); } catch {}
  await sleep(1500);
}
process.exit(exitCode);