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
