// ── addons: an installed addon must actually change the playback URL ─────────
//
// The failure this pins down is silent, which is what made it survive. The
// Settings gallery lets you install VidCloud or MoviesAPI; the entry appears in
// the list; you pick it and press play. And getSourceUrl — the single function
// every source path goes through — did:
//
//   const src = PLAYER_SOURCES.find(s => s.id === sourceId) ?? PLAYER_SOURCES[0];
//
// Addon ids are not in PLAYER_SOURCES, so find() returned undefined and the
// fallback substituted whatever source happened to be first in the list. The
// addon looked installed, looked selected, and played something else.
//
// So every assertion here is about the URL that comes out, not about the addon
// being registered:
//
//   node test/addons.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── DOM stubs ────────────────────────────────────────────────────────────────
// addons.js persists to localStorage and api.js reads the TMDB language from
// it, so both are needed before either module evaluates.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// addons.js calls loadAddons() at module scope and loadAddons reaches for
// window.electron.getInstallPath. Without a window the import throws before any
// assertion runs, so the suite reported PASS and then exited 1 — the summary and
// the exit code disagreed, which is exactly the kind of thing that makes a test
// result untrustworthy.
// A real EventTarget so the registry-change announcement behaves as it does in
// the renderer, plus the one preload surface addons.js probes at load time.
const fakeWindow = new EventTarget();
fakeWindow.electron = {
  // Resolves to nothing, so the addon directory scan finds no files and the
  // registry starts empty — which is what the tests drive.
  getInstallPath: async () => null,
};
globalThis.window = fakeWindow;

// Node has no CustomEvent; the registry builds one to announce a change. It has
// to extend Event or EventTarget.dispatchEvent rejects it.
if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init) {
      super(type);
      this.detail = init?.detail;
    }
  };
}

// api.js imports "./addons" without an extension, which vite resolves but
// Node's ESM loader does not. Load an extension-complete copy instead: patched
// in a temp file, then deleted before the process exits.
//
// The copy stays in src/utils so its relative import of "./addons" still
// resolves to the real registry rather than to a second copy — two registries
// would mean an addon registered in the test is invisible to the API under test.
const { writeFileSync, unlinkSync } = await import("node:fs");

// Both modules need their extensionless imports made explicit for Node. Patching
// both matters: api.js imports "./addons" and addons.js dynamically imports
// "./api", so fixing only one side still fails to resolve.
//
// The filenames are unique per run on purpose. A fixed name plus Node's module
// cache means a second run in the same second reuses the *first* run's compiled
// module — and since an earlier failing run left the originals in place, the
// stale cache still pointed at the unpatched specifier and the resolution error
// came back looking like a broken patch.
const stamp = process.hrtime.bigint().toString(36);
const patchedApiPath = join(root, `src/utils/.api.${stamp}.js`);
const patchedAddonsPath = join(root, `src/utils/.addons.${stamp}.js`);

// api.js -> ./addons, and addons.js -> ./api. Patching each to point at the
// *other patched file* keeps a single pair of instances in play: pointing
// addons at the original api.js meant api.js was evaluated twice, and the copy
// loaded by addons still had the unpatched "./addons" specifier.
writeFileSync(
  patchedApiPath,
  readFileSync(join(root, "src/utils/api.js"), "utf8").replace(
    /from\s+"\.\/addons"/,
    `from "${patchedAddonsPath}"`,
  ),
);

writeFileSync(
  patchedAddonsPath,
  readFileSync(join(root, "src/utils/addons.js"), "utf8").replace(
    /import\("\.\/api"\)/,
    `import("${patchedApiPath}")`,
  ),
);

const addons = await import(pathToFileURL(patchedAddonsPath).href);
const api = await import(pathToFileURL(patchedApiPath).href);

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

// ── 1. Registering an addon makes it resolvable ──────────────────────────────
{
  addons.registerAddon({
    id: "vidcloud",
    name: "VidCloud",
    version: "1.0.0",
    type: "stream-source",
    description: "test",
    manifest: {
      id: "vidcloud",
      movieUrl: (id) => `https://vidcloud.pro/movie/${id}`,
      tvUrl: (id, s, e) => `https://vidcloud.pro/tv/${id}/${s}/${e}`,
      supportsProgress: true,
    },
  });
  ok(addons.getAddon("vidcloud") !== null, "addon not registered");
  ok(addons.isAddonLoaded("vidcloud") === true, "addon does not report as loaded");
  ok(addons.getAddonSource("vidcloud") !== null, "getAddonSource cannot find it");
}

