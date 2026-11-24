// ── 2-Way Account Sync (AniList & Trakt.tv) + Universal CSV/XML Importer ─────
// Pure client-side integration — credentials live exclusively in OS keychain
// via Electron safeStorage (never in localStorage or backup files).

import { storage, secureStorage, STORAGE_KEYS } from "./storage.js";
import { tmdbFetch, fetchAnilistData, isAnimeContent } from "./api.js";

const ANILIST_GQL = "https://graphql.anilist.co";
const TRAKT_API = "https://api.trakt.tv";

// ── Watched key parser ───────────────────────────────────────────────────────

export function parseWatchedKey(key) {
  if (typeof key !== "string") return null;
  const mMovie = /^movie_(\d+)$/.exec(key);
  if (mMovie) return { mediaType: "movie", tmdbId: Number(mMovie[1]) };
  const mTv = /^tv_(\d+)_s(\d+)e(\d+)$/.exec(key);
  if (mTv) {
    return {
      mediaType: "tv",
      tmdbId: Number(mTv[1]),
      season: Number(mTv[2]),
      episode: Number(mTv[3]),
    };
  }
  return null;
}

// ── AniList GraphQL Sync ─────────────────────────────────────────────────────

async function anilistRequest(token, query, variables = {}) {
  const res = await fetch(ANILIST_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors?.[0]?.message || `AniList HTTP ${res.status}`);
  }
  return json.data;
}

export async function verifyAnilistToken(token) {
  if (!token) throw new Error("Missing token");
  const data = await anilistRequest(token, `query { Viewer { id name } }`);
  return data?.Viewer || null;
}

export async function pushAnilistProgress({
  token,
  mediaId,
  progress = 1,
  completed = false,
}) {
  if (!token || !mediaId) return null;
  const query = `
    mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
        id
        status
        progress
      }
    }
  `;
  return anilistRequest(token, query, {
    mediaId: Number(mediaId),
    progress: Number(progress),
    status: completed ? "COMPLETED" : "CURRENT",
  });
}

export async function pullAnilistWatchlist(token) {
  const viewer = await verifyAnilistToken(token);
  if (!viewer?.id) throw new Error("Could not resolve AniList user");

  const query = `
    query ($userId: Int) {
      MediaListCollection(userId: $userId, type: ANIME) {
        lists {
          entries {
            status
            progress
            media {
              format
              seasonYear
              title { english romaji }
            }
          }
        }
      }
    }
  `;
  const data = await anilistRequest(token, query, { userId: viewer.id });
  const statusMap = {
    CURRENT: "watching",
    PLANNING: "plan",
    COMPLETED: "completed",
    PAUSED: "hold",
    DROPPED: "dropped",
  };

  const out = [];
  for (const list of data?.MediaListCollection?.lists || []) {
    for (const entry of list.entries || []) {
      const m = entry.media;
      const title = m?.title?.english || m?.title?.romaji;
      if (!title) continue;
      out.push({
        title,
        year: m?.seasonYear ? String(m.seasonYear) : "",
        mediaHint: m?.format === "MOVIE" ? "movie" : "tv",
        status: statusMap[entry.status] || "plan",
      });
    }
  }
  return out;
}

// ── Trakt.tv REST Sync ───────────────────────────────────────────────────────

function traktHeaders(clientId, token) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${token}`,
  };
}

export async function verifyTraktCredentials({ clientId, token }) {
  if (!clientId || !token) throw new Error("Missing Client ID or Token");
  const res = await fetch(`${TRAKT_API}/users/settings`, {
    headers: traktHeaders(clientId, token),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Trakt HTTP ${res.status}`);
  const data = await res.json();
  return data?.user || null;
}

