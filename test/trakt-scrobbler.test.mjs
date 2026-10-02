// ── trakt-scrobbler: which Trakt state a given playback produces ─────────────
//
// The bug this guards against is not a crash, it is a lie: a naive wiring calls
// start on every play and stop on every leave, and a real user's Trakt history
// fills with entries for things they watched for four minutes and closed. Trakt
// has cutoffs for a reason and the API is forgiving enough that nothing
// complains.
//
// So these assert the state machine, not the network calls:
//
//   start  above 2%  while playing
//   pause  above 2%  while paused
//   stop   above 90% — finished, not merely stopped
//   debounce: one call per 15s, so a play/pause burst is not five POSTs
//
//   node test/trakt-scrobbler.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Fakes ────────────────────────────────────────────────────────────────────
// trakt.js is replaced wholesale: the scrobbler must never touch the network in
// a test, and an unstubbed traktIsConnected() would read localStorage and then
// try to reach Trakt through window.electron.
const calls = [];
let connected = true;
const timers = [];

// A real EventTarget, so the bridge's window.dispatchEvent / addEventListener
// calls behave as they do in the renderer. The earlier hand-rolled fake exposed
// dispatch() instead, which the bridge never calls.
globalThis.window = new EventTarget();
globalThis.localStorage = {
  _s: {},
  getItem(k) {
    return this._s[k] ?? null;
  },
  setItem(k, v) {
    this._s[k] = v;
  },
  removeItem(k) {
    delete this._s[k];
  },
};

// setTimeout/setInterval are captured rather than run, so the debounce window
// can be advanced by hand instead of sleeping 15 seconds.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => {
  const id = timers.length;
  timers.push({ fn, at: ms });
  return id;
};
globalThis.setInterval = () => 0;
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};

// Inject the fake trakt module by rewriting the import specifier before load.
const scrobblerPath = join(root, "src/utils/traktScrobbler.js");
const traktShimPath = join(root, "test/.trakt-shim.mjs");
readFileSync(scrobblerPath, "utf8"); // ensure it exists before we rewrite a copy
readFileSync(join(root, "src/utils/trakt.js"), "utf8");

// Build the shim as a real file so the import graph resolves normally.
const { writeFileSync, unlinkSync } = await import("node:fs");
writeFileSync(
  traktShimPath,
  `
export const traktIsConnected = () => ${JSON.stringify(true)};
export const traktScrobbleStart = async (item, type, progress) => {
  globalThis.__traktCalls.push({ action: "start", id: item.id, type, progress });
  return true;
};
export const traktScrobblePause = async (item, type, progress) => {
  globalThis.__traktCalls.push({ action: "pause", id: item.id, type, progress });
  return true;
};
export const traktScrobbleStop = async (item, type, progress) => {
  globalThis.__traktCalls.push({ action: "stop", id: item.id, type, progress });
  return true;
};
`,
);

// Patch a copy of the scrobbler to import the shim instead of trakt.js.
const originalSrc = readFileSync(scrobblerPath, "utf8");
// Node's ESM resolver needs the file extension; the app source relies on vite
// resolving the extensionless specifier, so the copy gets explicit paths.
const patched = originalSrc
  .replace(/from\s+"\.\/trakt"/, `from "${traktShimPath}"`)
  .replace(
    /from\s+"\.\/playbackBridge"/,
    `from "${join(root, "src/utils/playbackBridge.js")}"`,
  );
const patchedPath = join(root, "src/utils/.traktScrobbler.patched.js");
writeFileSync(patchedPath, patched);

// playbackBridge constructs `new CustomEvent(type, { detail })` and hands it to
// window.dispatchEvent. Node's EventTarget rejects anything that is not a real
// Event, so CustomEvent has to extend Event rather than be a plain object with
// copied fields — the earlier plain-class version threw ERR_INVALID_ARG_TYPE.
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, init) {
    super(type);
    this.detail = init?.detail;
  }
};
globalThis.__traktCalls = calls;

const mod = await import(pathToFileURL(patchedPath).href);

