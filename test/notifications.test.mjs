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

const { shouldNotifyNewEpisode } = await import(
  "../src/utils/episodeNotifications.js"
);

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

console.log(`\npassed: ${passed}`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all checks green");
