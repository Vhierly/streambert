import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { CloseIcon, ExternalLinkIcon } from "./Icons";
import { srtToVtt, shiftVttTimestamps } from "../utils/srtToVtt";
import { storage } from "../utils/storage";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export default function LocalPlayerModal({
  dl,
  watchedKey,
  initialSecs = 0,
  onSaveSecs,
  onSaveProgress,
  onMarkWatched,
  onOpenExternal,
  onClose,
}) {
  const videoRef = useRef(null);
  const [speed, setSpeed] = useState(1);
  const [subOffset, setSubOffset] = useState(0);
  const [rawTracks, setRawTracks] = useState([]); // [{ lang, label, vtt }]
  const [playbackError, setPlaybackError] = useState(false);
  const autoMarkedRef = useRef(false);
  const watchedThreshold = useMemo(
    () => storage.get("watchedThreshold") ?? 20,
    [],
  );

  const mediaUrl = useMemo(
    () =>
      dl?.filePath
        ? `streambert-media://local?path=${encodeURIComponent(dl.filePath)}`
        : "",
    [dl?.filePath],
  );

  // Load local subtitle files (.srt / .vtt) and convert to WebVTT
  useEffect(() => {
    let mounted = true;
    const subs = dl?.subtitlePaths || [];
    if (!subs.length || !window.electron?.readSubtitleText) {
      setRawTracks([]);
      return;
    }
    Promise.all(
      subs.map(async (sp, i) => {
        const p = typeof sp === "string" ? sp : sp?.path;
        const lang = (typeof sp === "object" && sp?.lang) || `sub${i + 1}`;
        const res = await window.electron.readSubtitleText(p);
        if (!res?.ok || !res.text) return null;
        return {
          lang,
          label: lang.toUpperCase(),
          vtt: srtToVtt(res.text),
        };
      }),
    ).then((loaded) => {
      if (mounted) setRawTracks(loaded.filter(Boolean));
    });
    return () => {
      mounted = false;
    };
  }, [dl?.subtitlePaths]);

  // Create shifted Blob URLs whenever rawTracks or subOffset changes
  const trackUrls = useMemo(() => {
    return rawTracks.map((t) => {
      const shifted = shiftVttTimestamps(t.vtt, subOffset);
      const blob = new Blob([shifted], { type: "text/vtt" });
      return { ...t, url: URL.createObjectURL(blob) };
    });
  }, [rawTracks, subOffset]);

  useEffect(() => {
    return () => {
      trackUrls.forEach((t) => URL.revokeObjectURL(t.url));
    };
  }, [trackUrls]);

  const flushProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.duration || !Number.isFinite(v.duration)) return;
    const ct = Math.floor(v.currentTime || 0);
    const dur = v.duration;
    onSaveSecs?.(ct, dur);
    if (watchedKey) {
      const pct = Math.min(100, Math.max(0, Math.round((ct / dur) * 100)));
      onSaveProgress?.(watchedKey, pct);
      if (!autoMarkedRef.current && dur - ct <= watchedThreshold && dur > 30) {
        autoMarkedRef.current = true;
        onMarkWatched?.(watchedKey);
      }
    }
  }, [watchedKey, watchedThreshold, onSaveSecs, onSaveProgress, onMarkWatched]);

  // Periodic 5s progress sync
  useEffect(() => {
    const id = setInterval(flushProgress, 5000);
    return () => {
      clearInterval(id);
      flushProgress();
    };
  }, [flushProgress]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        flushProgress();
        onClose();
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 10);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flushProgress, onClose]);

  const handleSpeedChange = (s) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  return (
    <div
      className="trailer-overlay"
      onClick={() => {
        flushProgress();
        onClose();
      }}
    >
      <div
        className="trailer-modal"
        style={{ maxWidth: 1080, width: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="trailer-modal-header" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="trailer-modal-title" style={{ flex: 1 }}>
            {dl?.name || "Local Player"}
          </span>

          {/* Speed pills */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleSpeedChange(s)}
                style={{
                  padding: "3px 7px",
                  fontSize: 11,
                  fontWeight: speed === s ? 700 : 500,
                  borderRadius: 5,
                  border: `1px solid ${speed === s ? "var(--red)" : "var(--border)"}`,
                  background: speed === s ? "var(--red-dim)" : "var(--surface)",
                  color: speed === s ? "var(--red)" : "var(--text2)",
                  cursor: "pointer",
                }}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* Subtitle sync offset controls */}
          {trackUrls.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text3)",
              }}
              title="Adjust subtitle timing offset"
            >
              <button
                type="button"
                className="trailer-openbrowser-btn"
                onClick={() => setSubOffset((v) => +(v - 0.5).toFixed(1))}
              >
                Sub -0.5s
              </button>
              <span style={{ minWidth: 36, textAlign: "center", color: "var(--text2)" }}>
                {subOffset >= 0 ? `+${subOffset}s` : `${subOffset}s`}
              </span>
              <button
                type="button"
                className="trailer-openbrowser-btn"
                onClick={() => setSubOffset((v) => +(v + 0.5).toFixed(1))}
              >
                +0.5s
              </button>
            </div>
          )}

          {onOpenExternal && (
            <button
              type="button"
              className="trailer-openbrowser-btn"
              onClick={() => {
                flushProgress();
                onOpenExternal();
                onClose();
              }}
              title="Open in mpv / VLC instead"
            >
              <ExternalLinkIcon size={12} /> MPV / VLC
            </button>
          )}

          <button
            className="trailer-close-btn"
            onClick={() => {
              flushProgress();
              onClose();
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <div style={{ background: "#000", position: "relative" }}>
          {playbackError ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text2)" }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                Unsupported codec in built-in player
              </div>
              <div style={{ fontSize: 13, color: "var(--text3)", marginBottom: 18 }}>
                This video uses an audio/video codec (e.g. HEVC / AC3) best played in mpv or VLC.
              </div>
              {onOpenExternal && (
                <button
                  className="btn btn-primary"
                  style={{ marginInline: "auto" }}
                  onClick={() => {
                    onOpenExternal();
                    onClose();
                  }}
                >
                  Open in External Player (mpv / VLC)
                </button>
              )}
            </div>
          ) : (
            <video
              ref={videoRef}
              src={mediaUrl}
              controls
              autoPlay
              style={{
                width: "100%",
                maxHeight: "78vh",
                display: "block",
                background: "#000",
              }}
              onLoadedMetadata={(e) => {
                if (initialSecs > 0 && e.currentTarget.duration > initialSecs + 3) {
                  e.currentTarget.currentTime = initialSecs;
                }
              }}
              onPause={flushProgress}
              onEnded={() => {
                if (watchedKey) onMarkWatched?.(watchedKey);
                flushProgress();
              }}
              onError={() => setPlaybackError(true)}
            >
              {trackUrls.map((t, i) => (
                <track
                  key={`${t.lang}_${i}_${subOffset}`}
                  kind="subtitles"
                  src={t.url}
                  srcLang={t.lang}
                  label={t.label}
                  default={i === 0}
                />
              ))}
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
