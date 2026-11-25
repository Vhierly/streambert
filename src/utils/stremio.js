// ── Stremio Addon Protocol v1 Bridge Utilities ──────────────────────────────
// Pure helpers for normalizing manifest URLs, building stream endpoints,
// parsing resolution/quality badges, and formatting magnet fallbacks.

import { storage, STORAGE_KEYS } from "./storage.js";

/**
 * Normalize a user-supplied Stremio addon URL (`stremio://...` or `https://...`)
 * into `{ manifestUrl, baseUrl }`.
 */
export function normalizeAddonUrl(input) {
  if (!input || typeof input !== "string") return null;
  let cleaned = input.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }
  try {
    const u = new URL(cleaned);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    let pathname = u.pathname.replace(/\/+$/, "");
    if (!pathname.endsWith("/manifest.json")) {
      pathname = `${pathname}/manifest.json`;
    }
    const manifestUrl = `${u.origin}${pathname}${u.search}`;
    const baseUrl = `${u.origin}${pathname.slice(0, -"/manifest.json".length)}`;
    return { manifestUrl, baseUrl };
  } catch {
    return null;
  }
}

/**
 * Validate a Stremio manifest object and check if it exposes `stream` resources.
 */
export function validateStremioManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.id || !manifest.name) {
    return { valid: false, reason: "Invalid Stremio manifest JSON" };
  }
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const supportsStream = resources.some((r) =>
    typeof r === "string" ? r === "stream" : r?.name === "stream",
  );
  return {
    valid: true,
    supportsStream,
    id: String(manifest.id),
    name: String(manifest.name),
    version: String(manifest.version || "1.0.0"),
    description: String(manifest.description || ""),
    logo: typeof manifest.logo === "string" ? manifest.logo : null,
    types: Array.isArray(manifest.types) ? manifest.types : ["movie", "series"],
  };
}

/**
 * Build the Stremio stream endpoint URL for an IMDb ID.
 * @param {string} baseUrl  Addon base URL (without trailing `/manifest.json`)
 * @param {"movie"|"tv"|"series"} mediaType
 * @param {string} imdbId   e.g. "tt0133093"
 * @param {number} [season]
 * @param {number} [episode]
 */
export function buildStremioStreamUrl(
  baseUrl,
  mediaType,
  imdbId,
  season = null,
  episode = null,
) {
  if (!baseUrl || !imdbId || !/^tt\d+$/i.test(imdbId)) return null;
  const cleanBase = String(baseUrl).replace(/\/+$/, "");
  const stremioType = mediaType === "movie" ? "movie" : "series";
  const videoId =
    stremioType === "movie"
      ? imdbId
      : `${imdbId}:${Number(season || 1)}:${Number(episode || 1)}`;
  return `${cleanBase}/stream/${stremioType}/${encodeURIComponent(videoId)}.json`;
}

/**
 * Extract quality badge ("4K", "1080p", "720p", "480p", "CAM") from stream text.
 */
export function detectStreamQuality(stream) {
  const hay = `${stream?.name || ""} ${stream?.title || ""} ${stream?.description || ""}`;
  if (/\b(2160p|4k|uhd)\b/i.test(hay)) return "4K";
  if (/\b1080p\b/i.test(hay)) return "1080p";
  if (/\b720p\b/i.test(hay)) return "720p";
  if (/\b480p\b/i.test(hay)) return "480p";
  if (/\b(cam|ts|hdcam)\b/i.test(hay)) return "CAM";
  return "Auto";
}

/**
 * Build a magnet URI when an addon stream provides `infoHash` instead of HTTP `url`.
 */
