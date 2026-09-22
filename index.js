// -- Streambert main process entry point ---------------------------------------
// Responsible for: window creation, session setup, ad-blocking, scheduled
// backup trigger, and app lifecycle. All heavy IPC logic lives in src/ipc/.

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  webContents,
  Notification,
} = require("electron");
const path = require("path");

// -- RAM / performance flags ---------------------------------------------------
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=256 --expose-gc",
);
app.commandLine.appendSwitch(
  "disable-features",
  "HardwareMediaKeyHandling,MediaSessionService,UseSandboxedXdgPortal",
);
// Run the network stack in the browser process → one less utility process
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
// NOTE: enable-low-end-device-mode removed, it cuts the GPU texture tile budget
// and causes visible seams/stripes/dots on large images.

// Cap disk cache and limit renderer processes (prevents RAM growth on multi-page navigation)
app.commandLine.appendSwitch("disk-cache-size", String(80 * 1024 * 1024));
app.commandLine.appendSwitch("renderer-process-limit", "3");

// -- Startup benchmark ---------------------------------------------------------
const _t0 = Date.now();
const _bench = (label) =>
  console.log(`[boot] ${label}: +${Date.now() - _t0}ms`);

// -- Sub-modules ---------------------------------------------------------------
const blockStats = require("./src/ipc/blockStats");
const storageIpc = require("./src/ipc/storage");
const downloadsIpc = require("./src/ipc/downloads");
const subtitlesIpc = require("./src/ipc/subtitles");
const allmangaIpc = require("./src/ipc/allmanga");
const playerIpc = require("./src/ipc/player");
const discordRpc = require("./src/ipc/discordRpc");

// -- Ad/tracker block list -----------------------------------------------------
const BLOCKED_HOSTS = [
  "*://www.google-analytics.com/*",
  "*://analytics.google.com/*",
  "*://googletagmanager.com/*",
  "*://www.googletagmanager.com/*",
  "*://googletagservices.com/*",
  "*://doubleclick.net/*",
  "*://*.doubleclick.net/*",
  "*://adservice.google.com/*",
  "*://adservice.google.de/*",
  "*://pagead2.googlesyndication.com/*",
  "*://stats.g.doubleclick.net/*",
  "*://yt3.ggpht.com/ytc/*",
  "*://fonts.googleapis.com/*",
  "*://fonts.gstatic.com/*",
  "*://googleapis.com/*",
  "*://gstatic.com/*",
  "*://cdn.adx1.com/*",
  "*://intelligenceadx.com/*",
  "*://adsco.re/*",
  "*://mc.yandex.com/*",
  "*://mc.yandex.ru/*",
  "*://bvtpk.com/*",
  "*://my.rtmark.net/*",
  "*://bvtpk.com/*",
  "*://b7510.com/*",
  "*://gt.unbrownunflat.com/*",
  "*://im.malocacomals.com/*",
  // NOTE: users.videasy.net removed — required for Videasy player auth/embed
  "*://nf.sixmossin.com/*",
  "*://realizationnewestfangs.com/*",
  "*://acscdn.com/*",
  "*://lt.taloseempest.com/*",
  "*://pl26708123.profitableratecpm.com/*",
  "*://preferencenail.com/*",
  "*://protrafficinspector.com/*",
  "*://s10.histats.com/*",
  "*://weirdopt.com/*",
  "*://static.cloudflareinsights.com/*",
  "*://kettledroopingcontinuation.com/*",
  "*://wayfarerorthodox.com/*",
  "*://woxaglasuy.net/*",
  "*://adeptspiritual.com/*",
  "*://www.calculating-laugh.com/*",
  "*://amavhxdlofklxjg.xyz/*",
  "*://7jtjubf8p5kq7x3z2.u3qleufcm6vure326ktfpbj.cfd/*",
  "*://5mq.get64t9vqg8pnbex1y463o.rest/*",
  "*://usrpubtrk.com/*",
  "*://adexchangeclear.com/*",
  "*://rzjzjnavztycv.online/*",
  "*://tmstr4.cloudnestra.com/*",
  "*://tmstr4.neonhorizonworkshops.com/*",
];

// -- Module-level state --------------------------------------------------------
let mainWindow = null;
const getMainWindow = () => mainWindow;

const playerWcIds = new Set();
let sessionsConfigured = false;

