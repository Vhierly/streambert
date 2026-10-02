// ── dead-exports: no renderer utility may export a symbol nobody calls ──────
//
// Deep-dive finding behind v2.9.0: 38 exports across the utility layer had zero
// references anywhere in the codebase. Five of them were why entire features
// looked finished and were not:
//
//   serverClient.js      Jellyfin/Plex could "connect" but had no UI to browse
//   trakt.js             auth worked; nothing ever scrobbled
//   addons.js            addons install but resolveWithAddon is never called
//   smartDownloads.js    Settings saves 10 options that nothing reads
//   watchParty.js        WebSocket lines commented out — two devices never sync
//
// This test locks that shut, so the next five features cannot rot the same way.
//
//   node test/dead-exports.test.mjs
//
// The suite starts red: KNOWN_DEAD below is the measured baseline, not an
// excuse. Each entry must disappear from it as the feature it belongs to gets
// wired up, and the count is a ratchet — it may only go down. Widen the
// allowlist to make this green again and the ratchet check fails.
//
// Two failure classes, reported separately:
//
//   DEAD          exported, referenced nowhere — including its own file.
//                 Wire it up or delete it.
//   OVER-EXPORTED used internally but needlessly `export`ed. A note, never a
//                 failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".git", "build"]);

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, acc);
    else if (/\.(js|jsx|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

// test/ is deliberately absent. A test calling an export does not make it
// reachable: including it hid three addon functions that nothing in the app
// calls, which is precisely the question this scan exists to answer. The suites
// import the real modules and exercise real behaviour, so they lose nothing by
// not being part of the corpus.
const sources = [
  ...collect(join(root, "src")),
  ...collect(join(root, "scripts")),
  join(root, "index.js"),
  join(root, "preload.js"),
  join(root, "popout-preload.js"),
].filter((p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
});

// This file is excluded from the corpus on purpose. Its own KNOWN_DEAD table
// names every symbol it is looking for, so including it would make all of them
// look referenced and report zero dead exports — a green run that proves
// nothing.
const SELF = fileURLToPath(import.meta.url);
const texts = new Map(
  sources
    .filter((p) => resolve(p) !== SELF)
    .map((p) => [p, readFileSync(p, "utf8")]),
);
const utilFiles = collect(join(root, "src", "utils"));

// ── Parse exports ──────────────────────────────────────────────────────────
const DECL = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
  /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm,
  /^export\s*\{([^}]+)\}/gm,
];

function parseExports(src) {
  const names = new Set();
  for (const re of DECL) {
    for (const m of src.matchAll(re)) {
      if (re.source.includes("\\{")) {
        // `export { a, b as c }` — the alias is the imported name.
        for (const part of m[1].split(","))
          names.add(part.split(/\s+as\s+/).pop().trim());
      } else names.add(m[1]);
    }
  }
  names.delete("");
  return names;
}

// ── Measure ────────────────────────────────────────────────────────────────
const dead = []; // unreachable: zero refs anywhere
const overExported = []; // used inside its own file only
let exportCount = 0;

for (const file of utilFiles) {
  const src = texts.get(file);
  const rel = relative(root, file);
  for (const name of parseExports(src)) {
    exportCount++;
    const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
    let usedElsewhere = false;
    for (const [p, t] of texts) {
      if (p !== file && word.test(t)) {
        usedElsewhere = true;
        break;
      }
    }
    if (usedElsewhere) continue;
    const selfRefs = (src.match(word) || []).length;
    (selfRefs > 1 ? overExported : dead).push({ name, rel });
  }
}

const liveNames = new Set();
for (const f of utilFiles) for (const n of parseExports(texts.get(f))) liveNames.add(n);

