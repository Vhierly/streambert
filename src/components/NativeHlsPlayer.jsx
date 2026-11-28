import { useState, useEffect, useRef } from "react";
import Hls from "hls.js";

// shortcut: uses browser native <video> controls + hls.js without custom seekbar/transcoding; some tokenized or non-HLS embeds require Back to Embed
export default function NativeHlsPlayer({
  m3u8Url,
  subtitles = [],
  initialPct = 0,
  progressKey,
  onSaveProgress,
  onExit,
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const lastSaveRef = useRef(0);
  const seekedRef = useRef(false);
  const [selectedSub, setSelectedSub] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !m3u8Url) return;
    let hls = null;
    let cancelled = false;
    let recovered = false;
    seekedRef.current = false;
    setError(null);

    const start = async () => {
      try {
        await window.electron?.setNativeHlsStream?.(m3u8Url);
      } catch {}
      if (cancelled) return;

      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hls.loadSource(m3u8Url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data?.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls.recoverMediaError();
            return;
          }
          setError(data.details || "Stream failed to load natively");
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = m3u8Url;
        video.play().catch(() => {});
      } else {
        setError("HLS playback is not supported");
      }
    };

    start();
    return () => {
      cancelled = true;
      if (hls) {
        hls.destroy();
        hls = null;
      }
      window.electron?.setNativeHlsStream?.(null).catch(() => {});
    };
  }, [m3u8Url]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "SELECT" || tag === "BUTTON" || tag === "INPUT") return;
      const video = videoRef.current;
      if (!video) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        const target = containerRef.current || video;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else target.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video || seekedRef.current) return;
    if (initialPct > 2 && initialPct < 96 && Number.isFinite(video.duration) && video.duration > 30) {
      seekedRef.current = true;
      video.currentTime = (initialPct / 100) * video.duration;
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !progressKey || !onSaveProgress) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const now = Date.now();
    if (now - lastSaveRef.current < 10000) return;
    lastSaveRef.current = now;
    const pct = Math.min(100, Math.round((video.currentTime / video.duration) * 100));
    if (pct > 0) onSaveProgress(progressKey, pct);
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 25,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        crossOrigin="anonymous"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onError={() => setError("Playback failed natively")}
        style={{ width: "100%", height: "100%", background: "#000" }}
      >
        {selectedSub && (
          <track
            key={selectedSub}
            kind="subtitles"
            src={selectedSub}
            label="Subtitle"
            default
          />
        )}
      </video>

      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          className="player-overlay-btn"
          style={{ cursor: "default", color: "#4ade80", pointerEvents: "none" }}
        >
          ⚡ Ad-Free Native
        </span>
        {subtitles.length > 0 && (
          <select
            className="player-overlay-btn"
            value={selectedSub}
            onChange={(e) => setSelectedSub(e.target.value)}
            style={{ maxWidth: 160 }}
            title="Select captured subtitle"
          >
            <option value="">Subtitles: Off</option>
            {subtitles.map((sub, i) => (
              <option key={sub.url || i} value={sub.url}>
                {sub.lang || `Subtitle ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <button className="player-overlay-btn" onClick={onExit}>
          ✕ Back to Embed
        </button>
      </div>

      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 28,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background: "rgba(0,0,0,0.88)",
            color: "var(--text1)",
          }}
        >
          <span style={{ fontSize: 14, color: "var(--text2)" }}>{error}</span>
          <button className="player-overlay-btn" onClick={onExit}>
            ✕ Back to Embed
          </button>
        </div>
      )}
    </div>
  );
}
