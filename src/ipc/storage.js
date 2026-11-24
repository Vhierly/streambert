// ── IPC: Secure key store + Scheduled Backups ─────────────────────────────────
// Handles safeStorage (OS keychain) and scheduled backup read/write/trigger.
//
// Exports register(ipcMain) + helpers used by index.js (migration, backup trigger)

const { app, ipcMain, safeStorage, shell, net } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const TRAKT_REDIRECT_URI = "http://127.0.0.1:49215/callback";
const TRAKT_AUTH_KEY = "traktPkceAuth";
let _activePkceServer = null;
let _traktRefreshPromise = null;

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function traktTokenPost(payload) {
  const body = JSON.stringify(payload);
  if (net && typeof net.fetch === "function") {
    const res = await net.fetch("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Streambert",
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(
        json.error_description || json.error || `Trakt token HTTP ${res.status}`,
      );
    }
    return json;
  }
  throw new Error("Electron network stack unavailable");
}

// ── Secure key/value store ────────────────────────────────────────────────────
// Falls back to plain base64 when OS encryption is unavailable (rare Linux).

let _secureStoreFile = null;
const secureStoreFile = () =>
  _secureStoreFile ||
  (_secureStoreFile = path.join(app.getPath("userData"), "secure-store.json"));

let _secureStoreCache = null;

function readSecureStore() {
  if (_secureStoreCache) return _secureStoreCache;
  try {
    _secureStoreCache = JSON.parse(fs.readFileSync(secureStoreFile(), "utf8"));
  } catch {
    _secureStoreCache = {};
  }
  return _secureStoreCache;
}

function writeSecureStore(data) {
  _secureStoreCache = data;
  fs.writeFileSync(secureStoreFile(), JSON.stringify(data));
}

function secureStoreGet(key) {
  const store = readSecureStore();
  const raw = store[key];
  if (!raw) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(raw, "base64"));
    }
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function secureStoreSet(key, value) {
  const store = readSecureStore();
  if (value === null || value === undefined || value === "") {
    delete store[key];
  } else {
    if (safeStorage.isEncryptionAvailable()) {
      store[key] = safeStorage.encryptString(value).toString("base64");
    } else {
      store[key] = Buffer.from(value, "utf8").toString("base64");
    }
  }
  writeSecureStore(store);
}

// ── Secret migration (AppImage update key re-encryption) ──────────────────────
// When the AppImage binary is replaced, safeStorage can no longer decrypt the
// old ciphertext. We write a short-lived plaintext file before exit and
// re-encrypt it on the next startup.

const migrationFile = () =>
  path.join(app.getPath("userData"), ".secret-migration.json");

function writeSecretMigration() {
  try {
    const store = readSecureStore();
    const plain = {};
    for (const [k, raw] of Object.entries(store)) {
      if (!raw) continue;
      try {
        if (safeStorage.isEncryptionAvailable()) {
          plain[k] = safeStorage.decryptString(Buffer.from(raw, "base64"));
        } else {
          plain[k] = Buffer.from(raw, "base64").toString("utf8");
        }
      } catch {
        /* skip unreadable keys */
      }
    }
    if (Object.keys(plain).length > 0) {
      fs.writeFileSync(migrationFile(), JSON.stringify(plain), { mode: 0o600 });
    }
  } catch {
    /* best-effort */
  }
}

function applySecretMigrationIfNeeded() {
  const mf = migrationFile();
  if (!fs.existsSync(mf)) return;
  let plain = null;
  try {
    const raw = fs.readFileSync(mf, "utf8");
    // Delete IMMEDIATELY after reading
    try {
      fs.unlinkSync(mf);
    } catch {
      try {
        fs.writeFileSync(mf, "{}", { mode: 0o600 });
      } catch {}
    }
    plain = JSON.parse(raw);
  } catch {
    return;
  }
  if (!plain) return;
  for (const [k, v] of Object.entries(plain)) {
    try {
      if (v) secureStoreSet(k, v);
    } catch {}
  }
}

// Safety-net: nuke migration file on quit if it somehow survived
app.on("quit", () => {
  try {
    fs.unlinkSync(migrationFile());
  } catch {}
});