// ── Allowlists ─────────────────────────────────────────────────────────────
// Reviewed and deliberately left alone: either a duplicate of a live path, a
// constant, or internals reachable through a wrapper. Keyed by export name so a
// moved export stays covered.
const ALLOW = {
  BACKUP_KEYS: "backup manifest, read by index.js at runtime",
  MAX_HOPS: "source-recovery tuning constant",
  NO_VIDEO_GRACE_MS: "source-recovery tuning constant",
  STALE_TTL_MS: "health-cache TTL constant",
  QUEUE_KEY: "downloadQueue storage key constant",
  SETTINGS_KEY: "downloadQueue storage key constant",
  DEFAULT_SETTINGS: "downloadQueue defaults, read internally",
  queueKey: "downloadQueue helper, read internally",
  isPlayerPlaying: "downloadQueue helper, read internally",
  canStartNow: "downloadQueue helper, read internally",
  startGamepadLoop: "gamepad internals, read internally",
  setGamepadFocus: "spatial nav internals, read internally",
  getGamepadFocus: "spatial nav internals, read internally",
  certToMinAge: "age-rating internals, read internally",
  getCurrentBandwidthUsage: "smart-download helper, read internally",
  saveDownloadQueue: "smart-download helper, read internally",
  healthySources: "source-health internals, read internally",
  isAnimeSource: "source-health internals, read internally",
  GITHUB_REPO: "updates internals, via checkForUpdatesWithFallback",
  CODEBERG_REPO: "updates internals, via checkForUpdatesWithFallback",
  normaliseVersion: "updates internals, via checkForUpdatesWithFallback",
  semverGt: "updates internals, via checkForUpdatesWithFallback",
  checkForUpdates: "updates internals, via checkForUpdatesWithFallback",
  // Exported and deliberately returns null: server-library playback needs Plex
  // transcoder sessions negotiated before a URL means anything. The server-client
  // suite asserts it stays null rather than quietly building a leaky one.
  serverGetStreamUrl: "playback from a server library is not implemented; asserted null by test/server-client.test.mjs",
  getAddons: "addon gallery, exercised via getAddonGallery",
  loadAddons: "addon loader, called from getAddonGallery",
};

// The measured baseline. Each entry is work item t4–t8 in the v2.9.0 push, or
// is slated for deletion. Shrinks as they land. Count is enforced.
//
// t3 (watch party) is done and no longer listed: WebRTC transport, the playback
// bridge and the host-clock sync all landed, and watchPartyUpdateState,
// watchPartyGetState and watchPartyShouldResync are called from the modal.
const KNOWN_DEAD = {
  // t3 — watch party: DONE. WebRTC transport + playback bridge wired, and
  // watchPartyUpdateState is called by the modal. Nothing left here.
  // t4 — trakt scrobble: DONE. traktScrobbleStart/Pause/Stop are called by
  // src/utils/traktScrobbler.js, which TVPage and MoviePage drive.
  "traktGetClientId": 1,
  "traktSetClientId": 1,
  "traktSyncHistory": 1,
  "traktSyncWatchlist": 1,
  "traktGetRecommendations": 1,
  "traktGetShowProgress": 1,
  "traktSearch": 1,
  "traktGetCalendar": 1,
  "traktGetTrending": 1,
  "traktGetPopular": 1,
  // t5 — addons: resolveWithAddon and getAddonSources DONE (backed by
  // getAddonSource, and reachable from the source menu via getAllSources).
  // These three remain: only test/addons.test.mjs calls them, no page does.
  // A test calling an export does not make a feature reachable, and the ratchet
  // is only worth having if it keeps saying so.
  "getAddon": 1,
  "isAddonLoaded": 1,
  "unregisterAddon": 1,
  // t6 — smart downloads: DONE. isWithinSchedule / shouldAutoDownload /
  // matchesQuality are the gates in src/utils/autoDownload.js, started from
  // App.jsx. canStartDownload stays: downloadQueue.canStartNow covers the
  // runtime gate and this one duplicates it with no caller.
  // t7 — jellyfin/plex: transport DONE (serverGetLibraries, serverGetItems,
  // serverReportProgress all wired to the main-process IPC). These three remain
  // because playback from a server library is a separate piece of work — Plex
  // needs a transcode decision and a live transcoder session, Jellyfin needs its
  // playlist through the loopback proxy. serverGetStreamUrl returns null on
  // purpose rather than building a URL that leaks the API key into every log it
  // passes through.
  "isServerConnected": 1,
  "jellyfinGetPlaybackInfo": 1,
  // t8 — ai recommendations reach the home page
  "getSimilarRecommendations": 1,
  "getBecauseYouWatched": 1,
  // genuinely orphaned: no feature claims these, slated for deletion
  "clearAniSkipCache": 1,
  "buildSearchUrl": 1,
  "getAllCustomMetadata": 1,
  "importCustomMetadata": 1,
  "searchCustomMetadata": 1,
  "hasCustomMetadata": 1,
  "saveHomeLayout": 1,
  "loadStartPage": 1,
  "getHealthMap": 1,
  "stopHealthTimer": 1,
};

