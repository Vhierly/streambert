// ── Sequential Magnet / BitTorrent Instant Streamer + FFmpeg Audio Remuxer ───
// Streams magnet URIs over a local loopback HTTP 206 Partial Content server
// (`127.0.0.1:<ephemeral>`) AND provides on-the-fly FFmpeg audio transcoding
// (`AC3 / EAC3 / DTS / TrueHD / FLAC 5.1 → Stereo AAC`) with instant HTTP-Range
// seeking so Blu-Ray `.mkv` & `.mp4` torrents always play with full sound.

const { ipcMain } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

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

const BROWSER_SAFE_AUDIO = new Set(["aac", "mp3", "vorbis", "opus"]);
const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text"]);

let cachedFfmpegBin = undefined;

function resolveFfmpegPath() {
  if (cachedFfmpegBin !== undefined) return cachedFfmpegBin;
  try {
    const raw = require("ffmpeg-static");
    if (raw) {
      const unpacked = raw.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      if (fs.existsSync(unpacked)) {
        cachedFfmpegBin = unpacked;
        return cachedFfmpegBin;
      }
      if (fs.existsSync(raw)) {
        cachedFfmpegBin = raw;
        return cachedFfmpegBin;
      }
    }
  } catch {}

  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(cmd, ["ffmpeg"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) {
      cachedFfmpegBin = r.stdout.trim().split(/\r?\n/)[0].trim();
      return cachedFfmpegBin;
    }
  } catch {}

  cachedFfmpegBin = null;
  return null;
}

/**
 * Parse `ffmpeg -i` stderr output into duration, video codec, audio tracks, and text subtitle tracks.
 */
function parseFfmpegProbeOutput(stderrText) {
  const text = String(stderrText || "");
  let durationSec = 0;
  const durMatch = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (durMatch) {
    durationSec =
      Number(durMatch[1]) * 3600 +
      Number(durMatch[2]) * 60 +
      Number(durMatch[3]);
  }

  let videoCodec = "h264";
  const vidMatch = /Stream #0:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Video:\s*([a-zA-Z0-9_]+)/.exec(
    text,
  );
  if (vidMatch) {
    videoCodec = vidMatch[1].toLowerCase();
  }

  const audioTracks = [];
  const audioRegex =
    /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?:\s*Audio:\s*([a-zA-Z0-9_]+)([^\r\n]*)/g;
  let m;
  let aIdx = 0;
  while ((m = audioRegex.exec(text)) !== null) {
    const lang = (m[2] || `Track ${aIdx + 1}`).trim();
    const codec = (m[3] || "unknown").toLowerCase();
    const extra = (m[4] || "").trim();
    const isMultichannel = /\b(5\.1|7\.1|6 channels|8 channels)\b/i.test(extra);
    const needsRemux = !BROWSER_SAFE_AUDIO.has(codec) || isMultichannel;
    audioTracks.push({
      audioIdx: aIdx,
      streamIndex: Number(m[1]),
      lang,
      codec,
      label: `${lang.toUpperCase()} (${codec.toUpperCase()}${isMultichannel ? " 5.1" : ""})`,
      needsRemux,
    });
    aIdx++;
  }

  const embeddedSubs = [];
  const subRegex =
    /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?:\s*Subtitle:\s*([a-zA-Z0-9_]+)([^\r\n]*)/g;
  let sIdx = 0;
  while ((m = subRegex.exec(text)) !== null) {
    const lang = (m[2] || `Sub ${sIdx + 1}`).trim();
    const codec = (m[3] || "").toLowerCase();
    const extra = (m[4] || "").trim();
    if (TEXT_SUB_CODECS.has(codec)) {
      embeddedSubs.push({
        subIdx: sIdx,
        streamIndex: Number(m[1]),
        lang,
        codec,
        label: `Embedded · ${lang.toUpperCase()}${/forced/i.test(extra) ? " (Forced)" : ""}`,
      });
    }
    sIdx++;
  }

  return { durationSec, videoCodec, audioTracks, embeddedSubs };
}

