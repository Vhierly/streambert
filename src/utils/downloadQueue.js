// ── Download Queue: a real, executing queue ───────────────────────────────────
// The previous stub (index.js get-download-queue) returned [] and the renderer
// copy in smartDownloads.js was never imported by any page — so "queueing" a
// download did nothing at all. This module is the working replacement.
//
// Shape of an entry mirrors what src/ipc/downloads.js run-download expects, so
// starting a queued item is a single runDownload call with no translation layer.
//
// Persistence: localStorage (survives reload like the rest of the app's state).
// Concurrency: maxConcurrent at a time, so a 20-episode batch doesn't spawn 20
// ffmpeg processes and starve the machine.

import { storage, STORAGE_KEYS } from "./storage";

const QUEUE_KEY = "dlQueue";
const SETTINGS_KEY = "dlQueueSettings";

export const QUEUE_STATUS = {
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  DONE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
};

const DEFAULT_SETTINGS = {
  enabled: true,
  maxConcurrent: 2,
  // Don't start new downloads while the user is actively watching something.
  pauseWhilePlaying: true,
  autoStart: true,
};

function readSettings() {
  const stored = storage.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

function writeSettings(s) {
  storage.set(SETTINGS_KEY, s);
}

export function getQueueSettings() {
  return readSettings();
}

export function saveQueueSettings(patch) {
  const next = { ...readSettings(), ...patch };
  writeSettings(next);
  return next;
}

// ── Queue CRUD ────────────────────────────────────────────────────────────────

export function getQueue() {
  const q = storage.get(QUEUE_KEY);
  if (!Array.isArray(q)) return [];
  // A reload mid-download leaves orphan "downloading" rows. Requeue them so the
  // user isn't stuck with a permanently frozen progress bar.
  return q.map((item) =>
    item.status === QUEUE_STATUS.DOWNLOADING
      ? { ...item, status: QUEUE_STATUS.QUEUED, progress: 0 }
      : item,
  );
}

function writeQueue(queue) {
  storage.set(QUEUE_KEY, queue);
  // notify subscribers
  for (const fn of _subscribers) {
    try {
      fn(queue);
    } catch {
      /* ignore bad subscriber */
    }
  }
  return queue;
}

const _subscribers = new Set();

export function subscribeQueue(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

/** Stable-ish key for dedupe. Falls back to the URL when there's no tmdb id. */
export function queueKey(item) {
  if (item.tmdbId != null || item.mediaId != null) {
    const id = item.tmdbId ?? item.mediaId;
    return `${item.mediaType || "movie"}_${id}_s${item.season ?? 0}_e${item.episode ?? 0}`;
  }
  return `url_${item.m3u8Url || item.name || crypto.randomUUID()}`;
}

export function addToQueue(item, { priority = 0, posterPath = null, name } = {}) {
  const queue = getQueue();
  const key = queueKey(item);
  if (queue.some((q) => q.key === key && q.status !== QUEUE_STATUS.DONE)) {
    return { queue, added: false };
  }
  const entry = {
    ...item,
    key,
    posterPath: item.posterPath ?? posterPath,
    name: name ?? item.name,
    priority, // 0 normal, 1 high, 2 urgent
    status: QUEUE_STATUS.QUEUED,
    progress: 0,
    speed: "",
    lastMessage: "Waiting…",
    addedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    downloadId: null, // set once runDownload returns an id
  };
  queue.push(entry);
  sortQueue(queue);
  return { queue: writeQueue(queue), added: true };
}

export function removeFromQueue(key) {
  return writeQueue(getQueue().filter((q) => q.key !== key));
}

export function updateQueueItem(key, patch) {
  const queue = getQueue();
  const i = queue.findIndex((q) => q.key === key);
  if (i === -1) return queue;
  queue[i] = { ...queue[i], ...patch };
  return writeQueue(queue);
}

export function setPriority(key, priority) {
  const queue = getQueue();
  const i = queue.findIndex((q) => q.key === key);
  if (i === -1) return queue;
  queue[i].priority = priority;
  sortQueue(queue);
  return writeQueue(queue);
}

/** Move a queued item up or down in priority order. */
export function moveInQueue(key, dir) {
  const queue = getQueue();
  const i = queue.findIndex((q) => q.key === key);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= queue.length) return queue;
  const a = queue[i];
  queue[i] = queue[j];
  queue[j] = a;
  return writeQueue(queue);
}

function sortQueue(queue) {
  queue.sort(
    (a, b) => b.priority - a.priority || a.addedAt - b.addedAt,
  );
}

export function clearFinished() {
  return writeQueue(
    getQueue().filter(
      (q) =>
        q.status !== QUEUE_STATUS.DONE &&
        q.status !== QUEUE_STATUS.CANCELLED,
    ),
  );
}

// ── Execution ────────────────────────────────────────────────────────────────

// token is NOT persisted: it's minted per session by checkDownloader and bound
// to a trusted binary path in the main process. We re-resolve it at start time.
let _activeCount = 0;
const _running = new Set();

function eligible(queue, settings) {
  return queue.filter(
    (q) =>
      q.status === QUEUE_STATUS.QUEUED && !_running.has(q.key),
  );
}

// ── "Don't disturb": hold new downloads while the user is watching ────────────
// Player pages announce their play state over a window event (see
// player-state.js); the queue reads it so the setting isn't decorative.
const PLAYER_PLAYING_EVENT = "streambert:player-state";

let _playingNow = false;

export function announcePlayerState(isPlaying) {
  _playingNow = !!isPlaying;
  window.dispatchEvent(
    new CustomEvent(PLAYER_PLAYING_EVENT, { detail: { playing: _playingNow } }),
  );
}

export function isPlayerPlaying() {
  return _playingNow;
}

/** True when the queue may start a new item under the current settings. */
export function canStartNow(settings = readSettings()) {
  if (!settings.enabled) return false;
  if (settings.pauseWhilePlaying && isPlayerPlaying()) return false;
  return true;
}

/**
 * Start as many queued items as the concurrency budget allows.
 * `ctx` needs: { getToken(): Promise<string|null>, onStarted(entry, dl) }
 */
export async function pump(ctx) {
  if (!canStartNow()) return getQueue();

  let queue = getQueue();
  let started = 0;
  let safety = 0;
  const settings = readSettings();

  while (_activeCount < settings.maxConcurrent && safety++ < 50) {
    queue = getQueue();
    const next = eligible(queue, settings)[0];
    if (!next) break;

    _activeCount += 1;
    _running.add(next.key);
    updateQueueItem(next.key, {
      status: QUEUE_STATUS.DOWNLOADING,
      startedAt: Date.now(),
      lastMessage: "Starting…",
    });

    try {
      const token = await ctx.getToken(next);
      if (!token) {
        updateQueueItem(next.key, {
          status: QUEUE_STATUS.ERROR,
          error: "Downloader binary not found — set the folder in Settings",
          finishedAt: Date.now(),
        });
        _activeCount -= 1;
        _running.delete(next.key);
        continue;
      }

      const result = await window.electron.runDownload({
        token,
        m3u8Url: next.m3u8Url,
        subtitles: next.subtitles || [],
        name: next.name,
        downloadPath: next.downloadPath,
        mediaId: next.mediaId,
        mediaType: next.mediaType,
        season: next.season,
        episode: next.episode,
        posterPath: next.posterPath || null,
        tmdbId: next.tmdbId ?? next.mediaId ?? null,
      });

      if (!result?.ok) {
        updateQueueItem(next.key, {
          status: QUEUE_STATUS.ERROR,
          error: result?.error || "Failed to start",
          finishedAt: Date.now(),
        });
      } else {
        updateQueueItem(next.key, { downloadId: result.id });
        ctx.onStarted?.(getQueue().find((q) => q.key === next.key), result);
        started += 1;
        // The active slot is released by releaseSlot() when the download
        // progress event reports a terminal state for this key.
      }
    } catch (err) {
      updateQueueItem(next.key, {
        status: QUEUE_STATUS.ERROR,
        error: err?.message || String(err),
        finishedAt: Date.now(),
      });
      _activeCount -= 1;
      _running.delete(next.key);
    }
  }

  return getQueue();
}

export function releaseSlot(key, { ok, progress, speed, message }) {
  _activeCount = Math.max(0, _activeCount - 1);
  _running.delete(key);
  updateQueueItem(key, {
    status: ok ? QUEUE_STATUS.DONE : QUEUE_STATUS.ERROR,
    progress: progress ?? 100,
    speed: speed ?? "",
    lastMessage: message ?? (ok ? "Done" : "Failed"),
    finishedAt: Date.now(),
  });
}

/**
 * Bridge the global download-progress stream into queue state.
 * Returns an unsubscribe function. Safe to call once per app session.
 */
export function attachProgressBridge() {
  if (!window.electron?.onDownloadProgress) return () => {};
  const handler = window.electron.onDownloadProgress((d) => {
    const queue = getQueue();
    const entry = queue.find((q) => q.downloadId === d?.id);
    if (!entry) return;
    const terminal =
      d.status === "completed" ||
      d.status === "error" ||
      d.status === "interrupted";
    if (terminal) {
      releaseSlot(entry.key, {
        ok: d.status === "completed",
        progress: d.progress,
        speed: d.speed,
        message: d.lastMessage,
      });
    } else {
      updateQueueItem(entry.key, {
        progress: d.progress ?? entry.progress,
        speed: d.speed ?? "",
        lastMessage: d.lastMessage ?? entry.lastMessage,
      });
    }
  });
  return () => window.electron.offDownloadProgress?.(handler);
}

/** Restart anything left mid-flight (called once on app start). */
export function reconcileOnStartup() {
  const queue = getQueue();
  let changed = false;
  const fixed = queue.map((q) => {
    if (q.status === QUEUE_STATUS.DOWNLOADING) {
      changed = true;
      return { ...q, status: QUEUE_STATUS.QUEUED, progress: 0 };
    }
    return q;
  });
  if (changed) writeQueue(fixed);
  return fixed;
}

export { QUEUE_KEY, SETTINGS_KEY, DEFAULT_SETTINGS };