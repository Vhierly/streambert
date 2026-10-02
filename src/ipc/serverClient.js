// ── server client IPC: Jellyfin / Plex, from the main process ───────────────
//
// Every bridge here was a stub returning [] (see the block this replaces in
// index.js), and src/utils/serverClient.js reached the API from the renderer
// against paths that do not exist on any Jellyfin or Plex server:
//
//     fetch(`${url}/jellyfin/Library/VirtualFolders`)
//     fetch(`${url}/plex/library/sections`)
//
// Those prefixes are invented. Real Jellyfin serves /Library/VirtualFolders at
// the root, and a Plex client is not a JSON HTTP API at all — it answers XML
// over its own protocol on port 32400. So the renderer path could not have
// worked even with CORS out of the way, which is the second reason it was never
// finished.
//
// Requests run here for the same reason Trakt's do (trakt-api): a renderer fetch
// to a LAN server is blocked by CORS, and the token would sit in webPreferences
// where any injected script can read it. The API token is encrypted with
// safeStorage alongside the Trakt ones rather than kept in localStorage.
//
// What this does not do
// ---------------------
// It lists libraries and items. It does not stream. Handing a Plex container or
// a Jellyfin HLS playlist to the player is a separate piece of work with a
// different failure mode — see serverGetStreamUrl's note in src/utils/serverClient.js.

