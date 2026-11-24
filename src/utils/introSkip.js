// ── Live-Action Series Intro / Recap / Outro Skip (TheIntroDB) ──────────────
// Complements aniSkip.js (which handles Anime via MAL ID) with TMDB-based
// intro/recap/outro timestamps for live-action TV series.

const INTRODB_API = "https://api.theintrodb.org/v1/media";
export const INTRODB_CACHE_KEY = "streambert_introdbCache";
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

function getCache() {
  try {
    return JSON.parse(localStorage.getItem(INTRODB_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setCache(cache) {
  try {
    localStorage.setItem(INTRODB_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export function normalizeIntroDbResponse(data) {
  if (!data || typeof data !== "object") return null;
  const parseSeg = (seg) => {
    if (!seg || typeof seg !== "object") return null;
    const start =
      seg.start_sec ??
      (seg.start_ms != null ? seg.start_ms / 1000 : seg.startTime);
    const end =
      seg.end_sec ?? (seg.end_ms != null ? seg.end_ms / 1000 : seg.endTime);
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      end > start &&
      end - start >= 3
    ) {
      return { startTime: start, endTime: end };
    }
    return null;
  };

  const out = {};
  const intro = parseSeg(data.intro) || parseSeg(data.recap);
  const outro = parseSeg(data.outro) || parseSeg(data.credits);
  if (intro) out.intro = intro;
  if (outro) out.outro = outro;
  return Object.keys(out).length > 0 ? out : null;
}

export async function fetchLiveIntroTimings(tmdbId, season, episode) {
  if (!tmdbId || season == null || episode == null) return null;
  const cacheKey = `${tmdbId}_s${season}_e${episode}`;
  const cache = getCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  try {
    const res = await fetch(
      `${INTRODB_API}?tmdb_id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 404) {
      cache[cacheKey] = { data: null, expiresAt: Date.now() + CACHE_TTL };
      setCache(cache);
      return null;
    }
    if (!res.ok) return null;
    const raw = await res.json();
    const timings = normalizeIntroDbResponse(raw);
    cache[cacheKey] = { data: timings, expiresAt: Date.now() + CACHE_TTL };
    setCache(cache);
    return timings;
  } catch {
    return null;
  }
}
