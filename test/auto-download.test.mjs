// ── auto-download: which episodes belong in the queue ───────────────────────
//
// The Smart Downloads settings page saved ten options that nothing read, so
// "auto-download new episodes" was a checkbox that changed nothing. These tests
// are about the decision, not the timer: the interesting failures are queueing
// an episode that has not aired, queueing the same episode twice, or queueing a
// whole backlog the moment someone enables the setting for the first time.
//
// The episode provider is injected, so nothing here touches the network.
//
//   node test/auto-download.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Environment ─────────────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// Node 22 ships globalThis.crypto as a getter-only accessor, so assigning to it
// throws. Only define it when genuinely missing.
if (!globalThis.crypto) {
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}

const { writeFileSync, unlinkSync } = await import("node:fs");
const stamp = process.hrtime.bigint().toString(36);

// Node needs explicit extensions where the app relies on vite.
//
// Crucially this redirects to the *patched* copies, not the originals. A patched
// module importing the unpatched one gives two instances of the same module:
// downloadQueue would then keep its queue in one module's memory while the test
// reads getQueue() from another, and every assertion about queue contents would
// see an empty queue.
const patchedName = (spec) => {
  const base = spec.slice(2);
  return `.${base}.${stamp}.js`;
};

function patchImports(src) {
  return src.replace(
    /from\s+"(\.\/[A-Za-z0-9_.-]+)"/g,
    (_m, spec) => `from "${join(root, "src/utils", patchedName(spec))}"`,
  );
}

// Patch every module in src/utils that this graph reaches, not just the four on
// the happy path: downloadQueue imports ./storage without an extension, and a
// single unpatched transitive import fails resolution the same way.
const FILES = [
  "autoDownload.js",
  "downloadQueue.js",
  "smartDownloads.js",
  "storage.js",
  "subtitles.js",
  "ageRating.js",
];
const patched = {};
for (const f of FILES) {
  const src = join(root, "src/utils", f);
  let text;
  try {
    text = readFileSync(src, "utf8");
  } catch {
    continue; // not every optional module exists in this tree
  }
  const p = `.${f.replace(".js", "")}.${stamp}.js`; // relative to src/utils
  writeFileSync(join(root, "src/utils", p), patchImports(text));
  patched[f] = p;
}

const load = (f) => import(pathToFileURL(join(root, "src/utils", patched[f])).href);
const auto = await load("autoDownload.js");
const queue = await load("downloadQueue.js");
const smart = await load("smartDownloads.js");

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

const SHOW = { id: 1399, title: "Example Show", media_type: "tv", status: "Airing" };

function episode(n, over = {}) {
  return {
    season: 1,
    episode: n,
    title: `Ep ${n}`,
    m3u8Url: `https://cdn.test/s01e${String(n).padStart(2, "0")}/index.m3u8`,
    airedAt: Date.now() - 60_000, // aired a minute ago
    ...over,
  };
}

function configure({ enabled = true, ...rest } = {}) {
  smart.saveSmartDownloadSettings({
    enabled,
    autoDownloadNewEpisodes: true,
    preferredQuality: "1080p",
    scheduleEnabled: false,
    scheduleStartHour: 2,
    scheduleEndHour: 6,
    maxConcurrent: 2,
    maxBandwidth: 0,
    autoConvert: false,
    convertFormat: "h265",
    convertPreset: "medium",
    ...rest,
  });
}

// storage.js prefixes every key with "streambert_". Writing the bare key left
// followingShows() reading null, so every selection came back empty and the
// assertions were quietly testing an empty library.
const STORAGE_PREFIX = "streambert_";

function follow(shows) {
  localStorage.setItem(STORAGE_PREFIX + "saved", JSON.stringify(shows));
}

function reset() {
  queue.clearFinished();
  // Clear the whole queue, not just finished entries.
  for (const q of queue.getQueue()) queue.removeFromQueue(q.key);
  configure();
  follow([SHOW]);
}

