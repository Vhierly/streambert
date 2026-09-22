// ── Trakt.tv API Integration ──────────────────────────────────────────────────
// Docs: https://trakt.docs.apiary.io
// All API calls go through Electron main process to avoid CORS.
// Renderer should use window.electron.trakt* IPC methods, not call these directly.

const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_OAUTH = "https://trakt.tv/oauth";

// IMPORTANT: Replace with a real Trakt.tv application client_id.
// Register at https://trakt.tv/oauth/applications to get your own.
// The PIN flow only needs client_id (no client_secret required).
const DEFAULT_CLIENT_ID = ""; // Users must provide their own

let _clientId = DEFAULT_CLIENT_ID;
let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = null;

// ── Token storage (localStorage) ──────────────────────────────────────────────
const TRAKT_STORAGE_KEY = "streambert_trakt_tokens";

function loadTokens() {
  try {
    const raw = localStorage.getItem(TRAKT_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    _accessToken = data.accessToken || null;
    _refreshToken = data.refreshToken || null;
    _tokenExpiresAt = data.expiresAt || null;
    _clientId = data.clientId || DEFAULT_CLIENT_ID;
  } catch {}
}

function saveTokens() {
  try {
    localStorage.setItem(
      TRAKT_STORAGE_KEY,
      JSON.stringify({
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        expiresAt: _tokenExpiresAt,
        clientId: _clientId,
      })
    );
  } catch {}
}

export const traktLogout = () => {
  _accessToken = null;
  _refreshToken = null;
  _tokenExpiresAt = null;
  localStorage.removeItem(TRAKT_STORAGE_KEY);
};

export const traktIsConnected = () => {
  loadTokens();
  return !!_accessToken && (!_tokenExpiresAt || Date.now() < _tokenExpiresAt);
};

export const traktGetClientId = () => _clientId;

export const traktSetClientId = (id) => {
  _clientId = id;
  saveTokens();
};

// ── PIN-based OAuth Flow (renderer → main process via IPC) ─────────────────
// All OAuth calls go through Electron main process to avoid CORS.
// Falls back to direct fetch only in non-Electron (web dev) environments.

// Step 1: Get a PIN code from Trakt (requires valid client_id)
export const traktGetPin = async () => {
  // Prefer IPC (Electron main process)
  if (window.electron?.traktGetPin) {
    return window.electron.traktGetPin();
  }
  // Fallback for non-Electron (web dev)
  if (!_clientId) {
    throw new Error("Trakt client_id not configured. Set it in Settings → Trakt.tv → Advanced.");
  }
  const res = await fetch(`${TRAKT_OAUTH}/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: _clientId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Trakt PIN request failed (${res.status})`);
  }
  return res.json();
};

