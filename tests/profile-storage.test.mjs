// Self-check for profile-scoped storage + legacy migration (TES-122).
// Run: node tests/profile-storage.test.mjs
// No test framework in this repo — plain asserts.

// Minimal localStorage stub, installed before importing storage.js.
// Keys are stored as own enumerable properties, matching real localStorage
// (storage.js's clearProfileData relies on Object.keys(localStorage)).
class LS {
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null;
  }
  setItem(k, v) {
    this[k] = String(v);
  }
  removeItem(k) {
    delete this[k];
  }
  get length() {
    return Object.keys(this).length;
  }
  key(i) {
    return Object.keys(this)[i];
  }
}
const ls = new LS();
globalThis.localStorage = ls;
Object.defineProperty(globalThis, "window", {
  value: { addEventListener() {}, removeEventListener() {} },
  configurable: true,
});

const {
  storage,
  STORAGE_KEYS,
  getProfileData,
  setProfileData,
  clearProfileData,
  getCurrentProfileId,
  getProfileDataOrLegacy,
  migrateLegacyToDefaultProfile,
} = await import("../src/utils/storage.js");

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failures.push(name);
  }
}
const reset = () => {
  for (const k of Object.keys(ls)) delete ls[k];
};

// ── 1. Legacy migration moves global data into the default profile ───────────
reset();
storage.set("saved", { tv_1: { id: 1, title: "Legacy Show" } });
storage.set("history", [{ id: 1, media_type: "tv" }]);
storage.set("progress", { tv_1_s1_e1: 42 });
storage.set("watched", { tv_1_s1_e1: true });
storage.set("savedOrder", ["tv_1"]);
storage.set(STORAGE_KEYS.LIBRARY_SORT, "title");
storage.set(STORAGE_KEYS.HISTORY_ENABLED, 0);

const migrated = migrateLegacyToDefaultProfile();
check("migration reports it ran", migrated === true);
check(
  "saved copied to default profile",
  getProfileData("default", "saved")?.tv_1?.title === "Legacy Show",
);
check("history copied", getProfileData("default", "history")?.length === 1);
check("progress copied", getProfileData("default", "progress")?.tv_1_s1_e1 === 42);
check("watched copied", getProfileData("default", "watched")?.tv_1_s1_e1 === true);
check("savedOrder copied", getProfileData("default", "savedOrder")?.[0] === "tv_1");
check(
  "librarySort copied",
  getProfileData("default", STORAGE_KEYS.LIBRARY_SORT) === "title",
);
check(
  "historyEnabled copied",
  getProfileData("default", STORAGE_KEYS.HISTORY_ENABLED) === 0,
);
check("legacy global saved removed", storage.get("saved") === null);
check("legacy global history removed", storage.get("history") === null);

// ── 2. Migration is idempotent and never clobbers profile data ───────────────
setProfileData("default", "saved", { tv_9: { id: 9, title: "Newer" } });
const second = migrateLegacyToDefaultProfile();
check("second migration is a no-op", second === false);
check(
  "existing profile value preserved",
  getProfileData("default", "saved").tv_9.title === "Newer",
);

// ── 3. Per-profile isolation ────────────────────────────────────────────────
reset();
setProfileData("alice", "saved", { tv_1: { id: 1 } });
setProfileData("bob", "saved", { tv_2: { id: 2 } });
check("alice sees only her data", getProfileData("alice", "saved").tv_1.id === 1);
check("bob does not see alice's data", getProfileData("bob", "saved").tv_1 === undefined);
check("alice has no tv_2", getProfileData("alice", "saved").tv_2 === undefined);

// ── 4. clearProfileData only wipes the target profile ───────────────────────
clearProfileData("alice");
check("alice cleared", getProfileData("alice", "saved") === null);
check("bob untouched", getProfileData("bob", "saved").tv_2.id === 2);

// ── 5. getCurrentProfileId + legacy fallback ────────────────────────────────
reset();
check("defaults to 'default'", getCurrentProfileId() === "default");
storage.set(STORAGE_KEYS.CURRENT_PROFILE, "carol");
check("reads persisted profile", getCurrentProfileId() === "carol");
storage.set("saved", { tv_5: { id: 5 } });
check(
  "falls back to legacy key pre-migration",
  getProfileDataOrLegacy("saved").tv_5.id === 5,
);
setProfileData("carol", "saved", { tv_6: { id: 6 } });
check(
  "prefers profile value over legacy",
  getProfileDataOrLegacy("saved").tv_6.id === 6,
);

// ── 6. Profile keys do not collide across profiles ──────────────────────────
reset();
setProfileData("p1", "history", [{ id: 1 }]);
setProfileData("p10", "history", [{ id: 10 }]);
check("p1 history isolated", getProfileData("p1", "history")[0].id === 1);
check("p10 history isolated", getProfileData("p10", "history")[0].id === 10);

// ── 7. Exact key format (regression: prefix was doubled before) ─────────────
reset();
setProfileData("u1", "saved", { tv_1: { id: 1 } });
check(
  "real localStorage key is streambert_p_u1_saved",
  ls.getItem("streambert_p_u1_saved") !== null,
);
check(
  "no double-prefixed key written",
  ls.getItem("streambert_streambert_p_u1_saved") === null,
);

console.log(`\npassed: ${passed}`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all checks green");