export function buildMagnetFromStream(stream, fallbackTitle = "") {
  const hash = stream?.infoHash;
  if (!hash || !/^[a-f0-9]{32,40}$/i.test(hash)) return null;
  const params = new URLSearchParams();
  const dn = stream.title?.split("\n")?.[0] || fallbackTitle;
  if (dn) params.set("dn", dn.slice(0, 140));
  const sources = Array.isArray(stream.sources) ? stream.sources : [];
  const trackers = sources
    .filter((s) => typeof s === "string" && s.startsWith("tracker:"))
    .map((s) => s.slice("tracker:".length));
  let magnet = `magnet:?xt=urn:btih:${hash}`;
  if (params.toString()) magnet += `&${params.toString()}`;
  for (const tr of trackers.slice(0, 12)) {
    magnet += `&tr=${encodeURIComponent(tr)}`;
  }
  return magnet;
}

/**
 * Extract seeder count from Stremio stream object or formatted description (`👤 240`, `🌱 240`, `Seeds: 240`).
 */
export function extractStreamSeeds(stream) {
  if (typeof stream?.seeds === "number" && Number.isFinite(stream.seeds)) {
    return stream.seeds;
  }
  if (typeof stream?.seeders === "number" && Number.isFinite(stream.seeders)) {
    return stream.seeders;
  }
  const hay = `${stream?.title || ""} ${stream?.description || ""} ${stream?.name || ""}`;
  const m = /(?:(?:👤|🌱)\s*|\bseeds?\s*[:=-]?\s*)(\d+)/iu.exec(hay);
  return m ? Number(m[1]) : 0;
}

/**
 * Extract release group tag (e.g. "subsplease", "erai-raws", "flux", "ntb") from stream text.
 */
export function extractReleaseGroupTag(stream) {
  const hay = `${stream?.details || ""} ${stream?.title || ""} ${stream?.sourceLabel || ""}`;
  const bracket = /\[([a-zA-Z0-9._-]{3,24})\]/.exec(hay);
  if (
    bracket &&
    !/^(1080p|720p|2160p|480p|4k|uhd|web|bd|bluray|hevc|x264|x265|h264|h265|aac|eac3|ac3|hdr|10bit)$/i.test(
      bracket[1],
    )
  ) {
    return bracket[1].toLowerCase();
  }
  const scene = /-([a-zA-Z0-9]{3,16})(?:\.[a-z0-9]{2,4})?(?:\s|$|\)|\[|·)/i.exec(
    hay,
  );
  if (scene) return scene[1].toLowerCase();
  return "";
}

/**
 * Pick the best matching stream for the next episode during Binge-Watch auto-advance.
 */
