// ── taste: the decision layer behind "Recommended for You" ──────────────────
//
// The home page already had a recommendations row, and it worked — TMDB's
// /recommendations per recent history item, interleaved, deduped. What it did
// not do was look at *taste*: src/utils/aiRecommendations.js had
// analyzeWatchHistory (genre affinity, average rating, watch streak) and nothing
// ever called it, so five thrillers and twenty comedies produced the same row.
//
// This module is the part worth testing: when to fall back, what to weight, and
// the "because you watched" pairing. The fetching stays in HomePage, where the
// AbortController and the existing dedupe already live.
//
//   node test/taste.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { writeFileSync, unlinkSync } = await import("node:fs");
const stamp = process.hrtime.bigint().toString(36);

// localStorage + fetch are the only things analyzeWatchHistory touches.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Patching every module in src/utils pulls in addons.js, which calls
// loadAddons() at module scope and reaches for window.electron. Without a window
// the import throws *after* the suite has already printed its PASS line, so the
// process exited non-zero and the run looked like a failure with a passing
// summary — the two disagreeing is exactly what makes a result untrustworthy.
globalThis.window = new EventTarget();
globalThis.window.electron = { getInstallPath: async () => null };
if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init) {
      super(type);
      this.detail = init?.detail;
    }
  };
}

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: true, json: async () => ({ results: [] }) };
};

// Extension-complete imports throughout the graph: Node resolves "./api" only
// with an extension, and the chain is aiRecommendations -> api -> addons, so
// patching one file is not enough.
// Keeps the original basename so imports resolve: Node needs a real ".js" on
// the patched file, not ".taste.js.<stamp>" with no extension at the end.
const patchedName = (spec) => {
  const base = spec.slice(2).replace(/\.js$/, "");
  return `.${base}.${stamp}.js`;
};
const patchImports = (text) =>
  text.replace(
    /from\s+"(\.\/[A-Za-z0-9_.-]+)"/g,
    (_m, s) => `from "${join(root, "src/utils", patchedName(s))}"`,
  );

// Every module in src/utils, not the four on the happy path. Chasing them one
// at a time is how the chain grew: taste -> aiRecommendations -> api -> addons
// -> storage, and each round added another name.
const { readdirSync } = await import("node:fs");
const FILES = readdirSync(join(root, "src/utils")).filter(
  (f) => f.endsWith(".js") && !f.startsWith("."),
);
const patched = {};
for (const f of FILES) {
  const p = patchedName(`./${f}`);
  writeFileSync(
    join(root, "src/utils", p),
    patchImports(readFileSync(join(root, "src/utils", f), "utf8")),
  );
  patched[f] = p;
}

const mod = await import(
  pathToFileURL(join(root, "src/utils", patched["taste.js"])).href
);
// analyzeWatchHistory lives in aiRecommendations.js; taste.js imports it rather
// than re-exporting, because a re-export exists only to be called from a test.
const aiMod = await import(
  pathToFileURL(join(root, "src/utils", patched["aiRecommendations.js"])).href
);

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

const watched = (id, genres, extra = {}) => ({
  id,
  title: `Title ${id}`,
  genres: genres.map((g) => ({ id: g })),
  vote_average: 7,
  watchedAt: extra.watchedAt ?? new Date().toISOString(),
  media_type: "movie",
  ...extra,
});

// ── 1. Genre affinity drives the weighting ──────────────────────────────────
// Thrillers should lead a profile that is mostly thrillers. This is the whole
// reason for the module existing: without it, ten thrillers and twenty comedies
// produce the same row.
//
// Every watched item carries several genres, because that is what a real history
// entry looks like — a film is Drama *and* Thriller, not one or the other. The
// first draft of this test gave each item a single genre and then expected three
// genre ids out of the result, which the input could not possibly contain.
{
  const history = [
    ...Array.from({ length: 9 }, (_, i) => watched(i + 1, [53, 28])),
    ...Array.from({ length: 3 }, (_, i) => watched(100 + i, [35])),
  ];
  const out = mod.pickTasteGenres(history, 3);
  ok(out.length === 3, `expected 3 genres, got ${out.length} (${out.join(",")})`);
  ok(out[0] === 53, `thriller should lead, got ${out.join(",")}`);
  ok(out.includes(28), "the co-occurring action genre was dropped");
  ok(out.includes(35), "the comedy genre was dropped despite three entries");
}

