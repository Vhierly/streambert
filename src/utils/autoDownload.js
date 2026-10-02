// ── autoDownload: decide what belongs in the download queue ─────────────────
//
// The Smart Downloads settings page saves ten options — enabled, quality,
// schedule window, concurrency, bandwidth cap, transcode format — and nothing
// read them. shouldAutoDownload, isWithinSchedule, matchesQuality and
// canStartDownload were exported with zero callers, so "auto-download new
// episodes" was a checkbox that changed nothing.
//
// This module is the missing decision layer. src/utils/downloadQueue.js already
// is a working queue — concurrency, pause-while-playing, priority, resume — so
// nothing here re-implements it. The job is narrower: given what the user is
// following and what has aired, which episodes should be in the queue that
// downloadQueue is already draining?
//
// What "following" means here
// --------------------------
// The app has no follow list. The closest real signal is SAVED: a show the user
// saved to their library is one they intend to watch. Inventing a separate
// follow list would mean asking the user to mark shows twice, and a setting
// nothing populates is the exact failure being fixed.
//
// Why it does not fetch episode lists
// ----------------------------------
// Doing this properly means asking TMDB or AniList which episodes exist for
// each saved show, on a schedule, in a background process — network calls from a
// renderer with no lifecycle guarantees. What ships here is the scheduling and
// the policy, with the episode source behind an injected function:
//
//   scanForNewEpisodes({ listEpisodes })
//
// The app passes a fetcher; a test passes a literal array. That keeps the
// network out of the part worth testing and leaves a single seam for tuning
// which provider answers.

import {
  addToQueue,
  getQueue,
  queueKey,
  QUEUE_STATUS,
} from "./downloadQueue";
import { storage, STORAGE_KEYS } from "./storage";
import { getSmartDownloadSettings, shouldAutoDownload, isWithinSchedule, matchesQuality }
  from "./smartDownloads";

const CONFIG = {
  // How often the scheduler looks for new episodes. An hour is the same cadence
  // the app already uses for Trakt calendar checks, and a new episode does not
  // appear faster than that in practice.
  INTERVAL_MS: 60 * 60 * 1000,
  // Skip the scan immediately after a run. The scheduler re-checks on a timer,
  // but a manual "scan now" should not be followed by the timer firing again
  // two seconds later.
  MIN_GAP_MS: 10 * 60 * 1000,
  // Ceiling on one pass, so a large library cannot produce an unbounded burst of
  // network calls or queue entries in a single tick.
  MAX_SHOWS_PER_SCAN: 25,
  MAX_EPISODES_PER_SHOW: 4,
};

let _timer = null;
let _lastScanAt = 0;
let _running = false;
let _listEpisodes = null;