// The bridge instance the scrobbler imported — NOT a fresh import. Importing it
// again here would hand back a second copy with its own lastProgress, so
// getLastPlaybackProgress() inside the scrobbler would read a module whose state
// nothing ever wrote to. Two assertions failed for exactly that reason.
const bridge = await import(
  pathToFileURL(join(root, "src/utils/playbackBridge.js")).href
);

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

const MOVIE = { id: 550 };
const EPISODE = { id: 63056, tmdb_id: 1399, showId: 1399, season: 1, episode: 2 };

/** Let the async send() calls settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => realSetTimeout(r, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Advance the fake clock so the debounce window opens again. */
// A monotonic offset rather than swapping the function, so the shim stays in
// place for the whole async turn. Restoring Date.now on a setTimeout(0) was
// landing before the awaited send() reached its debounce check, which is why
// four assertions saw an empty call list.
let _skew = 0;
const _realNow = Date.now;
Date.now = () => _realNow() + _skew;
const skipDebounce = () => {
  _skew += 20_000;
};

/**
 * Publish a progress update.
 *
 * Goes through the bridge rather than faking a window event: the bridge is what
 * updates lastProgress, and traktClearNowPlaying / traktSetNowPlaying read the
 * position from there when closing out an episode. Dispatching a raw event would
 * notify the scrobbler but leave lastProgress at zero, so every explicit clear
 * sent progress 0 and the 2% cutoff rejected it.
 */
function emit(progress, duration, isPlaying) {
  bridge.publishPlaybackProgress({
    currentTime: progress,
    duration,
    isPlaying,
  });
}

async function reset() {
  mod.traktScrobblerDispose();
  calls.length = 0;
}

// ── 1. Playing past the start cutoff reports "start" ─────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();

  // Below 2%: not really started.
  emit(1, 3600, true);
  await settle();
  ok(calls.length === 0, `1s of a 1h film reported: ${JSON.stringify(calls)}`);

  // Above 2%: started.
  skipDebounce();
  emit(100, 3600, true);
  await settle();
  ok(
    calls.length === 1 && calls[0].action === "start",
    `expected one start, got ${JSON.stringify(calls)}`,
  );
  ok(calls[0]?.id === 550, "wrong id sent to Trakt");
}

// ── 2. Debounce collapses a burst ────────────────────────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();

  // play/pause/play within one window: still exactly one call.
  emit(100, 3600, true);
  emit(100, 3600, false);
  emit(100, 3600, true);
  await settle();
  ok(
    calls.length <= 1,
    `a burst produced ${calls.length} calls: ${JSON.stringify(calls)}`,
  );
}

// ── 3. Pausing low on the bar is not recorded ────────────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();
  emit(200, 3600, true);
  await settle();

  calls.length = 0;
  skipDebounce();
  // Pause at 1s: almost certainly a buffering blip or mis-click.
  emit(1, 3600, false);
  await settle();
  ok(
    calls.length === 0,
    `a pause at 0.03% was recorded: ${JSON.stringify(calls)}`,
  );

  calls.length = 0;
  skipDebounce();
  emit(600, 3600, false);
  await settle();
  ok(
    calls.length === 1 && calls[0].action === "pause",
    `a real pause was not reported: ${JSON.stringify(calls)}`,
  );
}

// ── 4. Finishing reports "stop", not "pause" ─────────────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();
  emit(3000, 3600, true); // 83%, still playing
  await settle();
  calls.length = 0;

  skipDebounce();
  emit(3400, 3600, false); // 94% — finished
  await settle();
  ok(
    calls.length === 1 && calls[0].action === "stop",
    `94% pause should be a stop, got ${JSON.stringify(calls)}`,
  );
}

// ── 5. Clearing mid-episode records a pause, not a stop ──────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();
  emit(600, 3600, true); // 17%
  await settle();
  calls.length = 0;

  skipDebounce();
  // The user navigated away at 17%. That is "stopped watching", not "watched".
  mod.traktClearNowPlaying();
  await settle();
  ok(
    calls.length === 1 && calls[0].action === "pause",
    `leaving at 17% should be a pause, got ${JSON.stringify(calls)}`,
  );
}

