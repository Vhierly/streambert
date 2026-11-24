import { useState, useEffect } from "react";
import { PLAYER_SOURCES } from "./api";

const HEALTH_TTL = 3 * 60 * 1000; // 3 minutes
let _healthCache = { ts: 0, data: {} };
let _inflight = null;

function getSourceOriginTargets() {
  return PLAYER_SOURCES.map((s) => {
    try {
      const sample = s.movieUrl ? s.movieUrl("550") : null;
      if (!sample) return null;
      return { id: s.id, url: new URL(sample).origin };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function useSourceHealth(menuOpen) {
  const [health, setHealth] = useState(() => _healthCache.data);

  useEffect(() => {
    if (!menuOpen || !window.electron?.pingPlayerSources) return;
    if (Date.now() - _healthCache.ts < HEALTH_TTL) {
      setHealth(_healthCache.data);
      return;
    }
    let mounted = true;
    if (!_inflight) {
      _inflight = window.electron
        .pingPlayerSources(getSourceOriginTargets())
        .then((res) => {
          _healthCache = { ts: Date.now(), data: res || {} };
          return _healthCache.data;
        })
        .catch(() => ({}))
        .finally(() => {
          _inflight = null;
        });
    }
    _inflight.then((data) => {
      if (mounted) setHealth(data);
    });
    return () => {
      mounted = false;
    };
  }, [menuOpen]);

  return health;
}

export function getHealthIndicator(entry) {
  if (!entry) return null;
  if (!entry.ok) return { color: "#ef4444", label: "Offline" };
  if (entry.ms <= 450) return { color: "#48c774", label: `${entry.ms}ms` };
  return { color: "#f59e0b", label: `${entry.ms}ms` };
}