export function pickBestNextEpisodeStream(candidates = [], previousStream = null) {
  const playable = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && (c.isDirect || c.magnetUrl),
  );
  if (playable.length === 0) return null;
  if (!previousStream) return playable[0];

  const prevGroup = extractReleaseGroupTag(previousStream);
  const qRank = { "4K": 5, "1080p": 4, "720p": 3, Auto: 2, "480p": 1, CAM: 0 };

  let best = playable[0];
  let bestScore = -Infinity;

  for (const cand of playable) {
    let score = 0;
    if (previousStream.infoHash && cand.infoHash === previousStream.infoHash) {
      score += 130;
    }
    if (Boolean(cand.isDirect) === Boolean(previousStream.isDirect)) {
      score += 45;
    }
    if (cand.addonName && cand.addonName === previousStream.addonName) {
      score += 28;
    }
    const candGroup = extractReleaseGroupTag(cand);
    if (prevGroup && candGroup && prevGroup === candGroup) {
      score += 65;
    }
    if (cand.quality && cand.quality === previousStream.quality) {
      score += 32;
    } else {
      score += (qRank[cand.quality] ?? 1) * 3;
    }
    const seeds = Number(cand.seeds || 0);
    score += Math.min(25, seeds / 4);
    if (!cand.isDirect && seeds === 0 && !previousStream.infoHash) {
      score -= 35;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  return best;
}

/**
 * Normalize raw streams returned by an addon into UI-ready items.
 */
export function normalizeAddonStreams(rawStreams = [], addonName = "Addon", fallbackTitle = "") {
  if (!Array.isArray(rawStreams)) return [];
  return rawStreams
    .map((s, idx) => {
      if (!s || typeof s !== "object") return null;
      const directUrl =
        typeof s.url === "string" && /^https?:\/\//i.test(s.url) ? s.url : null;
      const externalUrl =
        typeof s.externalUrl === "string" && /^https?:\/\//i.test(s.externalUrl)
          ? s.externalUrl
          : null;
      const magnetUrl = !directUrl ? buildMagnetFromStream(s, fallbackTitle) : null;
      if (!directUrl && !externalUrl && !magnetUrl) return null;

      const reqHeaders = s.behaviorHints?.proxyHeaders?.request || {};
      const streamHeaders = {
        referer: reqHeaders.Referer || reqHeaders.referer || "",
        origin: reqHeaders.Origin || reqHeaders.origin || "",
        userAgent: reqHeaders["User-Agent"] || reqHeaders["user-agent"] || "",
      };
      const subtitles = Array.isArray(s.subtitles)
        ? s.subtitles
            .filter((sub) => sub?.url && /^https?:\/\//i.test(sub.url))
            .map((sub) => ({
              url: sub.url,
              lang: String(sub.lang || "sub").slice(0, 12),
            }))
        : [];

      const rawLabel = String(s.title || s.description || s.name || "Stream").trim();
      const quality = detectStreamQuality(s);
      const seeds = extractStreamSeeds(s);

      return {
        id: `${addonName}_${idx}_${s.infoHash || directUrl || externalUrl}`,
        addonName,
        sourceLabel: String(s.name || addonName).replace(/\s+/g, " ").trim(),
        details: rawLabel,
        quality,
        seeds,
        directUrl,
        externalUrl,
        magnetUrl,
        infoHash: s.infoHash ? String(s.infoHash).toLowerCase() : null,
        fileIdx: typeof s.fileIdx === "number" ? s.fileIdx : null,
        isDirect: !!directUrl,
        streamHeaders,
        subtitles,
      };
    })
    .filter(Boolean);
}

// ── Curated 1-Click Community Stream Addons ─────────────────────────────────

export const FEATURED_COMMUNITY_ADDONS = [
  {
    id: "com.stremio.torrentio.addon",
    name: "Torrentio",
    badge: "Most Popular",
    kind: "P2P + Debrid",
    manifestUrl: "https://torrentio.strem.fun/manifest.json",
    configureUrl: "https://torrentio.strem.fun/configure",
    description:
      "Largest 4K REMUX / 1080p Blu-Ray / Anime multi-tracker index (YTS, EZTV, 1337x, RARBG, Nyaa).",
  },
  {
    id: "com.hayduk.webstreamr",
    name: "WebStreamr",
    badge: "Direct HTTP",
    kind: "No P2P Needed",
    manifestUrl: "https://webstreamr.hayd.uk/manifest.json",
    configureUrl: "https://webstreamr.hayd.uk/configure",
    description:
      "Direct HTTP/HLS multi-hoster streams for Movies & TV Series without BitTorrent.",
  },
  {
    id: "com.nuvio.streams",
    name: "Nuvio Streams",
    badge: "Direct HTTP",
    kind: "Fast Direct",
    manifestUrl: "https://nuviostreams.hayd.uk/manifest.json",
    configureUrl: "https://nuviostreams.hayd.uk/",
    description:
      "High-bitrate direct HTTP streams with multi-audio and 4K/1080p links.",
  },
  {
    id: "com.elfhosted.mediafusion",
    name: "MediaFusion (ElfHosted)",
    badge: "All-in-One",
    kind: "Movies, TV & Anime",
    manifestUrl: "https://mediafusion.elfhosted.com/manifest.json",
    configureUrl: "https://mediafusion.elfhosted.com/configure",
    description:
      "Universal stream provider for global Movies, Series, Anime, and live events.",
  },
  {
    id: "com.elfhosted.comet",
    name: "Comet (ElfHosted)",
    badge: "Fast Search",
    kind: "P2P + Debrid",
    manifestUrl: "https://comet.elfhosted.com/manifest.json",
    configureUrl: "https://comet.elfhosted.com/configure",
    description:
      "Ultra-fast torrent and debrid stream aggregator hosted by ElfHosted.",
  },
  {
    id: "com.stremio.tpbplus",
    name: "ThePirateBay+",
    badge: "Classic",
    kind: "P2P Archive",
    manifestUrl: "https://thepiratebay-plus.strem.fun/manifest.json",
    configureUrl: null,
    description:
      "Broad torrent catalog for classic, indie, and hard-to-find Movies & Shows.",
  },
];

// ── Persistence helpers ──────────────────────────────────────────────────────

export function loadInstalledAddons() {
  const list = storage.get(STORAGE_KEYS.STREMIO_ADDONS);
  return Array.isArray(list) ? list : [];
}

export function saveInstalledAddons(list) {
  storage.set(STORAGE_KEYS.STREMIO_ADDONS, list);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("streambert:addons-changed"));
  }
}