// ── 2. The addon actually produces its own URL ───────────────────────────────
// This is the assertion the whole commit exists for. It fails if getSourceUrl
// ever goes back to falling through to PLAYER_SOURCES[0].
{
  const movie = api.getSourceUrl("vidcloud", "movie", 550);
  ok(
    typeof movie === "string" && movie.startsWith("https://vidcloud.pro/movie/550"),
    `addon movie URL wrong: ${movie}`,
  );
  ok(
    !/vidsrc|videasy|vidking/.test(movie || ""),
    `addon movie URL silently fell back to a built-in source: ${movie}`,
  );

  const tv = api.getSourceUrl("vidcloud", "tv", 1399, 2, 5);
  ok(
    tv && tv.startsWith("https://vidcloud.pro/tv/1399/2/5"),
    `addon TV URL wrong: ${tv}`,
  );
}

// ── 3. Built-in sources are untouched ────────────────────────────────────────
{
  const before = api.getSourceUrl("vidsrc", "movie", 550);
  ok(
    before && before.includes("550"),
    `built-in source regressed: ${before}`,
  );

  // An unknown id still falls back rather than throwing — that behaviour is
  // load-bearing for the source menu.
  const unknown = api.getSourceUrl("no-such-source", "movie", 550);
  ok(typeof unknown === "string", "unknown source id threw instead of falling back");
}

// ── 4. Disabled and removed addons stop resolving ───────────────────────────
{
  addons.toggleAddon("vidcloud", false);
  ok(addons.getAddonSource("vidcloud") === null, "a disabled addon still resolves");
  // A disabled addon must fall back like any unknown id, not throw.
  const afterDisable = api.getSourceUrl("vidcloud", "movie", 550);
  ok(
    !/vidcloud/.test(afterDisable || ""),
    `disabled addon still produced its URL: ${afterDisable}`,
  );

  addons.toggleAddon("vidcloud", true);
  ok(addons.getAddonSource("vidcloud") !== null, "re-enabling an addon did not work");
}

// ── 5. A manifest missing its URL builders is treated as absent ─────────────
// Not broken, just a manifest that does not serve this content type — it must
// fall back rather than throw inside the player.
{
  addons.registerAddon({
    id: "movieonly",
    name: "Movie Only",
    type: "stream-source",
    description: "test",
    manifest: {
      id: "movieonly",
      movieUrl: (id) => `https://movieonly.test/m/${id}`,
    },
  });
  const movie = api.getSourceUrl("movieonly", "movie", 7);
  ok(movie && movie.startsWith("https://movieonly.test/m/7"), `movie URL wrong: ${movie}`);

  // A movie-only addon asked for a TV episode must fall back to a built-in
  // source, and must NOT return null: every call site feeds this straight into
  // a webview src, so null becomes the literal string "null" and a blank player
  // with nothing to act on.
  const tv = api.getSourceUrl("movieonly", "tv", 7, 1, 1);
  ok(typeof tv === "string", `TV request on a movie-only addon returned ${tv}`);
  ok(
    tv && !/movieonly/.test(tv),
    `TV request on a movie-only addon kept the addon URL: ${tv}`,
  );

  // resolveWithAddon is the explicit API, so it reports the gap rather than
  // quietly handing back a different source the caller did not ask for.
  let threw = false;
  try {
    await addons.resolveWithAddon("movieonly", "tv", 7, 1, 1);
  } catch {
    threw = true;
  }
  checks++;
  ok(threw, "resolveWithAddon returned a wrong URL instead of reporting the gap");
}

// ── 6. Extra params still apply to addon URLs ───────────────────────────────
{
  addons.registerAddon({
    id: "paramsonly",
    name: "With Params",
    type: "stream-source",
    description: "test",
    manifest: {
      id: "paramsonly",
      params: { autoplay: "1", hl: "en" },
      movieUrl: (id) => `https://params.test/watch/${id}`,
    },
  });
  const url = api.getSourceUrl("paramsonly", "movie", 42, undefined, undefined, {
    extra: "yes",
  });
  const u = new URL(url);
  ok(u.searchParams.get("autoplay") === "1", "manifest params lost on an addon URL");
  ok(u.searchParams.get("hl") === "en", "second manifest param lost");
  ok(u.searchParams.get("extra") === "yes", "caller extraParams lost on an addon URL");
}