// Step 2: Poll for token after user enters PIN at trakt.tv/pin
export const traktPollPin = async (pin, interval = 5) => {
  // Prefer IPC (Electron main process)
  if (window.electron?.traktPollPin) {
    return window.electron.traktPollPin(pin, interval);
  }
  // Fallback for non-Electron
  const maxAttempts = Math.floor(600 / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(`${TRAKT_OAUTH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pin,
        client_id: _clientId,
        client_secret: "",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      _accessToken = data.access_token;
      _refreshToken = data.refresh_token;
      _tokenExpiresAt = Date.now() + data.expires_in * 1000;
      saveTokens();
      return { ok: true };
    }
    const err = await res.json().catch(() => ({}));
    if (err.error === "authorization_pending") continue;
    if (err.error === "expired_token") return { ok: false, error: "PIN expired" };
    if (err.error === "access_denied") return { ok: false, error: "Denied" };
    return { ok: false, error: err.error || "Unknown error" };
  }
  return { ok: false, error: "Timeout" };
};

// Custom client_id flow (user provides their own Trakt app credentials)
export const traktGetPinCustom = async (clientId) => {
  if (window.electron?.traktGetPinCustom) {
    return window.electron.traktGetPinCustom(clientId);
  }
  if (!clientId) throw new Error("client_id required");
  const res = await fetch(`${TRAKT_OAUTH}/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Trakt PIN request failed (${res.status})`);
  }
  return res.json();
};

export const traktPollPinCustom = async (pin, clientId, interval = 5) => {
  if (window.electron?.traktPollPinCustom) {
    return window.electron.traktPollPinCustom(pin, clientId, interval);
  }
  if (!clientId) throw new Error("client_id required");
  const maxAttempts = Math.floor(600 / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(`${TRAKT_OAUTH}/token`, {
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
      _accessToken = data.access_token;
      _refreshToken = data.refresh_token;
      _tokenExpiresAt = Date.now() + data.expires_in * 1000;
      saveTokens();
      return { ok: true };
    }
    const err = await res.json().catch(() => ({}));
    if (err.error === "authorization_pending") continue;
    if (err.error === "expired_token") return { ok: false, error: "PIN expired" };
    if (err.error === "access_denied") return { ok: false, error: "Denied" };
    return { ok: false, error: err.error || "Unknown error" };
  }
  return { ok: false, error: "Timeout" };
};

// ── API Helpers (called from main process via IPC) ───────────────────────────
const traktHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${_accessToken}`,
  "trakt-api-version": "2",
  "trakt-api-key": _clientId,
});

const traktFetch = async (path, options = {}) => {
  // In Electron, proxy through the main process to avoid CORS
  if (window.electron?.traktApi) {
    const result = await window.electron.traktApi(
      options.method || "GET",
      path,
      options.body
    );
    if (!result.ok) {
      if (result.status === 401) {
        traktLogout();
        throw new Error("Trakt auth expired");
      }
      throw new Error(result.error || `Trakt ${result.status}`);
    }
    return result.data;
  }

  // Fallback for non-Electron (web dev)
  loadTokens();
  if (!_accessToken) throw new Error("Not connected to Trakt");
  const res = await fetch(`${TRAKT_BASE}${path}`, {
    ...options,
    headers: { ...traktHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    if (_refreshToken) {
      const refreshed = await traktRefreshToken();
      if (refreshed) return traktFetch(path, options);
    }
    traktLogout();
    throw new Error("Trakt auth expired");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Trakt ${res.status}`);
  }
  return res.json();
};

const traktRefreshToken = async () => {
  if (!_refreshToken) return false;
  const res = await fetch(`${TRAKT_OAUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: _refreshToken,
      client_id: _clientId,
      client_secret: "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  _accessToken = data.access_token;
  _refreshToken = data.refresh_token;
  _tokenExpiresAt = Date.now() + data.expires_in * 1000;
  saveTokens();
  return true;
};

// ── Scrobbling (auto-track what you watch) ─────────────────────────────────────
// Called when playback starts — creates a "watching" status
export const traktScrobbleStart = async (item, type = "movie", progress = 0) => {
  const body = type === "movie"
    ? { movie: { ids: { tmdb: String(item.id) } }, progress: Math.round(progress) }
    : {
        episode: { ids: { tmdb: String(item.id) } },
        show: { ids: { tmdb: String(item.tmdb_id || item.showId) } },
        progress: Math.round(progress),
      };
  return traktFetch("/scrobble/start", { method: "POST", body: JSON.stringify(body) });
};

export const traktScrobblePause = async (item, type = "movie", progress = 0) => {
  const body = type === "movie"
    ? { movie: { ids: { tmdb: String(item.id) } }, progress: Math.round(progress) }
    : {
        episode: { ids: { tmdb: String(item.id) } },
        show: { ids: { tmdb: String(item.tmdb_id || item.showId) } },
        progress: Math.round(progress),
      };
  return traktFetch("/scrobble/pause", { method: "POST", body: JSON.stringify(body) });
};

export const traktScrobbleStop = async (item, type = "movie", progress = 0) => {
  const body = type === "movie"
    ? { movie: { ids: { tmdb: String(item.id) } }, progress: Math.round(progress) }
    : {
        episode: { ids: { tmdb: String(item.id) } },
        show: { ids: { tmdb: String(item.tmdb_id || item.showId) } },
        progress: Math.round(progress),
      };
  return traktFetch("/scrobble/stop", { method: "POST", body: JSON.stringify(body) });
};

// ── Sync Library ──────────────────────────────────────────────────────────────
export const traktSyncHistory = async (items) => {
  // Sync local watch history to Trakt
  const history = items.map((item) => ({
    watched_at: new Date(item.watchedAt || Date.now()).toISOString(),
    ids: { tmdb: String(item.id) },
    type: item.media_type === "tv" ? "episode" : "movie",
    ...(item.media_type === "tv"
      ? {
          episode: {
            season: item.season,
            number: item.episode,
            title: item.episodeName || "",
          },
          show: { ids: { tmdb: String(item.tmdb_id || item.showId) } },
        }
      : {}),
  }));
  return traktFetch("/sync/history", {
    method: "POST",
    body: JSON.stringify({ history }),
  });
};

export const traktSyncWatchlist = async (items) => {
  const movies = items
    .filter((i) => i.media_type === "movie")
    .map((i) => ({ ids: { tmdb: String(i.id) } }));
  const shows = items
    .filter((i) => i.media_type === "tv")
    .map((i) => ({ ids: { tmdb: String(i.id) } }));
  return traktFetch("/sync/watchlist", {
    method: "POST",
    body: JSON.stringify({ movies, shows }),
  });
};

// ── Recommendations ───────────────────────────────────────────────────────────
export const traktGetRecommendations = async (type = "movies", limit = 10) => {
  return traktFetch(`/recommendations/${type}?limit=${limit}`);
};

// ── Watched progress (resume from Trakt) ──────────────────────────────────────
export const traktGetShowProgress = async (tmdbId) => {
  return traktFetch(`/shows/${tmdbId}/progress/watched`);
};

// ── Search Trakt ──────────────────────────────────────────────────────────────
export const traktSearch = async (query, type = "movie,show", limit = 5) => {
  return traktFetch(`/search/${type}?query=${encodeURIComponent(query)}&limit=${limit}`);
};

// ── Calendar (upcoming episodes) ───────────────────────────────────────────────
export const traktGetCalendar = async (days = 7) => {
  const startDate = new Date().toISOString().slice(0, 10);
  return traktFetch(`/calendars/my/shows/${startDate}/${days}`);
};

// ── Trending/Popular ──────────────────────────────────────────────────────────
export const traktGetTrending = async (type = "movies", limit = 10) => {
  return traktFetch(`/${type}/trending?limit=${limit}`);
};

export const traktGetPopular = async (type = "movies", limit = 10) => {
  return traktFetch(`/${type}/popular?limit=${limit}`);
};

// Initialize on module load
loadTokens();
