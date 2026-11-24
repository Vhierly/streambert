// ── Discover / Explore & Smart Search Utilities ──────────────────────────────
// Pure helpers shared by ExplorePage, SearchModal, and unit tests.

export const DISCOVER_MODES = [
  { id: "movie", label: "Movies", mediaType: "movie", isAnime: false },
  { id: "tv", label: "TV Series", mediaType: "tv", isAnime: false },
  { id: "anime_tv", label: "Anime Series", mediaType: "tv", isAnime: true },
  { id: "anime_movie", label: "Anime Movies", mediaType: "movie", isAnime: true },
];

export const DISCOVER_SORTS = [
  { value: "popularity.desc", label: "Most Popular" },
  { value: "vote_average.desc", label: "Highest Rated" },
  { value: "release_date.desc", label: "Newest Releases" },
  { value: "vote_count.desc", label: "Most Voted" },
];

export const POPULAR_PROVIDERS = [
  { id: 8, label: "Netflix" },
  { id: 9, label: "Prime Video" },
  { id: 337, label: "Disney+" },
  { id: 1899, label: "Max" },
  { id: 350, label: "Apple TV+" },
  { id: 283, label: "Crunchyroll" },
  { id: 15, label: "Hulu" },
  { id: 531, label: "Paramount+" },
];

export const YEAR_PRESETS = [
  { value: "", label: "Any Year" },
  { value: "2026", label: "2026" },
  { value: "2025", label: "2025" },
  { value: "2024", label: "2024" },
  { value: "2020s", label: "2020s" },
  { value: "2010s", label: "2010s" },
  { value: "2000s", label: "2000s" },
  { value: "1990s", label: "1990s" },
  { value: "classic", label: "Before 1990" },
];

export const RATING_FLOOR_OPTIONS = [
  { value: 0, label: "Any Rating" },
  { value: 6, label: "★ 6.0+" },
  { value: 7, label: "★ 7.0+" },
  { value: 7.5, label: "★ 7.5+" },
  { value: 8, label: "★ 8.0+" },
  { value: 8.5, label: "★ 8.5+" },
];

export const LANGUAGE_OPTIONS = [
  { value: "", label: "Any Language" },
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "id", label: "Indonesian" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "zh", label: "Chinese" },
  { value: "hi", label: "Hindi" },
];

export const DEFAULT_EXPLORE_FILTERS = {
  mode: "movie",
  genres: [],
  yearPreset: "",
  minRating: 0,
  providerId: null,
  origLang: "",
  sortBy: "popularity.desc",
};

export function hasCustomExploreFilters(filters) {
  if (!filters) return false;
  return (
    (filters.mode && filters.mode !== DEFAULT_EXPLORE_FILTERS.mode) ||
    (Array.isArray(filters.genres) && filters.genres.length > 0) ||
    !!filters.yearPreset ||
    Number(filters.minRating || 0) > 0 ||
    filters.providerId != null ||
    !!filters.origLang ||
    (filters.sortBy && filters.sortBy !== DEFAULT_EXPLORE_FILTERS.sortBy)
  );
}

/**
 * Resolve a year/decade preset into inclusive YYYY-MM-DD bounds.
 */
export function resolveYearBounds(yearPreset) {
  if (!yearPreset) return { gte: null, lte: null };
  if (/^\d{4}$/.test(yearPreset)) {
    return { gte: `${yearPreset}-01-01`, lte: `${yearPreset}-12-31` };
  }
  const decadeMatch = String(yearPreset).match(/^(\d{4})s$/);
  if (decadeMatch) {
    const start = Number(decadeMatch[1]);
    return { gte: `${start}-01-01`, lte: `${start + 9}-12-31` };
  }
  if (yearPreset === "classic") {
    return { gte: null, lte: "1989-12-31" };
  }
  return { gte: null, lte: null };
}

/**
 * Build a TMDB /discover/{movie|tv} path and resolved mediaType from UI filters.
 */
