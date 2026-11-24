// ── Zero-Setup Built-in Torrent Auto-Indexers ────────────────────────────────
// Automatically searches Blu-Ray / WEB-DL torrents matching the exact Movie or
// TV/Anime Episode being viewed (via IMDb ID & title) with zero user setup.
// Uses Electron's DoH-protected `fetchJsonViaBridge` so ISP DNS blocks are bypassed.

import {
  buildMagnetFromStream,
  detectStreamQuality,
  fetchJsonViaBridge,
} from "./stremio.js";

export function formatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

/**
 * Parse YTS API `list_movies.json` response into normalized stream items.
 */
export function parseYtsResponse(json, fallbackTitle = "") {
  const movies = json?.data?.movies;
  if (!Array.isArray(movies) || movies.length === 0) return [];
  const out = [];

  for (const movie of movies) {
    const mTitle = movie?.title_long || movie?.title || fallbackTitle;
    const torrents = Array.isArray(movie?.torrents) ? movie.torrents : [];
    torrents.forEach((t, idx) => {
      if (!t?.hash) return;
      const magnetUrl = buildMagnetFromStream(
        { infoHash: t.hash, title: `${mTitle} [${t.quality}] [${t.type}]` },
        mTitle,
      );
      if (!magnetUrl) return;
      const codec = t.video_codec ? ` · ${t.video_codec.toUpperCase()}` : "";
      const kind = t.type ? t.type.toUpperCase() : "ENCODE";
      const seeds = Number(t.seeds || 0);
      const quality = detectStreamQuality({
        name: t.quality,
        title: `${t.quality} ${t.type}`,
      });

      out.push({
        id: `yts_${t.hash}_${idx}`,
        addonName: "Built-in · YTS Blu-Ray",
        sourceLabel: `${kind}${codec}`,
        details: `${mTitle} (${t.quality} ${kind}) · 📦 ${t.size || formatByteSize(t.size_bytes)} · 🌱 ${seeds} seeders`,
        quality,
        seeds,
        directUrl: null,
        externalUrl: null,
        magnetUrl,
        infoHash: t.hash.toLowerCase(),
        fileIdx: null,
        isDirect: false,
        streamHeaders: {},
        subtitles: [],
      });
    });
  }
  return out;
}

/**
 * Parse EZTV API `get-torrents` response and filter to matching Season & Episode.
 */
export function parseEztvResponse(json, season = 1, episode = 1) {
  const torrents = json?.torrents;
  if (!Array.isArray(torrents) || torrents.length === 0) return [];

  const targetS = Number(season || 1);
  const targetE = Number(episode || 1);
  const epRegex = new RegExp(
    `(?:s0*${targetS}[ ._\\-]*e0*${targetE}\\b|\\b${targetS}x0*${targetE}\\b)`,
    "i",
  );

  return torrents
    .filter((t) => {
      const sNum = Number(t.season);
      const eNum = Number(t.episode);
      if (sNum === targetS && eNum === targetE) return true;
      if (epRegex.test(t.title || t.filename || "")) return true;
      // Also allow full season packs (episode === 0) so sequential file selector picks SxxExx
      if (sNum === targetS && eNum === 0 && /complete|season/i.test(t.title || "")) {
        return true;
      }
      return false;
    })
    .map((t, idx) => {
      const magnetUrl =
        typeof t.magnet_url === "string" && t.magnet_url.startsWith("magnet:?")
          ? t.magnet_url
          : buildMagnetFromStream({ infoHash: t.hash, title: t.title }, t.title);
      if (!magnetUrl) return null;

      const seeds = Number(t.seeds || 0);
      const sizeStr = formatByteSize(t.size_bytes);
      const quality = detectStreamQuality({ title: t.title });

      return {
        id: `eztv_${t.hash || idx}`,
        addonName: "Built-in · EZTV",
        sourceLabel: "TV Torrent",
        details: `${t.title || t.filename}${sizeStr ? ` · 📦 ${sizeStr}` : ""} · 🌱 ${seeds} seeders`,
        quality,
        seeds,
        directUrl: null,
        externalUrl: null,
        magnetUrl,
        infoHash: t.hash ? String(t.hash).toLowerCase() : null,
        fileIdx: null,
        isDirect: false,
        streamHeaders: {},
        subtitles: [],
      };
    })
    .filter(Boolean);
}

