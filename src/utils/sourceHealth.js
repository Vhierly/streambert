// ── Source health: rank + auto-recover ────────────────────────────────────────
// Thin renderer wrapper over the main-process probe in src/ipc/sourceHealth.js.
//
// The existing failover cache (storage.getFailoverSource) handles "this title
// isn't on AllManga". This module handles the other half: "this *host* is
// down/blocked right now", which is a per-host property rather than a
// per-episode one. Both coexist — failover cache is per episode, health is
// per host.

import { PLAYER_SOURCES } from "./api";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // re-probe every 30 min
const STALE_TTL_MS = 6 * 60 * 60 * 1000;

// module-level singleton so every page shares one probe run
let _health = {};
let _refreshedAt = 0;
let _timer = null;
let _listeners = new Set();

const rankOf = { down: 0, flaky: 1, unknown: 2, up: 3 };

export function getHealthMap() {
  return _health;
}

export function getHealth(sourceId) {
  return _health[sourceId] || { status: "unknown" };
}

/**
 * Sort sources best-first: healthy hosts, then unknown, then flaky, then down.
 * Within a tier the authored PLAYER_SOURCES order is preserved, so the user's
 * default source still wins among equally-healthy options.
 */
export function rankSources(sources = PLAYER_SOURCES, health = _health) {
  const order = new Map(sources.map((s, i) => [s.id, i]));
  return [...sources].sort((a, b) => {
    const ra = rankOf[health[a.id]?.status] ?? rankOf.unknown;
    const rb = rankOf[health[b.id]?.status] ?? rankOf.unknown;
    if (ra !== rb) return rb - ra; // healthier first
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

/** Sources considered usable right now (not known-down, not flaky). */
export function healthySources(sources = PLAYER_SOURCES, health = _health) {
  return rankSources(sources, health).filter((s) => {
    const st = health[s.id]?.status;
    return st === "up" || st === "unknown";
  });
}

/**
 * Pick the best alternative after `fromId` failed.
 * Returns null when nothing else is usable, so callers can surface an error
 * instead of silently reloading the same dead source.
 */
export function nextBestSource(fromId, { isAnime = false } = {}) {
  const pool = PLAYER_SOURCES.filter((s) => s.id !== fromId);
  const candidates = healthySources(pool, _health);
  if (!candidates.length) return null;
  // For anime titles prefer anime sources; getNextNonAsyncSource in api.js
  // already encodes that rule, so defer to the authored list when available.
  const animeOnly = candidates.filter((s) => isAnimeSource(s.id));
  if (isAnime && animeOnly.length) return animeOnly[0].id;
  return candidates[0].id;
}

// HiAnime is the only anime source left. This list used to hold six ids for
// sources that have all since been removed, which made isAnimeSource() return
// false for everything — so nextBestSource() never preferred an anime source and
// anime failover hopped onto whatever movie embed happened to rank highest.
const ANIME_SOURCE_IDS = new Set(["hianime"]);

export function isAnimeSource(id) {
  return ANIME_SOURCE_IDS.has(id);
}

function notify() {
  for (const fn of _listeners) {
    try {
      fn(_health);
    } catch {
      /* a bad listener must not break the others */
    }
  }
}

export function subscribeHealth(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Drop verdicts for sources that no longer exist.
 *
 * The cache is merged, never replaced, so removing a source left its entry
 * behind forever — six removed anime hosts were still being probed every 6h and
 * still showed up in the health map. Prune on load and after every refresh.
 */
function pruneHealth(map, sources = PLAYER_SOURCES) {
  const live = new Set(sources.map((s) => s.id));
  let changed = false;
  for (const id of Object.keys(map)) {
    if (!live.has(id)) {
      delete map[id];
      changed = true;
    }
  }
  return changed;
}

/** Load cached verdicts immediately, then schedule a probe. */
export async function initSourceHealth({ autoRefresh = true } = {}) {
  if (!window.electron?.sourceHealthGet) return _health;
  try {
    _health = (await window.electron.sourceHealthGet()) || {};
    pruneHealth(_health);
    _refreshedAt = Date.now();
    notify();
  } catch {
    /* first run: no cache file yet */
  }

  const needsProbe = Object.values(_health).some((h) => h.stale) ||
    Object.keys(_health).length === 0;
  if (needsProbe) refreshSourceHealth();

  if (autoRefresh && _timer === null) {
    _timer = setInterval(() => {
      if (Date.now() - _refreshedAt >= REFRESH_INTERVAL_MS) refreshSourceHealth();
    }, REFRESH_INTERVAL_MS);
    // Don't hold the event loop open in tests / teardown.
    if (_timer.unref) _timer.unref();
  }
  return _health;
}

export async function refreshSourceHealth(ids) {
  if (!window.electron?.sourceHealthCheck) return _health;
  try {
    const fresh = (await window.electron.sourceHealthCheck(ids)) || {};
    _health = { ..._health, ...fresh };
    pruneHealth(_health);
    _refreshedAt = Date.now();
    notify();
  } catch {
    /* offline: keep the last known map */
  }
  return _health;
}

/** Called when a play attempt visibly fails on this source. */
export async function reportSourceFailure(sourceId) {
  if (!window.electron?.sourceHealthReportFailure) return;
  try {
    const entry = await window.electron.sourceHealthReportFailure(sourceId);
    if (entry) {
      _health = { ..._health, [sourceId]: entry };
      notify();
    }
  } catch {}
}

export async function reportSourceSuccess(sourceId) {
  if (!window.electron?.sourceHealthReportSuccess) return;
  try {
    const entry = await window.electron.sourceHealthReportSuccess(sourceId);
    if (entry) {
      _health = { ..._health, [sourceId]: entry };
      notify();
    }
  } catch {}
}

/** Manual "check now" from Settings. */
export async function resetAndRefresh() {
  if (window.electron?.sourceHealthReset) {
    try {
      await window.electron.sourceHealthReset();
    } catch {}
  }
  _health = {};
  return refreshSourceHealth();
}

export function stopHealthTimer() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

export { STALE_TTL_MS };