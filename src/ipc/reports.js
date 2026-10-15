// ── Content report + source-health store ──────────────────────────────────────
// Local-first JSON in userData, mirroring src/ipc/blockStats.js.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const REPORTS_FILE = () => path.join(app.getPath("userData"), "reports.json");

const REPORT_KINDS = new Set(["broken_stream", "wrong_metadata", "missing_subtitle"]);
const MEDIA_TYPES = new Set(["movie", "tv"]);
const NOTE_MAX_LEN = 1000;
const REPORTS_CAP = 200;
const VALID_SOURCES = new Set(["videasy", "vidsrc", "vidking", "allmanga"]);

let reports = [];
let sourceHealth = {};
let saveTimer = null;

function loadReports() {
  try {
    const raw = fs.readFileSync(REPORTS_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    reports = Array.isArray(parsed.reports) ? parsed.reports : [];
    sourceHealth = parsed.sourceHealth && typeof parsed.sourceHealth === "object"
      ? parsed.sourceHealth
      : {};
  } catch {
    reports = [];
    sourceHealth = {};
  }
}

function saveReports() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(
        REPORTS_FILE(),
        JSON.stringify({ reports, sourceHealth }),
      );
    } catch {}
  }, 2000);
}

function addReport({ kind, mediaType, tmdbId, season, episode, title, sourceId, note }) {
  if (!REPORT_KINDS.has(kind)) throw new Error("invalid kind");
  if (!MEDIA_TYPES.has(mediaType)) throw new Error("invalid mediaType");
  if (typeof tmdbId !== "string" || !tmdbId) throw new Error("invalid tmdbId");

  if (note != null && (typeof note !== "string" || note.length > NOTE_MAX_LEN))
    throw new Error("invalid note");

  if (kind === "missing_subtitle") {
    if (!sourceId || !VALID_SOURCES.has(sourceId))
      throw new Error("missing_subtitle requires valid sourceId");
  } else {
    sourceId = null;
  }

  const report = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    kind,
    mediaType,
    tmdbId,
    season: season ?? null,
    episode: episode ?? null,
    title: typeof title === "string" ? title : "",
    sourceId,
    note: typeof note === "string" ? note : "",
    status: "open",
  };

  reports.unshift(report);
  if (reports.length > REPORTS_CAP) reports.length = REPORTS_CAP;

  saveReports();
  return report;
}

function getReports() {
  return reports;
}

function deleteReport(id) {
  const before = reports.length;
  reports = reports.filter((r) => r.id !== id);
  if (reports.length !== before) saveReports();
}

function getSourceHealth() {
  return sourceHealth;
}

function voteSourceHealth(sourceId, vote) {
  if (!VALID_SOURCES.has(sourceId)) throw new Error("invalid sourceId");
  if (vote !== "up" && vote !== "down") throw new Error("invalid vote");

  if (!sourceHealth[sourceId]) {
    sourceHealth[sourceId] = { up: 0, down: 0, lastVoteAt: null };
  }
  sourceHealth[sourceId][vote === "up" ? "up" : "down"]++;
  sourceHealth[sourceId].lastVoteAt = Date.now();
  saveReports();
  return sourceHealth[sourceId];
}

function register(ipcMain) {
  ipcMain.handle("get-reports", () => getReports());
  ipcMain.handle("add-report", (_e, data) => addReport(data));
  ipcMain.handle("delete-report", (_e, id) => deleteReport(id));
  ipcMain.handle("get-source-health", () => getSourceHealth());
  ipcMain.handle("vote-source-health", (_e, { sourceId, vote }) =>
    voteSourceHealth(sourceId, vote),
  );
}

module.exports = {
  register,
  loadReports,
  saveReports,
  addReport,
  getReports,
  deleteReport,
  getSourceHealth,
  voteSourceHealth,
  // exported for testing
  _internals: {
    REPORTS_FILE,
    REPORT_KINDS,
    MEDIA_TYPES,
    NOTE_MAX_LEN,
    REPORTS_CAP,
    VALID_SOURCES,
    _setState: (r, h) => { reports = r; sourceHealth = h; },
    _getState: () => ({ reports, sourceHealth }),
  },
};