export async function pushTraktWatched({
  clientId,
  token,
  mediaType,
  tmdbId,
  season,
  episode,
}) {
  if (!clientId || !token || !tmdbId) return null;
  const body =
    mediaType === "movie"
      ? { movies: [{ ids: { tmdb: Number(tmdbId) } }] }
      : {
          shows: [
            {
              ids: { tmdb: Number(tmdbId) },
              seasons: [
                {
                  number: Number(season || 1),
                  episodes: [{ number: Number(episode || 1) }],
                },
              ],
            },
          ],
        };
  const res = await fetch(`${TRAKT_API}/sync/history`, {
    method: "POST",
    headers: traktHeaders(clientId, token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Trakt sync HTTP ${res.status}`);
  return res.json();
}

export async function pullTraktWatchlist({ clientId, token }) {
  const res = await fetch(`${TRAKT_API}/sync/watchlist`, {
    headers: traktHeaders(clientId, token),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Trakt HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      if (r.movie?.ids?.tmdb) {
        return {
          tmdbId: r.movie.ids.tmdb,
          mediaType: "movie",
          title: r.movie.title,
          year: r.movie.year ? String(r.movie.year) : "",
          status: "plan",
        };
      }
      if (r.show?.ids?.tmdb) {
        return {
          tmdbId: r.show.ids.tmdb,
          mediaType: "tv",
          title: r.show.title,
          year: r.show.year ? String(r.show.year) : "",
          status: "plan",
        };
      }
      return null;
    })
    .filter(Boolean);
}

// ── Background Auto-Scrobble Hook (called from App.jsx markWatched) ──────────

export async function scrobbleWatchedKey(watchedKey, apiKey) {
  const parsed = parseWatchedKey(watchedKey);
  if (!parsed) return;

  // 1. Trakt.tv scrobble
  if (storage.get(STORAGE_KEYS.TRAKT_SYNC_ENABLED)) {
    Promise.all([
      secureStorage.get(STORAGE_KEYS.TRAKT_CLIENT_ID),
      secureStorage.get(STORAGE_KEYS.TRAKT_TOKEN),
    ])
      .then(([clientId, token]) => {
        if (clientId && token) {
          return pushTraktWatched({ clientId, token, ...parsed });
        }
      })
      .catch(() => {});
  }

  // 2. AniList scrobble (for anime content)
  if (storage.get(STORAGE_KEYS.ANILIST_SYNC_ENABLED) && apiKey) {
    secureStorage
      .get(STORAGE_KEYS.ANILIST_TOKEN)
      .then(async (token) => {
        if (!token) return;
        const details = await tmdbFetch(
          `/${parsed.mediaType}/${parsed.tmdbId}`,
          apiKey,
        );
        if (!isAnimeContent(details, details)) return;
        const title = details.title || details.name;
        const anilist = await fetchAnilistData(title, "ANIME", parsed.tmdbId);
        if (!anilist?.id) return;
        await pushAnilistProgress({
          token,
          mediaId: anilist.id,
          progress: parsed.mediaType === "movie" ? 1 : parsed.episode || 1,
          completed: parsed.mediaType === "movie",
        });
      })
      .catch(() => {});
  }
}

// ── Universal Watchlist File Parser (IMDb CSV, Letterboxd CSV, MAL XML) ──────

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export function parseWatchlistImport(text, filename = "") {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();

  // MyAnimeList XML export (<anime> blocks)
  if (filename.toLowerCase().endsWith(".xml") || trimmed.startsWith("<?xml") || trimmed.includes("<myanimelist>")) {
    const blocks = trimmed.match(/<anime>[\s\S]*?<\/anime>/gi) || [];
    const malStatus = {
      Watching: "watching",
      Completed: "completed",
      "On-Hold": "hold",
      Dropped: "dropped",
      "Plan to Watch": "plan",
    };
    return blocks
      .map((blk) => {
        const getTag = (tag) => {
          const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, "i").exec(blk);
          return (m?.[1] ?? m?.[2] ?? "").trim();
        };
        const title = getTag("series_title");
        if (!title) return null;
        const seriesType = getTag("series_type").toLowerCase();
        return {
          title,
          year: "",
          imdbId: null,
          mediaHint: seriesType === "movie" ? "movie" : "tv",
          status: malStatus[getTag("my_status")] || "plan",
        };
      })
      .filter(Boolean);
  }

  // CSV (IMDb or Letterboxd)
  const rows = parseCsvRows(trimmed);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.toLowerCase());

  const imdbIdx = header.findIndex((h) => h === "const" || h === "imdb id");
  const titleIdx = header.findIndex((h) => h === "title" || h === "name");
  const yearIdx = header.findIndex((h) => h === "year");
  const typeIdx = header.findIndex((h) => h === "title type" || h === "type");

  if (titleIdx === -1 && imdbIdx === -1) return [];

  return rows
    .slice(1)
    .map((cols) => {
      const imdbId = imdbIdx >= 0 ? cols[imdbIdx] || null : null;
      const title = titleIdx >= 0 ? cols[titleIdx] || "" : "";
      if (!title && !imdbId) return null;
      const year = yearIdx >= 0 ? (cols[yearIdx] || "").slice(0, 4) : "";
      const rawType = typeIdx >= 0 ? (cols[typeIdx] || "").toLowerCase() : "";
      const mediaHint =
        rawType.includes("tv") || rawType.includes("series") ? "tv" : "movie";
      return {
        title,
        year,
        imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null,
        mediaHint,
        status: "plan",
      };
    })
    .filter(Boolean);
}
