// ── Sequential Magnet / BitTorrent Instant Streamer (Pure JS) ────────────────
// Streams magnet URIs over a local loopback HTTP 206 Partial Content server
// (`127.0.0.1:<ephemeral>`) so HTML5 <video> and MPV/VLC can play immediately
// without waiting for 100% download completion. Cleans up temp cache on stop.

const { ipcMain } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "wss://tracker.openwebtorrent.com",
];

const VIDEO_EXTS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi",
  ".mov",
  ".ts",
]);

const MIME_BY_EXT = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ts": "video/mp2t",
};

function selectTargetVideoFile(files, { fileIdx = null, season = null, episode = null } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;

  if (
    typeof fileIdx === "number" &&
    fileIdx >= 0 &&
    fileIdx < files.length &&
    VIDEO_EXTS.has(path.extname(files[fileIdx].name).toLowerCase())
  ) {
    return files[fileIdx];
  }

  const videoFiles = files.filter((f) =>
    VIDEO_EXTS.has(path.extname(f.name).toLowerCase()),
  );
  const candidates = videoFiles.length > 0 ? videoFiles : files;

  if (season != null && episode != null) {
    const s = Number(season);
    const e = Number(episode);
    const epRegex = new RegExp(
      `(?:s0*${s}[ ._\\-]*e0*${e}\\b|\\b${s}x0*${e}\\b|[ ._\\-]0*${e}(?:v\\d+)?[ ._\\-\\[\\(])`,
      "i",
    );
    const matched = candidates.filter((f) => epRegex.test(f.path || f.name));
    if (matched.length > 0) {
      return matched.reduce((best, cur) => (cur.length > best.length ? cur : best));
    }
  }

  return candidates.reduce((best, cur) => (cur.length > best.length ? cur : best));
}

function srtTextToVtt(srt) {
  const clean = String(srt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return (
    "WEBVTT\n\n" +
    clean.replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4",
    )
  );
}

let activeSession = null;

function getBaseTempDir() {
  return path.join(os.tmpdir(), "streambert-torrents");
}

function safeRmDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore locked handles on Windows; cleaned on next boot
  }
}

