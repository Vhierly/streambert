// ── IPC: Downloads ────────────────────────────────────────────────────────────
// Manages the download queue (concurrency cap, pause/resume/retry), spawns
// vid-dl-cli-only or system yt-dlp, tracks progress, and handles download IPC.

const { app, ipcMain, shell, dialog, session } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");

let downloads = [];
let _downloadsFile = null;
const downloadsFile = () =>
  _downloadsFile ||
  (_downloadsFile = path.join(app.getPath("userData"), "downloads.json"));

let _queueCfgFile = null;
const queueCfgFile = () =>
  _queueCfgFile ||
  (_queueCfgFile = path.join(app.getPath("userData"), "downloads-queue.json"));

let maxConcurrent = 2;

function loadQueueConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(queueCfgFile(), "utf8"));
    const n = Number(raw?.maxConcurrent);
    if (n >= 1 && n <= 5) maxConcurrent = Math.floor(n);
  } catch {}
}

function saveQueueConfig() {
  try {
    fs.writeFileSync(
      queueCfgFile(),
      JSON.stringify({ maxConcurrent }, null, 2),
    );
  } catch {}
}

// Track running child processes by download id
const activeProcs = new Map();
// Track intentional pauses so the close handler marks "paused" instead of "error"
const pausedIds = new Set();

// Maps session tokens -> { binaryPath, engine: "vid-dl" | "yt-dlp" }
const trustedBinaryPaths = new Map();

let _getMainWindow = () => null;
let _getStreamMeta = () => null;

function sendProgress(update) {
  const mw = _getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send("download-progress", update);
  }
}

function loadDownloads() {
  loadQueueConfig();
  try {
    const raw = fs.readFileSync(downloadsFile(), "utf8");
    const parsed = JSON.parse(raw);
    const seen = new Map();
    const sorted = [...parsed].sort(
      (a, b) =>
        (b.completedAt || b.startedAt || 0) -
        (a.completedAt || a.startedAt || 0),
    );
    for (const d of sorted) {
      // Any item that was mid-download or queued when the app exited becomes "interrupted"
      if (d.status === "downloading" || d.status === "queued") {
        d.status = "interrupted";
        d.speed = "";
        d.lastMessage = "Interrupted — click Resume to continue";
      }
      const key =
        d.tmdbId && d.mediaType
          ? `${d.tmdbId}|${d.mediaType}|${d.season ?? ""}|${d.episode ?? ""}`
          : d.id;
      if (!seen.has(key)) seen.set(key, d);
    }
    downloads = [...seen.values()];
  } catch {
    downloads = [];
  }
}

function saveDownloads() {
  try {
    // Strip internal runtime fields (_bin, _ffmpegTotalSecs) before persisting
    const toSave = downloads.map(({ _bin, _ffmpegTotalSecs, ...rest }) => rest);
    fs.writeFileSync(downloadsFile(), JSON.stringify(toSave, null, 2));
  } catch {}
}

function cleanupTempFiles(downloadPath) {
  if (!downloadPath) return;
  const TEMP_PATTERNS = [
    /\.part$/,
    /\.part\.\d+$/,
    /\.part\.tmp$/,
    /\.tmp$/,
    /\.ytdl$/,
    /\.part-Frag\d+$/,
  ];
  try {
    const entries = fs.readdirSync(downloadPath);
    for (const entry of entries) {
      if (TEMP_PATTERNS.some((p) => p.test(entry))) {
        try {
          fs.unlinkSync(path.join(downloadPath, entry));
        } catch {}
      }
    }
  } catch {}
}

function killAllDownloads() {
  for (const [id, proc] of activeProcs.entries()) {
    pausedIds.add(id);
    try {
      proc.kill("SIGKILL");
    } catch {}
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx !== -1) {
      downloads[idx].status = "interrupted";
      downloads[idx].speed = "";
      downloads[idx].lastMessage = "Interrupted on exit — click Resume";
    }
    activeProcs.delete(id);
  }
  for (const d of downloads) {
    if (d.status === "queued") {
      d.status = "interrupted";
      d.lastMessage = "Interrupted on exit — click Resume";
    }
  }
  saveDownloads();
}