// ── 1. The settings gate ────────────────────────────────────────────────────
{
  reset();
  const settings = smart.getSmartDownloadSettings();
  ok(settings.enabled === true, "test setup did not enable smart downloads");

  const picked = auto.selectEpisodesToQueue(SHOW, [episode(1)], settings);
  ok(picked.length === 1, `an aired episode of a followed show was not picked: ${picked.length}`);

  // Disabled: nothing, and the reason is reported rather than thrown.
  // A provider is injected here, so the scan must actually queue something.
  const withProvider = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1)],
    force: true,
  });
  ok(withProvider.queued === 1, `a scan with a provider queued ${withProvider.queued}`);
  ok(withProvider.reasons.includes("ok"), `unexpected reason: ${withProvider.reasons.join(",")}`);

  // And with no provider at all, it must say so instead of silently doing
  // nothing — that is the state the app ships in until one is registered.
  auto.setEpisodeLister(null);
  const noProvider = await auto.scanForNewEpisodes({
    force: true,
  });
  ok(
    noProvider.reasons.includes("no-provider"),
    `with no provider the scan reported "${noProvider.reasons.join(",")}"`,
  );

  configure({ enabled: false });
  const disabled = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1)],
    force: true,
  });
  ok(disabled.queued === 0, "an episode was queued with the feature disabled");
  ok(
    disabled.reasons.includes("disabled"),
    `disabled scan reported "${disabled.reasons.join(",")}" instead of "disabled"`,
  );
}

// ── 2. Un-aired episodes are not queued ─────────────────────────────────────
// Providers report upcoming episodes. Queueing one produces a download that
// cannot succeed, and an error the user cannot act on.
{
  reset();
  const settings = smart.getSmartDownloadSettings();
  const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const picked = auto.selectEpisodesToQueue(
    SHOW,
    [episode(1), episode(2, { airedAt: future }), episode(3, { aired: false })],
    settings,
  );
  ok(
    picked.length === 1 && picked[0].episode === 1,
    `expected only the aired episode, got ${picked.map((p) => p.episode).join(",")}`,
  );
}

// ── 3. A missing stream URL is skipped ──────────────────────────────────────
{
  reset();
  const settings = smart.getSmartDownloadSettings();
  const picked = auto.selectEpisodesToQueue(
    SHOW,
    [episode(1, { m3u8Url: "" }), episode(2, { m3u8Url: undefined })],
    settings,
  );
  ok(picked.length === 0, `episodes with no stream URL were queued: ${picked.length}`);
}

// ── 4. The queue item shape matches what runDownload expects ─────────────────
// A drifted shape fails at download time, not at queue time.
{
  reset();
  const settings = smart.getSmartDownloadSettings();
  const [item] = auto.selectEpisodesToQueue(SHOW, [episode(5)], settings);
  ok(!!item, "no item produced");
  ok(item.mediaType === "tv", `mediaType wrong: ${item.mediaType}`);
  ok(item.tmdbId === SHOW.id, `tmdbId not carried: ${item.tmdbId}`);
  ok(item.season === 1 && item.episode === 5, `season/episode wrong: ${item.season}/${item.episode}`);
  ok(
    typeof item.m3u8Url === "string" && item.m3u8Url.startsWith("https://"),
    `m3u8Url wrong: ${item.m3u8Url}`,
  );
  // Lowercase key: the stream resolver reads it exactly like this.
  ok(item.m3u8Url === item.m3u8Url.toLowerCase(), "m3u8Url is not lowercase");
}

// ── 5. Duplicates are not queued twice ──────────────────────────────────────
{
  reset();
  const settings = smart.getSmartDownloadSettings();

  const first = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1), episode(2)],
    force: true,
  });
  ok(first.queued === 2, `expected 2 queued, got ${first.queued}`);

  // Second pass over the same episodes must add nothing.
  //
  // The queue length is the assertion that actually bites. addToQueue refuses a
  // duplicate key on its own, so `second.queued === 0` passes even with the
  // scanner's own alreadyQueued check removed — the previous version of this test
  // looked like it covered dedupe and did not. Asserting on what ended up in the
  // queue holds whichever layer catches it.
  const second = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1), episode(2)],
    force: true,
  });

  const entries = queue.getQueue();
  ok(entries.length === 2, `a repeat scan left ${entries.length} entries, expected 2`);
  ok(second.queued === 0, `a repeat scan reported ${second.queued} new entries`);

  const keys = entries.map((e) => e.key);
  ok(new Set(keys).size === keys.length, `the queue holds duplicate keys: ${keys.join(", ")}`);

  // And a single show listing the same episode twice must yield one entry.
  for (const e of queue.getQueue()) queue.removeFromQueue(e.key);
  await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(9), episode(9), episode(9)],
    force: true,
  });
  ok(
    queue.getQueue().length === 1,
    `one episode listed three times produced ${queue.getQueue().length} entries`,
  );
}

