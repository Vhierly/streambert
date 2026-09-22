import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { tmdbFetch, imgUrl } from "../utils/api";
import { SearchIcon, CloseIcon, FilterIcon } from "./Icons";
import { storage } from "../utils/storage";

const HISTORY_KEY = "searchHistory";
const MAX_HISTORY = 12;

// TMDB genre IDs for filter dropdown
const TMDB_GENRES = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 18, name: "Drama" },
  { id: 14, name: "Fantasy" },
  { id: 27, name: "Horror" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Sci-Fi" },
  { id: 53, name: "Thriller" },
];

function loadHistory() {
  return storage.get(HISTORY_KEY) || [];
}

function saveHistory(history) {
  storage.set(HISTORY_KEY, history);
}

export default function SearchModal({ apiKey, onSelect, onClose, offline }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedGenres, setSelectedGenres] = useState([]);
  const [yearFilter, setYearFilter] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [mediaType, setMediaType] = useState("multi"); // multi | movie | tv
  const inputRef = useRef();

  useEffect(() => {
    const tid = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(tid);
  }, []);

  // Debounced search with filters
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let mounted = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        // Use appropriate endpoint based on media type
        const endpoint = mediaType === "movie"
          ? `/search/movie?query=${encodeURIComponent(query)}&page=1`
          : mediaType === "tv"
          ? `/search/tv?query=${encodeURIComponent(query)}&page=1`
          : `/search/multi?query=${encodeURIComponent(query)}&page=1`;
        
        const data = await tmdbFetch(endpoint, apiKey);
        let filtered = (data.results || []).filter((r) => r.media_type !== "person");
        
        // Apply genre filter
        if (selectedGenres.length > 0) {
          filtered = filtered.filter((r) => {
            const genreIds = r.genre_ids || [];
            return selectedGenres.some((g) => genreIds.includes(g));
          });
        }
        
        // Apply year filter
        if (yearFilter) {
          filtered = filtered.filter((r) => {
            const date = r.release_date || r.first_air_date || "";
            return date.startsWith(yearFilter);
          });
        }
        
        // Apply rating filter
        if (minRating > 0) {
          filtered = filtered.filter((r) => (r.vote_average || 0) >= minRating);
        }
        
        if (mounted) {
          setResults(filtered.slice(0, 20));
        }
      } catch {}
      if (mounted) setLoading(false);
    }, 380);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [query, apiKey, selectedGenres, yearFilter, minRating, mediaType]);

  const toggleGenre = useCallback((genreId) => {
    setSelectedGenres((prev) =>
      prev.includes(genreId)
        ? prev.filter((g) => g !== genreId)
        : [...prev, genreId]
    );
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedGenres([]);
    setYearFilter("");
    setMinRating(0);
    setMediaType("multi");
  }, []);

  const hasActiveFilters = selectedGenres.length > 0 || yearFilter || minRating > 0 || mediaType !== "multi";

  const addToHistory = useCallback((term) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const next = [trimmed, ...prev.filter((h) => h !== trimmed)].slice(
        0,
        MAX_HISTORY,
      );
      saveHistory(next);
      return next;
    });
  }, []);

  const removeFromHistory = useCallback((e, term) => {
    e.stopPropagation();
    setHistory((prev) => {
      const next = prev.filter((h) => h !== term);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const handleSelect = (r) => {
    const trimmed = query.trim();
    if (trimmed) {
      const next = [trimmed, ...history.filter((h) => h !== trimmed)].slice(
        0,
        MAX_HISTORY,
      );
      saveHistory(next);
      setHistory(next);
    }
    onSelect(r);
    onClose();
  };

  const handleHistoryClick = useCallback((term) => {
    setQuery(term);
    inputRef.current?.focus();
  }, []);

  const handleKey = (e) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && query.trim()) addToHistory(query);
  };

  const showHistory = !query && history.length > 0;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="search-box">
        <div className="search-input-wrap">
          <SearchIcon />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search movies and series..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          <button
            className={`btn btn-ghost btn-icon ${hasActiveFilters ? "filter-active" : ""}`}
            onClick={() => setShowFilters((v) => !v)}
            title="Toggle filters"
          >
            <FilterIcon />
          </button>
          {query ? (
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setQuery("")}
            >
              <CloseIcon />
            </button>
          ) : (
            <button className="btn btn-ghost btn-icon" onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </div>

        {/* Filter Panel */}
        {showFilters && (
          <div className="search-filters">
            <div className="search-filters-header">
              <span className="search-filters-title">Filters</span>
              {hasActiveFilters && (
                <button className="search-filters-clear" onClick={clearFilters}>
                  Clear all
                </button>
              )}
            </div>

            {/* Media Type */}
            <div className="filter-group">
              <div className="filter-label">Type</div>
              <div className="filter-options">
                {[
                  { id: "multi", label: "All" },
                  { id: "movie", label: "Movies" },
                  { id: "tv", label: "TV Series" },
                ].map((t) => (
                  <button
                    key={t.id}
                    className={`filter-chip ${mediaType === t.id ? "active" : ""}`}
                    onClick={() => setMediaType(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Genres */}
            <div className="filter-group">
              <div className="filter-label">Genres</div>
              <div className="filter-options">
                {TMDB_GENRES.map((g) => (
                  <button
                    key={g.id}
                    className={`filter-chip ${selectedGenres.includes(g.id) ? "active" : ""}`}
                    onClick={() => toggleGenre(g.id)}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Year */}
            <div className="filter-group">
              <div className="filter-label">Year</div>
              <input
                type="text"
                className="filter-input"
                placeholder="e.g. 2024"
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value.replace(/\D/g, "").slice(0, 4))}
                maxLength={4}
              />
            </div>

            {/* Min Rating */}
            <div className="filter-group">
              <div className="filter-label">Min Rating: {minRating > 0 ? `${minRating}+` : "Any"}</div>
              <div className="filter-options">
                {[0, 5, 6, 7, 8, 9].map((r) => (
                  <button
                    key={r}
                    className={`filter-chip ${minRating === r ? "active" : ""}`}
                    onClick={() => setMinRating(r)}
                  >
                    {r === 0 ? "Any" : `${r}+`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="search-results">
          {offline && (
            <div
              style={{
                padding: "12px 20px",
                background: "rgba(255,165,0,0.1)",
                borderBottom: "1px solid var(--border)",
                fontSize: 13,
                color: "#ff9800",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              🌐 No internet, search is unavailable offline.
            </div>
          )}

          {!offline && loading && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}

          {!loading && query && results.length === 0 && (
            <div className="search-empty">No results for "{query}"</div>
          )}

          {!loading &&
            results.map((r) => (
              <div
                key={r.id}
                className="search-result"
                onClick={() => handleSelect(r)}
              >
                <img
                  src={
                    r.poster_path
                      ? imgUrl(r.poster_path, "w92")
                      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='58'%3E%3Crect fill='%23222' width='40' height='58'/%3E%3C/svg%3E"
                  }
                  alt=""
                />
                <div className="search-result-info">
                  <div className="search-result-title">{r.title || r.name}</div>
                  <div className="search-result-meta">
                    {(r.release_date || r.first_air_date || "").slice(0, 4)}
                    {r.vote_average ? ` · ★ ${r.vote_average.toFixed(1)}` : ""}
                  </div>
                </div>
                <span
                  className={`search-result-type ${r.media_type === "tv" ? "type-tv" : "type-movie"}`}
                >
                  {r.media_type === "tv" ? "Series" : "Movie"}
                </span>
              </div>
            ))}

          {showHistory && (
            <div className="search-history">
              <div className="search-history-header">
                <span className="search-history-label">Recent searches</span>
                <button className="search-history-clear" onClick={clearHistory}>
                  Clear all
                </button>
              </div>
              {history.map((term) => (
                <div
                  key={term}
                  className="search-history-item"
                  onClick={() => handleHistoryClick(term)}
                >
                  <span className="search-history-icon">
                    <SearchIcon />
                  </span>
                  <span className="search-history-term">{term}</span>
                  <button
                    className="search-history-remove"
                    onClick={(e) => removeFromHistory(e, term)}
                    title="Remove"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          )}

          {!query && history.length === 0 && (
            <div className="search-hint">
              Search for movies and series &nbsp;·&nbsp; <kbd>ESC</kbd> to close
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
