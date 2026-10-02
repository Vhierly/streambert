// ── playbackBridge ───────────────────────────────────────────────────────────
// A tiny pub/sub so the watch party can follow playback without owning the
// player.
//
// Why this exists
// ---------------
// WatchPartyModal is mounted at the App level, but the <video> element lives
// inside TVPage/MoviePage, sometimes inside a <webview> for embed sources, and
// sometimes inside NativePlayer for resolved HLS. There is no common ancestor
// that holds both the modal and the element, and threading a ref through four
// components to reach it would make the player worse to change for everyone
// else.
//
// So the player publishes and the modal subscribes. The event name follows the
// app's existing `streambert:*` convention (see TVPage's player-settings and
// gamepad-settings events) rather than inventing a second style.
//
// What crosses the boundary
// -------------------------
//   playback:progress  { currentTime, duration, isPlaying }
//   playback:command   { type: "seek" | "play" | "pause", currentTime, duration }
//
// Only plain numbers. The consumer never receives the element itself, so this
// cannot be used to smuggle a reference into somewhere that outlives the
// player.

const EV_PROGRESS = "streambert:playback-progress";
const EV_COMMAND = "streambert:playback-command";

let lastProgress = { currentTime: 0, duration: 0, isPlaying: false };

/** The player calls this as it plays. Cheap enough for a timeupdate handler. */
export function publishPlaybackProgress(detail) {
  const next = {
    currentTime: Number(detail?.currentTime) || 0,
    duration: Number(detail?.duration) || 0,
    isPlaying: !!detail?.isPlaying,
  };
  lastProgress = next;
  window.dispatchEvent(new CustomEvent(EV_PROGRESS, { detail: next }));
}

/** Ask the player to seek / play / pause. No-op when nothing is playing. */
export function requestPlaybackCommand(type, currentTime = 0, duration = 0) {
  window.dispatchEvent(
    new CustomEvent(EV_COMMAND, { detail: { type, currentTime, duration } }),
  );
}

/** Subscribe to progress. Returns an unsubscribe function. */
export function onPlaybackProgress(handler) {
  const wrapped = (e) => handler(e.detail);
  window.addEventListener(EV_PROGRESS, wrapped);
  return () => window.removeEventListener(EV_PROGRESS, wrapped);
}

/** Subscribe to commands (seek / play / pause). Returns an unsubscribe function. */
export function onPlaybackCommand(handler) {
  const wrapped = (e) => handler(e.detail);
  window.addEventListener(EV_COMMAND, wrapped);
  return () => window.removeEventListener(EV_COMMAND, wrapped);
}

/** The most recent progress, for a subscriber that attaches late. */
export function getLastPlaybackProgress() {
  // A copy, not the live object. Returning `_lastProgress` directly would let
  // any caller mutate the stored state — a subscriber writing `snap.foo = x`
  // would silently corrupt what every later subscriber sees, and nothing about
  // that failure points back here.
  return { ...lastProgress };
}