function setupSession(playerSession, trailerSession) {
  const stripHeaders = (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-frame-options" || lower === "content-security-policy")
        delete headers[key];
    }
    callback({ responseHeaders: headers });
  };

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  playerSession.setUserAgent(UA);
  trailerSession.setUserAgent(UA);

  playerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );
  trailerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );

  // Trailer: block ads only (no media intercept needed)
  trailerSession.webRequest.onBeforeRequest({ urls: BLOCKED_HOSTS }, (_, cb) =>
    cb({ cancel: true }),
  );

  // Player session: block ads + intercept m3u8/vtt URLs for renderer
  const MEDIA_URLS = [
    "*://*/*.m3u8*",
    "*://*/*.m3u8",
    "*://*/*.vtt*",
    "*://*/*.vtt",
  ];
  playerSession.webRequest.onBeforeRequest(
    { urls: [...BLOCKED_HOSTS, ...MEDIA_URLS] },
    (details, callback) => {
      const { url } = details;
      const isMedia = url.includes(".m3u8") || url.includes(".vtt");
      if (!isMedia) {
        blockStats.recordBlockedRequest(url);
        callback({ cancel: true });
        return;
      }
      // Media URL: check if it also happens to be on a blocked domain
      try {
        const host = new URL(url).hostname;
        const blocked = BLOCKED_HOSTS.some((pat) => {
          const hostPat = pat.replace(/^\*:\/\//, "").split("/")[0];
          return hostPat.startsWith("*.")
            ? host.endsWith(hostPat.slice(1))
            : host === hostPat || host === hostPat.replace(/^\*\./, "");
        });
        if (blocked) {
          blockStats.recordBlockedRequest(url);
          callback({ cancel: true });
          return;
        }
      } catch {}
      // Pass through + notify renderer
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        if (url.includes(".m3u8")) {
          mw.webContents.send("m3u8-found", url);
        } else if (url.includes(".vtt")) {
          const { extractSubtitleLang } = require("./src/ipc/subtitles");
          mw.webContents.send("subtitle-found", {
            url,
            lang: extractSubtitleLang(url),
          });
        }
      }
      callback({});
    },
  );

  // YouTube consent cookie → suppress consent gate in both sessions
  const ytCookie = {
    url: "https://www.youtube.com",
    name: "SOCS",
    value: "CAI",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 2,
  };
  for (const domain of [".youtube.com", ".youtube-nocookie.com"]) {
    const cookie = { ...ytCookie, domain };
    trailerSession.cookies.set(cookie).catch(() => {});
    playerSession.cookies.set(cookie).catch(() => {});
  }
}