const BASELINE_COUNT = Object.keys(KNOWN_DEAD).length;

const problems = [];

// 1. Anything dead that is neither allowlisted nor declared in KNOWN_DEAD.
const unexplained = dead.filter(
  (d) => !(d.name in ALLOW) && !(d.name in KNOWN_DEAD),
);
for (const d of unexplained)
  problems.push(`new dead export — wire it up, delete it, or justify it: ${d.rel}: ${d.name}`);

// 2. KNOWN_DEAD entries that no longer exist (they got wired up, or deleted).
const gone = Object.keys(KNOWN_DEAD).filter((n) => !dead.some((d) => d.name === n));
if (gone.length) {
  problems.push(
    `ratchet: ${gone.length} KNOWN_DEAD entr(ies) are now referenced or removed — ` +
      `delete them from the list so the count stays honest:`,
  );
  for (const g of gone) problems.push(`  • ${g}`);
}

// 3. The count itself. It may only shrink.
if (dead.length > BASELINE_COUNT) {
  problems.push(
    `dead exports went UP: ${dead.length} now, baseline was ${BASELINE_COUNT}`,
  );
}

// 4. Stale allowlist entries rot silently and would hide a future reuse.
const staleAllow = Object.keys(ALLOW).filter((n) => !liveNames.has(n));
if (staleAllow.length) {
  problems.push(`stale allowlist — these exports no longer exist: ${staleAllow.join(", ")}`);
}

// A missing-import scan was tried here and removed.
//
// It is the natural mirror of the dead-export check, and it did catch a real
// one: `getLastPlaybackProgress is not defined` reached a build and only fired
// at runtime, because vite treats an unimported identifier as a global and
// compiles it clean (see scripts/smoke.mjs for why the smoke test is what
// catches that class).
//
// It could not be made trustworthy without a real parser. Text matching cannot
// separate three cases that all look identical in a flat scan:
//
//   ageRating.js    export function getAgeLimitSetting(storage)   ← parameter
//   sourceHealth.js // the failover cache (storage.getFailoverSource…)  ← comment
//   gamepad.js      //  - useGamepadNav.js → app-wide D-pad nav     ← comment
//
// Every one of those was reported as a missing import. Stripping comments and
// tracking function scope would fix those specific cases but not the general
// problem (shadowed names, hoisted declarations, destructured aliases), and a
// check that fires on correct code trains everyone to ignore it — worse than no
// check at all.
//
// The coverage stays where it can be honest: scripts/smoke.mjs mounts the real
// app and fails on the runtime ReferenceError, and test/playback-bridge.test.mjs
// asserts the specific import sites that ship together.

if (problems.length) {
  console.error(`FAIL — dead-exports:\n\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  process.exit(1);
}

if (overExported.length) {
  const shown = overExported.slice(0, 4).map((o) => o.name).join(", ");
  console.log(
    `note — ${overExported.length} over-exported (internal-only, harmless): ${shown}` +
      (overExported.length > 4 ? ", …" : ""),
  );
}

const progress = BASELINE_COUNT - dead.length;
console.log(
  `PASS — ${exportCount} exports checked · ${dead.length} dead ` +
    `(baseline ${BASELINE_COUNT}` +
    (progress ? `, ${progress} fixed` : "") +
    `) · ${overExported.length} over-exported`,
);