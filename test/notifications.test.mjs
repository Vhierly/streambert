// Tests for the pure episode-notification decision logic (TES-144).
// Run: node test/notifications.test.mjs
// No test framework in this repo — plain asserts.

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failures.push(name);
  }
}

const { shouldNotifyNewEpisode, shouldScanForEpisodes, newEpisodeDeepLink, resolveDeepLink } =
  await import("../src/utils/episodeNotifications.js");

// Fixed "now" for deterministic tests: Oct 15, 2026 noon local
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();

// ── 1. First check: seed cache, do NOT notify ────────────────────────────────
check(
  "first check (no prev) does not notify",
  shouldNotifyNewEpisode(null, { air_date: "2026-10-14" }, NOW) === false,
);
check(
  "first check (empty prev) does not notify",
  shouldNotifyNewEpisode({}, { air_date: "2026-10-14" }, NOW) === false,
);

// ── 2. Migration: old cache without lastEpDate → seed, don't notify ──────────
check(
  "migration (no lastEpDate in cache) does not notify",
  shouldNotifyNewEpisode(
    { checkedAt: NOW - 86400000 },
    { air_date: "2026-10-14" },
    NOW,
  ) === false,
);

// ── 3. Changed last_episode_to_air notifies ───────────────────────────────────
check(
  "changed last_episode_to_air notifies",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-01", checkedAt: NOW - 86400000 },
    { air_date: "2026-10-10" },
    NOW,
  ) === true,
);
check(
  "changed to more recent date notifies",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-05", checkedAt: NOW - 86400000 },
    { air_date: "2026-10-12" },
    NOW,
  ) === true,
);

// ── 4. Unchanged does not notify ──────────────────────────────────────────────
check(
  "unchanged last_episode_to_air does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-10", checkedAt: NOW - 86400000 },
    { air_date: "2026-10-10" },
    NOW,
  ) === false,
);
check(
  "same air_date does not notify even if cache is old",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-10", checkedAt: NOW - 86400000 * 30 },
    { air_date: "2026-10-10" },
    NOW,
  ) === false,
);

// ── 5. Older than 7 days does not notify ──────────────────────────────────────
check(
  "episode older than 7 days does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-09-01", checkedAt: NOW - 86400000 },
    { air_date: "2026-09-20" },
    NOW,
  ) === false,
);
check(
  "changed but last episode older than 7 days does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-09-01", checkedAt: NOW - 86400000 },
    { air_date: "2026-09-25" },
    NOW,
  ) === false,
);

// ── 6. Missing air_date ───────────────────────────────────────────────────────
check(
  "no air_date does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-01", checkedAt: NOW - 86400000 },
    {},
    NOW,
  ) === false,
);
check(
  "null last episode does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-01", checkedAt: NOW - 86400000 },
    null,
    NOW,
  ) === false,
);

// ── 7. Regression: date went backwards (rare, but must not notify) ────────────
check(
  "date went backwards does not notify",
  shouldNotifyNewEpisode(
    { lastEpDate: "2026-10-10", checkedAt: NOW - 86400000 },
    { air_date: "2026-10-05" },
    NOW,
  ) === false,
);

// ── 8. Opt-in gate: opt-out (and fresh install) skips the scan (TES-143 AC3) ──
// The guard lives in App.jsx's startup effect; this is the same predicate.
check("opt-out (false) skips the scan", shouldScanForEpisodes(false) === false);
check(
  "missing pref (fresh install) skips the scan",
  shouldScanForEpisodes(undefined) === false &&
    shouldScanForEpisodes(null) === false,
);
check("opt-in (true) runs the scan", shouldScanForEpisodes(true) === true);
check(
  "truthy non-boolean still skips the scan",
  shouldScanForEpisodes("true") === false && shouldScanForEpisodes(1) === false,
);

// ── 9. Deep link payload matches the in-app card (TES-147) ───────────────────
// The in-app card navigates with `{ ...entry.seriesItem, season: entry.season ?? 1 }`,
// where seriesItem IS the saved entry. The deep link must produce the same object.
const SERIES = {
  id: 1399,
  media_type: "tv",
  title: "Game of Thrones",
  poster_path: "/poster.jpg",
  vote_average: 8.4,
  year: "2011",
};
const SAVED = { "tv_1399": SERIES };

const cardPayload = { ...SERIES, season: 3 };
const linkPayload = resolveDeepLink(newEpisodeDeepLink(1399, 3), SAVED);
check(
  "deep link payload equals the in-app card payload",
  JSON.stringify(linkPayload) === JSON.stringify(cardPayload),
);
check(
  "deep link payload keeps title + poster (the blank-render defect)",
  linkPayload.title === "Game of Thrones" &&
    linkPayload.poster_path === "/poster.jpg",
);

check(
  "no season in cache defaults to season 1, like the card",
  resolveDeepLink(newEpisodeDeepLink(1399, null), SAVED).season === 1,
);
check(
  "unknown show falls back to id + media_type, no crash",
  JSON.stringify(resolveDeepLink("streambert://show/999", SAVED)) ===
    JSON.stringify({ id: 999, media_type: "tv" }),
);
check(
  "non-show URL resolves to null",
  resolveDeepLink("streambert://episode/1399", SAVED) === null &&
    resolveDeepLink("", SAVED) === null &&
    resolveDeepLink(null, SAVED) === null,
);
check(
  "malformed season does not throw",
  resolveDeepLink("streambert://show/1399?season=abc", SAVED).season ===
    undefined,
);

console.log(`\npassed: ${passed}`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all checks green");