function cleanStaleTempDirs() {
  const base = getBaseTempDir();
  try {
    if (fs.existsSync(base)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

async function stopActiveSession({ keepFiles = false } = {}) {
  const cur = activeSession;
  activeSession = null;
  if (!cur) return;

  await new Promise((resolve) => {
    try {
      if (cur.server) cur.server.close(() => resolve());
      else resolve();
    } catch {
      resolve();
    }
  });

  await new Promise((resolve) => {
    try {
      if (cur.engine) cur.engine.destroy(() => resolve());
      else resolve();
    } catch {
      resolve();
    }
  });

  if (!keepFiles && cur.tmpDir) {
    safeRmDir(cur.tmpDir);
  }
}

function startTorrentSession({ magnet, fileIdx = null, season = null, episode = null }) {
  return new Promise(async (resolve) => {
    if (!magnet || typeof magnet !== "string" || !magnet.startsWith("magnet:?")) {
      resolve({ ok: false, error: "Invalid magnet URI" });
      return;
    }

    let torrentStream;
    try {
      torrentStream = require("torrent-stream");
    } catch {
      resolve({ ok: false, error: "Torrent engine module not installed" });
      return;
    }

    await stopActiveSession({ keepFiles: false });

    const tmpDir = path.join(
      getBaseTempDir(),
      `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      resolve(payload);
    };

    let engine;
    try {
      engine = torrentStream(magnet, {
        tmp: tmpDir,
        path: tmpDir,
        trackers: DEFAULT_TRACKERS,
        dht: true,
        verify: false,
      });
    } catch (err) {
      safeRmDir(tmpDir);
      resolve({ ok: false, error: err.message || "Failed to initialize torrent" });
      return;
    }

    const readyTimer = setTimeout(async () => {
      if (!settled) {
        try {
          engine.destroy();
        } catch {}
        safeRmDir(tmpDir);
        finish({
          ok: false,
          error: "Timed out finding peers (0 active seeders or UDP blocked by network).",
        });
      }
    }, 28000);

    engine.on("error", (err) => {
      if (!settled) {
        finish({ ok: false, error: err?.message || "Torrent stream error" });
      }
    });

    engine.on("ready", () => {
      const target = selectTargetVideoFile(engine.files, { fileIdx, season, episode });
      if (!target) {
        engine.destroy();
        safeRmDir(tmpDir);
        finish({ ok: false, error: "No playable video file found inside torrent" });
        return;
      }

      // Deselect everything first, then select target video + small subtitle files
      const subFiles = [];
      for (const f of engine.files) {
        const ext = path.extname(f.name).toLowerCase();
        if (f === target) {
          f.select();
        } else if ((ext === ".srt" || ext === ".vtt") && f.length < 5 * 1024 * 1024) {
          f.select();
          subFiles.push(f);
        } else {
          f.deselect();
        }
      }

      // Pre-prioritize first 2 MB + last 512 KB (for MP4 moov atom / MKV cues)
      try {
        const headEnd = Math.min(target.length - 1, 2 * 1024 * 1024);
        const headStream = target.createReadStream({ start: 0, end: headEnd });
        headStream.resume();
        setTimeout(() => {
          try {
            headStream.destroy();
          } catch {}
        }, 4000);
      } catch {}

      const ext = path.extname(target.name).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      const safeFileSlug = encodeURIComponent(
        target.name.replace(/[^a-zA-Z0-9._\- ]/g, "_"),
      );

      const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

        // Subtitle endpoint: /sub/0.vtt
        const subMatch = /^\/sub\/(\d+)\.vtt$/i.exec(reqUrl.pathname);
        if (subMatch) {
          const idx = Number(subMatch[1]);
          const subFile = subFiles[idx];
          if (!subFile) {
            res.writeHead(404);
            res.end();
            return;
          }
          const chunks = [];
          const rs = subFile.createReadStream();
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const vtt = subFile.name.toLowerCase().endsWith(".vtt")
              ? raw
              : srtTextToVtt(raw);
            res.writeHead(200, {
              "Content-Type": "text/vtt; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.end(vtt);
          });
          rs.on("error", () => {
            res.writeHead(500);
            res.end();
          });
          return;
        }

        if (!reqUrl.pathname.startsWith("/video")) {
          res.writeHead(404);
          res.end();
          return;
        }

        const total = target.length;
        const range = req.headers.range;

        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end =
            m && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;

          if (start < 0 || start >= total || start > end) {
            res.writeHead(416, { "Content-Range": `bytes */${total}` });
            res.end();
            return;
          }

          res.writeHead(206, {
            "Content-Type": mime,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
          });

          if (req.method === "HEAD") {
            res.end();
            return;
          }

          const stream = target.createReadStream({ start, end });
          req.on("close", () => {
            try {
              stream.destroy();
            } catch {}
          });
          stream.on("error", () => {
            try {
              res.end();
            } catch {}
          });
          stream.pipe(res);
          return;
        }

        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": String(total),
          "Accept-Ranges": "bytes",
        });

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        const stream = target.createReadStream();
        req.on("close", () => {
          try {
            stream.destroy();
          } catch {}
        });
        stream.on("error", () => {
          try {
            res.end();
          } catch {}
        });
        stream.pipe(res);
      });

      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const streamUrl = `http://127.0.0.1:${port}/video/${safeFileSlug}`;
        const subtitles = subFiles.map((sf, i) => ({
          url: `http://127.0.0.1:${port}/sub/${i}.vtt`,
          lang: sf.name.replace(/\.(srt|vtt)$/i, "").slice(-10) || `Sub ${i + 1}`,
        }));

        activeSession = {
          engine,
          server,
          tmpDir,
          target,
          streamUrl,
        };

        finish({
          ok: true,
          streamUrl,
          fileName: target.name,
          fileSize: target.length,
          isMkv: ext === ".mkv" || ext === ".avi",
          subtitles,
        });
      });
    });
  });
}

function getActiveStatus() {
  if (!activeSession || !activeSession.engine) {
    return { active: false };
  }
  const { engine, target, streamUrl } = activeSession;
  const swarm = engine.swarm || {};
  const wires = Array.isArray(swarm.wires) ? swarm.wires : [];
  const activePeers = wires.filter((w) => !w.destroyed).length;
  const downloaded = swarm.downloaded || 0;
  const fileSize = target?.length || 1;
  return {
    active: true,
    streamUrl,
    fileName: target?.name || "",
    fileSize,
    downloaded,
    progressPct: Math.min(100, Math.round((downloaded / fileSize) * 100)),
    downloadSpeed: swarm.downloadSpeed ? swarm.downloadSpeed() : 0,
    uploadSpeed: swarm.uploadSpeed ? swarm.uploadSpeed() : 0,
    numPeers: activePeers,
  };
}

function register() {
  cleanStaleTempDirs();

  ipcMain.handle("start-torrent-stream", async (_, opts = {}) =>
    startTorrentSession(opts),
  );

  ipcMain.handle("get-torrent-status", () => getActiveStatus());

  ipcMain.handle("stop-torrent-stream", async (_, opts = {}) => {
    await stopActiveSession(opts);
    return { ok: true };
  });
}

module.exports = {
  register,
  shutdown: () => stopActiveSession({ keepFiles: false }),
  selectTargetVideoFile,
};