// ── Downloader binary resolution (vid-dl-cli-only OR yt-dlp) ──────────────────

function findSystemYtDlp() {
  const candidates =
    process.platform === "win32"
      ? ["yt-dlp", "yt-dlp.exe"]
      : process.platform === "darwin"
        ? ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "yt-dlp"]
        : ["/usr/bin/yt-dlp", "/usr/local/bin/yt-dlp", "yt-dlp"];
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    try {
      const r = spawnSync(whichCmd, [c], { encoding: "utf8", timeout: 4000 });
      if (r.status === 0 && r.stdout.trim()) {
        return r.stdout.trim().split(/\r?\n/)[0].trim();
      }
    } catch {}
  }
  return null;
}

function resolveDownloader(folderPath) {
  // 1. Check user-configured folder first (if provided)
  if (folderPath) {
    try {
      const entries = fs.readdirSync(folderPath);
      // Direct yt-dlp binary inside chosen folder
      const ytdlpInFolder = entries.find((e) =>
        /^yt-dlp(\.exe)?$/i.test(e),
      );
      if (ytdlpInFolder) {
        const full = path.join(folderPath, ytdlpInFolder);
        if (fs.statSync(full).isFile()) {
          return {
            exists: true,
            binaryPath: full,
            engine: "yt-dlp",
            label: "yt-dlp (folder)",
          };
        }
      }

      // vid-dl-cli-only structure (_internal + executable)
      if (!entries.includes("_internal")) {
        const sysYt = findSystemYtDlp();
        if (sysYt) {
          return {
            exists: true,
            binaryPath: sysYt,
            engine: "yt-dlp",
            label: "yt-dlp (system PATH)",
          };
        }
        return { exists: false, reason: "no_internal" };
      }

      const binary = entries.find((e) => {
        if (e === "_internal" || e.startsWith(".")) return false;
        try {
          const stat = fs.statSync(path.join(folderPath, e));
          if (!stat.isFile()) return false;
          return process.platform === "win32"
            ? e.endsWith(".exe")
            : !!(stat.mode & 0o111);
        } catch {
          return false;
        }
      });
      if (!binary) return { exists: false, reason: "no_executable" };
      return {
        exists: true,
        binaryPath: path.join(folderPath, binary),
        engine: "vid-dl",
        label: binary,
      };
    } catch (e) {
      const sysYt = findSystemYtDlp();
      if (sysYt) {
        return {
          exists: true,
          binaryPath: sysYt,
          engine: "yt-dlp",
          label: "yt-dlp (system PATH)",
        };
      }
      const reason =
        e.code === "EACCES" ? "folder_permission" : "folder_unreadable";
      return { exists: false, reason };
    }
  }

  // 2. Fallback: auto-detect yt-dlp on system PATH
  const sysYt = findSystemYtDlp();
  if (sysYt) {
    return {
      exists: true,
      binaryPath: sysYt,
      engine: "yt-dlp",
      label: "yt-dlp (system PATH)",
    };
  }
  return { exists: false, reason: "no_folder" };
}

function buildDownloadCliArgs(entry, binInfo) {
  const safeName =
    String(entry.name || "video")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "video";

  if (binInfo.engine === "yt-dlp") {
    const meta = entry.streamHeaders || _getStreamMeta?.(entry.m3u8Url) || {};
    const args = [
      "--newline",
      "--continue",
      "--concurrent-fragments",
      "6",
      "--merge-output-format",
      "mp4",
      "-o",
      path.join(entry.downloadPath, `${safeName}.%(ext)s`),
    ];
    try {
      const { resolveFfmpegPath } = require("./torrentStreamer");
      const ff = resolveFfmpegPath();
      if (ff) args.push("--ffmpeg-location", ff);
    } catch {}
    if (meta.referer) args.push("--referer", meta.referer);
    if (meta.userAgent) args.push("--user-agent", meta.userAgent);
    if (meta.origin) args.push("--add-header", `Origin:${meta.origin}`);
    args.push("--", entry.m3u8Url);
    return args;
  }

  return [
    "--cli",
    entry.m3u8Url,
    "-f",
    "mp4 (with Audio)",
    "-r",
    "best",
    "-b",
    "320",
    "-n",
    entry.name,
    "-d",
    entry.downloadPath,
  ];
}