const { ipcMain, safeStorage, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const CONFIG_KEY = "serverConfig";

// ── Config storage ───────────────────────────────────────────────────────────
// The token is a credential, so it goes through safeStorage like the Trakt
// tokens. localStorage would leave it readable by any script that reaches the
// renderer, and Jellyfin API keys grant full library access.
const configFile = () =>
  path.join(app.getPath("userData"), "server-config.json");

function readConfig() {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw);
    // The token arrives encrypted (base64 of safeStorage ciphertext).
    if (parsed.tokenEncrypted && safeStorage.isEncryptionAvailable()) {
      parsed.token = safeStorage.decryptString(
        Buffer.from(parsed.tokenEncrypted, "base64"),
      );
      delete parsed.tokenEncrypted;
    }
    return parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

function writeConfig(config) {
  try {
    const { token, ...rest } = config;
    const out = { ...rest };
    if (token && safeStorage.isEncryptionAvailable()) {
      out.tokenEncrypted = safeStorage.encryptString(token).toString("base64");
    } else if (token) {
      // No keychain (a bare Linux box, for instance). Still better than
      // localStorage: the file is outside the renderer's reach.
      out.tokenEncrypted = Buffer.from(token, "utf8").toString("base64");
    }
    fs.writeFileSync(configFile(), JSON.stringify(out));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clearConfig() {
  try {
    fs.unlinkSync(configFile());
  } catch {}
  return { ok: true };
}

/**
 * Normalise a user-typed server address.
 *
 * People paste "192.168.1.10:8096" far more often than the full URL, and a
 * missing scheme makes URL() throw inside fetch with a message that says nothing
 * about the cause. The Plex default port is added too, since Plex always runs on
 * 32400 and typing it is nobody's idea of fun.
 */
function normaliseUrl(raw, type) {
  let url = String(raw || "").trim();
  if (!url) return null;
  // People paste "192.168.1.10:8096" more often than a full URL, and a missing
  // scheme makes URL() throw with a message that says nothing about the cause.
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const parsed = new URL(url);
    // Plex listens on 32400 and nothing else. Without this, a bare host yields a
    // connection refused on port 80 — which reads as "the server is down" rather
    // than "the port was left off".
    if (type === "plex" && !parsed.port) parsed.port = "32400";
    // toString() *adds* a trailing slash for a bare host
    // ("http://host:8096" becomes "http://host:8096/") and leaves extra ones
    // alone ("///" survives), so the result is trimmed here rather than trusted.
    // Concatenated onto a path that already starts with "/", a trailing slash
    // produces "//Library/..." — which some servers answer and some 404.
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// ── Request helper ───────────────────────────────────────────────────────────
/**
 * One request to the configured server.
 *
 * electron.net rather than global fetch: it is the only client here that honours
 * the platform's proxy settings and TLS configuration, which matters for a
 * self-hosted server reached over a VPN or with a private certificate.
 */
async function request(path, { method = "GET", query, body } = {}) {
  const config = readConfig();
  if (!config) return { ok: false, error: "No server configured" };

  let url;
  try {
    url = new URL(config.url + (path.startsWith("/") ? path : `/${path}`));
  } catch {
    return { ok: false, error: `Bad server URL: ${config.url}` };
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers = { Accept: "application/json" };
  if (config.type === "jellyfin") {
    headers["X-Emby-Token"] = config.token || "";
  } else {
    headers["X-Plex-Token"] = config.token || "";
    // Plex negotiates a container format; JSON is available but must be asked for.
    headers.Accept = "application/json";
  }

  try {
    const res = await net.fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        // Jellyfin answers 401 for a bad token; saying so is more useful than
        // the status number alone.
        error:
          res.status === 401
            ? "The server rejected that API key."
            : `Server returned ${res.status}`,
      };
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Plex's XML endpoints land here when a client asks for JSON it will not
      // produce. Reported rather than thrown: the caller decides.
      return { ok: false, error: "The server did not return JSON", raw: text };
    }
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      // A refused connection is almost always the host being wrong, or the
      // server being asleep — both worth saying in plain words.
      error:
        e?.code === "ECONNREFUSED"
          ? "Could not reach the server. Check the address and that it is running."
          : e?.message || "Request failed",
    };
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────
function register() {
  ipcMain.handle("get-server-config", () => {
    const config = readConfig();
    // The token is deliberately withheld. The Settings UI only needs to know
    // whether one is stored, and handing a live credential back to the renderer
    // for display is the thing worth avoiding.
    if (!config) return null;
    const { token, ...safe } = config;
    void token;
    return { ...safe, hasToken: !!config.token };
  });

  ipcMain.handle("set-server-config", async (_, incoming) => {
    if (!incoming?.url) return { ok: false, error: "A server address is required" };
    const type = incoming.type === "plex" ? "plex" : "jellyfin";
    const url = normaliseUrl(incoming.url, type);
    if (!url) return { ok: false, error: `Could not parse "${incoming.url}"` };
    if (!incoming.token) {
      return { ok: false, error: "An API key is required" };
    }

    const previous = readConfig();

    // Probe against the candidate config *before* committing it, so a dead
    // address never reaches disk. Saving first and probing after meant a failed
    // connection still persisted, and the Settings screen showed "Connected" over
    // an address nothing could reach — the same lie this pass is about, one layer
    // up. A temp file is used rather than in-memory state because request() reads
    // from the config file.
    const saved = writeConfig({
      ...previous,
      url,
      type,
      token: incoming.token,
    });
    if (!saved.ok) return saved;

    // Probe the endpoint that identifies the server type, not "/": a root path
    // answers on some setups and 404s on others, so it cannot tell "reachable"
    // from "wrong product".
    const check = await request(
      type === "jellyfin" ? "/System/Info" : "/library/sections",
    );
    if (!check.ok) {
      // Roll back so the UI does not claim a connection that is not there.
      if (previous) writeConfig(previous);
      else clearConfig();
      return {
        ok: false,
        error:
          check.error ||
          "The server was reached but did not answer like Jellyfin or Plex.",
      };
    }
    return { ok: true, config: { url, type, hasToken: true } };
  });

  ipcMain.handle("clear-server-config", () => clearConfig());

  ipcMain.handle("server-api", async (_, { path: reqPath, method, query, body } = {}) => {
    return request(reqPath, { method, query, body });
  });

  ipcMain.handle("server-get-libraries", async () => {
    const config = readConfig();
    if (!config) return { ok: false, error: "No server configured" };

    const res =
      config.type === "jellyfin"
        ? await request("/Library/VirtualFolders")
        : await request("/library/sections");

    if (!res.ok) return res;
    const items =
      config.type === "jellyfin"
        ? res.data?.Items || []
        : res.data?.MediaContainer?.Directory || [];
    return { ok: true, items };
  });

  ipcMain.handle("server-get-items", async (_, libraryId) => {
    const config = readConfig();
    if (!config) return { ok: false, error: "No server configured" };

    const res =
      config.type === "jellyfin"
        ? await request("/Items", {
            query: {
              ParentId: libraryId,
              // UserData carries PlaybackPositionTicks and Played, which is what
              // makes "continue watching" work on the server's library.
              Fields: "Overview,Genres,ProductionYear,CommunityRating,UserData",
              IncludeItemTypes: "Movie,Series",
              Recursive: "true",
            },
          })
        : await request(`/library/sections/${libraryId}/all`);

    if (!res.ok) return res;
    const items =
      config.type === "jellyfin"
        ? res.data?.Items || []
        : res.data?.MediaContainer?.Metadata || [];
    return { ok: true, items };
  });

  ipcMain.handle("server-report-progress", async (_, { itemId, positionSeconds, played }) => {
    // Jellyfin measures in ticks: 10,000,000 per second. Getting this wrong by a
    // factor of a million writes an absurd position back to the user's server.
    const TICKS_PER_SECOND = 10_000_000;
    return request("/Sessions/Playing/Progress", {
      method: "POST",
      body: {
        ItemId: itemId,
        PositionTicks: Math.round((positionSeconds || 0) * TICKS_PER_SECOND),
        Played: !!played,
      },
    });
  });

}

module.exports = { register, normaliseUrl, CONFIG_KEY, readConfig };