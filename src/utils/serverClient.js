// ── Jellyfin/Plex Client Mode ────────────────────────────────────────────────
// Connect to local Jellyfin or Plex server to stream from your own library.
// Supports browsing libraries, playback progress sync, and direct play.

const JELLYFIN_API = "/jellyfin";
const PLEX_API = "/plex";

let _serverConfig = null; // { type: 'jellyfin' | 'plex', url, token, userId }

// ── Server Configuration ─────────────────────────────────────────────────────
export function getServerConfig() {
  return _serverConfig;
}

export function setServerConfig(config) {
  _serverConfig = config;
  try {
    localStorage.setItem("streambert_serverConfig", JSON.stringify(config));
  } catch {}
}

export function clearServerConfig() {
  _serverConfig = null;
  localStorage.removeItem("streambert_serverConfig");
}

export function isServerConnected() {
  return !!_serverConfig;
}

// Load config on module init
try {
  const stored = localStorage.getItem("streambert_serverConfig");
  if (stored) _serverConfig = JSON.parse(stored);
} catch {}

// ── Jellyfin API ──────────────────────────────────────────────────────────────
const jellyfinFetch = async (path, options = {}) => {
  if (!_serverConfig || _serverConfig.type !== "jellyfin") {
    throw new Error("Jellyfin server not configured");
  }
  const res = await fetch(`${_serverConfig.url}${JELLYFIN_API}${path}`, {
    ...options,
    headers: {
      "X-Emby-Token": _serverConfig.token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  return res.json();
};

export const jellyfinGetLibraries = async () => {
  const data = await jellyfinFetch("/Library/VirtualFolders");
  return data.Items || [];
};

export const jellyfinGetItems = async (libraryId, params = {}) => {
  const query = new URLSearchParams({
    ParentId: libraryId,
    Fields: "Overview,Genres,ProductionYear,CommunityRating,UserData',
    ...params,
  });
  const data = await jellyfinFetch(`/Items?${query}`);
  return data.Items || [];
};

export const jellyfinGetPlaybackInfo = async (itemId) => {
  return jellyfinFetch(`/Items/${itemId}/PlaybackInfo`, {
    method: "POST",
    body: JSON.stringify({}),
  });
};

export const jellyfinReportProgress = async (itemId, positionTicks, played) => {
  await jellyfinFetch(`/Sessions/Playing/Progress`, {
    method: "POST",
    body: JSON.stringify({
      ItemId: itemId,
      PositionTicks: positionTicks,
      Played: played,
    }),
  });
};

// ── Plex API ─────────────────────────────────────────────────────────────────
const plexFetch = async (path, options = {}) => {
  if (!_serverConfig || _serverConfig.type !== "plex") {
    throw new Error("Plex server not configured");
  }
  const res = await fetch(`${_serverConfig.url}${PLEX_API}${path}`, {
    ...options,
    headers: {
      "X-Plex-Token": _serverConfig.token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Plex ${res.status}`);
  return res.json();
};

export const plexGetLibraries = async () => {
  const data = await plexFetch("/library/sections");
  return data.MediaContainer?.Directory || [];
};

export const plexGetItems = async (libraryKey) => {
  const data = await plexFetch(`/library/sections/${libraryKey}/all`);
  return data.MediaContainer?.Metadata || [];
};

// ── Unified API ──────────────────────────────────────────────────────────────
export const serverGetLibraries = async () => {
  if (!_serverConfig) return [];
  return _serverConfig.type === "jellyfin"
    ? jellyfinGetLibraries()
    : plexGetLibraries();
};

export const serverGetItems = async (libraryId) => {
  if (!_serverConfig) return [];
  return _serverConfig.type === "jellyfin"
    ? jellyfinGetItems(libraryId)
    : plexGetItems(libraryId);
};

// ── Stream URL builder ───────────────────────────────────────────────────────
export const serverGetStreamUrl = (itemId, quality = "original") => {
  if (!_serverConfig) return null;
  
  if (_serverConfig.type === "jellyfin") {
    return `${_serverConfig.url}/Videos/${itemId}/stream?static=true&api_key=${_serverConfig.token}`;
  }
  
  if (_serverConfig.type === "plex") {
    return `${_serverConfig.url}/library/parts/${itemId}?api_key=${_serverConfig.token}`;
  }
  
  return null;
};
