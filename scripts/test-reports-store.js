#!/usr/bin/env node
// Store self-check for src/ipc/reports.js — run with: node scripts/test-reports-store.js
// Revert-proof: fails if validation, sourceId rules, or the 200-report cap are removed.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// Mock electron (main-process module) with a temp userData dir before requiring reports.js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "streambert-test-"));
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return { app: { getPath: () => tmpDir } };
  }
  return origLoad.call(this, request, ...rest);
};

const reports = require("../src/ipc/reports");
const { _internals } = reports;

// Use a direct (non-debounced) save to make disk assertions deterministic
function flushSave() {
  // _internals exposes the timer-free path: write synchronously via a second call
  reports.saveReports();
  // saveReports is debounced (2s); clear by re-requiring state through a fresh
  // saveReports call writes synchronously only after the timer fires — instead we
  // assert on in-memory state, which is the source of truth the IPC handlers use.
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("reports store self-check");

// ── add + list ────────────────────────────────────────────────────────────────
check("add valid broken_stream report", () => {
  const r = reports.addReport({
    kind: "broken_stream",
    mediaType: "movie",
    tmdbId: "123",
    title: "Test Movie",
    sourceId: "vidsrc",
    note: "stream died at 12:34",
  });
  assert(r.id && r.ts && r.status === "open", "report shape");
  assert.strictEqual(r.sourceId, null, "broken_stream must not carry sourceId");
  assert.strictEqual(r.note, "stream died at 12:34");
});

check("add wrong_metadata report", () => {
  const r = reports.addReport({
    kind: "wrong_metadata",
    mediaType: "movie",
    tmdbId: "456",
    title: "Wrong Title",
  });
  assert.strictEqual(r.sourceId, null, "wrong_metadata must not carry sourceId");
});

check("add missing_subtitle with sourceId", () => {
  const r = reports.addReport({
    kind: "missing_subtitle",
    mediaType: "tv",
    tmdbId: "789",
    season: 2,
    episode: 5,
    title: "TV Show",
    sourceId: "videasy",
  });
  assert.strictEqual(r.sourceId, "videasy");
  assert.strictEqual(r.season, 2);
  assert.strictEqual(r.episode, 5);
});

check("getReports returns all reports", () => {
  assert.strictEqual(reports.getReports().length, 3);
});

// ── validation ────────────────────────────────────────────────────────────────
check("reject invalid kind", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "bug",
        mediaType: "movie",
        tmdbId: "1",
      }),
    /invalid kind/,
  );
});

check("reject invalid mediaType", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "broken_stream",
        mediaType: "song",
        tmdbId: "1",
      }),
    /invalid mediaType/,
  );
});

check("reject non-string tmdbId", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "broken_stream",
        mediaType: "movie",
        tmdbId: 123,
      }),
    /invalid tmdbId/,
  );
});

check("reject missing_subtitle without sourceId", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "missing_subtitle",
        mediaType: "movie",
        tmdbId: "123",
      }),
    /sourceId/,
  );
});

check("reject invalid sourceId", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "missing_subtitle",
        mediaType: "movie",
        tmdbId: "123",
        sourceId: "notarealsource",
      }),
    /sourceId/,
  );
});

check("reject oversized note", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "broken_stream",
        mediaType: "movie",
        tmdbId: "1",
        note: "x".repeat(1001),
      }),
    /invalid note/,
  );
});

check("reject non-string note", () => {
  assert.throws(
    () =>
      reports.addReport({
        kind: "broken_stream",
        mediaType: "movie",
        tmdbId: "1",
        note: 42,
      }),
    /invalid note/,
  );
});

check("reject invalid vote", () => {
  assert.throws(
    () => reports.voteSourceHealth("vidsrc", "sideways"),
    /invalid vote/,
  );
});

// ── source health ─────────────────────────────────────────────────────────────
check("vote up/down increments counters", () => {
  reports.voteSourceHealth("vidsrc", "up");
  reports.voteSourceHealth("vidsrc", "up");
  reports.voteSourceHealth("vidsrc", "down");
  const h = reports.getSourceHealth();
  assert.strictEqual(h.vidsrc.up, 2);
  assert.strictEqual(h.vidsrc.down, 1);
  assert(h.vidsrc.lastVoteAt > 0, "lastVoteAt set");
});

check("reject vote for non-PLAYER_SOURCES id", () => {
  assert.throws(
    () => reports.voteSourceHealth("notarealsource", "up"),
    /invalid sourceId/,
  );
});

// ── 200-report cap ────────────────────────────────────────────────────────────
check("evict oldest past 200 cap (newest kept)", () => {
  const before = reports.getReports().length;
  assert(before < 200, `precondition: ${before} < 200`);
  const target = _internals.REPORTS_CAP;
  const total = before + target + 50; // 3 + 250 = 253 → evict 53 oldest
  const evictCount = total - target;
  for (let i = 0; i < target + 50; i++) {
    reports.addReport({
      kind: "broken_stream",
      mediaType: "movie",
      tmdbId: String(1000 + i),
    });
  }
  const list = reports.getReports();
  assert.strictEqual(list.length, target, `cap enforced at ${target}`);
  // newest-first: last added must be first
  assert.strictEqual(list[0].tmdbId, String(1000 + target + 49));
  // oldest surviving: evictCount oldest removed (3 initial + 1000..1049) → 1050
  const surviving = list[list.length - 1];
  assert.strictEqual(surviving.tmdbId, String(1000 + evictCount - before));
});

// ── delete ────────────────────────────────────────────────────────────────────
check("deleteReport removes by id", () => {
  const list = reports.getReports();
  const target = list[0];
  reports.deleteReport(target.id);
  assert.strictEqual(reports.getReports().length, _internals.REPORTS_CAP - 1);
  assert(
    !reports.getReports().some((r) => r.id === target.id),
    "deleted id gone",
  );
});

console.log(`\nall ${passed} checks passed`);
