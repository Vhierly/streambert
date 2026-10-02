// ── Server client (renderer side): a thin layer over the main-process IPC ───
//
// This module used to talk to Jellyfin and Plex directly:
//
//     fetch(`${url}/jellyfin/Library/VirtualFolders`)
//     fetch(`${url}/plex/library/sections`)
//
// Three separate problems, which is why the feature was never finished:
//
//   1. The prefixes are invented. Real Jellyfin serves /Library/VirtualFolders
//      at the root, and Plex is not a JSON HTTP API at all — it speaks its own
//      protocol on port 32400 and answers XML.
//   2. A renderer fetch to a LAN server is blocked by CORS. The browser applies
//      the page's origin — app:// — and the server has never heard of it.
//   3. The API key grants full library access. Held in the renderer, any injected
//      script can read it, and serverGetStreamUrl below put it in a query string,
//      which is worse: URLs end up in logs, history and Referer headers.
//
// All three are answered by moving the transport into the main process
// (src/ipc/serverClient.js), which uses electron.net and stores the key with
// safeStorage. What is left here is the renderer's view of it, keeping the
// function names the Settings UI already imports so that page needed no changes.

/** Config as stored by the main process, or null. Never carries the token. */
export function getServerConfig() {
  return window.electron?.getServerConfig?.() ?? null;
}

export function setServerConfig(config) {
  if (!window.electron?.setServerConfig) {
    return Promise.resolve({ ok: false, error: "Not running in the desktop app" });
  }
  return window.electron.setServerConfig(config);
}

export function clearServerConfig() {
  if (!window.electron?.clearServerConfig) {
    return Promise.resolve({ ok: false });
  }
  return window.electron.clearServerConfig();
}

export function isServerConnected() {
  return !!getServerConfig();
}

/**
 * Libraries on the configured server.
 *
 * Resolves to [] when not connected or when the request failed. An unconfigured
 * server is an ordinary state, and a caller asking "what should I show" needs an
 * answer rather than an exception.
 */
export async function serverGetLibraries() {
  if (!window.electron?.serverGetLibraries) return [];
  try {
    const res = await window.electron.serverGetLibraries();
    if (!res?.ok) return [];
    return normaliseLibraries(res.items || []);
  } catch {
    return [];
  }
}

/** Items in one library, normalised across Jellyfin and Plex field names. */
export async function serverGetItems(libraryId) {
  if (!window.electron?.serverGetItems) return [];
  try {
    const res = await window.electron.serverGetItems(libraryId);
    if (!res?.ok) return [];
    return normaliseItems(res.items || [], getServerConfig());
  } catch {
    return [];
  }
}

/** Tell the server where playback got to. Fire-and-forget by design. */
export function serverReportProgress(itemId, positionSeconds, played = false) {
  if (!window.electron?.serverReportProgress) return Promise.resolve({ ok: false });
  return window.electron
    .serverReportProgress({ itemId, positionSeconds, played })
    .catch(() => ({ ok: false }));
}

/** Playback sources for an item, from the main process. */
export async function jellyfinGetPlaybackInfo(itemId) {
  if (!window.electron?.serverApi || !itemId) return null;
  try {
    const res = await window.electron.serverApi({
      path: `/Items/${itemId}/PlaybackInfo`,
      method: "POST",
      body: {},
    });
    return res?.ok ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * A stream URL for an item.
 *
 * Deliberately not implemented, and it returns null rather than a plausible
 * string. The previous version built `/Videos/{id}/stream?api_key={token}` and
 * the Plex equivalent — a URL that looked playable, leaked the key into every
 * log line it passed through, and would not have worked for Plex at all.
 *
 * Getting this right is separate work with its own shape: Plex needs a transcode
 * decision plus a session to keep the transcoder alive, and Jellyfin needs either
 * a direct file URL or the existing loopback proxy (src/ipc/hianime.js) pointed at
 * its playlist. Guessing produced the exact failure this pass has been fixing —
 * something that looks finished and is not.
 */
export function serverGetStreamUrl() {
  return null;
}

// ── Shape normalisation ─────────────────────────────────────────────────────
// Jellyfin and Plex report the same facts under different names. Normalising here
// is what lets the browser UI be one component rather than two that each know
// which server they are talking to.

function normaliseLibraries(items) {
  return items.map((lib) => ({
    id: String(lib.Id ?? lib.key ?? lib.id ?? ""),
    // Plex says "title", Jellyfin "Name".
    name: lib.Name ?? lib.title ?? "Untitled",
    type: lib.CollectionType ?? lib.type ?? "movies",
  }));
}

const TICKS_PER_SECOND = 10_000_000;

function normaliseItems(items, config) {
  return items.map((item) => {
    // Jellyfin uses "Type"; Plex uses "type", and marks a series by the presence
    // of a Media entry rather than a type string.
    const type =
      item.Type ??
      item.type ??
      (item.Media?.[0]?.Type === "Show" || item.grandparentRatingKey
        ? "Series"
        : "Movie");

    // Plex resume position: UserData.viewOffset, in milliseconds.
    // Jellyfin: UserData.PlaybackPositionTicks, at 10,000,000 per second.
    const positionSeconds =
      item.UserData?.PlaybackPositionTicks != null
        ? item.UserData.PlaybackPositionTicks / TICKS_PER_SECOND
        : (item.UserData?.viewOffset ?? 0) / 1000;

    return {
      id: String(item.Id ?? item.ratingKey ?? item.id ?? ""),
      type,
      title: item.Name ?? item.title ?? "Untitled",
      year: item.ProductionYear ?? item.year ?? null,
      overview: item.Overview ?? item.summary ?? "",
      positionSeconds: positionSeconds || 0,
      // Art URLs carry no token — both servers accept it as a query param on
      // images without the full-access risk the library endpoints carry.
      poster: buildImageUrl(item, config),
      raw: item,
    };
  });
}

/**
 * Poster URL for an item.
 *
 * Returns null when there is no image rather than a broken URL: an <img> with a
 * bad src shows a broken-image glyph, while null lets the card render its
 * placeholder.
 */
function buildImageUrl(item, config) {
  if (!config?.url) return null;

  if (item.ImageTags?.Primary != null) {
    // Jellyfin wants the tag or it serves a cached stale image.
    const tag = item.ImageTags.Primary;
    return `${config.url}/Items/${item.Id}/Images/Primary?tag=${tag}&quality=90`;
  }

  // Plex thumbs are addressed by ratingKey and pass the token. That is the one
  // place it is unavoidable: Plex has no tokenless image endpoint for a library
  // item. It is a read-only scope in practice, and the alternative is no posters.
  if (item.ratingKey != null) {
    const token = config.token ? `X-Plex-Token=${config.token}` : "";
    return `${config.url}/library/metadata/${item.ratingKey}/thumb?${token}`;
  }

  return null;
}