// ── 1b. A genre seen once is too thin to describe anyone ────────────────────
// The other half of the same decision: a profile built from one film is not a
// taste, and padding the discover query with it narrows the row to noise.
{
  const history = [
    ...Array.from({ length: 4 }, (_, i) => watched(i + 1, [53, 28])),
    watched(99, [99]),
  ];
  const out = mod.pickTasteGenres(history, 3);
  ok(out.includes(53), "the established genre was dropped");
  ok(
    !out.includes(99),
    `a genre seen once survived the evidence threshold: ${out.join(",")}`,
  );
}

// ── 2. An established genre outranks a thinner one ──────────────────────────
{
  const history = [
    watched(1, [53, 28]),
    watched(2, [53, 28]),
    watched(3, [53, 28]),
    watched(4, [35, 16]),
    watched(5, [35, 16]),
  ];
  // limit 4, not 3: 35 and 16 tie on both count and score, so a 3-slot limit
  // drops one of them and the assertion below would compare an index against -1.
  // Four slots make both visible, which is what the ranking claim is about.
  const out = mod.pickTasteGenres(history, 4);
  ok(out[0] === 53, `the dominant genre should lead, got ${out.join(",")}`);
  // 28 has three entries, 16 has two — 28 should rank second.
  ok(out.indexOf(28) < out.indexOf(16), `ranking is not by weight: ${out.join(",")}`);
}

// ── 3. Genre objects and bare ids both parse ────────────────────────────────
// TMDB returns objects with a name, but stored history is sometimes just ids.
// The parser accepts both; a stored id coming back as "undefined" would silently
// produce an empty profile.
{
  const history = [
    watched(1, [53]),
    watched(2, [53]),
    { ...watched(3, []), genres: [28, 35] },
    { ...watched(4, []), genres: [28, 35] },
  ];
  const out = mod.pickTasteGenres(history, 3);
  ok(out.includes(53), "object-form genre lost");
  ok(out.includes(28), "bare-id genre lost");
  ok(!out.includes(undefined), "an undefined genre id leaked into the profile");
}

// ── 4. No history means no taste, and that is not an error ──────────────────
{
  for (const bad of [null, undefined, []]) {
    const out = mod.pickTasteGenres(bad, 3);
    checks++;
    if (!Array.isArray(out) || out.length !== 0) {
      problems.push(`pickTasteGenres(${JSON.stringify(bad)}) returned ${JSON.stringify(out)}, expected []`);
    }
  }
}

// ── 5. Rating weighting ─────────────────────────────────────────────────────
// A genre the user rated highly is a stronger signal than one they merely
// watched a lot of. Without this, dislike still counts as preference.
{
  // Reception has to overcome frequency, so the disliked genre is the more
  // common one: four 3/10s outrank nothing by count alone.
  //
  // Two earlier versions of this test failed to prove anything. The first gave
  // the well-rated genre more entries, so frequency decided it. The second tied
  // the counts, which left the sort's tie-break branch as the only thing under
  // test — and deleting the rating weight left it green, because the tie-break
  // was never reached with the scores already separated.
  const loved = [
    watched(1, [18], { vote_average: 10 }),
    watched(2, [18], { vote_average: 10 }),
  ];
  const endured = [
    watched(3, [35], { vote_average: 1 }),
    watched(4, [35], { vote_average: 1 }),
    watched(5, [35], { vote_average: 1 }),
    watched(6, [35], { vote_average: 1 }),
  ];
  const out = mod.pickTasteGenres([...loved, ...endured], 2);
  checks++;
  if (out[0] !== 18) {
    problems.push(
      `a genre rated 10/10 twice lost to one rated 1/10 four times: ${out.join(",")}`,
    );
  }
  checks++;
  if (out.length !== 2) {
    problems.push(`expected both genres to qualify, got ${out.join(",")}`);
  }

}