function probeMediaViaFfmpeg(rawUrl, ffmpegBin) {
  return new Promise((resolve) => {
    if (!ffmpegBin) {
      resolve({
        durationSec: 0,
        videoCodec: "h264",
        audioTracks: [],
        embeddedSubs: [],
      });
      return;
    }

    let stderr = "";
    let done = false;
    const proc = spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-analyzeduration",
        "4000000",
        "-probesize",
        "4000000",
        "-i",
        rawUrl,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve(parseFfmpegProbeOutput(stderr));
      }
    }, 9000);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(parseFfmpegProbeOutput(stderr));
      }
    });

    proc.on("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({
          durationSec: 0,
          videoCodec: "h264",
          audioTracks: [],
          embeddedSubs: [],
        });
      }
    });
  });
}

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
  } catch {}
}

function cleanStaleTempDirs() {
  const base = getBaseTempDir();
  try {
    if (fs.existsSync(base)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  } catch {}
}

function killActiveRemuxProcess(session) {
  if (session?.remuxProc) {
    try {
      session.remuxProc.kill("SIGKILL");
    } catch {}
    session.remuxProc = null;
  }
}

async function stopActiveSession({ keepFiles = false } = {}) {
  const cur = activeSession;
  activeSession = null;
  if (!cur) return;

  killActiveRemuxProcess(cur);

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

    const readyTimer = setTimeout(() => {
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

      // Prioritize opening 3 MB + tail 512 KB (for MP4 moov / MKV cues)
      try {
        const headEnd = Math.min(target.length - 1, 3 * 1024 * 1024);
        const hs = target.createReadStream({ start: 0, end: headEnd });
        hs.resume();
        setTimeout(() => {
          try {
            hs.destroy();
          } catch {}
        }, 5000);

        if (target.length > 1024 * 1024) {
          const tailStart = Math.max(0, target.length - 512 * 1024);
          const ts = target.createReadStream({ start: tailStart, end: target.length - 1 });
          ts.resume();
          setTimeout(() => {
            try {
              ts.destroy();
            } catch {}
          }, 5000);
        }
      } catch {}

      const ext = path.extname(target.name).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      const safeFileSlug = encodeURIComponent(
        target.name.replace(/[^a-zA-Z0-9._\- ]/g, "_"),
      );
      const ffmpegBin = resolveFfmpegPath();
      const sessionState = {
        engine,
        server: null,
        tmpDir,
        target,
        streamUrl: "",
        remuxBaseUrl: "",
        remuxProc: null,
        probe: { durationSec: 0, videoCodec: "h264", audioTracks: [], embeddedSubs: [] },
        mkvSubCache: new Map(),
      };

      const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

        // 1. External .srt/.vtt file inside torrent: /sub/:idx.vtt
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

        // 2. Embedded MKV subtitle extraction via FFmpeg: /mkvsub/:streamIndex.vtt
        const mkvSubMatch = /^\/mkvsub\/(\d+)\.vtt$/i.exec(reqUrl.pathname);
        if (mkvSubMatch && ffmpegBin) {
          const streamIndex = Number(mkvSubMatch[1]);
          if (sessionState.mkvSubCache.has(streamIndex)) {
            res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
            res.end(sessionState.mkvSubCache.get(streamIndex));
            return;
          }
          const chunks = [];
          const proc = spawn(
            ffmpegBin,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-i",
              sessionState.streamUrl,
              "-map",
              `0:${streamIndex}`,
              "-f",
              "webvtt",
              "pipe:1",
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
          );
          req.on("close", () => {
            if (!res.writableEnded) {
              try {
                proc.kill("SIGKILL");
              } catch {}
            }
          });
          proc.stdout.on("data", (c) => chunks.push(c));
          proc.on("close", (code) => {
            const out = Buffer.concat(chunks).toString("utf8");
            if (code === 0 && out.includes("WEBVTT")) {
              sessionState.mkvSubCache.set(streamIndex, out);
            }
            if (!res.headersSent) {
              res.writeHead(out ? 200 : 500, {
                "Content-Type": "text/vtt; charset=utf-8",
              });
            }
            res.end(out || "WEBVTT\n\n");
          });
          return;
        }

        // 3. Live FFmpeg Audio-to-AAC Remux endpoint: /remux?start=0&audio=0
        if (reqUrl.pathname === "/remux" && ffmpegBin) {
          killActiveRemuxProcess(sessionState);

          const startSec = Math.max(0, Number(reqUrl.searchParams.get("start") || 0));
          const audioIdx = Math.max(0, Number(reqUrl.searchParams.get("audio") || 0));
          const vCodec = sessionState.probe?.videoCodec || "h264";

          const args = ["-hide_banner", "-loglevel", "error"];
          if (startSec > 0) {
            args.push("-ss", String(startSec));
          }
          args.push(
            "-i",
            sessionState.streamUrl,
            "-map",
            "0:v:0",
            "-map",
            `0:a:${audioIdx}?`,
          );

          if (vCodec === "hevc") {
            args.push("-c:v", "copy", "-tag:v", "hvc1");
          } else if (vCodec === "h264" || vCodec === "vp9" || vCodec === "av1") {
            args.push("-c:v", "copy");
          } else {
            args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "22");
          }

          args.push(
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-b:a",
            "192k",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
          );

          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });

          const proc = spawn(ffmpegBin, args, {
            stdio: ["ignore", "pipe", "ignore"],
          });
          sessionState.remuxProc = proc;

          req.on("close", () => {
            if (sessionState.remuxProc === proc) {
              sessionState.remuxProc = null;
            }
            try {
              proc.kill("SIGKILL");
            } catch {}
          });

          proc.stdout.pipe(res);
          proc.on("error", () => {
            try {
              res.end();
            } catch {}
          });
          return;
        }

        // 4. Raw HTTP 206 Partial Content byte-range endpoint (/video/...)
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

      server.listen(0, "127.0.0.1", async () => {
        const port = server.address().port;
        const streamUrl = `http://127.0.0.1:${port}/video/${safeFileSlug}`;
        const remuxBaseUrl = ffmpegBin ? `http://127.0.0.1:${port}/remux` : null;

        sessionState.server = server;
        sessionState.streamUrl = streamUrl;
        sessionState.remuxBaseUrl = remuxBaseUrl;
        activeSession = sessionState;

        // Probe codec & tracks so we automatically remux AC3/EAC3/DTS/MKV audio to Stereo AAC!
        const probe = await probeMediaViaFfmpeg(streamUrl, ffmpegBin);
        sessionState.probe = probe;

        const folderSubs = subFiles.map((sf, i) => ({
          url: `http://127.0.0.1:${port}/sub/${i}.vtt`,
          lang: sf.name.replace(/\.(srt|vtt)$/i, "").slice(-14) || `Torrent Sub ${i + 1}`,
          label: `Torrent · ${sf.name}`,
        }));

        const mkvSubs = (probe.embeddedSubs || []).map((es) => ({
          url: `http://127.0.0.1:${port}/mkvsub/${es.streamIndex}.vtt`,
          lang: es.lang,
          label: es.label,
        }));

        const firstAudioNeedsRemux =
          ext === ".mkv" ||
          ext === ".avi" ||
          probe.audioTracks.length > 1 ||
          probe.audioTracks.some((a) => a.needsRemux);

        finish({
          ok: true,
          streamUrl,
          remuxBaseUrl,
          useRemuxByDefault: !!(remuxBaseUrl && firstAudioNeedsRemux),
          durationSec: probe.durationSec || 0,
          audioTracks: probe.audioTracks || [],
          fileName: target.name,
          fileSize: target.length,
          isMkv: ext === ".mkv" || ext === ".avi",
          subtitles: [...folderSubs, ...mkvSubs],
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
  parseFfmpegProbeOutput,
  resolveFfmpegPath,
};
