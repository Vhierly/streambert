import { useCallback, useMemo, useState, useEffect } from "react";
import MediaCard from "../components/MediaCard";
import { imgUrl, tmdbFetch } from "../utils/api";
import { EyeIcon, WatchedIcon, FolderIcon, TrashIcon } from "../components/Icons";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { storage, STORAGE_KEYS } from "../utils/storage";
import {
  WATCH_STATUSES,
  getLibraryKey,
  resolveItemWatchStatus,
  computeWatchStats,
  formatUpcomingSchedule,
} from "../utils/library";

const VIEW_TABS = [
  { id: "watchlist", label: "Watchlist" },
  { id: "collections", label: "Collections" },
  { id: "calendar", label: "Airing Calendar" },
  { id: "history", label: "History & Stats" },
];

export default function LibraryPage({
  history,
  inProgress,
  saved,
  progress,
  onSelect,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  onRemoveHistory,
  apiKey,
}) {
  const [activeTab, setActiveTab] = useState("watchlist");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");

  // Persistent item watch statuses & custom collections
  const [statusMap, setStatusMap] = useState(
    () => storage.get(STORAGE_KEYS.LIBRARY_STATUS) || {},
  );
  const [collections, setCollections] = useState(
    () => storage.get(STORAGE_KEYS.LIBRARY_COLLECTIONS) || [],
  );
  const [activeCollectionId, setActiveCollectionId] = useState(null);
  const [newColName, setNewColName] = useState("");
  const [itemMenu, setItemMenu] = useState(null); // { item, x, y }

  // Airing calendar state
  const [airingItems, setAiringItems] = useState([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);

  const allItems = useMemo(
    () => [...inProgress, ...saved],
    [inProgress, saved],
  );
  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const [sort, setSort] = useState(
    () => storage.get(STORAGE_KEYS.LIBRARY_SORT) || "manual",
  );
  useEffect(() => {
    const handler = (e) => setSort(e.detail);
    window.addEventListener("streambert:library-sort-changed", handler);
    return () =>
      window.removeEventListener("streambert:library-sort-changed", handler);
  }, []);

  // Close item context menu on click
  useEffect(() => {
    if (!itemMenu) return;
    const close = () => setItemMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [itemMenu]);

  // Fetch upcoming episode air dates when Airing Calendar tab opens
  useEffect(() => {
    if (activeTab !== "calendar" || !apiKey) return;
    const tvSaved = saved.filter((s) => s.media_type === "tv" && s.id);
    if (!tvSaved.length) {
      setAiringItems([]);
      return;
    }
    let cancelled = false;
    setLoadingCalendar(true);

    Promise.all(
      tvSaved.map(async (series) => {
        try {
          const data = await tmdbFetch(`/tv/${series.id}`, apiKey);
          const next = data?.next_episode_to_air;
          if (!next?.air_date) return null;
          return {
            id: series.id,
            title: series.title || series.name || data.name,
            poster_path: series.poster_path || data.poster_path,
            airDate: next.air_date,
            season: next.season_number,
            episode: next.episode_number,
            episodeName: next.name || "",
            seriesItem: series,
          };
        } catch {
          return null;
        }
      }),
    )
      .then((list) => {
        if (cancelled) return;
        setAiringItems(formatUpcomingSchedule(list.filter(Boolean)));
      })
      .finally(() => {
        if (!cancelled) setLoadingCalendar(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, apiKey, saved]);

  const sortLabels = {
    manual: "Custom order",
    title: "A-Z",
    rating: "Top rated",
    year: "Newest first",
  };

  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) => isRestricted(getRating(item).minAge, ageLimitSetting),
    [getRating, ageLimitSetting],
  );

  const setItemStatus = useCallback((item, status) => {
    const key = getLibraryKey(item);
    if (!key) return;
    setStatusMap((prev) => {
      const next = { ...prev, [key]: status };
      storage.set(STORAGE_KEYS.LIBRARY_STATUS, next);
      return next;
    });
  }, []);

  const createCollection = useCallback(
    (e) => {
      e.preventDefault();
      const trimmed = newColName.trim();
      if (!trimmed) return;
      const col = {
        id: `col_${Date.now()}`,
        name: trimmed,
        items: [],
      };
      setCollections((prev) => {
        const next = [...prev, col];
        storage.set(STORAGE_KEYS.LIBRARY_COLLECTIONS, next);
        return next;
      });
      setActiveCollectionId(col.id);
      setNewColName("");
    },
    [newColName],
  );

  const deleteCollection = useCallback(
    (colId) => {
      setCollections((prev) => {
        const next = prev.filter((c) => c.id !== colId);
        storage.set(STORAGE_KEYS.LIBRARY_COLLECTIONS, next);
        return next;
      });
      if (activeCollectionId === colId) setActiveCollectionId(null);
    },
    [activeCollectionId],
  );

  const toggleItemInCollection = useCallback((colId, item) => {
    const key = getLibraryKey(item);
    if (!key) return;
    setCollections((prev) => {
      const next = prev.map((c) => {
        if (c.id !== colId) return c;
        const exists = c.items.includes(key);
        return {
          ...c,
          items: exists ? c.items.filter((k) => k !== key) : [...c.items, key],
        };
      });
      storage.set(STORAGE_KEYS.LIBRARY_COLLECTIONS, next);
      return next;
    });
  }, []);

  // Status counts & filtered watchlist
  const statusCounts = useMemo(() => {
    const counts = { all: saved.length };
    for (const item of saved) {
      const st = resolveItemWatchStatus(item, { statusMap, watched, progress });
      counts[st] = (counts[st] || 0) + 1;
    }
    return counts;
  }, [saved, statusMap, watched, progress]);

  const filteredSaved = useMemo(() => {
    const q = query.trim().toLowerCase();
    return saved.filter((item) => {
      if (statusFilter !== "all") {
        const st = resolveItemWatchStatus(item, {
          statusMap,
          watched,
          progress,
        });
        if (st !== statusFilter) return false;
      }
      if (q && !(item.title || item.name || "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [saved, statusFilter, statusMap, watched, progress, query]);

  const stats = useMemo(
    () => computeWatchStats({ history, watched, saved }),
    [history, watched, saved],
  );

  const activeCollection = useMemo(
    () =>
      collections.find((c) => c.id === activeCollectionId) ||
      collections[0] ||
      null,
    [collections, activeCollectionId],
  );

  const collectionItems = useMemo(() => {
    if (!activeCollection) return [];
    const byKey = new Map(saved.map((i) => [getLibraryKey(i), i]));
    return activeCollection.items.map((k) => byKey.get(k)).filter(Boolean);
  }, [activeCollection, saved]);

  return (
    <div className="fade-in">
      {/* ── Top Header + Segmented View Tabs ── */}
      <div className="explore-top">
        <div className="explore-heading">
          <h1 className="explore-title">MY LIBRARY</h1>
          <span className="explore-count">
            {saved.length} saved
            {sort !== "manual" ? ` · ${sortLabels[sort]}` : ""}
          </span>
        </div>

        <div className="explore-segmented" role="tablist">
          {VIEW_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`explore-seg-btn${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════ TAB 1: WATCHLIST ══════════════ */}
      {activeTab === "watchlist" && (
        <>
          <div className="explore-bar-wrap">
            <div className="explore-bar">
              <div className="explore-bar__filters">
                {WATCH_STATUSES.map((st) => {
                  const cnt = statusCounts[st.id] || 0;
                  const active = statusFilter === st.id;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      className={`explore-dd__trigger${active ? " is-active" : ""}`}
                      onClick={() => setStatusFilter(st.id)}
                    >
                      <span>{st.label}</span>
                      {cnt > 0 && (
                        <span
                          style={{
                            fontSize: 11,
                            color: active ? "var(--red)" : "var(--text3)",
                            fontWeight: 600,
                          }}
                        >
                          {cnt}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="explore-bar__actions">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter library…"
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text)",
                    fontSize: 13,
                    outline: "none",
                    width: 190,
                  }}
                />
              </div>
            </div>
          </div>

          {statusFilter === "all" && !query.trim() && inProgress.length > 0 && (
            <div className="section">
              <div className="section-title">Continue Watching</div>
              <div className="cards-grid">
                {inProgress.map((item) => {
                  const pk =
                    item.media_type === "movie"
                      ? `movie_${item.id}`
                      : `tv_${item.id}_s${item.season}e${item.episode}`;
                  const r = getRating(item);
                  const restr = itemRestricted(item);
                  return (
                    <MediaCard
                      key={pk}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={progress[pk] || 0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={r.cert}
                      restricted={restr}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {filteredSaved.length > 0 ? (
            <div className="section">
              <div className="section-title">
                {WATCH_STATUSES.find((s) => s.id === statusFilter)?.label ||
                  "Watchlist"}{" "}
                ({filteredSaved.length})
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: "var(--font-body)",
                    fontWeight: 400,
                    color: "var(--text3)",
                  }}
                >
                  Right-click poster for status &amp; collections
                </span>
              </div>
              <div className="cards-grid">
                {filteredSaved.map((item) => {
                  const r = getRating(item);
                  const restr = itemRestricted(item);
                  return (
                    <div
                      key={`${item.media_type}_${item.id}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setItemMenu({ item, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <MediaCard
                        item={item}
                        onClick={() => onSelect(item)}
                        watched={watched}
                        onMarkWatched={onMarkWatched}
                        onMarkUnwatched={onMarkUnwatched}
                        ageRating={r.cert}
                        restricted={restr}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <EyeIcon />
              <h3>No titles in this view</h3>
              <p>
                Save movies or series to your Watchlist, or right-click any
                saved poster to organize its status.
              </p>
            </div>
          )}
        </>
      )}

      {/* ══════════════ TAB 2: CUSTOM COLLECTIONS ══════════════ */}
      {activeTab === "collections" && (
        <div className="section">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {collections.map((col) => {
                const isAct = activeCollection?.id === col.id;
                return (
                  <button
                    key={col.id}
                    type="button"
                    className={`explore-dd__trigger${isAct ? " is-active" : ""}`}
                    onClick={() => setActiveCollectionId(col.id)}
                  >
                    <FolderIcon />
                    <span>{col.name}</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>
                      ({col.items.length})
                    </span>
                  </button>
                );
              })}
            </div>

            <form
              onSubmit={createCollection}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <input
                type="text"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                placeholder="New collection name…"
                style={{
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface2)",
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                className="explore-btn explore-btn--primary"
                disabled={!newColName.trim()}
              >
                + Create List
              </button>
            </form>
          </div>

          {!activeCollection ? (
            <div className="empty-state">
              <FolderIcon />
              <h3>No custom collections yet</h3>
              <p>
                Create a list above (e.g. &ldquo;Weekend Watch&rdquo; or
                &ldquo;Sci-Fi Favorites&rdquo;) and right-click any Watchlist
                poster to add it.
              </p>
            </div>
          ) : (
            <>
              <div className="section-title">
                {activeCollection.name} ({collectionItems.length})
                <button
                  type="button"
                  className="explore-reset-btn"
                  style={{ color: "var(--red)" }}
                  onClick={() => deleteCollection(activeCollection.id)}
                >
                  <TrashIcon /> Delete List
                </button>
              </div>
              {collectionItems.length === 0 ? (
                <div style={{ color: "var(--text3)", fontSize: 13, padding: "20px 0" }}>
                  This list is empty. Go to the <strong>Watchlist</strong> tab
                  and right-click any title to add it to{" "}
                  <strong>{activeCollection.name}</strong>.
                </div>
              ) : (
                <div className="cards-grid">
                  {collectionItems.map((item) => {
                    const r = getRating(item);
                    return (
                      <MediaCard
                        key={`${item.media_type}_${item.id}`}
                        item={item}
                        onClick={() => onSelect(item)}
                        watched={watched}
                        onMarkWatched={onMarkWatched}
                        onMarkUnwatched={onMarkUnwatched}
                        ageRating={r.cert}
                        restricted={itemRestricted(item)}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══════════════ TAB 3: AIRING CALENDAR ══════════════ */}
      {activeTab === "calendar" && (
        <div className="section">
          <div className="section-title">Upcoming Episode Releases</div>
          {loadingCalendar ? (
            <div className="loader">
              <div className="spinner" />
            </div>
          ) : airingItems.length === 0 ? (
            <div className="empty-state">
              <h3>No upcoming air dates</h3>
              <p>
                Save ongoing TV series or anime to your Watchlist to see their
                upcoming episode schedule here.
              </p>
            </div>
          ) : (
            <div className="history-rows">
              {airingItems.map((entry) => (
                <div
                  key={`${entry.id}_s${entry.season}e${entry.episode}`}
                  className="history-row"
                  onClick={() =>
                    onSelect({
                      ...entry.seriesItem,
                      media_type: "tv",
                      season: entry.season ?? 1,
                    })
                  }
                >
                  <div className="history-thumb">
                    {entry.poster_path && (
                      <img src={imgUrl(entry.poster_path, "w92")} alt="" />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {entry.title}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text3)" }}>
                      S{entry.season}E{entry.episode}
                      {entry.episodeName ? ` · ${entry.episodeName}` : ""} ·{" "}
                      {entry.airDate}
                    </div>
                  </div>
                  <span
                    className="search-result-type"
                    style={{
                      background:
                        entry.diffDays <= 1
                          ? "var(--red-dim)"
                          : "var(--surface3)",
                      color:
                        entry.diffDays <= 1 ? "var(--red)" : "var(--text2)",
                      border: `1px solid ${entry.diffDays <= 1 ? "var(--red)" : "var(--border)"}`,
                    }}
                  >
                    {entry.badge}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════════ TAB 4: HISTORY & STATS ══════════════ */}
      {activeTab === "history" && (
        <div className="section">
          {/* Stats summary grid */}
          <div className="lib-stats-grid">
            <div className="lib-stat-card">
              <div className="lib-stat-value">{stats.estimatedHours}h</div>
              <div className="lib-stat-label">Estimated Watch Time</div>
            </div>
            <div className="lib-stat-card">
              <div className="lib-stat-value">{stats.moviesCompleted}</div>
              <div className="lib-stat-label">Movies Completed</div>
            </div>
            <div className="lib-stat-card">
              <div className="lib-stat-value">{stats.episodesCompleted}</div>
              <div className="lib-stat-label">Episodes Completed</div>
            </div>
            <div className="lib-stat-card">
              <div className="lib-stat-value">{stats.streakDays}d</div>
              <div className="lib-stat-label">Active Watch Streak</div>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 28 }}>
            Watch History
          </div>
          {history.length === 0 ? (
            <div className="empty-state">
              <EyeIcon />
              <h3>No watch history yet</h3>
              <p>Start watching a movie or series and it will appear here.</p>
            </div>
          ) : (
            <div className="history-rows">
              {history.map((item) => {
                const pk =
                  item.media_type === "movie"
                    ? `movie_${item.id}`
                    : `tv_${item.id}_s${item.season}e${item.episode}`;
                const isWatched = !!watched?.[pk];
                return (
                  <div
                    key={`${pk}_${item.watchedAt}`}
                    className="history-row"
                    onClick={() => onSelect(item)}
                  >
                    <div className="history-thumb">
                      {item.poster_path && (
                        <img src={imgUrl(item.poster_path, "w92")} alt="" />
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {item.title}
                        {isWatched && <WatchedIcon size={16} />}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text3)" }}>
                        {item.media_type === "tv" &&
                          item.season != null &&
                          item.episode != null && (
                            <>
                              {`S${item.season}E${item.episode}`}
                              {item.episodeName
                                ? ` · ${item.episodeName}`
                                : ""}
                              {" · "}
                            </>
                          )}
                        {new Date(item.watchedAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </div>
                    </div>
                    <span
                      className={`search-result-type ${item.media_type === "tv" ? "type-tv" : "type-movie"}`}
                    >
                      {item.media_type === "tv" ? "Series" : "Movie"}
                    </span>
                    {onRemoveHistory && (
                      <button
                        className="history-remove-btn"
                        title="Remove from history"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveHistory(item);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Right-Click Context Menu for Status & Custom Collections ── */}
      {itemMenu && (
        <div
          className="sidebar-context-menu"
          style={{
            position: "fixed",
            top: Math.min(itemMenu.y, window.innerHeight - 280),
            left: Math.min(itemMenu.x, window.innerWidth - 210),
            zIndex: 9999,
            minWidth: 195,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              padding: "6px 12px 4px",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              color: "var(--text3)",
            }}
          >
            Set Status
          </div>
          {WATCH_STATUSES.filter((s) => s.id !== "all").map((st) => {
            const current = resolveItemWatchStatus(itemMenu.item, {
              statusMap,
              watched,
              progress,
            });
            return (
              <div
                key={st.id}
                className="sidebar-context-menu-item"
                style={{
                  color: current === st.id ? "var(--red)" : "var(--text)",
                  fontWeight: current === st.id ? 600 : 400,
                }}
                onClick={() => {
                  setItemStatus(itemMenu.item, st.id);
                  setItemMenu(null);
                }}
              >
                {current === st.id ? "✓ " : ""}
                {st.label}
              </div>
            );
          })}

          {collections.length > 0 && (
            <>
              <div
                style={{
                  height: 1,
                  background: "var(--border)",
                  margin: "4px 0",
                }}
              />
              <div
                style={{
                  padding: "6px 12px 4px",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: "var(--text3)",
                }}
              >
                Collections
              </div>
              {collections.map((col) => {
                const inCol = col.items.includes(getLibraryKey(itemMenu.item));
                return (
                  <div
                    key={col.id}
                    className="sidebar-context-menu-item"
                    onClick={() => {
                      toggleItemInCollection(col.id, itemMenu.item);
                      setItemMenu(null);
                    }}
                  >
                    {inCol ? "✓ " : "＋ "}
                    {col.name}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