// ── 7. resolveWithAddon returns the addon's URL, not a fallback ────────────
{
  const url = await addons.resolveWithAddon("vidcloud", "movie", 550);
  ok(
    String(url).startsWith("https://vidcloud.pro/movie/550"),
    `resolveWithAddon returned the wrong URL: ${url}`,
  );

  let threw = false;
  try {
    await addons.resolveWithAddon("not-installed", "movie", 1);
  } catch {
    threw = true;
  }
  checks++;
  ok(threw, "resolveWithAddon accepted an addon that is not installed");
}

// ── 8. Uninstalling removes it ──────────────────────────────────────────────
{
  addons.unregisterAddon("paramsonly");
  ok(addons.getAddon("paramsonly") === null, "unregisterAddon left the addon in place");
  ok(addons.getAddonSource("paramsonly") === null, "uninstalled addon still resolves");
}

// ── 9. The source menu can enumerate addons ─────────────────────────────────
// getAddonSources is what makes them pickable; if nothing calls it, installing
// an addon still leaves it invisible in the UI.
{
  const src = readFileSync(join(root, "src/utils/addons.js"), "utf8");
  checks++;
  if (!src.includes("export function getAddonSources"))
    problems.push("getAddonSources is missing — addons cannot be listed as sources");

  // The gallery is reachable from Settings, so the registry is not orphaned.
  const settings = readFileSync(join(root, "src/pages/SettingsPage.jsx"), "utf8");
  checks++;
  if (!settings.includes("getAddonGallery") && !settings.includes("registerAddon"))
    problems.push("SettingsPage no longer references the addon gallery at all");
}

// ── 10. Registry changes are announced ───────────────────────────────────────
// The pages snapshot the source list on mount, so an addon installed from
// Settings was not selectable until the app restarted. The registry has to say
// so, and both pages have to listen.
{
  const events = [];
  window.addEventListener("streambert:addons-changed", (e) => events.push(e.detail));

  addons.registerAddon({
    id: "notifytest",
    name: "Notify Test",
    type: "stream-source",
    description: "test",
    manifest: { id: "notifytest", movieUrl: (id) => `https://notify.test/${id}` },
  });
  ok(events.length > 0, "registerAddon did not announce the change");
  ok(
    Array.isArray(events[events.length - 1]) &&
      events[events.length - 1].some((s) => s.id === "notifytest"),
    "the announcement did not carry the new addon",
  );
  // And the addon must actually reach the list the source menu renders, with
  // the URL builder intact — the bug this whole task is about was a menu entry
  // whose movieUrl had been lost to a JSON round trip.
  const listed = api.getAllSources();
  const entry = listed.find((s) => s.id === "notifytest");
  ok(!!entry, "the installed addon is not in getAllSources()");
  ok(entry?.label === "Notify Test", `addon menu label wrong: ${entry?.label}`);
  ok(
    typeof entry?.movieUrl === "function",
    "the menu entry lost its movieUrl — a JSON round trip dropped the function",
  );

  events.length = 0;
  addons.toggleAddon("notifytest", false);
  ok(events.length > 0, "disabling an addon did not announce the change");

  events.length = 0;
  addons.registerAddon({
    id: "notifytest",
    name: "Notify Test",
    type: "stream-source",
    description: "test",
    manifest: { id: "notifytest", movieUrl: (id) => `https://notify.test/${id}` },
  });
  events.length = 0;
  addons.unregisterAddon("notifytest");
  ok(events.length > 0, "uninstalling an addon did not announce the change");

  // A page must actually be listening, or the event goes nowhere.
  for (const f of ["src/pages/MoviePage.jsx", "src/pages/TVPage.jsx"]) {
    const src = readFileSync(join(root, f), "utf8");
    checks++;
    if (!src.includes("streambert:addons-changed")) {
      problems.push(`${f} does not listen for streambert:addons-changed`);
    }
  }

  // And the scrobbler must be disposed on unmount, or every visit to a detail
  // page leaks another progress subscription.
  for (const f of ["src/pages/MoviePage.jsx", "src/pages/TVPage.jsx"]) {
    const src = readFileSync(join(root, f), "utf8");
    checks++;
    if (!src.includes("traktScrobblerDispose()")) {
      problems.push(`${f} never disposes the Trakt scrobbler — listeners leak`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
unlinkSync(patchedApiPath);
unlinkSync(patchedAddonsPath);

if (problems.length) {
  console.error(`FAIL — addons: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — addons: ${checks} checks, installed addons really resolve`);