export function buildDiscoverPath(
  filters = {},
  page = 1,
  { watchRegion = "US", todayStr = null } = {},
) {
  const merged = { ...DEFAULT_EXPLORE_FILTERS, ...filters };
  const modeMeta =
    DISCOVER_MODES.find((m) => m.id === merged.mode) || DISCOVER_MODES[0];
  const kind = modeMeta.mediaType;
  const isAnime = modeMeta.isAnime;

  const params = new URLSearchParams();
  params.set("include_adult", "false");
  params.set("page", String(Math.max(1, Number(page) || 1)));

  // Adapt release_date sort key between movie and tv endpoints
  let sortKey = merged.sortBy || "popularity.desc";
  if (sortKey === "release_date.desc") {
    sortKey =
      kind === "movie" ? "primary_release_date.desc" : "first_air_date.desc";
  }
  params.set("sort_by", sortKey);

  // Merge user-selected genres with Animation (16) when in an Anime mode
  const genreSet = new Set(
    (Array.isArray(merged.genres) ? merged.genres : [])
      .map((g) => Number(g))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
  if (isAnime) genreSet.add(16);
  if (genreSet.size > 0) {
    params.set("with_genres", [...genreSet].join(","));
  }

  if (isAnime) {
    params.set("with_origin_country", "JP");
  }

  if (merged.origLang && !isAnime) {
    params.set("with_original_language", merged.origLang);
  }

  const minRating = Number(merged.minRating) || 0;
  if (minRating > 0) {
    params.set("vote_average.gte", String(minRating));
  }

  // Prevent 1-vote obscure entries from dominating rating sorts / floors
  if (sortKey === "vote_average.desc") {
    params.set("vote_count.gte", isAnime ? "80" : "150");
  } else if (minRating > 0) {
    params.set("vote_count.gte", "30");
  }

  // Date bounds
  const { gte, lte } = resolveYearBounds(merged.yearPreset);
  const dateField = kind === "movie" ? "primary_release_date" : "first_air_date";
  const today = todayStr || new Date().toISOString().slice(0, 10);

  if (gte) params.set(`${dateField}.gte`, gte);
  if (lte) {
    params.set(`${dateField}.lte`, lte);
  } else if (
    sortKey === "primary_release_date.desc" ||
    sortKey === "first_air_date.desc"
  ) {
    params.set(`${dateField}.lte`, today);
  }

  if (merged.providerId != null && merged.providerId !== "") {
    params.set("with_watch_providers", String(merged.providerId));
    params.set("watch_region", watchRegion || "US");
  }

  return {
    path: `/discover/${kind}?${params.toString()}`,
    mediaType: kind,
  };
}

/**
 * Lightweight anime check for TMDB search results.
 */
export function isAnimeSearchResult(item) {
  if (!item || (item.media_type !== "movie" && item.media_type !== "tv")) {
    return false;
  }
  const genres = item.genre_ids || [];
  const countries = item.origin_country || [];
  return (
    genres.includes(16) &&
    (item.original_language === "ja" || countries.includes("JP"))
  );
}

/**
 * Filter /search/multi results according to the active SearchModal tab.
 * Tabs: "all" | "movie" | "tv" | "anime" | "person"
 */
export function filterSearchResults(results, tab = "all") {
  if (!Array.isArray(results)) return [];
  const valid = results.filter(
    (r) =>
      r &&
      (r.media_type === "movie" ||
        r.media_type === "tv" ||
        r.media_type === "person"),
  );
  if (tab === "movie") return valid.filter((r) => r.media_type === "movie");
  if (tab === "tv") return valid.filter((r) => r.media_type === "tv");
  if (tab === "anime") return valid.filter(isAnimeSearchResult);
  if (tab === "person") return valid.filter((r) => r.media_type === "person");
  return valid;
}

/**
 * Pick a random item from a non-empty list.
 */
export function pickRandomItem(items, randomFn = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const idx = Math.min(
    items.length - 1,
    Math.max(0, Math.floor(randomFn() * items.length)),
  );
  return items[idx];
}
