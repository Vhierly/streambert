// ── IPC: Downloads ────────────────────────────────────────────────────────────
// Manages the download queue, downloads via pure-Node HLS downloader, tracks
// progress, and handles all download-related IPC handlers.
const { app, ipcMain, shell, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const {
  download: hlsDownload,
  DownloadError,
} = require("./hlsDownloader");

// ── Download store ────────────────────────────────────────────────────────────

let downloads = [];
let _downloadsFile = null;
const downloadsFile = () =>
  _downloadsFile ||
  (_downloadsFile = path.join(app.getPath("userData"), "downloads.json"));

// Track running downloads by id → AbortController
const activeAborts = new Map();

let _getMainWindow = () => null;

function sendProgress(update) {
  const mw = _getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send("download-progress", update);
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes > 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}

function loadDownloads() {
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
    const toSave = downloads.filter(
      (d) => d.status !== "downloading",
    );
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
  for (const [id, ac] of activeAborts.entries()) {
    try {
      ac.abort();
    } catch {}
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx !== -1) {
      downloads[idx].status = "error";
      downloads[idx].lastMessage = "Cancelled on exit";
    }
    activeAborts.delete(id);
  }
  const folders = new Set(downloads.map((d) => d.downloadPath).filter(Boolean));
  for (const folder of folders) cleanupTempFiles(folder);
  saveDownloads();
}

// ── Subtitle file downloader (used during run-download completion) ─────────────

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

// ── IPC registration ──────────────────────────────────────────────────────────

