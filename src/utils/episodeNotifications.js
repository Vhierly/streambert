// Pure decision logic for new-episode notifications (TES-144).
// No I/O, no React — testable without a browser.

/**
 * Decide whether a tracked show has a new episode worth notifying about.
 *
 * First check (no prev.checkedAt) → false: seed the cache, never storm.
 * Migration (prev.checkedAt but no lastEpDate) → false: same treatment.
 * Unchanged last_episode_to_air → false.
 * Older than 7 days → false.
 */
export function shouldNotifyNewEpisode(prev, lastEpisode, now = Date.now()) {
  if (!prev || !prev.checkedAt) return false;
  const lastDate = lastEpisode?.air_date || null;
  if (!lastDate) return false;
  if (lastDate === prev.lastEpDate) return false;
  // Old cache without lastEpDate → treat as first check (seed, don't notify)
  if (prev.lastEpDate == null) return false;

  const parseLocalDate = (d) => {
    if (!d) return null;
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day);
  };

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const lastParsed = parseLocalDate(lastDate);
  const prevParsed = parseLocalDate(prev.lastEpDate);

  return (
    lastParsed != null &&
    lastParsed >= sevenDaysAgo &&
    (!prevParsed || lastParsed > prevParsed)
  );
}

/**
 * Deep link for a new-episode notification (TES-147).
 * Carries the season because the in-app episode card navigates with
 * `entry.season ?? 1`; without it the deep link landed on season 1 instead.
 */
export function newEpisodeDeepLink(id, season) {
  return `streambert://show/${id}?season=${season ?? 1}`;
}

/**
 * Resolve a `streambert://show/<id>?season=<n>` URL into the navigation payload
 * for TVPage (TES-147). The URL carries only id + season, so the rest comes from
 * `saved` — the profile's saved-items map. The entry found there is the same
 * object the in-app episode card spreads, which is what makes both entry points
 * render identical metadata before the TVPage TMDB fetch resolves.
 *
 * Returns null when the URL is not a show deep link.
 */
export function resolveDeepLink(url, saved = {}) {
  const match = /^streambert:\/\/show\/(\d+)/.exec(url || "");
  if (!match) return null;
  const id = Number(match[1]);
  // Regex, not `new URL()`: a malformed link must not throw inside the IPC
  // listener, and this only ever has to read one integer.
  const season = Number(/[?&]season=(\d+)/.exec(url)?.[1] ?? NaN);
  return {
    ...(saved[`tv_${id}`] || { id }),
    id,
    media_type: "tv",
    ...(Number.isFinite(season) ? { season } : {}),
  };
}