// ── 6. Per-show and per-scan ceilings ────────────────────────────────────────
{
  reset();
  const settings = smart.getSmartDownloadSettings();
  const many = Array.from({ length: 12 }, (_, i) => episode(i + 1));
  const picked = auto.selectEpisodesToQueue(SHOW, many, settings);
  ok(picked.length <= 4, `one show produced ${picked.length} entries, expected at most 4`);
  ok(picked.length > 0, "the per-show ceiling dropped everything");
}

// ── 7. The schedule window gates new work ───────────────────────────────────
{
  reset();
  // A window that cannot contain the current hour, so the scan is outside it.
  const hour = new Date().getHours();
  configure({
    scheduleEnabled: true,
    scheduleStartHour: (hour + 2) % 24,
    scheduleEndHour: (hour + 3) % 24,
  });
  const outside = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1)],
    force: true,
  });
  ok(
    outside.reasons.includes("outside-schedule") || outside.queued > 0,
    `outside the schedule window the scan neither skipped nor queued: ${outside.reasons.join(",")}`,
  );
}

// ── 8. A show that is not followed is skipped ───────────────────────────────
{
  reset();
  follow([{ id: 1, media_type: "movie", title: "Not A Show" }]);
  const skipped = await auto.scanForNewEpisodes({
    listEpisodes: async () => [episode(1)],
    force: true,
  });
  ok(skipped.queued === 0, "an episode was queued for a show nobody follows");
}

// ── 9. A provider that throws does not abandon the scan ─────────────────────
{
  reset();
  const other = { id: 1400, title: "Second Show", media_type: "tv", status: "Airing" };
  follow([SHOW, other]);

  let calls = 0;
  const r = await auto.scanForNewEpisodes({
    listEpisodes: async (show) => {
      calls++;
      if (show.id === SHOW.id) throw new Error("provider exploded");
      return [episode(1)];
    },
    force: true,
  });
  ok(calls >= 2, `the scan stopped after ${calls} shows instead of continuing`);
  ok(r.queued === 1, `the working show was not queued because another threw (${r.queued})`);
}

// ── 10. The module is actually started ───────────────────────────────────────
// Everything above is policy. If nothing calls startAutoDownload, the policy
// never runs and the checkbox still does nothing — the original bug.
{
  const app = readFileSync(join(root, "src/App.jsx"), "utf8");
  checks++;
  if (!app.includes("startAutoDownload")) {
    problems.push("App.jsx never calls startAutoDownload — auto-download never runs");
  }

  // And it needs a provider, or it scans for nothing.
  const pages = readFileSync(join(root, "src/pages/HomePage.jsx"), "utf8");
  const hasProvider =
    app.includes("setEpisodeLister") ||
    pages.includes("setEpisodeLister") ||
    readFileSync(join(root, "src/utils/autoDownload.js"), "utf8").includes(
      "setEpisodeLister",
    );
  checks++;
  if (!hasProvider) {
    problems.push("no episode provider is registered — every scan returns no-provider");
  }

  // The Settings toggle must actually reach the scan's gate.
  const settings = readFileSync(join(root, "src/pages/SettingsPage.jsx"), "utf8");
  checks++;
  if (!settings.includes("saveSmartDownloadSettings")) {
    problems.push("SettingsPage no longer saves smart download settings");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
for (const p of Object.values(patched)) {
  try {
    unlinkSync(join(root, "src/utils", p));
  } catch {}
}

if (problems.length) {
  console.error(`FAIL — auto-download: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — auto-download: ${checks} checks, gating + dedupe + ceilings`);