function register(getMainWindow) {
  _getMainWindow = getMainWindow;

  // ── start download ────────────────────────────────────────────────────────
  ipcMain.handle(
    "run-download",
    (
      _,
      {
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
      },
    ) => {
      try {
        const id = crypto.randomUUID();

        const entry = {
          id,
          name,
          m3u8Url,
          downloadPath,
          filePath: null,
          status: "downloading",
          progress: 0,

          size: "",
          totalFragments: 0,
          completedFragments: 0,
          lastMessage: "Starting…",
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
          logPath: null,
        };

        downloads.push(entry);

        const isSameMedia = (d) =>
          d.id !== id &&
          d.tmdbId &&
          d.tmdbId === entry.tmdbId &&
          d.mediaType === entry.mediaType &&
          String(d.season ?? "") === String(entry.season ?? "") &&
          String(d.episode ?? "") === String(entry.episode ?? "");
        downloads = downloads.filter((d) => !isSameMedia(d));

        const abortController = new AbortController();
        activeAborts.set(id, abortController);

        const safeName = name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const tempPath = path.join(
          downloadPath,
          `.${safeName || "download"}.${id}.part`,
        );

        const onProgress = (p) => {
          const idx = downloads.findIndex((d) => d.id === id);
          if (idx === -1) return;
          const update = {};
          if (p.total > 0) {
            update.completedFragments = p.completed;
            update.totalFragments = p.total;
            update.progress = Math.min(
              99,
              Math.round((p.completed / p.total) * 100),
            );
            update.lastMessage = `Fragment ${p.completed} / ${p.total}`;
          } else if (p.bytes > 0) {
            const pct = p.percent != null
              ? p.percent
              : (p.totalBytes > 0 ? Math.round((p.bytes / p.totalBytes) * 100) : 0);
            update.progress = Math.min(99, pct);
            update.lastMessage = `Downloading… ${formatBytes(p.bytes)}`;
          }
          if (Object.keys(update).length > 0) {
            downloads[idx] = { ...downloads[idx], ...update };
            sendProgress({ id, ...update, status: downloads[idx].status });
          }
        };

        hlsDownload(m3u8Url, tempPath, onProgress, {
          signal: abortController.signal,
        })
          .then((result) => {
            activeAborts.delete(id);
            const idx = downloads.findIndex((d) => d.id === id);
            if (idx === -1) return;

            downloads[idx].status = "completed";
            downloads[idx].completedAt = Date.now();
            downloads[idx].progress = 100;
            downloads[idx].filePath = result.filePath;
            downloads[idx].size = formatBytes(result.bytes);
            if (result.durationSecs > 0) downloads[idx].durationSecs = result.durationSecs;

            // Rename file to proper media name
            try {
              const ext = result.ext || ".mp4";
              const newName = (safeName || "download") + ext;
              const newPath = path.join(downloadPath, newName);
              if (newPath !== result.filePath) {
                fs.renameSync(result.filePath, newPath);
                downloads[idx].filePath = newPath;
              }
            } catch {}

            // Download subtitle files
            if (
              downloads[idx].subtitles?.length > 0 &&
              downloads[idx].filePath
            ) {
              const videoBase = downloads[idx].filePath.replace(/\.[^.]+$/, "");
              const langCounter = {};
              const KNOWN_SUB_EXTS = [
                ".vtt",
                ".srt",
                ".ass",
                ".ssa",
                ".sub",
                ".idx",
              ];
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
                  const safeLang = (lang || "unknown").replace(
                    /[^a-z0-9_-]/gi,
                    "",
                  );
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
              status: "completed",
              progress: 100,
              filePath: downloads[idx].filePath,
              size: downloads[idx].size,
            });
            saveDownloads();
          })
          .catch((err) => {
            activeAborts.delete(id);
            const idx = downloads.findIndex((d) => d.id === id);
            if (idx === -1) return;

            downloads[idx].status = "error";
            downloads[idx].completedAt = Date.now();

            if (err instanceof DownloadError) {
              const kindLabels = {
                network: "Network error",
                parse: "Parse error",
                write: "Write error",
                cancelled: "Download cancelled",
                unsupported: "Unsupported format",
              };
              downloads[idx].lastMessage = `${kindLabels[err.kind] || "Error"}: ${err.message}`;
            } else {
              downloads[idx].lastMessage = `Download failed: ${err.message || String(err)}`;
            }

            try {
              fs.unlinkSync(tempPath);
            } catch {}

            sendProgress({
              id,
              status: "error",
              lastMessage: downloads[idx].lastMessage,
            });
            saveDownloads();
          });

        return { ok: true, id };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  );

  ipcMain.handle("get-downloads", () => downloads);

  ipcMain.handle("delete-download", (_, { id, filePath }) => {
    try {
      const dlEntry = downloads.find((d) => d.id === id);
      if (activeAborts.has(id)) {
        try {
          activeAborts.get(id).abort();
        } catch {}
        activeAborts.delete(id);
      }
      if (filePath && dlEntry) {
        try {
          const resolvedFp = path.resolve(filePath);
          const resolvedDl = path.resolve(dlEntry.downloadPath || "");
          if (resolvedDl && (resolvedFp === resolvedDl || resolvedFp.startsWith(resolvedDl + path.sep))) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        } catch {}
      }
      const dlDir = dlEntry?.downloadPath ? path.resolve(dlEntry.downloadPath) : null;
      for (const sp of dlEntry?.subtitlePaths || []) {
        try {
          if (!sp?.path) continue;
          const resolvedSp = path.resolve(sp.path);
          // Only delete subtitle files that live inside this download's
          // directory — guards against a tampered store pointing elsewhere.
          if (
            dlDir &&
            (resolvedSp === dlDir || resolvedSp.startsWith(dlDir + path.sep)) &&
            fs.existsSync(resolvedSp)
          ) {
            fs.unlinkSync(resolvedSp);
          }
        } catch {}
      }
      const dlPath = dlEntry?.downloadPath;
      if (dlPath) cleanupTempFiles(dlPath);
      downloads = downloads.filter((d) => d.id !== id);
      saveDownloads();
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
        const dlDir = dl.downloadPath ? path.resolve(dl.downloadPath) : null;
        if (dl.filePath) {
          try {
            const resolvedFp = path.resolve(dl.filePath);
            const allowed =
              !dlDir ||
              resolvedFp === dlDir ||
              resolvedFp.startsWith(dlDir + path.sep);
            if (allowed && fs.existsSync(resolvedFp)) {
              fs.unlinkSync(resolvedFp);
              deleted++;
            }
          } catch {
            errors++;
          }
        }
        for (const sp of dl.subtitlePaths || []) {
          try {
            if (!sp?.path) continue;
            const resolvedSp = path.resolve(sp.path);
            const allowed =
              !dlDir ||
              resolvedSp === dlDir ||
              resolvedSp.startsWith(dlDir + path.sep);
            if (allowed && fs.existsSync(resolvedSp)) fs.unlinkSync(resolvedSp);
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
    if (filePath && typeof filePath === "string" && fs.existsSync(filePath))
      shell.showItemInFolder(filePath);
  });

  ipcMain.handle("file-exists", (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== "string") return false;
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
    if (!filePath || typeof filePath !== "string") return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.openPath(filePath);
      } else {
        shell.showItemInFolder(filePath);
      }
    } catch {}
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

function getDownloadDuration(filePath) {
  const dl = downloads.find((d) => d.filePath === filePath);
  return dl?.durationSecs ?? null;
}

module.exports = {
  register,
  loadDownloads,
  saveDownloads,
  killAllDownloads,
  getDownloads: () => downloads,
  getDownloadDuration,
};