// ── 6. "Because you watched" picks the most recent, and does not mutate ──────
// history.sort() would reorder the caller's array in place — HomePage passes the
// real history, and mutating it would make the row's own dependency change under
// it on the next render.
{
  const history = [
    watched(1, [53], { watchedAt: "2024-01-01T00:00:00Z" }),
    watched(2, [35], { watchedAt: "2024-06-01T00:00:00Z" }),
    watched(3, [18], { watchedAt: "2024-03-01T00:00:00Z" }),
  ];
  const orderBefore = history.map((h) => h.id).join(",");

  const out = mod.pickBecauseYouWatched(history);
  ok(!!out, "no pairing produced");
  ok(out.id === 2, `expected the June title (id 2), got ${out?.id}`);
  ok(
    typeof out.note === "string" && out.note.includes("Title 2"),
    `the note does not name the title: ${out?.note}`,
  );
  ok(
    history.map((h) => h.id).join(",") === orderBefore,
    "pickBecauseYouWatched reordered the caller's history array",
  );

  // And the caller's array must still be usable afterwards: HomePage holds it in
  // state and re-runs this effect when history.length changes, so a function
  // that reorders it would change its own dependency under itself.
  ok(history.length === 3, `history length changed: ${history.length}`);
  ok(history[0].id === 1, `the array no longer starts where it did: ${history[0].id}`);

  // Object identity, not just position — an in-place sort mutates the entries'
  // ordering but a defensive copy could still be reordered without the caller
  // noticing. Freeze the array so any write throws.
  const frozen = Object.freeze([...history]);
  Object.freeze(frozen);
  checks++;
  try {
    mod.pickBecauseYouWatched(frozen);
  } catch (e) {
    problems.push(`pickBecauseYouWatched wrote to a frozen array: ${e.message}`);
  }
}

// ── 7. Empty and malformed history ──────────────────────────────────────────
{
  checks++;
  if (mod.pickBecauseYouWatched([]) !== null) {
    problems.push("an empty history produced a pairing");
  }
  checks++;
  if (mod.pickBecauseYouWatched(null) !== null) {
    problems.push("a null history produced a pairing");
  }
  // An entry with no watchedAt must not become "most recent" by accident.
  const undated = mod.pickBecauseYouWatched([watched(1, [53], { watchedAt: undefined })]);
  checks++;
  if (undated !== null) {
    problems.push("an entry with no date was treated as a valid pairing");
  }
}

// ── 8. A profile summary worth showing ───────────────────────────────────────
{
  const analysis = aiMod.analyzeWatchHistory([
    watched(1, [53]),
    watched(2, [53]),
    watched(3, [28]),
  ]);
  checks++;
  if (analysis.totalWatched !== 3) {
    problems.push(`totalWatched wrong: ${analysis.totalWatched}`);
  }
  checks++;
  if (!Array.isArray(analysis.favoriteGenres) || analysis.favoriteGenres.length === 0) {
    problems.push("favoriteGenres empty for a non-empty history");
  }
}

// ── 9. The row is actually driven by this ────────────────────────────────────
// Everything above is policy. If HomePage never calls it, the analysis runs in a
// test and nowhere else — the original failure, in a new file.
{
  const home = readFileSync(join(root, "src/pages/HomePage.jsx"), "utf8");
  // buildTasteProfile is the single entry point the page uses, so assert on that
  // rather than on the two helpers — asserting the helpers would let the page
  // call something else entirely and still pass.
  checks++;
  if (!home.includes("buildTasteProfile")) {
    problems.push("HomePage never calls buildTasteProfile — taste analysis is still dead code");
  }
  checks++;
  if (!home.includes("taste.discoverQuery")) {
    problems.push("HomePage computes a taste profile but never fetches from it");
  }
  checks++;
  if (!home.includes("subtitle={tasteInfo")) {
    problems.push("HomePage never renders the attribution — the row stays unexplainable");
  }
  // And the old similarity-only path must still work when there is no history:
  // a fresh install should get a row, not an empty home page.
  checks++;
  if (!home.includes("/recommendations") && !home.includes("/similar")) {
    problems.push("the existing /recommendations path is gone — a new user would see nothing");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
for (const p of Object.values(patched)) {
  try {
    unlinkSync(join(root, "src/utils", p));
  } catch {}
}

if (problems.length) {
  console.error(`FAIL — taste: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — taste: ${checks} checks, weighting + pairing + fallbacks`);