export async function installAddonFromUrl(rawUrl) {
  const parsed = normalizeAddonUrl(rawUrl);
  if (!parsed) {
    throw new Error("Invalid https://.../manifest.json or stremio://... URL.");
  }
  const raw = await fetchJsonViaBridge(parsed.manifestUrl);
  const check = validateStremioManifest(raw);
  if (!check.valid) {
    throw new Error(check.reason || "Invalid addon manifest.");
  }
  if (!check.supportsStream) {
    throw new Error(
      `"${check.name}" is a catalog/metadata addon only and does not provide streams.`,
    );
  }
  const nextAddon = {
    id: check.id,
    name: check.name,
    version: check.version,
    description: check.description,
    logo: check.logo,
    types: check.types,
    manifestUrl: parsed.manifestUrl,
    baseUrl: parsed.baseUrl,
    enabled: true,
    installedAt: Date.now(),
  };
  const current = loadInstalledAddons();
  const idx = current.findIndex(
    (a) => a.id === nextAddon.id || a.baseUrl === nextAddon.baseUrl,
  );
  const updated =
    idx >= 0
      ? current.map((a, i) => (i === idx ? { ...a, ...nextAddon } : a))
      : [...current, nextAddon];
  saveInstalledAddons(updated);
  return { addon: nextAddon, list: updated };
}

export async function fetchJsonViaBridge(url) {
  if (typeof window !== "undefined" && window.electron?.stremioFetchJson) {
    const res = await window.electron.stremioFetchJson(url);
    if (!res?.ok) throw new Error(res?.error || "Addon request failed");
    return res.data;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function queryEnabledAddons({
  mediaType,
  imdbId,
  season = null,
  episode = null,
  title = "",
}) {
  const addons = loadInstalledAddons().filter((a) => a && a.enabled !== false);
  if (!addons.length || !imdbId) return { streams: [], errors: [] };

  const streams = [];
  const errors = [];

  await Promise.all(
    addons.map(async (addon) => {
      const url = buildStremioStreamUrl(
        addon.baseUrl,
        mediaType,
        imdbId,
        season,
        episode,
      );
      if (!url) return;
      try {
        const data = await fetchJsonViaBridge(url);
        const parsed = normalizeAddonStreams(
          data?.streams || [],
          addon.name,
          title,
        );
        streams.push(...parsed);
      } catch (e) {
        errors.push({ addon: addon.name, error: e.message });
      }
    }),
  );

  // Rank direct HTTP/Debrid streams first, then by quality tier (4K > 1080p > 720p)
  const rank = { "4K": 5, "1080p": 4, "720p": 3, Auto: 2, "480p": 1, CAM: 0 };
  streams.sort((a, b) => {
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return (rank[b.quality] ?? 1) - (rank[a.quality] ?? 1);
  });

  return { streams, errors };
}
