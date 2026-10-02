// ── DownloadQueuePanel ────────────────────────────────────────────────────────
// The visible half of utils/downloadQueue.js. Renders the persisted queue,
// lets the user reorder / prioritise / cancel / retry, and drives the pump.
//
// Mounted from DownloadsPage so the queue is visible where downloads already
// are, and from DownloadModal so a user who just queued something sees it land.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  QUEUE_STATUS,
  getQueue,
  subscribeQueue,
  addToQueue,
  removeFromQueue,
  updateQueueItem,
  setPriority,
  moveInQueue,
  clearFinished,
  getQueueSettings,
  saveQueueSettings,
  pump,
  attachProgressBridge,
  reconcileOnStartup,
} from "../utils/downloadQueue";
import { storage } from "../utils/storage";

const fmtSize = (s) => (s ? String(s) : "");

function statusMeta(status) {
  switch (status) {
    case QUEUE_STATUS.QUEUED:
      return { label: "Queued", color: "var(--text3)" };
    case QUEUE_STATUS.DOWNLOADING:
      return { label: "Downloading", color: "var(--red)" };
    case QUEUE_STATUS.DONE:
      return { label: "Done", color: "#22c55e" };
    case QUEUE_STATUS.ERROR:
      return { label: "Failed", color: "#f59e0b" };
    case QUEUE_STATUS.CANCELLED:
      return { label: "Cancelled", color: "var(--text3)" };
    default:
      return { label: status, color: "var(--text3)" };
  }
}