// ── Subtitle file downloader ──────────────────────────────────────────────────

function downloadSubtitleFile(url, destPath) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "file:") {
        try {
          fs.copyFileSync(decodeURIComponent(parsedUrl.pathname), destPath);
          resolve(true);
        } catch {
          resolve(false);
        }
        return;
      }
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
            Referer: parsedUrl.origin,
            Accept: "*/*",
          },
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const loc = res.headers.location.startsWith("http")
              ? res.headers.location
              : parsedUrl.origin + res.headers.location;
            downloadSubtitleFile(loc, destPath).then(resolve);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve(false);
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(true);
          });
          file.on("error", () => {
            try {
              fs.unlinkSync(destPath);
            } catch {}
            resolve(false);
          });
          res.on("error", () => resolve(false));
        },
      );
      req.on("error", () => resolve(false));
      req.setTimeout(20000, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ── Queue runner & process spawning ───────────────────────────────────────────

function pumpQueue() {
  while (activeProcs.size < maxConcurrent) {
    const nextEntry = downloads.find((d) => d.status === "queued" && d._bin);
    if (!nextEntry) break;
    spawnDownloadEntry(nextEntry);
  }
}

function spawnDownloadEntry(entry) {
  const { id, name, m3u8Url, downloadPath } = entry;
  const binInfo = entry._bin;
  if (!binInfo?.binaryPath) {
    entry.status = "error";
    entry.lastMessage = "Downloader binary not configured";
    sendProgress({
      id,
      status: "error",
      lastMessage: entry.lastMessage,
    });
    saveDownloads();
    return;
  }

  const logPath =
    entry.logPath || path.join(os.tmpdir(), `streambert_dl_${id}.log`);
  entry.logPath = logPath;
  entry.status = "downloading";
  entry.lastMessage = "Starting…";
  pausedIds.delete(id);

  sendProgress({
    id,
    name: entry.name,
    status: "downloading",
    progress: entry.progress || 0,
    lastMessage: "Starting…",
  });

  try {
    fs.appendFileSync(
      logPath,
      `\nStreambert Download (${binInfo.engine})\nName: ${name}\nURL: ${m3u8Url}\nStarted: ${new Date().toISOString()}\n${"─".repeat(60)}\n`,
      "utf8",
    );
  } catch {}

  const args = buildDownloadCliArgs(entry, binInfo);
  const proc = spawn(binInfo.binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeProcs.set(id, proc);

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) return;

    const update = {};

    const fragMatch = trimmed.match(/\(frag\s+(\d+)\/(\d+)\)/);
    if (fragMatch) {
      const currentFrag = parseInt(fragMatch[1], 10);
      const total = parseInt(fragMatch[2], 10);
      update.completedFragments = currentFrag;
      update.totalFragments = total;
      update.progress = Math.min(99, Math.round((currentFrag / total) * 100));
      update.lastMessage = `Fragment ${currentFrag} / ${total}`;
    }

    if (!fragMatch && !downloads[idx].totalFragments) {
      const dlPctMatch = trimmed.match(
        /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))/i,
      );
      if (dlPctMatch) {
        const pct = parseFloat(dlPctMatch[1]);
        update.progress = Math.min(99, Math.round(pct));
        update.size = dlPctMatch[2].trim();
        const spMatch = trimmed.match(/\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i);
        if (spMatch) update.speed = spMatch[1].trim();
        update.lastMessage = `${Math.round(pct)}% of ${update.size}`;
      }
    }

    const durationMatch = trimmed.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (durationMatch) {
      const totalSecs =
        parseInt(durationMatch[1], 10) * 3600 +
        parseInt(durationMatch[2], 10) * 60 +
        parseFloat(durationMatch[3]);
      if (totalSecs > 0) downloads[idx]._ffmpegTotalSecs = totalSecs;
      return;
    }

    const ffmpegMatch = trimmed.match(
      /size=\s*([\d.]+\s*\w+)\s+time=(\d+):(\d+):([\d.]+)/i,
    );
    if (ffmpegMatch) {
      const elapsedSecs =
        parseInt(ffmpegMatch[2], 10) * 3600 +
        parseInt(ffmpegMatch[3], 10) * 60 +
        parseFloat(ffmpegMatch[4]);
      const totalSecs = downloads[idx]._ffmpegTotalSecs || 0;
      if (totalSecs > 0) {
        update.progress = Math.min(
          99,
          Math.round((elapsedSecs / totalSecs) * 100),
        );
      }
      const rawSize = ffmpegMatch[1].trim();
      const kbMatch = rawSize.match(/([\d.]+)\s*kB/i);
      if (kbMatch) {
        const mb = parseFloat(kbMatch[1]) / 1024;
        update.size =
          mb >= 1024
            ? `${(mb / 1024).toFixed(1)} GiB`
            : `${mb.toFixed(1)} MiB`;
      } else {
        update.size = rawSize;
      }
      const speedXMatch = trimmed.match(/speed=\s*([\d.]+)x/i);
      if (speedXMatch) update.speed = `${speedXMatch[1]}x`;
      update.lastMessage = `Processing… ${update.size}${update.speed ? ` at ${update.speed}` : ""}`;
    }

    const retryMatch =
      trimmed.match(/Retrying\s+\(\d+\/\d+\)/i) ||
      trimmed.match(/Got error:.*timed?\s*out/i) ||
      trimmed.match(/Read timed? out/i);
    if (retryMatch) {
      update.speed = "0 MB/s";
      const retryNumMatch = trimmed.match(/Retrying\s+\((\d+)\/(\d+)\)/i);
      update.lastMessage = retryNumMatch
        ? `Retrying… (${retryNumMatch[1]}/${retryNumMatch[2]})`
        : "Retrying…";
      downloads[idx] = { ...downloads[idx], ...update };
      sendProgress({ id, ...update, status: downloads[idx].status });
      return;
    }

    const speedMatch = trimmed.match(/\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i);
    if (speedMatch) update.speed = speedMatch[1].trim();

    const sizeMatch = trimmed.match(
      /\bof\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))\b/i,
    );
    if (sizeMatch) update.size = sizeMatch[1].trim();

    const fragTotalMatch = trimmed.match(/Total fragments:\s+(\d+)/);
    if (fragTotalMatch) {
      const total = parseInt(fragTotalMatch[1], 10);
      const u = {
        totalFragments: total,
        completedFragments: 0,
        lastMessage: `HLS: ${total} fragments`,
      };
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const destMatch = trimmed.match(/^\[download\] Destination:\s+(.+)/);
    if (destMatch) {
      const u = {
        filePath: destMatch[1].trim(),
        lastMessage: "Downloading…",
      };
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const mergeMatch = trimmed.match(/\[Merger\] Merging formats into "(.+)"/);
    if (mergeMatch) {
      const u = {
        filePath: mergeMatch[1].trim(),
        lastMessage: "Merging…",
        progress: 99,
      };
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const SUPPRESS_PATTERNS = [
      /Sleeping\s+[\d.]+\s+seconds/i,
      /^\[yt-dlp\s+DEBUG\]/i,
      /^\[debug\]/i,
    ];
    if (Object.keys(update).length === 0) {
      const suppress =
        downloads[idx].lastMessage.startsWith("Fragment") ||
        downloads[idx].lastMessage.startsWith("Retrying") ||
        SUPPRESS_PATTERNS.some((p) => p.test(trimmed));
      if (!suppress) update.lastMessage = trimmed;
    }

    if (Object.keys(update).length > 0) {
      downloads[idx] = { ...downloads[idx], ...update };
      sendProgress({ id, ...update, status: downloads[idx].status });
    }
  };

  let buf = "";
  let stderrBuf = "";

  const appendLog = (line) => {
    try {
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {}
  };

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r\n|\r|\n/);
    buf = lines.pop();
    lines.forEach((l) => {
      appendLog(l);
      handleLine(l);
    });
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    text.split(/\r\n|\r|\n/).forEach((l) => {
      appendLog(l);
      handleLine(l);
    });
  });

  proc.on("error", (err) => {
    activeProcs.delete(id);
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx !== -1) {
      const msg =
        err.code === "EACCES"
          ? `Permission denied: ${binInfo.binaryPath}`
          : err.code === "ENOENT"
            ? `Binary not found: ${binInfo.binaryPath}`
            : `Failed to start downloader: ${err.message}`;
      downloads[idx].status = "error";
      downloads[idx].completedAt = Date.now();
      downloads[idx].lastMessage = msg;
      appendLog(msg);
      sendProgress({ id, status: "error", lastMessage: msg });
      saveDownloads();
    }
    pumpQueue();
  });

  proc.on("close", (code) => {
    activeProcs.delete(id);
    if (buf.trim()) {
      appendLog(buf.trim());
      handleLine(buf.trim());
    }
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) {
      pumpQueue();
      return;
    }

    // Intentional pause: preserve partial fragments & paused status
    if (pausedIds.has(id)) {
      pausedIds.delete(id);
      if (downloads[idx].status !== "interrupted") {
        downloads[idx].status = "paused";
        downloads[idx].speed = "";
        downloads[idx].lastMessage = "Paused";
        sendProgress({
          id,
          status: "paused",
          speed: "",
          lastMessage: "Paused",
          progress: downloads[idx].progress,
        });
      }
      saveDownloads();
      pumpQueue();
      return;
    }

    const status = code === 0 ? "completed" : "error";
    downloads[idx].status = status;
    downloads[idx].completedAt = Date.now();
    if (code === 0) {
      downloads[idx].progress = 100;
      downloads[idx].speed = "";
      downloads[idx].logPath = null;
      try {
        fs.unlinkSync(logPath);
      } catch {}
    } else {
      try {
        fs.appendFileSync(
          logPath,
          `${"─".repeat(60)}\nFailed: exit code ${code}\nFinished: ${new Date().toISOString()}\n`,
          "utf8",
        );
      } catch {}
      const errorLine =
        stderrBuf
          .split(/\r\n|\r|\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .reverse()
          .find((l) => /error|failed|unable|cannot|denied/i.test(l)) || "";
      const prev = downloads[idx].lastMessage || "";
      const base = errorLine || prev;
      downloads[idx].lastMessage = base
        ? `${base} (exit ${code})`
        : `Download failed (exit code ${code})`;
    }

    if (code === 0 && !downloads[idx].filePath) {
      try {
        const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".avi", ".ts", ".m4v"];
        const match = fs
          .readdirSync(downloadPath)
          .filter((f) => VIDEO_EXTS.some((e) => f.toLowerCase().endsWith(e)))
          .map((f) => ({
            f,
            mtime: fs.statSync(path.join(downloadPath, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (match) downloads[idx].filePath = path.join(downloadPath, match.f);
      } catch {}
    }

    if (code === 0 && downloads[idx].filePath) {
      try {
        const ext = path.extname(downloads[idx].filePath) || ".mp4";
        const safeName = name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (safeName) {
          const newPath = path.join(downloadPath, safeName + ext);
          if (newPath !== downloads[idx].filePath) {
            fs.renameSync(downloads[idx].filePath, newPath);
            downloads[idx].filePath = newPath;
          }
        }
      } catch {}
    }

    if (downloads[idx].filePath) {
      try {
        const bytes = fs.statSync(downloads[idx].filePath).size;
        downloads[idx].size =
          bytes > 1e9
            ? (bytes / 1e9).toFixed(2) + " GB"
            : bytes > 1e6
              ? (bytes / 1e6).toFixed(1) + " MB"
              : bytes > 1e3
                ? (bytes / 1e3).toFixed(1) + " KB"
                : bytes + " B";
      } catch {}
    }

    if (
      code === 0 &&
      downloads[idx].subtitles?.length > 0 &&
      downloads[idx].filePath
    ) {
      const videoBase = downloads[idx].filePath.replace(/\.[^.]+$/, "");
      const langCounter = {};
      const KNOWN_SUB_EXTS = [".vtt", ".srt", ".ass", ".ssa", ".sub", ".idx"];
      const subPromises = downloads[idx].subtitles.map(
        ({ url, lang, name: subName, file_id }) => {
          const urlClean = url.split("?")[0].split("#")[0];
          const urlExt = path
            .extname(urlClean)
            .toLowerCase()
            .replace(/[^a-z0-9.]/g, "");
          const nameExt = subName
            ? path
                .extname(subName)
                .toLowerCase()
                .replace(/[^a-z0-9.]/g, "")
            : "";
          const subExt = KNOWN_SUB_EXTS.includes(urlExt)
            ? urlExt
            : KNOWN_SUB_EXTS.includes(nameExt)
              ? nameExt
              : ".srt";
          const safeLang = (lang || "unknown").replace(/[^a-z0-9_-]/gi, "");
          const lIdx = langCounter[safeLang] ?? 0;
          langCounter[safeLang] = lIdx + 1;
          const suffix = lIdx > 0 ? `.${lIdx}` : "";
          const subDestPath = `${videoBase}.${safeLang}${suffix}${subExt}`;
          return downloadSubtitleFile(url, subDestPath).then((ok) =>
            ok
              ? {
                  lang: lang || "unknown",
                  path: subDestPath,
                  file_id: file_id || null,
                }
              : null,
          );
        },
      );
      Promise.all(subPromises).then((results) => {
        const i2 = downloads.findIndex((d) => d.id === id);
        if (i2 !== -1) {
          downloads[i2].subtitlePaths = results.filter(Boolean);
          saveDownloads();
          sendProgress({
            id,
            subtitlePaths: downloads[i2].subtitlePaths,
          });
        }
      });
    }

    sendProgress({
      id,
      name,
      status: downloads[idx].status,
      progress: downloads[idx].progress,
      completedAt: downloads[idx].completedAt,
      filePath: downloads[idx].filePath,
      size: downloads[idx].size,
      completedFragments: downloads[idx].completedFragments,
      totalFragments: downloads[idx].totalFragments,
      lastMessage: downloads[idx].lastMessage,
      logPath: downloads[idx].logPath,
    });
    saveDownloads();
    pumpQueue();
  });
}

// ── IPC registration ──────────────────────────────────────────────────────────

function register(getMainWindow, getStreamMeta = null) {
  _getMainWindow = getMainWindow;
  if (typeof getStreamMeta === "function") _getStreamMeta = getStreamMeta;

  ipcMain.handle("check-downloader", (_, folderPath) => {
    const resolved = resolveDownloader(folderPath);
    if (!resolved.exists) return resolved;
    const token = crypto.randomUUID();
    trustedBinaryPaths.set(token, {
      binaryPath: resolved.binaryPath,
      engine: resolved.engine,
    });
    return {
      exists: true,
      token,
      engine: resolved.engine,
      label: resolved.label,
    };
  });

  ipcMain.handle("get-download-concurrency", () => maxConcurrent);

  ipcMain.handle("set-download-concurrency", (_, value) => {
    const n = Math.max(1, Math.min(5, Math.floor(Number(value) || 2)));
    maxConcurrent = n;
    saveQueueConfig();
    pumpQueue();
    return { ok: true, maxConcurrent };
  });

  ipcMain.handle(
    "run-download",
    (
      _,
      {
        token,
        m3u8Url,
        name,
        downloadPath,
        mediaId,
        mediaType,
        season,
        episode,
        posterPath,
        tmdbId,
        subtitles,
        streamHeaders,
      },
    ) => {
      try {
        let binInfo = token ? trustedBinaryPaths.get(token) : null;
        if (!binInfo) {
          const fallback = resolveDownloader("");
          if (fallback.exists) {
            binInfo = {
              binaryPath: fallback.binaryPath,
              engine: fallback.engine,
            };
          }
        }
        if (!binInfo) {
          return { ok: false, error: "Invalid or unknown downloader token" };
        }

        const id = crypto.randomUUID();
        const capturedMeta =
          streamHeaders || _getStreamMeta?.(m3u8Url) || null;
        const shouldQueue = activeProcs.size >= maxConcurrent;

        const entry = {
          id,
          name,
          m3u8Url,
          downloadPath,
          filePath: null,
          status: shouldQueue ? "queued" : "downloading",
          progress: 0,
          speed: "",
          size: "",
          totalFragments: 0,
          completedFragments: 0,
          lastMessage: shouldQueue
            ? "Queued — waiting for slot"
            : "Starting…",
          startedAt: Date.now(),
          completedAt: null,
          mediaId: mediaId || null,
          mediaType: mediaType || null,
          season: season || null,
          episode: episode || null,
          posterPath: posterPath || null,
          tmdbId: tmdbId || mediaId || null,
          subtitles: Array.isArray(subtitles) ? subtitles : [],
          subtitlePaths: [],
          streamHeaders: capturedMeta,
          engine: binInfo.engine,
          logPath: null,
          _bin: binInfo,
        };

        const isSameMedia = (d) =>
          d.id !== id &&
          d.tmdbId &&
          d.tmdbId === entry.tmdbId &&
          d.mediaType === entry.mediaType &&
          String(d.season ?? "") === String(entry.season ?? "") &&
          String(d.episode ?? "") === String(entry.episode ?? "");
        downloads = downloads.filter((d) => !isSameMedia(d));
        downloads.push(entry);
        saveDownloads();

        if (!shouldQueue) {
          spawnDownloadEntry(entry);
        }

        return { ok: true, id, status: entry.status };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  );

  ipcMain.handle("pause-download", (_, { id }) => {
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) return { ok: false, error: "Download not found" };

    if (downloads[idx].status === "queued") {
      downloads[idx].status = "paused";
      downloads[idx].lastMessage = "Paused";
      saveDownloads();
      sendProgress({ id, status: "paused", lastMessage: "Paused" });
      return { ok: true };
    }

    const proc = activeProcs.get(id);
    if (proc) {
      pausedIds.add(id);
      try {
        proc.kill("SIGKILL");
      } catch {}
      activeProcs.delete(id);
    }
    downloads[idx].status = "paused";
    downloads[idx].speed = "";
    downloads[idx].lastMessage = "Paused";
    saveDownloads();
    sendProgress({ id, status: "paused", speed: "", lastMessage: "Paused" });
    pumpQueue();
    return { ok: true };
  });

  ipcMain.handle("resume-download", (_, { id, folderPath } = {}) => {
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) return { ok: false, error: "Download not found" };
    const entry = downloads[idx];
    if (!entry.m3u8Url || !entry.downloadPath) {
      return { ok: false, error: "Missing stream URL or download folder" };
    }
    if (!entry._bin) {
      const resolved = resolveDownloader(folderPath || "");
      if (!resolved.exists) {
        return {
          ok: false,
          error:
            "Downloader binary not found. Configure downloader folder or install yt-dlp.",
        };
      }
      entry._bin = {
        binaryPath: resolved.binaryPath,
        engine: resolved.engine,
      };
    }

    entry.status = "queued";
    entry.lastMessage = "Queued — waiting for slot";
    saveDownloads();
    sendProgress({
      id,
      status: "queued",
      lastMessage: entry.lastMessage,
    });
    pumpQueue();
    return { ok: true };
  });

  ipcMain.handle("get-downloads", () =>
    downloads.map(({ _bin, _ffmpegTotalSecs, ...rest }) => rest),
  );

  ipcMain.handle("delete-download", (_, { id, filePath }) => {
    try {
      const dlEntry = downloads.find((d) => d.id === id);
      if (activeProcs.has(id)) {
        pausedIds.delete(id);
        try {
          activeProcs.get(id).kill("SIGKILL");
        } catch {}
        activeProcs.delete(id);
      }
      if (filePath) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }
      for (const sp of dlEntry?.subtitlePaths || []) {
        try {
          if (sp?.path && fs.existsSync(sp.path)) fs.unlinkSync(sp.path);
        } catch {}
      }
      const dlPath = dlEntry?.downloadPath;
      if (dlPath && activeProcs.size === 0) cleanupTempFiles(dlPath);
      downloads = downloads.filter((d) => d.id !== id);
      saveDownloads();
      pumpQueue();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("delete-all-downloads", async () => {
    try {
      let deleted = 0,
        errors = 0;
      for (const dl of downloads) {
        if (dl.filePath) {
          try {
            if (fs.existsSync(dl.filePath)) {
              fs.unlinkSync(dl.filePath);
              deleted++;
            }
          } catch {
            errors++;
          }
        }
        for (const sp of dl.subtitlePaths || []) {
          try {
            if (sp?.path && fs.existsSync(sp.path)) fs.unlinkSync(sp.path);
          } catch {}
        }
      }
      downloads = [];
      saveDownloads();
      return { ok: true, deleted, errors };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("get-downloads-size", async () => {
    let bytes = 0;
    await Promise.all(
      downloads.map(async (dl) => {
        if (!dl.filePath) return;
        try {
          const stat = await fs.promises.stat(dl.filePath);
          if (stat.isFile()) bytes += stat.size;
        } catch {}
      }),
    );
    return { bytes };
  });

  ipcMain.handle("show-in-folder", (_, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(path.dirname(filePath || ""));
  });

  ipcMain.handle("file-exists", (_, filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  });

  ipcMain.handle("pick-folder", async () => {
    const mw = getMainWindow();
    if (!mw) return null;
    const result = await dialog.showOpenDialog(mw, {
      properties: ["openDirectory"],
      title: "Select Folder",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("open-external", (_, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {}
  });

  ipcMain.handle("open-path", (_, filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.openPath(filePath);
      } else {
        shell.showItemInFolder(filePath);
      }
    } catch {
      shell.openPath(filePath);
    }
  });

  ipcMain.handle("get-install-path", () => {
    if (process.env.APPIMAGE) {
      return path.dirname(process.env.APPIMAGE);
    }
    if (app.isPackaged) {
      return path.dirname(process.execPath);
    }
    return app.getAppPath();
  });

  ipcMain.handle("scan-directory", (_, folderPath) => {
    try {
      if (!folderPath || !fs.existsSync(folderPath)) return [];
      const VIDEO_EXTS = [
        ".mp4",
        ".mkv",
        ".webm",
        ".avi",
        ".mov",
        ".m4v",
        ".ts",
      ];
      const results = [];
      const scanDir = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTS.includes(ext)) {
              let size = "";
              try {
                const bytes = fs.statSync(fullPath).size;
                size =
                  bytes > 1e9
                    ? (bytes / 1e9).toFixed(2) + " GB"
                    : bytes > 1e6
                      ? (bytes / 1e6).toFixed(1) + " MB"
                      : bytes > 1e3
                        ? (bytes / 1e3).toFixed(1) + " KB"
                        : bytes + " B";
              } catch {}
              results.push({
                filePath: fullPath,
                name: path.basename(entry.name, ext),
                size,
                ext,
              });
            }
          }
        }
      };
      scanDir(folderPath);
      return results;
    } catch {
      return [];
    }
  });

  ipcMain.handle("clear-app-cache", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      await Promise.all(sessions.map((s) => s.clearCache()));
      await Promise.all(
        sessions.map((s) =>
          s.clearStorageData({
            storages: ["shadercache", "serviceworkers", "cachestorage"],
          }),
        ),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("clear-watch-data", async () => {
    try {
      const vs = session.fromPartition("persist:player");
      await vs.clearStorageData();
      await vs.clearCache();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("get-cache-size", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      const sizes = await Promise.all(sessions.map((s) => s.getCacheSize()));
      return { bytes: sizes.reduce((a, b) => a + b, 0) };
    } catch {
      return { bytes: 0 };
    }
  });

  ipcMain.handle("reset-app", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      await Promise.all(sessions.map((s) => s.clearStorageData()));
      await Promise.all(sessions.map((s) => s.clearCache()));
      const dlFile = downloadsFile();
      if (fs.existsSync(dlFile)) fs.unlinkSync(dlFile);
      downloads = [];
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  loadDownloads,
  saveDownloads,
  killAllDownloads,
  getDownloads: () => downloads,
};
