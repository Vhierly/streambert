// ── IPC: Stream source health probing ────────────────────────────────────────
// Embed hosts rot constantly (domain parked, Cloudflare wall, 404 embed route).
// Probing them in the main process lets us rank sources by "known good" instead
// of letting the user discover a dead source by hitting Play and waiting.
//
// Design notes:
//  - Probes are HEAD requests with a redirect-following, short timeout. We only
//    care whether the host answers HTTP at all, not whether the embed renders.
//  - Results are cached in the app userData dir (not localStorage) so a probe
//    run survives reloads and can be shared across windows.
//  - A probe never blocks playback: it is fire-and-forget from the renderer and
//    failures just mean "unknown", which the ranker treats as neutral.

const { ipcMain, net } = require("electron");
const path = require("path");
const fs = require("fs");

// Hosts we probe, keyed by the PLAYER_SOURCES id used in the renderer.
//
// The host MUST match the one PLAYER_SOURCES actually loads. Probing a stale
// domain reports a working source as flaky/down, which demotes it in the source
// menu for no reason — that is worse than not probing at all. Five entries here
// had drifted (vidfast.to vs vidfast.vc, vidcore.pw vs vidcore.org,
// vidphantom.xyz vs .com, cinextream.to vs .cc, vidsrc3.to vs .created.app) and
// six pointed at sources that no longer exist at all.
//
// test/health-sync.test.mjs fails if this list and PLAYER_SOURCES disagree.
const PROBE_TARGETS = {
  videasy: "https://player.videasy.to/",
  vidsrc: "https://vsembed.su/",
  vidking: "https://www.vidking.net/",
  vidlink: "https://vidlink.pro/",
  vidspark: "https://vidspark.to/",
  vidfast: "https://vidfast.vc/",
  vidcore: "https://vidcore.org/",
  vidphantom: "https://vidphantom.com/",
  cinextream: "https://cinextream.cc/",
  vidsrc3: "https://vidsrc3.created.app/",
  hianime: "https://hianime.at/",
};

const PROBE_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-probe every 6h
const CACHE_FILE = "source-health.json";

// Consecutive failures before a source is considered "down". One flaky probe
// during a network hiccup must not get a good source banned.
const FAILURES_BEFORE_DOWN = 2;
// How long a "down" verdict is trusted before we probe again anyway.
const DOWN_TTL_MS = 60 * 60 * 1000;

function cachePath() {
  let dir;
  try {
    dir = require("electron").app.getPath("userData");
  } catch {
    dir = require("os").tmpdir();
  }
  return path.join(dir, CACHE_FILE);
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache), "utf8");
  } catch {
    /* cache is best-effort; never fail a probe because of disk */
  }
}

/**
 * Probe one host.
 * Returns { ok, status, ms, error }. Never throws.
 */
function probeOne(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...result });
    };

    try {
      const req = net.request({
        method: "HEAD",
        url,
        redirect: "follow",
        timeout: PROBE_TIMEOUT_MS,
      });
      req.on("response", (res) => {
        res.on("error", () => done({ ok: false, status: res.statusCode, error: "stream" }));
        res.resume();
        // Any HTTP answer means the host is alive. 4xx/5xx on a bare domain root
        // still proves the host resolves and serves HTTP, which is what we need;
        // per-title availability is the failover cache's job, not this module's.
        done({ ok: true, status: res.statusCode });
      });
      req.on("error", (err) =>
        done({ ok: false, error: err?.code || err?.message || "error" }),
      );
      req.on("timeout", () => {
        req.abort();
        done({ ok: false, error: "timeout" });
      });
      req.end();
    } catch (err) {
      done({ ok: false, error: err?.message || "throw" });
    }
  });
}

function register(getMainWindow) {
  // Returns the cached verdict for every known source without probing.
  ipcMain.handle("source-health-get", () => {
    const cache = readCache();
    const out = {};
    const now = Date.now();
    for (const id of Object.keys(PROBE_TARGETS)) {
      const entry = cache[id];
      if (!entry) {
        out[id] = { status: "unknown" };
        continue;
      }
      const age = now - (entry.ts || 0);
      if (entry.status === "down" && age < DOWN_TTL_MS) {
        out[id] = { ...entry, stale: false };
      } else if (age > CACHE_TTL_MS) {
        // Past TTL: report the last known verdict but flag it so the renderer
        // can schedule a refresh instead of treating it as authoritative.
        out[id] = { ...entry, stale: true };
      } else {
        out[id] = { ...entry, stale: false };
      }
    }
    return out;
  });

  // Probe every source (or a subset) and return the fresh verdict map.
  ipcMain.handle("source-health-check", async (_, ids) => {
    const wanted =
      Array.isArray(ids) && ids.length
        ? ids.filter((id) => PROBE_TARGETS[id])
        : Object.keys(PROBE_TARGETS);

    const cache = readCache();
    const results = await Promise.all(
      wanted.map(async (id) => {
        const r = await probeOne(PROBE_TARGETS[id]);
        const prev = cache[id];
        let status;
        if (r.ok) {
          status = "up";
        } else {
          // Escalate only after repeated failures; a single miss is a blip.
          const fails = (prev?.status === "down" ? prev.fails || 0 : 0) + 1;
          status = fails >= FAILURES_BEFORE_DOWN ? "down" : "flaky";
          cache[id] = {
            ...prev,
            status,
            fails,
            error: r.error,
            ms: r.ms,
          };
        }
        if (r.ok) {
          cache[id] = { status, fails: 0, ms: r.ms, statusCode: r.status, ts: Date.now() };
        } else {
          cache[id].ts = Date.now();
        }
        return id;
      }),
    );
    writeCache(cache);

    const out = {};
    for (const id of results) out[id] = { ...cache[id], stale: false };
    const mw = getMainWindow?.();
    if (mw && !mw.isDestroyed()) mw.webContents.send("source-health-updated", out);
    return out;
  });

  // Called by the renderer when a play attempt visibly fails. Bumps the fail
  // counter immediately so the very next source pick skips a dead host without
  // waiting for a probe round-trip.
  ipcMain.handle("source-health-report-failure", (_, sourceId) => {
    if (!PROBE_TARGETS[sourceId]) return null;
    const cache = readCache();
    const prev = cache[sourceId];
    const fails = (prev?.status === "down" ? prev.fails || 0 : 0) + 1;
    const entry = {
      status: fails >= FAILURES_BEFORE_DOWN ? "down" : "flaky",
      fails,
      ts: Date.now(),
      error: "player-failed",
    };
    cache[sourceId] = entry;
    writeCache(cache);
    return entry;
  });

  // Called when a source successfully paints a frame — resets the fail streak.
  ipcMain.handle("source-health-report-success", (_, sourceId) => {
    if (!PROBE_TARGETS[sourceId]) return null;
    const cache = readCache();
    cache[sourceId] = { status: "up", fails: 0, ts: Date.now() };
    writeCache(cache);
    return cache[sourceId];
  });

  ipcMain.handle("source-health-reset", () => {
    writeCache({});
    return {};
  });

  ipcMain.handle("source-health-targets", () => ({ ...PROBE_TARGETS }));
}

module.exports = { register, PROBE_TARGETS, PROBE_TIMEOUT_MS };