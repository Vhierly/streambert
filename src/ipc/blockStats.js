// ── Block stats store ─────────────────────────────────────────────────────────
// Tracks blocked ad/tracker requests per domain, debounces IPC + disk writes.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const blockStatsFile = () =>
  path.join(app.getPath("userData"), "blockStats.json");

let allBlockStats = { total: 0, domains: {} };
let pendingBlockBatch = null;
let blockBatchTimer = null;
let blockSaveTimer = null;

// Cap on distinct blocked domains kept in the persisted stats.
const BLOCK_STATS_MAX_DOMAINS = 500;

// Injected by init(), returns the current BrowserWindow (or null)
let _getMainWindow = () => null;

function init(getMainWindow) {
  _getMainWindow = getMainWindow;
}

function loadBlockStats() {
  try {
    const raw = fs.readFileSync(blockStatsFile(), "utf8");
    const parsed = JSON.parse(raw);
    allBlockStats = {
      total: parsed.total || 0,
      domains: parsed.domains || {},
    };
  } catch {
    allBlockStats = { total: 0, domains: {} };
  }
}

function saveBlockStats() {
  try {
    fs.writeFileSync(
      blockStatsFile(),
      JSON.stringify({
        total: allBlockStats.total,
        domains: allBlockStats.domains,
      }),
    );
  } catch {}
}

function recordBlockedRequest(url) {
  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return;
  }

  // Update alltime in-memory.
  // The ad matcher now catches a lot more hosts than the old hand-written list
  // did, and this map is serialised to disk, so cap it: a runaway set of
  // one-off hostnames should not grow the JSON without bound. When the cap is
  // hit the noisiest entries are kept and the rest folded into "*other*".
  allBlockStats.total++;
  if (!(domain in allBlockStats.domains)) {
    const keys = Object.keys(allBlockStats.domains);
    if (keys.length >= BLOCK_STATS_MAX_DOMAINS) {
      // drop the smallest entry, it is the least informative
      let smallest = keys[0];
      for (const k of keys) {
        if (allBlockStats.domains[k] < allBlockStats.domains[smallest]) smallest = k;
      }
      delete allBlockStats.domains[smallest];
    }
  }
  allBlockStats.domains[domain] = (allBlockStats.domains[domain] || 0) + 1;

  // Accumulate into pending batch
  if (!pendingBlockBatch) {
    pendingBlockBatch = { total: 0, domains: {} };
  }
  pendingBlockBatch.total++;
  pendingBlockBatch.domains[domain] =
    (pendingBlockBatch.domains[domain] || 0) + 1;

  // Debounced IPC send to renderer (250ms after last block in burst)
  if (blockBatchTimer) clearTimeout(blockBatchTimer);
  blockBatchTimer = setTimeout(() => {
    blockBatchTimer = null;
    const mw = _getMainWindow();
    if (mw && !mw.isDestroyed() && pendingBlockBatch) {
      mw.webContents.send("blocked-stats-update", pendingBlockBatch);
    }
    pendingBlockBatch = null;
  }, 250);

  // Debounced disk write (3s to reduce I/O during active playback)
  if (blockSaveTimer) clearTimeout(blockSaveTimer);
  blockSaveTimer = setTimeout(saveBlockStats, 3000);
}

function getBlockStats() {
  return { total: allBlockStats.total, domains: allBlockStats.domains };
}

module.exports = { init, loadBlockStats, recordBlockedRequest, getBlockStats };
