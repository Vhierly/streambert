// ── Library 2.0 Pure Utilities (Statuses, Collections, Stats & Airing) ─────

export const WATCH_STATUSES = [
  { id: "all", label: "All" },
  { id: "watching", label: "Watching" },
  { id: "plan", label: "Plan to Watch" },
  { id: "completed", label: "Completed" },
  { id: "hold", label: "On Hold" },
  { id: "dropped", label: "Dropped" },
];

export function getLibraryKey(item) {
  if (!item) return "";
  const mt = item.media_type || (item.first_air_date ? "tv" : "movie");
  return `${mt}_${item.id}`;
}

/**
 * Determine watch status for a saved library item.
 * Explicit user status overrides auto-inference.
 */
export function resolveItemWatchStatus(
  item,
  { statusMap = {}, watched = {}, progress = {} } = {},
) {
  const key = getLibraryKey(item);
  if (key && statusMap[key]) return statusMap[key];

  if (item.media_type === "movie") {
    if (watched?.[`movie_${item.id}`]) return "completed";
    if ((progress?.[`movie_${item.id}`] || 0) > 2) return "watching";
    return "plan";
  }

  const tvPrefix = `tv_${item.id}_`;
  const hasWatchedEp = Object.keys(watched || {}).some(
    (k) => k.startsWith(tvPrefix) && watched[k],
  );
  const hasProgressEp = Object.keys(progress || {}).some(
    (k) => k.startsWith(tvPrefix) && progress[k] > 2,
  );
  if (hasWatchedEp || hasProgressEp) return "watching";
  return "plan";
}

/**
 * Compute summary watch statistics from local history, watched map, and saved items.
 */
export function computeWatchStats({
  history = [],
  watched = {},
  saved = [],
} = {}) {
  let moviesCompleted = 0;
  let episodesCompleted = 0;

  for (const [k, val] of Object.entries(watched || {})) {
    if (!val) continue;
    if (k.startsWith("movie_")) moviesCompleted++;
    else if (k.startsWith("tv_")) episodesCompleted++;
  }

  // Approximate runtime: ~1.95h per movie, ~0.55h (33m) per TV/anime episode
  const estimatedHours =
    Math.round((moviesCompleted * 1.95 + episodesCompleted * 0.55) * 10) / 10;

  // Active watch streak (consecutive calendar days ending today or yesterday)
  const daySet = new Set();
  for (const h of history || []) {
    if (!h?.watchedAt) continue;
    const d = new Date(h.watchedAt);
    d.setHours(0, 0, 0, 0);
    daySet.add(d.getTime());
  }

  let streakDays = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const oneDay = 86_400_000;
  if (!daySet.has(cursor.getTime()) && daySet.has(cursor.getTime() - oneDay)) {
    cursor.setTime(cursor.getTime() - oneDay);
  }
  while (daySet.has(cursor.getTime())) {
    streakDays++;
    cursor.setTime(cursor.getTime() - oneDay);
  }

  return {
    moviesCompleted,
    episodesCompleted,
    estimatedHours,
    watchlistCount: Array.isArray(saved) ? saved.length : 0,
    streakDays,
  };
}

/**
 * Format and sort upcoming TV episode release entries chronologically.
 */
export function formatUpcomingSchedule(entries = [], nowDate = new Date()) {
  const today = new Date(nowDate);
  today.setHours(0, 0, 0, 0);

  return entries
    .filter((e) => e && e.airDate)
    .map((e) => {
      const [y, m, d] = String(e.airDate).split("-").map(Number);
      const target = new Date(y, (m || 1) - 1, d || 1);
      target.setHours(0, 0, 0, 0);
      const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
      let badge = e.airDate;
      if (diffDays === 0) badge = "Today";
      else if (diffDays === 1) badge = "Tomorrow";
      else if (diffDays > 1 && diffDays <= 7) {
        badge = target.toLocaleDateString("en-US", { weekday: "short" }) + ` (${diffDays}d)`;
      } else {
        badge = target.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
      return { ...e, diffDays, badge, ts: target.getTime() };
    })
    .filter((e) => e.diffDays >= -1)
    .sort((a, b) => a.ts - b.ts);
}
