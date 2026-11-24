import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import MediaCard from "../components/MediaCard";
import { tmdbFetch } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted, getRatingCountry } from "../utils/ageRating";
import { storage, STORAGE_KEYS } from "../utils/storage";
import {
  DISCOVER_MODES,
  DISCOVER_SORTS,
  POPULAR_PROVIDERS,
  YEAR_PRESETS,
  RATING_FLOOR_OPTIONS,
  LANGUAGE_OPTIONS,
  DEFAULT_EXPLORE_FILTERS,
  hasCustomExploreFilters,
  buildDiscoverPath,
  pickRandomItem,
} from "../utils/discover";

// Session-scoped genre list cache per media kind ("movie" | "tv")
const _genreCache = new Map();

export default function ExplorePage({
  apiKey,
  offline,
  onSelect,
  progress,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  savedList = [],
  showToast,
}) {
  const [filters, setFilters] = useState(() => {
    const saved = storage.get(STORAGE_KEYS.EXPLORE_FILTERS);
    return saved
      ? { ...DEFAULT_EXPLORE_FILTERS, ...saved }
      : DEFAULT_EXPLORE_FILTERS;
  });

  const [genresList, setGenresList] = useState([]);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [surprising, setSurprising] = useState(false);
  const sentinelRef = useRef(null);

  const activeMode = useMemo(
    () =>
      DISCOVER_MODES.find((m) => m.id === filters.mode) || DISCOVER_MODES[0],
    [filters.mode],
  );
  const mediaKind = activeMode.mediaType;
  const watchRegion = useMemo(() => getRatingCountry(storage) || "US", []);

  // Persist filters on change
  useEffect(() => {
    storage.set(STORAGE_KEYS.EXPLORE_FILTERS, filters);
  }, [filters]);

  // Fetch genre list for current media kind ("movie" or "tv")
  useEffect(() => {
    if (!apiKey || offline) return;
    if (_genreCache.has(mediaKind)) {
      setGenresList(_genreCache.get(mediaKind));
      return;
    }
    let mounted = true;
    tmdbFetch(`/genre/${mediaKind}/list`, apiKey)
      .then((data) => {
        const list = data?.genres || [];
        _genreCache.set(mediaKind, list);
        if (mounted) setGenresList(list);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [apiKey, offline, mediaKind]);

  // Fetch page 1 whenever filters change
  useEffect(() => {
    if (!apiKey || offline) return;
    let cancelled = false;
    setLoading(true);
    setPage(1);

    const { path, mediaType } = buildDiscoverPath(filters, 1, { watchRegion });
    tmdbFetch(path, apiKey)
      .then((data) => {
        if (cancelled) return;
        const results = (data?.results || []).map((item) => ({
          ...item,
          media_type: mediaType,
        }));
        setItems(results);
        setTotalPages(Math.min(data?.total_pages || 1, 500));
        setTotalResults(data?.total_results || results.length);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setTotalPages(1);
          setTotalResults(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, offline, filters, watchRegion]);

  // Load next page
  const loadNextPage = useCallback(() => {
    if (!apiKey || offline || loading || loadingMore || page >= totalPages) {
      return;
    }
    const nextPage = page + 1;
    setLoadingMore(true);
    const { path, mediaType } = buildDiscoverPath(filters, nextPage, {
      watchRegion,
    });
    tmdbFetch(path, apiKey)
      .then((data) => {
        const incoming = (data?.results || []).map((item) => ({
          ...item,
          media_type: mediaType,
        }));
        setItems((prev) => {
          const seen = new Set(prev.map((i) => `${i.media_type}_${i.id}`));
          const unique = incoming.filter(
            (i) => !seen.has(`${i.media_type}_${i.id}`),
          );
          return [...prev, ...unique];
        });
        setPage(nextPage);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [apiKey, offline, loading, loadingMore, page, totalPages, filters, watchRegion]);

  // Infinite scroll observer
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadNextPage();
      },
      { rootMargin: "320px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadNextPage]);

  // Age ratings & restriction filtering
  const { ratingsMap, ageLimitSetting } = useRatings(items);
  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) => isRestricted(getRating(item).minAge, ageLimitSetting),
    [getRating, ageLimitSetting],
  );
  const visibleItems = useMemo(
    () => items.filter((item) => !itemRestricted(item)),
    [items, itemRestricted],
  );

  // Filter mutators
  const updateFilter = useCallback((patch) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleModeChange = useCallback((modeId) => {
    setFilters((prev) => ({
      ...prev,
      mode: modeId,
      // Reset genre chips when switching movie <-> tv because some genre IDs differ
      genres: [],
    }));
  }, []);

  const toggleGenre = useCallback((genreId) => {
    setFilters((prev) => {
      const exists = prev.genres.includes(genreId);
      const nextGenres = exists
        ? prev.genres.filter((id) => id !== genreId)
        : [...prev.genres, genreId];
      return { ...prev, genres: nextGenres };
    });
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_EXPLORE_FILTERS);
  }, []);

  // Surprise Me: sample a random page (1..min(totalPages, 10)) from active filters
  const handleSurpriseMe = useCallback(async () => {
    if (!apiKey || offline || surprising) return;
    setSurprising(true);
    try {
      const maxPage = Math.max(1, Math.min(totalPages || 1, 10));
      const randomPage = Math.floor(Math.random() * maxPage) + 1;
      const { path, mediaType } = buildDiscoverPath(filters, randomPage, {
        watchRegion,
      });
      const data = await tmdbFetch(path, apiKey);
      const candidates = (data?.results || [])
        .map((i) => ({ ...i, media_type: mediaType }))
        .filter((i) => !itemRestricted(i));
      const picked = pickRandomItem(candidates.length ? candidates : visibleItems);
      if (picked) {
        onSelect(picked);
      } else {
        showToast?.("No matching titles found for Surprise Me");
      }
    } catch {
      const fallback = pickRandomItem(visibleItems);
      if (fallback) onSelect(fallback);
    } finally {
      setSurprising(false);
    }
  }, [
    apiKey,
    offline,
    surprising,
    totalPages,
    filters,
    watchRegion,
    itemRestricted,
    visibleItems,
    onSelect,
    showToast,
  ]);

  // Pick a random unwatched item from the user's Watchlist
  const handleRandomWatchlist = useCallback(() => {
    if (!savedList.length) return;
    const unwatched = savedList.filter((item) => {
      const pk =
        item.media_type === "movie" ? `movie_${item.id}` : `tv_${item.id}_s1e1`;
      return !watched?.[pk];
    });
    const picked = pickRandomItem(unwatched.length ? unwatched : savedList);
    if (picked) onSelect(picked);
  }, [savedList, watched, onSelect]);

  const isCustomized = hasCustomExploreFilters(filters);

  return (
    <div className="fade-in explore-page">
      {/* ── Header ── */}
      <div className="explore-header">
        <div>
          <div className="explore-title">EXPLORE &amp; DISCOVER</div>
          <div className="explore-subtitle">
            Browse movies, series, and anime by genre, era, rating, or streaming
            network
            {!loading && totalResults > 0
              ? ` · ${totalResults.toLocaleString()} titles`
              : ""}
          </div>
        </div>
        <div className="explore-header-actions">
          {savedList.length > 0 && (
            <button
              className="btn btn-secondary explore-action-btn"
              onClick={handleRandomWatchlist}
              title="Pick a random title from your Watchlist"
            >
              🎯 Random Watchlist
            </button>
          )}
          <button
            className="btn btn-primary explore-action-btn"
            onClick={handleSurpriseMe}
            disabled={offline || surprising || ( !loading && visibleItems.length === 0 )}
            title="Open a random title matching your current filters"
          >
            {surprising ? "Rolling…" : "🎲 Surprise Me"}
          </button>
          {isCustomized && (
            <button
              className="btn btn-ghost explore-action-btn"
              onClick={resetFilters}
              title="Reset all filters"
            >
              ↺ Reset
            </button>
          )}
        </div>
      </div>

      {/* ── Filter Controls ── */}
      <div className="explore-filters">
        {/* Mode tabs */}
        <div className="explore-modes">
          {DISCOVER_MODES.map((m) => (
            <button
              key={m.id}
              className={`explore-mode-btn${filters.mode === m.id ? " active" : ""}`}
              onClick={() => handleModeChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Select dropdowns */}
        <div className="explore-select-row">
          <label className="explore-select-group">
            <span>Sort by</span>
            <select
              className="explore-select"
              value={filters.sortBy}
              onChange={(e) => updateFilter({ sortBy: e.target.value })}
            >
              {DISCOVER_SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="explore-select-group">
            <span>Year / Era</span>
            <select
              className="explore-select"
              value={filters.yearPreset}
              onChange={(e) => updateFilter({ yearPreset: e.target.value })}
            >
              {YEAR_PRESETS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="explore-select-group">
            <span>Min Score</span>
            <select
              className="explore-select"
              value={filters.minRating}
              onChange={(e) =>
                updateFilter({ minRating: Number(e.target.value) })
              }
            >
              {RATING_FLOOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {!activeMode.isAnime && (
            <label className="explore-select-group">
              <span>Language</span>
              <select
                className="explore-select"
                value={filters.origLang}
                onChange={(e) => updateFilter({ origLang: e.target.value })}
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* Streaming provider pills */}
        <div className="explore-chip-row">
          <span className="explore-chip-label">Network</span>
          <div className="explore-chips">
            <button
              className={`explore-chip${filters.providerId == null ? " active" : ""}`}
              onClick={() => updateFilter({ providerId: null })}
            >
              All
            </button>
            {POPULAR_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`explore-chip${filters.providerId === p.id ? " active" : ""}`}
                onClick={() =>
                  updateFilter({
                    providerId: filters.providerId === p.id ? null : p.id,
                  })
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Genre multi-select chips */}
        {genresList.length > 0 && (
          <div className="explore-chip-row">
            <span className="explore-chip-label">Genres</span>
            <div className="explore-chips">
              {genresList
                .filter((g) => !(activeMode.isAnime && g.id === 16))
                .map((g) => {
                  const active = filters.genres.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      className={`explore-chip${active ? " active" : ""}`}
                      onClick={() => toggleGenre(g.id)}
                    >
                      {g.name}
                    </button>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {/* ── Content ── */}
      {offline ? (
        <div className="empty-state">
          <div style={{ fontSize: 42 }}>📡</div>
          <h3>Offline Mode</h3>
          <p>Connect to the internet to browse and filter the catalog.</p>
        </div>
      ) : loading ? (
        <div className="loader">
          <div className="spinner" />
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="empty-state">
          <h3>No titles match your filters</h3>
          <p>Try loosening your rating, network, or genre selection.</p>
          {isCustomized && (
            <button
              className="btn btn-secondary"
              style={{ marginTop: 14, marginInline: "auto" }}
              onClick={resetFilters}
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <div className="section">
          <div className="cards-grid">
            {visibleItems.map((item) => {
              const pk =
                item.media_type === "movie"
                  ? `movie_${item.id}`
                  : `tv_${item.id}_s1e1`;
              const r = getRating(item);
              return (
                <MediaCard
                  key={`${item.media_type}_${item.id}`}
                  item={item}
                  onClick={() => onSelect(item)}
                  progress={progress?.[pk] || 0}
                  watched={watched}
                  onMarkWatched={onMarkWatched}
                  onMarkUnwatched={onMarkUnwatched}
                  ageRating={r.cert}
                  restricted={false}
                />
              );
            })}
          </div>

          {/* Sentinel + manual Load More button */}
          <div ref={sentinelRef} className="explore-load-more">
            {loadingMore ? (
              <div className="loader" style={{ padding: 20 }}>
                <div className="spinner" />
              </div>
            ) : (
              page < totalPages && (
                <button className="btn btn-secondary" onClick={loadNextPage}>
                  Load More ({page} / {totalPages})
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
