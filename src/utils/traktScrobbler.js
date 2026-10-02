// ── traktScrobbler: tell Trakt what is playing ───────────────────────────────
//
// The Trakt settings page could sign you in and nothing more: the auth flow
// worked, and then 13 exported scrobble/sync/recommend functions sat in
// trakt.js with zero callers. Connecting to Trakt did nothing, which is the
// same failure mode as the watch party — a feature that looks finished because
// its UI renders.
//
// This module owns the policy; trakt.js owns the transport. The distinction
// matters because Trakt's scrobble states have real rules:
//
//   start  → on play, and again past the 80% rewind grace period
//   pause  → on pause, but only above the "in progress" cutoff
//   stop   → past the 90% mark, i.e. the user finished it
//
// Sending "start" on every pause and "stop" on every leave is what a naive
// wiring does, and it fills a real user's Trakt history with entries they never
// watched. Trakt's API is forgiving but the damage is permanent and visible.
//
// Debouncing
// ----------
// play/pause events arrive in bursts (the OS fires several while a video
// starts). Each is rate-limited to one call per SCROBBLE_DEBOUNCE_MS so a single
// "start watching" cannot produce five POSTs.
//
// Failures are swallowed on purpose. A Trakt outage must not interrupt playback
// or surface an error over the video, and a failed scrobble is not something the
// user can act on mid-episode.

import { traktIsConnected, traktScrobbleStart, traktScrobblePause, traktScrobbleStop }
  from "./trakt";
import { onPlaybackProgress, getLastPlaybackProgress } from "./playbackBridge";

const CONFIG = {
  // Trakt treats anything below 2% as "not really started" and above 90% as
  // watched. Matching those exactly is what keeps a history honest.
  START_PCT: 0.02,
  STOP_PCT: 0.9,
  // Below this, a pause is not worth recording — it is usually a buffering
  // blip or a mis-click, and Trakt shows it as "in progress" forever.
  PAUSE_PCT: 0.02,
  SCROBBLE_DEBOUNCE_MS: 15_000,
  // Do not report progress more often than this while playing. Trakt stores
  // scrobble timestamps, not a progress trace, so a 60s interval is plenty.
  PLAYING_HEARTBEAT_MS: 60_000,
};

// ── State ────────────────────────────────────────────────────────────────────
let _current = null; // { item, type, key }
let _lastCall = 0; // epoch ms of the last successful call
let _lastAction = null; // "start" | "pause" | "stop"
let _stopping = false;
let _unsubscribe = null;

/** A stable key so switching episodes does not look like the same title. */
function keyFor(item, type) {
  if (type === "episode") {
    return `episode:${item.showId || item.tmdb_id}:${item.season}:${item.episode}`;
  }
  return `movie:${item.id}`;
}

function pct(progress, duration) {
  if (!duration || !isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, progress / duration));
}

async function send(action, progress, duration) {
  if (!_current) return;
  const now = Date.now();
  // Debounce everything, so play/pause/play during startup collapses into one
  // call rather than three.
  if (now - _lastCall < CONFIG.SCROBBLE_DEBOUNCE_MS) return;
  if (_lastAction === action) return;

  const pctDone = pct(progress, duration);
  // Re-check the cutoffs here as well as in the caller: this is the last place
  // before the request goes out, so it is the last place to catch a duration
  // that only arrived with loadedmetadata.
  if (action === "pause" && pctDone < CONFIG.PAUSE_PCT) return;
  if (action === "stop" && pctDone < CONFIG.STOP_PCT) return;

  // Committed only after the cutoffs pass. Marking the call as spent before
  // this point meant a rejected low-progress pause still consumed the debounce
  // window, so the real pause that followed it — a few seconds later, perfectly
  // valid — was swallowed and the episode never got recorded at all.
  _lastCall = now;
  _lastAction = action;

  const { item, type } = _current;
  try {
    if (action === "start") await traktScrobbleStart(item, type, progress);
    else if (action === "pause") await traktScrobblePause(item, type, progress);
    else if (action === "stop") await traktScrobbleStop(item, type, progress);
  } catch {
    // Intentionally silent — see the note at the top of the file.
  }
}

/**
 * Declare what is playing. Safe to call on every render of a detail page: it
 * only resets state when the title actually changes.
 *
 * `item` must carry the ids Trakt needs — for an episode, { tmdb_id (show),
 * season, episode, tmdb_id of episode }.
 */
export function traktSetNowPlaying(item, type = "movie") {
  if (!item || !traktIsConnected()) {
    if (_current) traktStopNowPlaying({ isPlaying: false, progress: 0, duration: 0 });
    return;
  }

  const key = keyFor(item, type);
  if (_current?.key === key) return;

  // Switching titles mid-session: report the previous one as left behind, at
  // wherever it actually got to.
  if (_current) traktStopNowPlaying(getLastPlaybackProgress());

  _current = { item, type, key };
  _lastCall = 0;
  _lastAction = null;
  _stopping = false;
  traktStart();
}

/**
 * Report that nothing is playing (navigated away, closed the modal).
 *
 * The position comes from the bridge, not from an argument. Reading 0 here made
 * every explicit clear send progress 0, which the 2% cutoff then rejected — so
 * leaving a page mid-episode recorded nothing at all and the episode stayed
 * open in Trakt indefinitely.
 */
export function traktClearNowPlaying() {
  if (!_current) return;
  traktStopNowPlaying(getLastPlaybackProgress());
  _current = null;
}

/** Teardown, for the modal's unmount. */
export function traktScrobblerDispose() {
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = null;
  traktClearNowPlaying();
}

function traktStart() {
  if (_unsubscribe || !_current) return;
  _unsubscribe = onPlaybackProgress(handleProgress);
}

function traktStopNowPlaying(playback) {
  if (!_current) return;
  // If the user got most of the way through, that is a stop, not a pause.
  if (pct(playback.progress, playback.duration) >= CONFIG.STOP_PCT) {
    send("stop", playback.progress, playback.duration);
  } else {
    send("pause", playback.progress, playback.duration);
  }
  _stopping = true;
}

function handleProgress({ currentTime, duration, isPlaying }) {
  if (!_current || _stopping) return;
  const p = pct(currentTime, duration);

  if (isPlaying) {
    if (p < CONFIG.START_PCT) return;
    send("start", currentTime, duration);
    return;
  }

  // A pause past the watched cutoff is the end of the title, not an interruption.
  // Reporting it as "pause" is what puts 95%-watched films in Trakt as
  // "in progress" forever instead of watched, and it is also why a scrobble
  // stopped the moment the credits started.
  if (p >= CONFIG.STOP_PCT) {
    send("stop", currentTime, duration);
    // Once stopped, stop listening: further ticks would each try to re-send and
    // the episode would stay open in Trakt until the page unmounts.
    _stopping = true;
    return;
  }
  send("pause", currentTime, duration);
}