/**
 * Parse AnimeTosho JSON feed response into normalized stream items.
 */
export function parseAnimeToshoResponse(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item, idx) => {
      const magnetUrl =
        typeof item?.magnet_uri === "string" && item.magnet_uri.startsWith("magnet:?")
          ? item.magnet_uri
          : buildMagnetFromStream(
              { infoHash: item?.info_hash, title: item?.title },
              item?.title,
            );
      if (!magnetUrl) return null;
      const seeds = Number(item.seeders ?? 0);
      const sizeStr = formatByteSize(item.total_size);
      const quality = detectStreamQuality({ title: item.title });

      return {
        id: `tosho_${item.info_hash || idx}`,
        addonName: "Built-in · AnimeTosho",
        sourceLabel: "Anime BD/WEB",
        details: `${item.title || "Anime Release"}${sizeStr ? ` · 📦 ${sizeStr}` : ""} · 🌱 ${seeds} seeders`,
        quality,
        seeds,
        directUrl: null,
        externalUrl: null,
        magnetUrl,
        infoHash: item.info_hash ? String(item.info_hash).toLowerCase() : null,
        fileIdx: null,
        isDirect: false,
        streamHeaders: {},
        subtitles: [],
      };
    })
    .filter(Boolean);
}

async function fetchFirstReachableJson(urls) {
  for (const u of urls) {
    try {
      return await fetchJsonViaBridge(u);
    } catch {
      // try next mirror
    }
  }
  return null;
}

/**
 * Automatically search built-in public torrent indexers for the exact title/episode.
 */
export async function searchBuiltInTorrents({
  mediaType,
  imdbId,
  title = "",
  season = 1,
  episode = 1,
}) {
  const results = [];
  const tasks = [];

  if (mediaType === "movie" && imdbId) {
    const q = encodeURIComponent(imdbId);
    tasks.push(
      fetchFirstReachableJson([
        `https://yts.mx/api/v2/list_movies.json?query_term=${q}`,
        `https://yts.lt/api/v2/list_movies.json?query_term=${q}`,
      ]).then((json) => {
        if (json) results.push(...parseYtsResponse(json, title));
      }),
    );
  }

  if (mediaType === "tv" && imdbId) {
    const numericImdb = String(imdbId).replace(/^tt/i, "");
    if (/^\d+$/.test(numericImdb)) {
      tasks.push(
        fetchFirstReachableJson([
          `https://eztvx.to/api/get-torrents?imdb_id=${numericImdb}&limit=100`,
          `https://eztv.re/api/get-torrents?imdb_id=${numericImdb}&limit=100`,
        ]).then((json) => {
          if (json) results.push(...parseEztvResponse(json, season, episode));
        }),
      );
    }
  }

  // Also query AnimeTosho by clean title + episode/movie query (great for Anime & BD remuxes)
  const cleanTitle = String(title || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanTitle) {
    const epPadded = String(episode || 1).padStart(2, "0");
    const toshoQuery =
      mediaType === "tv" ? `${cleanTitle} ${epPadded}` : cleanTitle;
    tasks.push(
      fetchJsonViaBridge(
        `https://feed.animetosho.org/json?qx=1&num=20&q=${encodeURIComponent(toshoQuery)}`,
      )
        .then((json) => {
          if (Array.isArray(json)) {
            results.push(...parseAnimeToshoResponse(json));
          }
        })
        .catch(() => {}),
    );
  }

  await Promise.all(tasks);

  // Deduplicate by infoHash and rank by quality + seeders
  const seen = new Set();
  const deduped = results.filter((item) => {
    const key = item.infoHash || item.magnetUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const qRank = { "4K": 5, "1080p": 4, "720p": 3, Auto: 2, "480p": 1, CAM: 0 };
  deduped.sort((a, b) => {
    const rDiff = (qRank[b.quality] ?? 1) - (qRank[a.quality] ?? 1);
    if (rDiff !== 0) return rDiff;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return deduped;
}