function createWindow() {
  storageIpc.applySecretMigrationIfNeeded();
  downloadsIpc.loadDownloads();
  blockStats.loadBlockStats();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    icon:
      process.platform === "linux"
        ? path.join(__dirname, "public/sized/256x256.png")
        : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: true,
      spellcheck: false,
      // Caps the renderer's V8 heap + exposes gc() for manual GC hints after navigation
      additionalArguments: ["--js-flags=--max-old-space-size=256 --expose-gc"],
    },
  });

  // Force long-lived disk caching for TMDB images in the default session.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["*://image.tmdb.org/*"] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers["cache-control"] = ["public, max-age=604800, immutable"]; // 7 days
      delete headers["pragma"];
      delete headers["expires"];
      callback({ responseHeaders: headers });
    },
  );

  // -- Lazy session setup ----------------------------------------------------
  // Player/trailer sessions are configured on the first webview attach or
  // when the pop-out window opens, whichever comes first.

  // Block popups from webviews, intercept fullscreen, lazy-init sessions
  mainWindow.webContents.on("did-attach-webview", (_, wc) => {
    if (!sessionsConfigured) {
      sessionsConfigured = true;
      const playerSession = session.fromPartition("persist:player");
      const trailerSession = session.fromPartition("persist:trailer");
      setupSession(playerSession, trailerSession);
    }

    // Track player webviews for cleanup on player-stopped
    try {
      if (wc.session === session.fromPartition("persist:player")) {
        playerWcIds.add(wc.id);
        wc.once("destroyed", () => playerWcIds.delete(wc.id));
      }
    } catch {}

    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("enter-html-full-screen", () =>
      mainWindow.webContents.send("webview-enter-fullscreen"),
    );
    wc.on("leave-html-full-screen", () =>
      mainWindow.webContents.send("webview-leave-fullscreen"),
    );
  });

  mainWindow.loadFile(path.join(__dirname, "dist/index.html"));

  // Trigger scheduled backup after load
  mainWindow.webContents.once("did-finish-load", () => {
    _bench("renderer loaded");
    const sbSettings = storageIpc.loadScheduledBackupSettings();
    if (storageIpc.shouldRunScheduledBackup(sbSettings)) {
      mainWindow.webContents.send("scheduled-backup-requested");
    }
  });

  // Intercept close if downloads are active
  let closeResponsePending = false;
  mainWindow.on("close", (e) => {
    const running = downloadsIpc
      .getDownloads()
      .filter((d) => d.status === "downloading");
    if (running.length === 0) return;
    e.preventDefault();
    if (closeResponsePending) return;
    closeResponsePending = true;
    mainWindow.webContents.send("confirm-close", { count: running.length });
  });

  ipcMain.on("close-response", (_, confirmed) => {
    closeResponsePending = false;
    if (confirmed) {
      downloadsIpc.killAllDownloads();
      mainWindow.destroy();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

// -- Register all IPC modules --------------------------------------------------
storageIpc.register();
downloadsIpc.register(getMainWindow);
subtitlesIpc.register({
  getDownloads: downloadsIpc.getDownloads,
  saveDownloads: downloadsIpc.saveDownloads,
});
allmangaIpc.register();
playerIpc.register(getMainWindow, {
  writeSecretMigration: storageIpc.writeSecretMigration,
});
blockStats.init(getMainWindow);
discordRpc.register(ipcMain);

// ── Trakt.tv IPC handlers (main process — avoids CORS) ───────────────────────
// All Trakt OAuth + API calls run here, tokens stay in renderer localStorage.

const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || ""; // Set via env or leave empty for user-provided

ipcMain.handle("trakt-get-pin", async () => {
  if (!TRAKT_CLIENT_ID) {
    return { ok: false, error: "No Trakt client_id configured. Set TRAKT_CLIENT_ID env var or use the PIN flow with your own client_id." };
  }
  const res = await fetch("https://trakt.tv/oauth/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: TRAKT_CLIENT_ID }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.message || `Trakt PIN request failed (${res.status})` };
  }
  const data = await res.json();
  return { ok: true, ...data };
});

ipcMain.handle("trakt-poll-pin", async (_, { pin, interval = 5 }) => {
  if (!TRAKT_CLIENT_ID) {
    return { ok: false, error: "No Trakt client_id configured" };
  }
  const maxAttempts = Math.floor(600 / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch("https://trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pin,
        client_id: TRAKT_CLIENT_ID,
        client_secret: "",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, ...data };
    }
    const err = await res.json().catch(() => ({}));
    if (err.error === "authorization_pending") continue;
    if (err.error === "expired_token") return { ok: false, error: "PIN expired" };
    if (err.error === "access_denied") return { ok: false, error: "Denied" };
    return { ok: false, error: err.error || "Unknown error" };
  }
  return { ok: false, error: "Timeout" };
});

// User-provided client_id flow (for users who registered their own Trakt app)
ipcMain.handle("trakt-get-pin-custom", async (_, { clientId }) => {
  if (!clientId) return { ok: false, error: "client_id required" };
  const res = await fetch("https://trakt.tv/oauth/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.message || `Trakt PIN request failed (${res.status})` };
  }
  const data = await res.json();
  return { ok: true, ...data };
});

ipcMain.handle("trakt-poll-pin-custom", async (_, { pin, clientId, interval = 5 }) => {
  if (!clientId) return { ok: false, error: "client_id required" };
  const maxAttempts = Math.floor(600 / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch("https://trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pin,
        client_id: clientId,
        client_secret: "",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, ...data };
    }
    const err = await res.json().catch(() => ({}));
    if (err.error === "authorization_pending") continue;
    if (err.error === "expired_token") return { ok: false, error: "PIN expired" };
    if (err.error === "access_denied") return { ok: false, error: "Denied" };
    return { ok: false, error: err.error || "Unknown error" };
  }
  return { ok: false, error: "Timeout" };
});

ipcMain.handle("trakt-logout", () => {
  return { ok: true };
});

ipcMain.handle("trakt-is-connected", () => {
  return false;
});

// Generic Trakt API proxy (renderer → main → Trakt) to avoid CORS
ipcMain.handle("trakt-api", async (_, { method, path, body }) => {
  const url = `https://api.trakt.tv${path}`;
  const res = await fetch(url, {
    method: method || "GET",
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: err.message || `Trakt ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, data };
});

// ── Smart Downloads IPC handlers ──────────────────────────────────────────────
// Queue management is done in renderer (localStorage); these handlers provide
// main-process helpers for future enhancements (e.g., actual download execution).
ipcMain.handle("get-smart-download-settings", () => {
  // Renderer handles this; return empty for now
  return {};
});

ipcMain.handle("set-smart-download-settings", (_, settings) => {
  // Renderer handles this
  return { ok: true };
});

ipcMain.handle("get-download-queue", () => {
  // Renderer handles this
  return [];
});

ipcMain.handle("add-to-queue", (_, { item, priority }) => {
  // Renderer handles this
  return { ok: true };
});

ipcMain.handle("remove-from-queue", (_, id) => {
  // Renderer handles this
  return { ok: true };
});

ipcMain.handle("update-queue-item", (_, { id, updates }) => {
  // Renderer handles this
  return { ok: true };
});

// ── Mini Player (always-on-top window) ──────────────────────────────────────
let miniPlayerWindow = null;

ipcMain.handle("open-mini-player", async (_, { url, title }) => {
  if (!url) return { ok: false, reason: "no-url" };

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.loadURL(url);
    miniPlayerWindow.focus();
    return { ok: true, windowId: miniPlayerWindow.webContents.id };
  }

  miniPlayerWindow = new BrowserWindow({
    width: 480,
    height: 270,
    minWidth: 320,
    minHeight: 180,
    alwaysOnTop: true,
    title: title ? `${title} - Mini Player` : "Mini Player",
    backgroundColor: "#000000",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      partition: "persist:player",
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  miniPlayerWindow.loadURL(url);

  miniPlayerWindow.on("closed", () => {
    miniPlayerWindow = null;
  });

  return { ok: true, windowId: miniPlayerWindow.webContents.id };
});

ipcMain.handle("close-mini-player", () => {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.close();
  }
  return { ok: true };
});

ipcMain.handle("set-mini-player-size", (_, { width, height }) => {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.setSize(width, height);
    return { ok: true };
  }
  return { ok: false, reason: "no-window" };
});

ipcMain.handle("set-mini-player-always-on-top", (_, enabled) => {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.setAlwaysOnTop(enabled);
    return { ok: true };
  }
  return { ok: false, reason: "no-window" };
});

// ── Addon system IPC handlers ───────────────────────────────────────────────
ipcMain.handle("get-addon-gallery", () => {
  // Renderer handles this via addons.js
  return [];
});

ipcMain.handle("toggle-addon", (_, { id, enabled }) => {
  // Renderer handles this via addons.js
  return { ok: true };
});

ipcMain.handle("get-builtin-addons", () => {
  // Renderer handles this via addons.js
  return [];
});

// ── Server client IPC handlers ──────────────────────────────────────────────
ipcMain.handle("get-server-config", () => {
  // Renderer handles this via serverClient.js
  return null;
});

ipcMain.handle("set-server-config", (_, config) => {
  // Renderer handles this via serverClient.js
  return { ok: true };
});

ipcMain.handle("clear-server-config", () => {
  // Renderer handles this via serverClient.js
  return { ok: true };
});

ipcMain.handle("server-get-libraries", async () => {
  // Would call Jellyfin/Plex API via main process
  // For now, return empty (renderer handles via serverClient.js)
  return [];
});

ipcMain.handle("server-get-items", async (_, libraryId) => {
  // Would call Jellyfin/Plex API via main process
  return [];
});

// ── In-app update IPC handlers ───────────────────────────────────────────────
// Handles downloading and installing updates from the renderer (UpdateModal).
const { autoUpdater } = require("electron-updater");
const { download } = require("electron-dl");

ipcMain.handle("detect-update-format", () => {
  if (process.platform === "win32") return "exe";
  if (process.platform === "linux") return "AppImage";
  if (process.platform === "darwin") return "dmg";
  return null;
});

ipcMain.handle("download-and-install-update", async (_, { url, format }) => {
  if (!url) return { ok: false, error: "No download URL" };

  const win = getMainWindow();
  if (!win) return { ok: false, error: "No main window" };

  // For Windows NSIS and macOS, use auto-updater
  if (format === "exe" || format === "dmg") {
    try {
      autoUpdater.setFeedURL({ provider: "github", owner: "Vhierly", repo: "streambert" });
      autoUpdater.checkForUpdates();
      return { ok: true, message: "Update started via auto-updater" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // For Linux AppImage / deb, download the file and prompt install
  try {
    const dlResult = await download(win, url, {
      onProgress: (progress) => {
        win.webContents.send("update-progress", progress);
      },
    });
    // Open the downloaded file's folder
    const filePath = dlResult.getSavePath();
    const { shell } = require("electron");
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath, message: "Download complete — open folder to install" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("cancel-update", () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch {
    return { ok: true };
  }
});

// ── AI Recommendations IPC handlers ─────────────────────────────────────────
ipcMain.handle("get-personalized-recommendations", async (_, { history, limit }) => {
  // Would call TMDB API with genre affinity from history
  return [];
});

ipcMain.handle("analyze-watch-history", (_, { history }) => {
  // Renderer handles this via aiRecommendations.js
  return {};
});

ipcMain.handle("get-mood-recommendations", (_, { mood, limit }) => {
  // Renderer handles this via aiRecommendations.js
  return {};
});

// get-block-stats lives with its data
ipcMain.handle("get-block-stats", () => blockStats.getBlockStats());

// -- Player memory cleanup ---------------------------------------------
// Called by MoviePage / TVPage on component unmount.
// Destroys the player webview WebContents by tracked ID, then flushes caches and GCs.
ipcMain.on("player-stopped", () => {
  // Step 1: Mute + destroy all tracked player WebContents by ID.
  for (const id of playerWcIds) {
    try {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.setAudioMuted(true);
        } catch {}
        wc.destroy();
      }
    } catch {}
  }
  playerWcIds.clear();

  // Step 2: Flush HTTP + shader caches from the player session.
  try {
    const ps = session.fromPartition("persist:player");
    ps.clearCache().catch(() => {});
    ps.clearStorageData({ storages: ["shadercache", "cachestorage"] }).catch(
      () => {},
    );
  } catch {}

  // Step 3: GC hints
  if (typeof global.gc === "function") global.gc();
  const mw = mainWindow;
  if (mw && !mw.isDestroyed()) {
    mw.webContents
      .executeJavaScript("if(typeof gc==='function') gc();")
      .catch(() => {});
  }
});

// -- Desktop notifications -----------------------------------------------------
// Called from the renderer whenever it wants a native OS notification.
ipcMain.handle(
  "show-notification",
  (_event, { title, body, silent = false }) => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: String(title),
        body: String(body),
        silent,
      });
      n.show();
    } catch {}
  },
);

// -- Picture-in-Picture / Pop-Out window --------------------------------------
// Opens the player URL in a small always-on-top BrowserWindow (full site UI,
// with subtitles and controls). The Main Window closes the stream to avoid duplication.
let pipWindow = null;
const getPipWindow = () => pipWindow;

ipcMain.handle("open-pip-window", (_, { url, title }) => {
  if (!url || url === "about:blank") return { ok: false, reason: "no-url" };

  // Guarantee tracker/ad blocking is active in persist:player before any load
  if (!sessionsConfigured) {
    sessionsConfigured = true;
    const playerSession = session.fromPartition("persist:player");
    const trailerSession = session.fromPartition("persist:trailer");
    setupSession(playerSession, trailerSession);
  }

  if (pipWindow && !pipWindow.isDestroyed()) {
    pipWindow.loadURL(url);
    pipWindow.focus();
    return { ok: true };
  }

  pipWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 320,
    minHeight: 180,
    alwaysOnTop: true,
    title: title ? `${title} - Pop-out` : "Pop-out Player",
    backgroundColor: "#000000",
    // Same custom title bar as the main window
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      partition: "persist:player",
      nodeIntegration: false,
      contextIsolation: true,
      // Injects the custom title bar and wires window-control IPC
      preload: path.join(__dirname, "popout-preload.js"),
    },
  });

  // Block all popup windows from the streaming site and any nested frames
  pipWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // If the site uses <webview> elements (unlikely but safe), block there too
  pipWindow.webContents.on("did-attach-webview", (_, wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  pipWindow.loadURL(url);

  // Push maximize state into the popout renderer so the title bar icon updates
  pipWindow.on("maximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", true);
  });
  pipWindow.on("unmaximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", false);
  });

  const notifyMain = (channel) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) mw.webContents.send(channel);
  };

  pipWindow.on("closed", () => {
    pipWindow = null;
    notifyMain("pip-window-closed");
  });

  notifyMain("pip-window-opened");
  return { ok: true };
});

ipcMain.handle("close-pip-window", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});

ipcMain.handle("get-pip-webcontents-id", () => {
  if (pipWindow && !pipWindow.isDestroyed()) return pipWindow.webContents.id;
  return null;
});

// -- Popout window controls (used by popout-preload.js title bar buttons) -----
ipcMain.handle("popout-window-minimize", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.minimize();
});
ipcMain.handle("popout-window-toggle-maximize", () => {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  if (pipWindow.isMaximized()) pipWindow.unmaximize();
  else pipWindow.maximize();
});
ipcMain.handle("popout-window-close", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});
ipcMain.handle("popout-window-is-maximized", () => {
  return pipWindow && !pipWindow.isDestroyed()
    ? pipWindow.isMaximized()
    : false;
});

// -- Single-instance lock ------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    _bench("app ready");
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => discordRpc.shutdown());
  app.on("activate", () => {
    if (mainWindow === null) createWindow();
  });
}
