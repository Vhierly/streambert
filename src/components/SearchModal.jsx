import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { tmdbFetch, imgUrl } from "../utils/api";
import { filterSearchResults } from "../utils/discover";
import { SearchIcon, CloseIcon, BackIcon } from "./Icons";
import { storage } from "../utils/storage";

const HISTORY_KEY = "searchHistory";
const MAX_HISTORY = 12;

const SEARCH_TABS = [
  { id: "all", label: "All" },
  { id: "movie", label: "Movies" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
  { id: "person", label: "People" },
];

const POSTER_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='58'%3E%3Crect fill='%23222' width='40' height='58'/%3E%3C/svg%3E";

function loadHistory() {
  return storage.get(HISTORY_KEY) || [];
}

function saveHistory(history) {
  storage.set(HISTORY_KEY, history);
}

export default function SearchModal({ apiKey, onSelect, onClose, offline }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [rawResults, setRawResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Person filmography drill-down state
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [personCredits, setPersonCredits] = useState([]);
  const [loadingPerson, setLoadingPerson] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    const tid = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(tid);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setRawResults([]);
      setSelectedPerson(null);
      setActiveIndex(-1);
      return;
    }
    let mounted = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await tmdbFetch(
          `/search/multi?query=${encodeURIComponent(query)}&page=1`,
          apiKey,
        );
        if (mounted) {
          setRawResults(data.results || []);
          setSelectedPerson(null);
          setActiveIndex(0);
        }
      } catch {}
      if (mounted) setLoading(false);
    }, 340);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [query, apiKey]);

  const results = useMemo(
    () => filterSearchResults(rawResults, tab).slice(0, 16),
    [rawResults, tab],
  );

  // Reset active highlight when tab changes
  useEffect(() => {
    setSelectedPerson(null);
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [tab, results.length]);

  // Keep highlighted row scrolled into view during ArrowUp / ArrowDown navigation
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(
      `[data-search-idx="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

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

  const openPersonFilmography = useCallback(
    async (person) => {
      setSelectedPerson(person);
      setPersonCredits([]);
      setActiveIndex(0);
      setLoadingPerson(true);
      try {
        const data = await tmdbFetch(
          `/person/${person.id}/combined_credits`,
          apiKey,
        );
        const combined = [...(data?.cast || []), ...(data?.crew || [])].filter(
          (c) =>
            (c.media_type === "movie" || c.media_type === "tv") && c.id,
        );
        const seen = new Set();
        const deduped = [];
        for (const item of combined) {
          const key = `${item.media_type}_${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(item);
        }
        deduped.sort(
          (a, b) =>
            (b.vote_count || 0) - (a.vote_count || 0) ||
            (b.popularity || 0) - (a.popularity || 0),
        );
        setPersonCredits(deduped.slice(0, 30));
      } catch {
        setPersonCredits([]);
      } finally {
        setLoadingPerson(false);
      }
    },
    [apiKey],
  );

  const handleSelect = useCallback(
    (r) => {
      if (!r) return;
      if (r.media_type === "person") {
        openPersonFilmography(r);
        return;
      }
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
    },
    [query, history, onSelect, onClose, openPersonFilmography],
  );

  const handleHistoryClick = useCallback((term) => {
    setQuery(term);
    inputRef.current?.focus();
  }, []);

  const showHistory = !query && history.length > 0 && !selectedPerson;

  const activeListLength = selectedPerson
    ? personCredits.length
    : query
      ? results.length
      : showHistory
        ? history.length
        : 0;

  const handleKey = (e) => {
    if (e.key === "Escape") {
      if (selectedPerson) {
        e.stopPropagation();
        setSelectedPerson(null);
        setActiveIndex(0);
        return;
      }
      onClose();
      return;
    }
    if (e.key === "ArrowDown" && activeListLength > 0) {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % activeListLength);
      return;
    }
    if (e.key === "ArrowUp" && activeListLength > 0) {
      e.preventDefault();
      setActiveIndex((prev) =>
        prev <= 0 ? activeListLength - 1 : prev - 1,
      );
      return;
    }
    if (e.key === "Enter") {
      if (selectedPerson && personCredits[activeIndex]) {
        e.preventDefault();
        handleSelect(personCredits[activeIndex]);
        return;
      }
      if (query && results[activeIndex]) {
        e.preventDefault();
        handleSelect(results[activeIndex]);
        return;
      }
      if (showHistory && activeIndex >= 0 && history[activeIndex]) {
        e.preventDefault();
        handleHistoryClick(history[activeIndex]);
        return;
      }
      if (query.trim()) addToHistory(query);
    }
  };

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
            placeholder="Search movies, series, anime, or people..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
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

        {/* Filter tabs */}
        {query.trim() && !selectedPerson && (
          <div className="search-tabs">
            {SEARCH_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`search-tab${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Person Filmography Header */}
        {selectedPerson && (
          <div className="search-person-bar">
            <button
              type="button"
              className="search-person-back"
              onClick={() => {
                setSelectedPerson(null);
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              <BackIcon /> Back
            </button>
            <div className="search-person-meta">
              <span className="search-person-name">{selectedPerson.name}</span>
              {selectedPerson.known_for_department && (
                <span className="search-result-type type-person">
                  {selectedPerson.known_for_department}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="search-results" ref={listRef}>
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

          {!offline && (loading || loadingPerson) && (
            <div className="loader">
              <div className="spinner" />
            </div>
          )}

          {/* Person Filmography List */}
          {selectedPerson && !loadingPerson && (
            <>
              {personCredits.length === 0 ? (
                <div className="search-empty">
                  No filmography found for {selectedPerson.name}
                </div>
              ) : (
                personCredits.map((c, idx) => (
                  <div
                    key={`${c.media_type}_${c.id}`}
                    data-search-idx={idx}
                    className={`search-result${activeIndex === idx ? " active" : ""}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => handleSelect(c)}
                  >
                    <img
                      src={
                        c.poster_path
                          ? imgUrl(c.poster_path, "w92")
                          : POSTER_PLACEHOLDER
                      }
                      alt=""
                    />
                    <div className="search-result-info">
                      <div className="search-result-title">
                        {c.title || c.name}
                      </div>
                      <div className="search-result-meta">
                        {(c.release_date || c.first_air_date || "").slice(0, 4)}
                        {c.vote_average
                          ? ` · ★ ${c.vote_average.toFixed(1)}`
                          : ""}
                        {c.character
                          ? ` · as ${c.character}`
                          : c.job
                            ? ` · ${c.job}`
                            : ""}
                      </div>
                    </div>
                    <span
                      className={`search-result-type ${c.media_type === "tv" ? "type-tv" : "type-movie"}`}
                    >
                      {c.media_type === "tv" ? "Series" : "Movie"}
                    </span>
                  </div>
                ))
              )}
            </>
          )}

          {/* Normal Search Results */}
          {!selectedPerson && !loading && query && results.length === 0 && (
            <div className="search-empty">
              No {tab !== "all" ? `${tab} ` : ""}results for "{query}"
            </div>
          )}

          {!selectedPerson &&
            !loading &&
            results.map((r, idx) => {
              const isPerson = r.media_type === "person";
              const imgPath = isPerson ? r.profile_path : r.poster_path;
              const knownFor = isPerson
                ? (r.known_for || [])
                    .map((k) => k.title || k.name)
                    .filter(Boolean)
                    .slice(0, 2)
                    .join(", ")
                : "";
              return (
                <div
                  key={`${r.media_type}_${r.id}`}
                  data-search-idx={idx}
                  className={`search-result${activeIndex === idx ? " active" : ""}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelect(r)}
                >
                  <img
                    src={imgPath ? imgUrl(imgPath, "w92") : POSTER_PLACEHOLDER}
                    alt=""
                  />
                  <div className="search-result-info">
                    <div className="search-result-title">
                      {r.title || r.name}
                    </div>
                    <div className="search-result-meta">
                      {isPerson ? (
                        <>
                          {r.known_for_department || "Person"}
                          {knownFor ? ` · ${knownFor}` : ""}
                        </>
                      ) : (
                        <>
                          {(r.release_date || r.first_air_date || "").slice(
                            0,
                            4,
                          )}
                          {r.vote_average
                            ? ` · ★ ${r.vote_average.toFixed(1)}`
                            : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`search-result-type ${
                      isPerson
                        ? "type-person"
                        : r.media_type === "tv"
                          ? "type-tv"
                          : "type-movie"
                    }`}
                  >
                    {isPerson
                      ? "Person"
                      : r.media_type === "tv"
                        ? "Series"
                        : "Movie"}
                  </span>
                </div>
              );
            })}

          {showHistory && (
            <div className="search-history">
              <div className="search-history-header">
                <span className="search-history-label">Recent searches</span>
                <button className="search-history-clear" onClick={clearHistory}>
                  Clear all
                </button>
              </div>
              {history.map((term, idx) => (
                <div
                  key={term}
                  data-search-idx={idx}
                  className={`search-history-item${activeIndex === idx ? " active" : ""}`}
                  onMouseEnter={() => setActiveIndex(idx)}
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

          {!query && history.length === 0 && !selectedPerson && (
            <div className="search-hint">
              Search movies, series, anime &amp; people · <kbd>↑</kbd>{" "}
              <kbd>↓</kbd> <kbd>Enter</kbd> · <kbd>ESC</kbd> to close
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
