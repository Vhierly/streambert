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

const ChevronIcon = ({ open }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`explore-dd__chevron${open ? " is-open" : ""}`}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const CheckMark = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const DiceSvg = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const ShuffleSvg = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="16 3 21 3 21 8" />
    <line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" />
    <line x1="15" y1="15" x2="21" y2="21" />
    <line x1="4" y1="4" x2="9" y2="9" />
  </svg>
);

const ResetSvg = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <polyline points="3 3 3 8 8 8" />
  </svg>
);

function FilterDropdown({
  id,
  openMenu,
  setOpenMenu,
  label,
  active = false,
  badge = null,
  wide = false,
  children,
}) {
  const isOpen = openMenu === id;
  return (
    <div className="explore-dd">
      <button
        type="button"
        className={`explore-dd__trigger${isOpen ? " is-open" : ""}${active ? " is-active" : ""}`}
        onClick={() => setOpenMenu(isOpen ? null : id)}
      >
        <span className="explore-dd__text">{label}</span>
        {badge != null && <span className="explore-dd__badge">{badge}</span>}
        <ChevronIcon open={isOpen} />
      </button>
      {isOpen && (
        <div
          className={`explore-dd__panel${wide ? " explore-dd__panel--wide" : ""}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

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

  const [openMenu, setOpenMenu] = useState(null);
  const [genresList, setGenresList] = useState([]);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [surprising, setSurprising] = useState(false);

  const toolbarRef = useRef(null);
  const sentinelRef = useRef(null);

  const activeMode = useMemo(
    () =>
      DISCOVER_MODES.find((m) => m.id === filters.mode) || DISCOVER_MODES[0],
    [filters.mode],
  );
  const mediaKind = activeMode.mediaType;
  const watchRegion = useMemo(() => getRatingCountry(storage) || "US", []);

  // Close open dropdown on outside click or Escape
  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (e) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

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
  }, [
    apiKey,
    offline,
    loading,
    loadingMore,
    page,
    totalPages,
    filters,
    watchRegion,
  ]);

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
    setOpenMenu(null);
    setFilters((prev) => ({
      ...prev,
      mode: modeId,
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
    setOpenMenu(null);
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
      const picked = pickRandomItem(
        candidates.length ? candidates : visibleItems,
      );
      if (picked) {
        onSelect(picked);
      } else {
        showToast?.("No matching titles found");
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

  // Derived labels for compact triggers
  const sortLabel =
    DISCOVER_SORTS.find((s) => s.value === filters.sortBy)?.label ||
    "Most Popular";
  const activeProvider = POPULAR_PROVIDERS.find(
    (p) => p.id === filters.providerId,
  );
  const activeYear = YEAR_PRESETS.find((y) => y.value === filters.yearPreset);
  const activeRating = RATING_FLOOR_OPTIONS.find(
    (r) => Number(r.value) === Number(filters.minRating),
  );
  const activeLang = LANGUAGE_OPTIONS.find(
    (l) => l.value === filters.origLang,
  );

  const availableGenres = useMemo(
    () => genresList.filter((g) => !(activeMode.isAnime && g.id === 16)),
    [genresList, activeMode.isAnime],
  );

  // Dismissible active filter tags (excluding mode & default sort)
  const activeTags = useMemo(() => {
    const tags = [];
    if (activeProvider) {
      tags.push({
        key: `prov_${activeProvider.id}`,
        label: activeProvider.label,
        onRemove: () => updateFilter({ providerId: null }),
      });
    }
    for (const gid of filters.genres) {
      const g = genresList.find((x) => x.id === gid);
      if (g) {
        tags.push({
          key: `genre_${gid}`,
          label: g.name,
          onRemove: () => toggleGenre(gid),
        });
      }
    }
    if (filters.yearPreset && activeYear) {
      tags.push({
        key: "year",
        label: activeYear.label,
        onRemove: () => updateFilter({ yearPreset: "" }),
      });
    }
    if (Number(filters.minRating) > 0 && activeRating) {
      tags.push({
        key: "rating",
        label: activeRating.label,
        onRemove: () => updateFilter({ minRating: 0 }),
      });
    }
    if (!activeMode.isAnime && filters.origLang && activeLang) {
      tags.push({
        key: "lang",
        label: activeLang.label,
        onRemove: () => updateFilter({ origLang: "" }),
      });
    }
    return tags;
  }, [
    activeProvider,
    filters.genres,
    filters.yearPreset,
    filters.minRating,
    filters.origLang,
    activeMode.isAnime,
    genresList,
    activeYear,
    activeRating,
    activeLang,
    updateFilter,
    toggleGenre,
  ]);

  const isCustomized = hasCustomExploreFilters(filters);

  return (
    <div className="fade-in explore-page">
      {/* ── Top Row: Title + Segmented Mode Switcher ── */}
      <div className="explore-top">
        <div className="explore-heading">
          <h1 className="explore-title">EXPLORE</h1>
          {!loading && totalResults > 0 && (
            <span className="explore-count">
              {totalResults.toLocaleString()} titles
            </span>
          )}
        </div>

        <div className="explore-segmented" role="tablist">
          {DISCOVER_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={filters.mode === m.id}
              className={`explore-seg-btn${filters.mode === m.id ? " active" : ""}`}
              onClick={() => handleModeChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Compact Filter Strip + Quick Actions ── */}
      <div className="explore-bar-wrap" ref={toolbarRef}>
        <div className="explore-bar">
          <div className="explore-bar__filters">
            {/* Sort */}
            <FilterDropdown
              id="sort"
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              label={sortLabel}
              active={filters.sortBy !== DEFAULT_EXPLORE_FILTERS.sortBy}
            >
              {DISCOVER_SORTS.map((o) => {
                const selected = filters.sortBy === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`explore-dd__item${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      updateFilter({ sortBy: o.value });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{o.label}</span>
                    {selected && <CheckMark />}
                  </button>
                );
              })}
            </FilterDropdown>

            {/* Genres (Multi-select 2-col popover) */}
            {availableGenres.length > 0 && (
              <FilterDropdown
                id="genres"
                openMenu={openMenu}
                setOpenMenu={setOpenMenu}
                label="Genres"
                active={filters.genres.length > 0}
                badge={
                  filters.genres.length > 0 ? filters.genres.length : null
                }
                wide
              >
                <div className="explore-dd__grid">
                  {availableGenres.map((g) => {
                    const checked = filters.genres.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        className={`explore-dd__item${checked ? " is-selected" : ""}`}
                        onClick={() => toggleGenre(g.id)}
                      >
                        <span>{g.name}</span>
                        {checked && <CheckMark />}
                      </button>
                    );
                  })}
                </div>
                {filters.genres.length > 0 && (
                  <div className="explore-dd__footer">
                    <button
                      type="button"
                      className="explore-dd__clear"
                      onClick={() => updateFilter({ genres: [] })}
                    >
                      Clear selected genres
                    </button>
                  </div>
                )}
              </FilterDropdown>
            )}

            {/* Streaming Network */}
            <FilterDropdown
              id="network"
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              label={activeProvider ? activeProvider.label : "Network"}
              active={!!activeProvider}
            >
              <button
                type="button"
                className={`explore-dd__item${!activeProvider ? " is-selected" : ""}`}
                onClick={() => {
                  updateFilter({ providerId: null });
                  setOpenMenu(null);
                }}
              >
                <span>All Networks</span>
                {!activeProvider && <CheckMark />}
              </button>
              {POPULAR_PROVIDERS.map((p) => {
                const selected = filters.providerId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`explore-dd__item${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      updateFilter({ providerId: selected ? null : p.id });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{p.label}</span>
                    {selected && <CheckMark />}
                  </button>
                );
              })}
            </FilterDropdown>

            {/* Year / Era */}
            <FilterDropdown
              id="year"
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              label={filters.yearPreset ? activeYear?.label : "Year"}
              active={!!filters.yearPreset}
            >
              {YEAR_PRESETS.map((o) => {
                const selected = filters.yearPreset === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`explore-dd__item${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      updateFilter({ yearPreset: o.value });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{o.label}</span>
                    {selected && <CheckMark />}
                  </button>
                );
              })}
            </FilterDropdown>

            {/* Min Score */}
            <FilterDropdown
              id="rating"
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              label={
                Number(filters.minRating) > 0 ? activeRating?.label : "Score"
              }
              active={Number(filters.minRating) > 0}
            >
              {RATING_FLOOR_OPTIONS.map((o) => {
                const selected =
                  Number(filters.minRating) === Number(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`explore-dd__item${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      updateFilter({ minRating: Number(o.value) });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{o.label}</span>
                    {selected && <CheckMark />}
                  </button>
                );
              })}
            </FilterDropdown>

            {/* Original Language */}
            {!activeMode.isAnime && (
              <FilterDropdown
                id="lang"
                openMenu={openMenu}
                setOpenMenu={setOpenMenu}
                label={filters.origLang ? activeLang?.label : "Language"}
                active={!!filters.origLang}
              >
                {LANGUAGE_OPTIONS.map((o) => {
                  const selected = filters.origLang === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={`explore-dd__item${selected ? " is-selected" : ""}`}
                      onClick={() => {
                        updateFilter({ origLang: o.value });
                        setOpenMenu(null);
                      }}
                    >
                      <span>{o.label}</span>
                      {selected && <CheckMark />}
                    </button>
                  );
                })}
              </FilterDropdown>
            )}

            {isCustomized && (
              <button
                type="button"
                className="explore-reset-btn"
                onClick={resetFilters}
                title="Reset all filters"
              >
                <ResetSvg />
                <span>Reset</span>
              </button>
            )}
          </div>

          {/* Right-side Quick Actions */}
          <div className="explore-bar__actions">
            {savedList.length > 0 && (
              <button
                type="button"
                className="explore-btn explore-btn--secondary"
                onClick={handleRandomWatchlist}
                title="Open a random unwatched title from your Watchlist"
              >
                <ShuffleSvg />
                <span>Watchlist Pick</span>
              </button>
            )}
            <button
              type="button"
              className="explore-btn explore-btn--primary"
              onClick={handleSurpriseMe}
              disabled={
                offline || surprising || (!loading && visibleItems.length === 0)
              }
              title="Pick a random title matching your active filters"
            >
              <DiceSvg />
              <span>{surprising ? "Picking…" : "Surprise Me"}</span>
            </button>
          </div>
        </div>

        {/* Dismissible Active Filter Tags (rendered ONLY when filters are active) */}
        {activeTags.length > 0 && (
          <div className="explore-active-tags">
            {activeTags.map((t) => (
              <button
                key={t.key}
                type="button"
                className="explore-tag"
                onClick={t.onRemove}
                title={`Remove ${t.label}`}
              >
                <span>{t.label}</span>
                <span className="explore-tag__x">×</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Results Grid ── */}
      {offline ? (
        <div className="empty-state">
          <h3>You are offline</h3>
          <p>Connect to the internet to browse the catalog.</p>
        </div>
      ) : loading ? (
        <div className="loader">
          <div className="spinner" />
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="empty-state">
          <h3>No matching titles</h3>
          <p>Remove a genre, network, or score filter to broaden results.</p>
          {isCustomized && (
            <button
              className="btn btn-secondary"
              style={{ marginTop: 14, marginInline: "auto" }}
              onClick={resetFilters}
            >
              Reset filters
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

          <div ref={sentinelRef} className="explore-load-more">
            {loadingMore ? (
              <div className="loader" style={{ padding: 20 }}>
                <div className="spinner" />
              </div>
            ) : (
              page < totalPages && (
                <button className="btn btn-secondary" onClick={loadNextPage}>
                  Load more ({page} / {totalPages})
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