// ── Scheduled backup store ────────────────────────────────────────────────────

const scheduledBackupSettingsFile = () =>
  path.join(app.getPath("userData"), "scheduled-backup-settings.json");

function loadScheduledBackupSettings() {
  try {
    const raw = fs.readFileSync(scheduledBackupSettingsFile(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      enabled: false,
      path: "",
      keepCount: 5,
      frequency: "startup",
      lastRun: null,
    };
  }
}

function saveScheduledBackupSettings(settings) {
  fs.writeFileSync(
    scheduledBackupSettingsFile(),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

function shouldRunScheduledBackup(settings) {
  if (!settings.enabled || !settings.path) return false;
  if (settings.frequency === "startup") return true;
  if (!settings.lastRun) return true;
  const diff = Date.now() - new Date(settings.lastRun).getTime();
  if (settings.frequency === "daily") return diff >= 86_400_000;
  if (settings.frequency === "weekly") return diff >= 604_800_000;
  if (settings.frequency === "monthly") return diff >= 2_592_000_000;
  return false;
}

// ── IPC registration ──────────────────────────────────────────────────────────

function register() {
  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("secure-store-get", (_, key) => {
    try {
      return { ok: true, value: secureStoreGet(key) };
    } catch {
      return { ok: false, value: null };
    }
  });

  ipcMain.handle("secure-store-set", (_, { key, value }) => {
    try {
      secureStoreSet(key, value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Trakt OAuth 2.0 PKCE Login + Rotating Refresh Token ───────────────────
  ipcMain.handle("trakt-pkce-login", async (_, rawClientId) => {
    const clientId = String(rawClientId || "").trim();
    if (!clientId) return { ok: false, error: "Please enter your Trakt Client ID" };

    if (_activePkceServer) {
      try {
        _activePkceServer.close();
      } catch {}
      _activePkceServer = null;
    }

    const verifier = toBase64Url(crypto.randomBytes(32));
    const challenge = toBase64Url(
      crypto.createHash("sha256").update(verifier).digest(),
    );
    const state = toBase64Url(crypto.randomBytes(16));

    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Sign-in timed out after 3 minutes"));
        }, 180_000);

        const server = http.createServer((req, res) => {
          try {
            const u = new URL(req.url, "http://127.0.0.1:49215");
            if (u.pathname !== "/callback") {
              res.writeHead(404);
              res.end();
              return;
            }
            const err = u.searchParams.get("error");
            const gotCode = u.searchParams.get("code");
            const gotState = u.searchParams.get("state");

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              err || !gotCode || gotState !== state
                ? "<html><body style='background:#0a0a0a;color:#f0f0f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div><h2 style='color:#e50914'>Authorization failed</h2><p>You can close this tab and try again in Streambert.</p></div></body></html>"
                : "<html><body style='background:#0a0a0a;color:#f0f0f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='text-align:center'><h2 style='color:#48c774'>✓ Streambert Connected to Trakt!</h2><p style='color:#909090'>You can close this browser tab and return to Streambert.</p></div></body></html>",
            );
            cleanup();
            if (err) reject(new Error(`Trakt authorization denied: ${err}`));
            else if (gotState !== state) reject(new Error("OAuth state mismatch"));
            else if (!gotCode) reject(new Error("Missing authorization code"));
            else resolve(gotCode);
          } catch (e) {
            cleanup();
            reject(e);
          }
        });

        function cleanup() {
          clearTimeout(timer);
          if (_activePkceServer === server) _activePkceServer = null;
          try {
            server.close();
          } catch {}
        }

        _activePkceServer = server;
        server.on("error", (err) => {
          cleanup();
          reject(
            err.code === "EADDRINUSE"
              ? new Error("Port 49215 is busy — please wait a few seconds and retry")
              : err,
          );
        });

        server.listen(49215, "127.0.0.1", () => {
          const authUrl = new URL("https://auth.trakt.tv/oauth/authorize");
          authUrl.searchParams.set("response_type", "code");
          authUrl.searchParams.set("client_id", clientId);
          authUrl.searchParams.set("redirect_uri", TRAKT_REDIRECT_URI);
          authUrl.searchParams.set("code_challenge", challenge);
          authUrl.searchParams.set("code_challenge_method", "S256");
          authUrl.searchParams.set("state", state);
          shell.openExternal(authUrl.toString());
        });
      });

      const tok = await traktTokenPost({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: TRAKT_REDIRECT_URI,
        code_verifier: verifier,
      });

      const expiresInMs = Math.max(300, Number(tok.expires_in) || 86400) * 1000;
      const record = {
        clientId,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || "",
        expiresAt: Date.now() + expiresInMs,
      };
      secureStoreSet(TRAKT_AUTH_KEY, JSON.stringify(record));
      secureStoreSet("traktClientId", clientId);
      return { ok: true, clientId, accessToken: record.accessToken };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("trakt-get-valid-auth", async () => {
    try {
      const raw = secureStoreGet(TRAKT_AUTH_KEY);
      if (!raw) {
        // Legacy manual token fallback
        const cid = secureStoreGet("traktClientId");
        const tok = secureStoreGet("traktToken");
        if (cid && tok) return { ok: true, clientId: cid, accessToken: tok };
        return { ok: false };
      }
      const auth = JSON.parse(raw);
      if (!auth?.clientId || !auth?.accessToken) return { ok: false };

      // Refresh if within 5 minutes of expiry
      if (auth.expiresAt && Date.now() < auth.expiresAt - 5 * 60 * 1000) {
        return {
          ok: true,
          clientId: auth.clientId,
          accessToken: auth.accessToken,
        };
      }
      if (!auth.refreshToken) return { ok: false, error: "Session expired" };

      if (!_traktRefreshPromise) {
        _traktRefreshPromise = (async () => {
          const refreshed = await traktTokenPost({
            grant_type: "refresh_token",
            refresh_token: auth.refreshToken,
            client_id: auth.clientId,
            redirect_uri: TRAKT_REDIRECT_URI,
          });
          const expiresInMs =
            Math.max(300, Number(refreshed.expires_in) || 86400) * 1000;
          const updated = {
            clientId: auth.clientId,
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token || auth.refreshToken,
            expiresAt: Date.now() + expiresInMs,
          };
          secureStoreSet(TRAKT_AUTH_KEY, JSON.stringify(updated));
          return {
            ok: true,
            clientId: updated.clientId,
            accessToken: updated.accessToken,
          };
        })().finally(() => {
          _traktRefreshPromise = null;
        });
      }
      return await _traktRefreshPromise;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("trakt-logout", () => {
    secureStoreSet(TRAKT_AUTH_KEY, "");
    secureStoreSet("traktToken", "");
    return { ok: true };
  });

  ipcMain.handle("get-scheduled-backup-settings", () =>
    loadScheduledBackupSettings(),
  );

  ipcMain.handle("set-scheduled-backup-settings", (_, settings) => {
    try {
      saveScheduledBackupSettings(settings);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("perform-scheduled-backup", (_, { data, settings }) => {
    try {
      const backupDir = settings.path;
      if (!backupDir) return { ok: false, error: "No backup path set" };

      const resolvedDir = path.resolve(backupDir);

      fs.mkdirSync(resolvedDir, { recursive: true });

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const filename = `streambert-backup-${timestamp}.json`;
      const fullPath = path.join(resolvedDir, filename);
      fs.writeFileSync(
        fullPath,
        JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            scheduledBackup: true,
            data,
          },
          null,
          2,
        ),
        "utf8",
      );

      // Prune old backups
      const keepCount = Math.max(1, Number(settings.keepCount) || 5);
      fs.readdirSync(resolvedDir)
        .filter(
          (f) => f.startsWith("streambert-backup-") && f.endsWith(".json"),
        )
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(resolvedDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(keepCount)
        .forEach(({ name }) => {
          try {
            fs.unlinkSync(path.join(resolvedDir, name));
          } catch {}
        });

      saveScheduledBackupSettings({
        ...settings,
        lastRun: new Date().toISOString(),
      });
      return { ok: true, path: fullPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  applySecretMigrationIfNeeded,
  writeSecretMigration,
  loadScheduledBackupSettings,
  shouldRunScheduledBackup,
};
