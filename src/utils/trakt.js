// ── Trakt.tv API Integration ──────────────────────────────────────────────────
// Docs: https://trakt.docs.apiary.io
// OAuth flow: https://trakt.tv/oauth/applications

const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_OAUTH = "https://trakt.tv/oauth";

// Client ID from Streambert's Trakt app (public, for open-source apps)
// Users can override with their own via settings
const DEFAULT_CLIENT_ID = "streambert";

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

// ── OAuth Device Flow (no browser popup needed) ───────────────────────────────
// Returns a device code for the user to enter at trakt.tv/activate
export const traktStartDeviceAuth = async () => {
  const res = await fetch(`${TRAKT_OAUTH}/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: _clientId }),
  });
  if (!res.ok) throw new Error("Trakt device auth failed");
  return res.json(); // { user_code, device_code, expires_in, interval, verification_url }
};

export const traktPollDeviceAuth = async (deviceCode, interval = 5) => {
  // Poll until user authorizes or timeout
  const maxAttempts = Math.floor(900 / interval); // 15 min max
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(`${TRAKT_OAUTH}/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: deviceCode,
        client_id: _clientId,
        client_secret: "", // Public app — no secret
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
    if (err.error === "expired_token") return { ok: false, error: "Code expired" };
    if (err.error === "access_denied") return { ok: false, error: "Denied" };
    return { ok: false, error: err.error || "Unknown error" };
  }
  return { ok: false, error: "Timeout" };
};

// ── API Helpers ───────────────────────────────────────────────────────────────
const traktHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${_accessToken}`,
  "trakt-api-version": "2",
  "trakt-api-key": _clientId,
});

const traktFetch = async (path, options = {}) => {
  loadTokens();
  if (!_accessToken) throw new Error("Not connected to Trakt");
  const res = await fetch(`${TRAKT_BASE}${path}`, {
    ...options,
    headers: { ...traktHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    // Token expired — try refresh
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