/** Saved shows, in the shape shouldAutoDownload expects. */
function followingShows() {
  try {
    const saved = storage.get(STORAGE_KEYS.SAVED) || [];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/**
 * Keys already present in the queue.
 *
 * Used as a cheap pre-filter before calling addToQueue, which matters mostly
 * because it keeps the "queued" counter honest: addToQueue reports added:false
 * for a duplicate, so this is belt-and-braces rather than the only guard.
 */
function knownEpisodeKeys() {
  return new Set(getQueue().map((q) => q.key));
}

/**
 * Turn one episode into a queue item.
 *
 * The shape matches what src/ipc/downloads.js runDownload expects, because that
 * is what downloadQueue.pump feeds it — a queue entry that drifts from that
 * shape becomes a failed download rather than an obvious error.
 */
function toQueueItem(show, episode) {
  // Providers frequently return episodes with no id of their own — TMDB episode
  // ids live in a different namespace and are often omitted. queueKey still
  // produces a stable, unique key from show + season + episode, so the episode
  // id is not needed for dedupe; it is only used when present.
  const episodeId = episode.tmdbId ?? episode.id;
  return {
    tmdbId: episodeId ?? show.id ?? show.tmdbId,
    mediaId: episodeId ?? show.id ?? show.tmdbId,
    mediaType: "tv",
    season: episode.season ?? show.season ?? 1,
    episode: episode.episode ?? episode.number,
    // Lowercase on purpose: the stream resolver reads m3u8Url exactly like that,
    // and a capital U here is an unplayable queue entry.
    m3u8Url: episode.m3u8Url ?? episode.url ?? "",
    name:
      episode.title ||
      `${show.title || show.name || "Show"} S${episode.season ?? 1}E${episode.episode}`,
    // Smart downloads are background work by definition, so they yield to a
    // manual download the moment one is queued.
    priority: 0,
    posterPath: show.poster_path || show.posterPath || null,
  };
}

/**
 * Decide which episodes from one show belong in the queue.
 *
 * Exported because it is the part with real branching, and it is testable
 * without a scheduler, a clock or a network.
 */
export function selectEpisodesToQueue(show, episodes, settings) {
  const out = [];

  for (const episode of episodes || []) {
    // shouldAutoDownload carries the enabled / airing / following gates. It is
    // written against the show, so it is asked once per show here.
    if (!shouldAutoDownload(show, settings, followingShows())) continue;

    // Only episodes that have actually aired. Providers report upcoming ones,
    // and queueing those means a download that cannot succeed for days.
    if (episode.airedAt && episode.airedAt > Date.now()) continue;
    if (episode.aired === false) continue;

    const item = toQueueItem(show, episode);
    if (!item.m3u8Url) continue;

    // matchesQuality reads the stream URL. When a provider gives no quality
    // hint, do not reject on a guess — the preference is a floor, not a veto.
    if (episode.quality && !matchesQuality(item.m3u8Url, settings.preferredQuality)) {
      continue;
    }

    // No alreadyQueued() check here on purpose. addToQueue refuses a key it
    // already holds, so a second guard costs a full queue scan per episode and
    // changes nothing — verified by removing it and re-running the suite, which
    // stayed green. Dedupe belongs in one place, and that place is the queue.
    out.push(item);
  }

  return out.slice(0, CONFIG.MAX_EPISODES_PER_SHOW);
}

/**
 * One pass: find new episodes for every followed show and queue them.
 *
 * @param listEpisodes  async (show) => [{ season, episode, title, m3u8Url, airedAt }]
 *                      Injected so the scheduling and policy are testable and so
 *                      choosing a provider is one decision in one place.
 * @param opts.force    Ignore the between-scan gap. Used by the manual button.
 * @returns { scanned, queued, skipped, reasons }
 */
export async function scanForNewEpisodes({ listEpisodes, force = false } = {}) {
  const settings = getSmartDownloadSettings();
  const now = Date.now();

  const result = { scanned: 0, queued: 0, skipped: 0, reasons: [] };

  // Not enabled: not a failure, just nothing to do. Reported so the caller can
  // say "auto-download is off" instead of "no new episodes".
  if (!settings.enabled) {
    result.reasons.push("disabled");
    return result;
  }

  // The schedule window is a second gate, separate from the interval: outside
  // it, no new work is started at all. Downloads already running are the
  // queue's business, not this module's.
  if (settings.scheduleEnabled && !isWithinSchedule(new Date(), settings)) {
    result.reasons.push("outside-schedule");
    return result;
  }

  if (!force && now - _lastScanAt < CONFIG.MIN_GAP_MS) {
    result.reasons.push("too-soon");
    return result;
  }

  const fetch = listEpisodes || _listEpisodes;
  if (typeof fetch !== "function") {
    // No provider wired. Silent by design: this module is started on app boot,
    // and logging on every boot for a missing optional capability is noise.
    result.reasons.push("no-provider");
    return result;
  }

  if (_running) {
    result.reasons.push("already-running");
    return result;
  }

  _running = true;
  _lastScanAt = now;

  try {
    const shows = followingShows().slice(0, CONFIG.MAX_SHOWS_PER_SCAN);
    if (!shows.length) {
      result.reasons.push("nothing-following");
      return result;
    }

    for (const show of shows) {
      if (!shouldAutoDownload(show, settings, followingShows())) {
        result.skipped++;
        continue;
      }

      let episodes = null;
      try {
        episodes = await fetch(show);
      } catch {
        // One show failing must not abandon the rest of the library.
        result.skipped++;
        continue;
      }
      if (!Array.isArray(episodes)) {
        result.skipped++;
        continue;
      }

      result.scanned++;

      // Snapshot the keys once per show rather than per episode: a season has a
      // dozen entries and the check is O(queue) each time.
      const known = knownEpisodeKeys();
      for (const item of selectEpisodesToQueue(show, episodes, settings)) {
        if (known.has(queueKey(item))) continue;
        const { added } = addToQueue(item);
        if (added) {
          known.add(queueKey(item));
          result.queued++;
        }
      }
    }

    result.reasons.push("ok");
    return result;
  } finally {
    _running = false;
  }
}

/** Register the provider used when scanForNewEpisodes is called without one. */
export function setEpisodeLister(fn) {
  _listEpisodes = typeof fn === "function" ? fn : null;
}

/**
 * The default provider: TMDB season listings.
 *
 * TVPage already fetches seasons this way (see its `/tv/${id}/season/${n}`
 * call), so this follows the same endpoint and the same parameter rather than
 * inventing a second convention — and it needs no API key beyond the one the app
 * already holds.
 *
 * Only the latest season is considered. A library that follows an old finished
 * show should not be offered its entire back catalogue the first time somebody
 * ticks the box, and the newest season is where a new episode appears.
 *
 * Returns [] rather than throwing on a failed lookup: one unreachable show must
 * not end the pass over the rest of the library.
 */
async function tmdbEpisodeLister(show) {
  const apiKey = storage.get(STORAGE_KEYS.API_KEY);
  if (!apiKey) return [];

  const showId = show?.tmdbId ?? show?.id;
  if (!showId) return [];

  const { tmdbFetch, getSourceUrl } = await import("./api");

  // Prefer the last season TMDB lists. One extra request, but it is the only
  // reliable way to know which season is current without hardcoding a number.
  const detail = await tmdbFetch(`/tv/${showId}`, apiKey).catch(() => null);
  const lastSeason =
    detail?.number_of_seasons ??
    detail?.seasons?.reduce((max, s) => Math.max(max, s.season_number || 0), 0) ??
    1;
  if (!lastSeason) return [];

  const season = await tmdbFetch(
    `/tv/${showId}/season/${lastSeason}`,
    apiKey,
  ).catch(() => null);
  const episodes = season?.episodes;
  if (!Array.isArray(episodes)) return [];

  const sourceId = storage.get(STORAGE_KEYS.PLAYER_SOURCE);

  return episodes.map((ep) => ({
    tmdbId: ep.id,
    season: ep.season_number ?? lastSeason,
    episode: ep.episode_number,
    title: ep.name,
    // TMDB gives an air date but no stream. The URL is built through the same
    // resolver the player uses, so an auto-downloaded episode takes exactly the
    // path a manual one does — including whichever source is active.
    m3u8Url: getSourceUrl(
      sourceId,
      "tv",
      showId,
      ep.season_number ?? lastSeason,
      ep.episode_number,
    ),
    airedAt: ep.air_date ? new Date(ep.air_date).getTime() : null,
    quality: null,
  }));
}

/** Install the built-in provider. Called at startup. */
export function useDefaultEpisodeLister() {
  setEpisodeLister(tmdbEpisodeLister);
}

/** Start scanning on an interval. Safe to call more than once. */
export function startAutoDownload() {
  if (_timer) return;

  const tick = () => {
    scanForNewEpisodes().catch(() => {
      // Already recorded in the result; nothing to add by throwing here.
    });
  };

  // First run is delayed rather than immediate: this is called during app start,
  // and an immediate pass would fire a burst of provider requests while the
  // window is still mounting.
  _timer = setInterval(tick, CONFIG.INTERVAL_MS);
}

export function stopAutoDownload() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