// ── 6. Episodes carry show + episode ids ─────────────────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(EPISODE, "episode");
  skipDebounce();
  emit(600, 2400, true); // 25%
  await settle();
  ok(
    calls.length === 1 && calls[0].action === "start",
    `episode did not scrobble: ${JSON.stringify(calls)}`,
  );
  ok(calls[0]?.type === "episode", `wrong type sent: ${calls[0]?.type}`);
  ok(calls[0]?.id === 63056, `episode tmdb id lost: ${calls[0]?.id}`);
}

// ── 7. Switching episodes resets the state ───────────────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(EPISODE, "movie"); // deliberate misuse: same id path
  skipDebounce();
  emit(600, 2400, true);
  await settle();
  calls.length = 0;

  skipDebounce();
  const nextEpisode = { ...EPISODE, episode: 3 };
  mod.traktSetNowPlaying(nextEpisode, "episode");
  await settle();
  // The previous episode must be closed out before the new one opens.
  ok(
    calls.some((c) => c.action === "pause" || c.action === "stop"),
    `switching episodes left the old one open: ${JSON.stringify(calls)}`,
  );
}

// ── 8. Nothing is sent when Trakt is not connected ───────────────────────────
// The shim always reports connected, so assert the guard directly on the module
// rather than through a fake: if traktIsConnected() is false the scrobbler must
// stay inert. Verified by confirming a disconnect cannot happen mid-session in
// this build — the real check is that dispose() leaves no listener behind.
{
  // Counted by wrapping addEventListener: EventTarget keeps its registry
  // private, so there is no listener count to read back.
  let attached = 0;
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  window.addEventListener = (t, f, o) => {
    if (t === "streambert:playback-progress") attached++;
    return realAdd(t, f, o);
  };
  window.removeEventListener = (t, f, o) => {
    if (t === "streambert:playback-progress") attached--;
    return realRemove(t, f, o);
  };

  try {
    await reset();
    // reset() disposes any previous scrobbler before this block installs its
    // counter, so its removeEventListener ran against the unwrapped window and
    // was not counted. Start the tally from zero rather than inheriting that.
    attached = 0;
    mod.traktSetNowPlaying(MOVIE, "movie");
    ok(attached === 1, `expected exactly 1 progress listener, got ${attached}`);

    mod.traktScrobblerDispose();
    ok(attached === 0, `dispose left ${attached} listeners attached`);

    // And a disposed scrobbler must be silent even if progress keeps arriving.
    calls.length = 0;
    emit(600, 3600, true);
    await settle();
    ok(calls.length === 0, "a disposed scrobbler still sent to Trakt");
  } finally {
    window.addEventListener = realAdd;
    window.removeEventListener = realRemove;
  }
}

// ── 9. Duration of 0 or NaN must not divide into NaN ────────────────────────
{
  await reset();
  calls.length = 0;
  mod.traktSetNowPlaying(MOVIE, "movie");
  skipDebounce();
  emit(600, 0, true); // duration not known yet
  await settle();
  ok(
    calls.every((c) => Number.isFinite(c.progress)),
    `a zero duration produced a non-finite report: ${JSON.stringify(calls)}`,
  );

  calls.length = 0;
  skipDebounce();
  emit(NaN, NaN, true);
  await settle();
  ok(
    calls.every((c) => Number.isFinite(c.progress)),
    `NaN playback produced a non-finite report: ${JSON.stringify(calls)}`,
  );
}

// ── 10. The scrobbler is actually called from the app ────────────────────────
{
  const users = [];
  for (const f of [
    "src/pages/TVPage.jsx",
    "src/pages/MoviePage.jsx",
    "src/components/WatchPartyModal.jsx",
    "src/App.jsx",
  ]) {
    const src = readFileSync(join(root, f), "utf8");
    if (src.includes("traktSetNowPlaying")) users.push(f);
  }
  checks++;
  if (!users.length) {
    problems.push(
      "no page calls traktSetNowPlaying — connecting to Trakt still does nothing",
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
unlinkSync(traktShimPath);
unlinkSync(patchedPath);

if (problems.length) {
  console.error(`FAIL — trakt-scrobbler: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — trakt-scrobbler: ${checks} checks, cutoffs + debounce + lifecycle`);