export default function DownloadQueuePanel({ onDownloadStarted, compact = false }) {
  const [queue, setQueue] = useState(() => getQueue());
  const [settings, setSettings] = useState(() => getQueueSettings());
  const [expanded, setExpanded] = useState(!compact);
  const [open, setOpen] = useState(false);
  const [playerPlaying, setPlayerPlaying] = useState(false);
  const pumpLock = useRef(false);

  const downloaderFolder = storage.get("downloaderFolder") || "";

  // Resolve a fresh downloader token per start — tokens are session-scoped and
  // bound to a trusted binary path in the main process, so they must not be
  // persisted in the queue.
  const getToken = useCallback(async () => {
    if (!downloaderFolder) return null;
    try {
      const res = await window.electron?.checkDownloader?.(downloaderFolder);
      return res?.token ?? null;
    } catch {
      return null;
    }
  }, [downloaderFolder]);

  // Start the pump whenever a slot frees up.
  const runPump = useCallback(async () => {
    if (pumpLock.current) return;
    pumpLock.current = true;
    try {
      await pump({ getToken, onStarted: onDownloadStarted });
    } finally {
      pumpLock.current = false;
    }
  }, [getToken, onDownloadStarted]);

  // Requeue orphans left over from a previous session, and react when the
  // player starts/stops so "Don't disturb" actually holds the queue.
  useEffect(() => {
    reconcileOnStartup();
    const off = subscribeQueue((q) => setQueue([...q]));
    const offProgress = attachProgressBridge();
    const onPlayerState = (e) => {
      setPlayerPlaying(!!e.detail?.playing);
      // Playback stopped → queued items may start now.
      if (!e.detail?.playing) runPump();
    };
    window.addEventListener("streambert:player-state", onPlayerState);
    return () => {
      off();
      offProgress();
      window.removeEventListener("streambert:player-state", onPlayerState);
    };
  }, [runPump]);

  useEffect(() => {
    runPump();
  }, [queue, runPump]);

  const pending = useMemo(
    () => queue.filter((q) => q.status !== QUEUE_STATUS.DONE),
    [queue],
  );
  const finishedCount = useMemo(
    () => queue.filter((q) => q.status === QUEUE_STATUS.DONE).length,
    [queue],
  );
  const heldByPlayer =
    playerPlaying && settings.pauseWhilePlaying && pending.length > 0;

  const handleRetry = (entry) => {
    updateQueueItem(entry.key, {
      status: QUEUE_STATUS.QUEUED,
      error: null,
      finishedAt: null,
      progress: 0,
    });
  };

  const handleCancel = (entry) => {
    updateQueueItem(entry.key, {
      status: QUEUE_STATUS.CANCELLED,
      finishedAt: Date.now(),
    });
  };

  if (!open) {
    return (
      <button
        className="btn btn-ghost"
        onClick={() => setOpen(true)}
        style={{ marginBottom: 12 }}
      >
        Queue{pending.length > 0 ? ` (${pending.length})` : ""}
      </button>
    );
  }

  return (
    <div className="dlq-panel">
      <div className="dlq-head">
        <button
          className="dlq-head__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="dlq-head__chevron">{expanded ? "▾" : "▸"}</span>
          Download Queue
          <span className="dlq-count">
            {pending.length}
            {finishedCount > 0 && ` · ${finishedCount} done`}
          </span>
        </button>
        <div className="dlq-head__actions">
          <label
            className="dlq-toggle"
            title="Pause starting new downloads while you're watching"
          >
            <input
              type="checkbox"
              checked={settings.pauseWhilePlaying}
              onChange={(e) =>
                setSettings(
                  saveQueueSettings({ pauseWhilePlaying: e.target.checked }),
                )
              }
            />
            <span>Don't disturb</span>
          </label>
          <button
            className="btn btn-ghost btn-sm"
            onClick={runPump}
            title="Start the next queued item now"
          >
            Start next
          </button>
          {finishedCount > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setQueue([...clearFinished()])}
            >
              Clear done
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
      </div>

      {expanded && (
        <div className="dlq-list">
          {heldByPlayer && (
            <div className="dlq-held">
              Holding downloads while you watch — they'll start when playback
              stops.
            </div>
          )}
          {queue.length === 0 && (
            <div className="dlq-empty">
              Nothing queued. Use “Add to queue” on a title to line up several
              episodes at once.
            </div>
          )}

          {queue.map((entry) => {
            const meta = statusMeta(entry.status);
            const canOrder = entry.status === QUEUE_STATUS.QUEUED;
            return (
              <div
                key={entry.key}
                className={`dlq-item dlq-item--${entry.status}`}
              >
                <div className="dlq-item__main">
                  <div className="dlq-item__title" title={entry.name}>
                    {entry.name}
                  </div>
                  <div className="dlq-item__meta">
                    <span style={{ color: meta.color }}>{meta.label}</span>
                    {entry.status === QUEUE_STATUS.DOWNLOADING && (
                      <>
                        <span>· {Math.round(entry.progress || 0)}%</span>
                        {entry.speed && <span>· {fmtSize(entry.speed)}</span>}
                      </>
                    )}
                    {entry.error && (
                      <span className="dlq-item__err">· {entry.error}</span>
                    )}
                    {!entry.error && entry.lastMessage &&
                      entry.status !== QUEUE_STATUS.DOWNLOADING && (
                        <span>· {entry.lastMessage}</span>
                      )}
                  </div>
                  {entry.status === QUEUE_STATUS.DOWNLOADING && (
                    <div className="dlq-item__bar">
                      <div
                        className="dlq-item__bar-fill"
                        style={{ width: `${Math.min(entry.progress || 0, 100)}%` }}
                      />
                    </div>
                  )}
                </div>

                <div className="dlq-item__controls">
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canOrder}
                    title="Move up"
                    onClick={() => setQueue([...moveInQueue(entry.key, -1)])}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canOrder}
                    title="Move down"
                    onClick={() => setQueue([...moveInQueue(entry.key, 1)])}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canOrder || entry.priority >= 2}
                    title={
                      entry.priority === 1 ? "Already high priority" : "Move to front"
                    }
                    onClick={() =>
                      setQueue([...setPriority(entry.key, entry.priority + 1)])
                    }
                  >
                    {entry.priority > 0 ? `P${entry.priority}` : "Prioritise"}
                  </button>
                  {(entry.status === QUEUE_STATUS.ERROR ||
                    entry.status === QUEUE_STATUS.CANCELLED) && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleRetry(entry)}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Remove from queue"
                    onClick={() =>
                      setQueue([...removeFromQueue(entry.key)])
                    }
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── "Add to queue" button, reusable wherever a title has an m3u8 ──────────────
export function AddToQueueButton({ item, label = "Add to queue" }) {
  const [added, setAdded] = useState(false);
  const downloaderFolder = storage.get("downloaderFolder") || "";

  const handle = () => {
    if (!item?.m3u8Url) return;
    addToQueue(
      {
        m3u8Url: item.m3u8Url,
        subtitles: item.subtitles || [],
        downloadPath: item.downloadPath || storage.get("downloadPath"),
        mediaId: item.mediaId,
        mediaType: item.mediaType,
        season: item.season,
        episode: item.episode,
        posterPath: item.posterPath,
        tmdbId: item.tmdbId,
      },
      { posterPath: item.posterPath, name: item.name },
    );
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  };

  if (!item?.m3u8Url) return null;

  return (
    <button
      className="btn btn-ghost"
      onClick={handle}
      disabled={!downloaderFolder}
      title={
        downloaderFolder
          ? "Queue this for download instead of starting it now"
          : "Set a download folder in Settings first"
      }
    >
      {added ? "Queued ✓" : label}
    </button>
  );
}