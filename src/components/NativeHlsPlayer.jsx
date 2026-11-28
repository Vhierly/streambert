import { useState, useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import { parseSubtitleCues } from "../utils/srtToVtt";
import { secureStorage, STORAGE_KEYS } from "../utils/storage";

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// Cinema-style Ad-Free HLS player with full quality/audio/subtitle/speed controls.
export default function NativeHlsPlayer({
  m3u8Url,
  subtitles = [],
  initialPct = 0,
  progressKey,
  onSaveProgress,
  onExit,
  title = "",
  tmdbId = null,
  mediaType = "movie",
  season = null,
  episode = null,
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const scrubRef = useRef(null);
  const lastSaveRef = useRef(0);
  const seekedRef = useRef(false);
  const hudTimerRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverPct, setHoverPct] = useState(0);
  const [error, setError] = useState(null);

  // Quality & audio tracks
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [audioTracks, setAudioTracks] = useState([]);
  const [currentAudio, setCurrentAudio] = useState(-1);

  // Subtitles: "off" | "hls:<idx>" | "cap:<idx>" | "online:<id>"
  const [hlsSubTracks, setHlsSubTracks] = useState([]);
  const [onlineSubs, setOnlineSubs] = useState([]);
  const [selectedSubId, setSelectedSubId] = useState("off");
  const [parsedCues, setParsedCues] = useState([]);
  const [activeCueText, setActiveCueText] = useState("");
  const [subOffsetSec, setSubOffsetSec] = useState(0);
  const [subSizePx, setSubSizePx] = useState(21);
  const [subSearchLang, setSubSearchLang] = useState("id");
  const [searchingSubs, setSearchingSubs] = useState(false);
  const [subStatusMsg, setSubStatusMsg] = useState("");

  // Popovers: null | "cc" | "settings"
  const [openMenu, setOpenMenu] = useState(null);

  const scheduleHideHud = useCallback(() => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    setHudVisible(true);
    hudTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !openMenu) setHudVisible(false);
    }, 2800);
  }, [openMenu]);

  useEffect(() => {
    scheduleHideHud();
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    };
  }, [scheduleHideHud]);

  // Sync fullscreen state
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Load HLS manifest with main-process Referer/Origin + CORS bridge
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !m3u8Url) return;
    let hls = null;
    let cancelled = false;
    let recovered = false;
    seekedRef.current = false;
    setError(null);
    setBuffering(true);
    setLevels([]);
    setCurrentLevel(-1);
    setAudioTracks([]);
    setCurrentAudio(-1);
    setHlsSubTracks([]);
    setSelectedSubId("off");
    setParsedCues([]);
    setActiveCueText("");

    video.muted = false;
    video.volume = volume;

    const syncTracks = (instance) => {
      if (!instance) return;
      if (Array.isArray(instance.levels)) {
        setLevels(
          instance.levels.map((lv, i) => ({
            id: i,
            height: lv.height || 0,
            bitrate: lv.bitrate || 0,
            label: lv.height
              ? `${lv.height}p`
              : `${Math.round((lv.bitrate || 0) / 1000)} kbps`,
          })),
        );
        setCurrentLevel(instance.currentLevel);
      }
      if (Array.isArray(instance.audioTracks) && instance.audioTracks.length > 0) {
        setAudioTracks(
          instance.audioTracks.map((t, i) => ({
            id: i,
            name: t.name || t.lang || `Audio ${i + 1}`,
            lang: t.lang || "",
          })),
        );
        if (instance.audioTrack < 0 || instance.audioTrack >= instance.audioTracks.length) {
          instance.audioTrack = 0;
        }
        setCurrentAudio(instance.audioTrack);
      }
      if (Array.isArray(instance.subtitleTracks)) {
        setHlsSubTracks(
          instance.subtitleTracks.map((t, i) => ({
            id: i,
            name: t.name || t.lang || `Track ${i + 1}`,
            lang: t.lang || "",
          })),
        );
      }
    };

    const start = async () => {
      try {
        await window.electron?.setNativeHlsStream?.(m3u8Url);
      } catch {}
      if (cancelled) return;

      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        hls.loadSource(m3u8Url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          syncTracks(hls);
          video.muted = muted;
          video.volume = volume;
          video.playbackRate = playbackRate;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => syncTracks(hls));
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, d) => setCurrentAudio(d.id));
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
          if (hls.autoLevelEnabled) setCurrentLevel(-1);
          else setCurrentLevel(d.level);
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => syncTracks(hls));
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
        video.muted = muted;
        video.volume = volume;
        video.play().catch(() => {});
      } else {
        setError("HLS playback is not supported");
      }
    };

    start();
    return () => {
      cancelled = true;
      hlsRef.current = null;
      if (hls) hls.destroy();
      window.electron?.setNativeHlsStream?.(null).catch(() => {});
    };
  }, [m3u8Url]);

  // Apply subtitle selection across HLS, captured .vtt, or online cached subtitles
  useEffect(() => {
    const hls = hlsRef.current;
    const video = videoRef.current;
    let cancelled = false;

    const clearTextTracks = () => {
      if (!video?.textTracks) return;
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = "disabled";
      }
    };

    setActiveCueText("");
    if (!selectedSubId || selectedSubId === "off") {
      if (hls) hls.subtitleTrack = -1;
      clearTextTracks();
      setParsedCues([]);
      return;
    }

    if (selectedSubId.startsWith("hls:")) {
      const idx = Number(selectedSubId.slice(4));
      setParsedCues([]);
      if (hls) hls.subtitleTrack = idx;
      if (video?.textTracks?.[idx]) {
        clearTextTracks();
        video.textTracks[idx].mode = "hidden";
      }
      return;
    }

    if (hls) hls.subtitleTrack = -1;
    clearTextTracks();

    if (selectedSubId.startsWith("online:")) {
      const found = onlineSubs.find((s) => `online:${s.id}` === selectedSubId);
      setParsedCues(found?.rawText ? parseSubtitleCues(found.rawText) : []);
      return;
    }

    if (selectedSubId.startsWith("cap:")) {
      const idx = Number(selectedSubId.slice(4));
      const target = subtitles[idx];
      if (!target?.url) return;
      (async () => {
        try {
          const res = await fetch(target.url);
          if (!res.ok) return;
          const raw = await res.text();
          if (!cancelled && raw) setParsedCues(parseSubtitleCues(raw));
        } catch {
          if (!cancelled) setParsedCues([]);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [selectedSubId, subtitles, onlineSubs]);

  // Render active subtitle cue (from parsed cues or active HLS TextTrack)
  useEffect(() => {
    if (selectedSubId === "off") {
      setActiveCueText("");
      return;
    }
    if (selectedSubId.startsWith("hls:")) {
      const idx = Number(selectedSubId.slice(4));
      const track = videoRef.current?.textTracks?.[idx];
      if (!track?.activeCues) {
        setActiveCueText("");
        return;
      }
      const lines = [];
      for (let i = 0; i < track.activeCues.length; i++) {
        const txt = (track.activeCues[i].text || "").replace(/<[^>]+>/g, "").trim();
        if (txt) lines.push(txt);
      }
      setActiveCueText(lines.join("\n"));
      return;
    }
    if (!parsedCues.length) {
      setActiveCueText("");
      return;
    }
    const t = currentTime - subOffsetSec;
    const matches = parsedCues.filter((c) => t >= c.start && t <= c.end);
    setActiveCueText(matches.map((m) => m.text).join("\n"));
  }, [currentTime, subOffsetSec, parsedCues, selectedSubId]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    scheduleHideHud();
  }, [scheduleHideHud]);

  const seekBy = useCallback(
    (delta) => {
      const v = videoRef.current;
      if (!v) return;
      const cap = Number.isFinite(v.duration) ? v.duration : Infinity;
      v.currentTime = Math.max(0, Math.min(cap, v.currentTime + delta));
      scheduleHideHud();
    },
    [scheduleHideHud],
  );

  const toggleFullscreen = useCallback(() => {
    const target = containerRef.current || videoRef.current;
    if (!target) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else target.requestFullscreen?.().catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
  }, [muted]);

  const handleVolumeChange = (val) => {
    const clamped = Math.max(0, Math.min(1, Number(val)));
    setVolume(clamped);
    if (videoRef.current) {
      videoRef.current.volume = clamped;
      videoRef.current.muted = clamped === 0;
    }
    setMuted(clamped === 0);
  };

  const handleSpeedChange = (rate) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const handleQualityChange = (lvlId) => {
    setCurrentLevel(lvlId);
    if (hlsRef.current) hlsRef.current.currentLevel = lvlId;
  };

  const handleAudioChange = (trackId) => {
    setCurrentAudio(trackId);
    if (hlsRef.current) hlsRef.current.audioTrack = trackId;
  };

  const runOnlineSubSearch = async (lang = subSearchLang) => {
    if (!tmdbId || !window.electron?.searchSubtitles) {
      setSubStatusMsg("Subtitle search unavailable");
      return;
    }
    setSubSearchLang(lang);
    setSearchingSubs(true);
    setSubStatusMsg("");
    try {
      const [subdlApiKey, wyzieApiKey] = await Promise.all([
        secureStorage.get(STORAGE_KEYS.SUBDL_API_KEY),
        secureStorage.get(STORAGE_KEYS.WYZIE_API_KEY),
      ]);
      const res = await window.electron.searchSubtitles({
        tmdbId,
        mediaType,
        season: mediaType === "tv" ? season : undefined,
        episode: mediaType === "tv" ? episode : undefined,
        languages: lang,
        subdlApiKey: subdlApiKey || "",
        wyzieApiKey: wyzieApiKey || "",
      });
      if (!res?.ok || !res.results?.length) {
        setSubStatusMsg(res?.error || "No subtitles found");
        return;
      }
      const list = res.results.slice(0, 6).map((r) => ({
        id: String(r.file_id),
        file_id: r.file_id,
        direct_url: r.direct_url,
        label: `${(r.language || lang || "SUB").toUpperCase()} · ${r.release || r.file_name || r.uploader || "Online"}`,
        rawText: null,
      }));
      setOnlineSubs(list);
      setSubStatusMsg(`${list.length} found`);
    } catch (e) {
      setSubStatusMsg(e.message || "Search failed");
    } finally {
      setSearchingSubs(false);
    }
  };

  const applyOnlineSub = async (item) => {
    if (item.rawText) {
      setSelectedSubId(`online:${item.id}`);
      setOpenMenu(null);
      return;
    }
    if (!window.electron?.fetchSubtitleText) return;
    setSubStatusMsg("Loading…");
    try {
      const res = await window.electron.fetchSubtitleText({
        fileId: item.file_id,
        directUrl: item.direct_url,
      });
      if (!res?.ok || !res.text) {
        setSubStatusMsg(res?.error || "Failed to load");
        return;
      }
      setOnlineSubs((prev) =>
        prev.map((s) => (s.id === item.id ? { ...s, rawText: res.text } : s)),
      );
      setSelectedSubId(`online:${item.id}`);
      setSubStatusMsg("");
      setOpenMenu(null);
    } catch {
      setSubStatusMsg("Load error");
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space" || e.key === "k" || e.key === "K") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft" || e.key === "j" || e.key === "J") {
        e.preventDefault();
        seekBy(-10);
      } else if (e.code === "ArrowRight" || e.key === "l" || e.key === "L") {
        e.preventDefault();
        seekBy(10);
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        handleVolumeChange(volume + 0.1);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        handleVolumeChange(volume - 0.1);
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setOpenMenu((m) => (m === "cc" ? null : "cc"));
      } else if (e.key === "Escape" && openMenu) {
        e.preventDefault();
        setOpenMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, seekBy, volume, toggleMute, toggleFullscreen, openMenu]);

  const scrubFromPointer = (clientX) => {
    const el = scrubRef.current;
    const v = videoRef.current;
    if (!el || !v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration;
    setCurrentTime(v.currentTime);
  };

  const handleScrubPointerDown = (e) => {
    e.preventDefault();
    scrubFromPointer(e.clientX);
    const onMove = (ev) => scrubFromPointer(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0;

  return (
    <div
      ref={containerRef}
      onMouseMove={scheduleHideHud}
      onClick={() => openMenu && setOpenMenu(null)}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 25,
        background: "#000",
        overflow: "hidden",
        userSelect: "none",
        cursor: hudVisible ? "default" : "none",
        fontFamily: "var(--font-body, system-ui, sans-serif)",
      }}
    >
      <video
        ref={videoRef}
        playsInline
        crossOrigin="anonymous"
        onClick={(e) => {
          e.stopPropagation();
          if (openMenu) setOpenMenu(null);
          else togglePlay();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          toggleFullscreen();
        }}
        onPlay={() => {
          setPlaying(true);
          setBuffering(false);
          scheduleHideHud();
        }}
        onPause={() => {
          setPlaying(false);
          setHudVisible(true);
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => {
          setBuffering(false);
          setPlaying(true);
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          setDuration(v.duration || 0);
          setBuffering(false);
          if (
            !seekedRef.current &&
            initialPct > 2 &&
            initialPct < 96 &&
            Number.isFinite(v.duration) &&
            v.duration > 30
          ) {
            seekedRef.current = true;
            v.currentTime = (initialPct / 100) * v.duration;
          }
        }}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          setCurrentTime(v.currentTime || 0);
          if (Number.isFinite(v.duration)) setDuration(v.duration);
          if (v.buffered?.length) {
            setBufferedEnd(v.buffered.end(v.buffered.length - 1));
          }
          if (progressKey && onSaveProgress && v.duration > 0) {
            const now = Date.now();
            if (now - lastSaveRef.current >= 10000) {
              lastSaveRef.current = now;
              const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
              if (pct > 0) onSaveProgress(progressKey, pct);
            }
          }
        }}
        onError={() => setError("Playback failed natively")}
        style={{ width: "100%", height: "100%", background: "#000", objectFit: "contain" }}
      />

      {/* Subtitle overlay */}
      {activeCueText && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: hudVisible ? 88 : 34,
            transform: "translateX(-50%)",
            zIndex: 27,
            maxWidth: "82%",
            padding: "5px 14px",
            borderRadius: 6,
            background: "rgba(0, 0, 0, 0.72)",
            color: "#fff",
            fontSize: subSizePx,
            lineHeight: 1.38,
            fontWeight: 500,
            textAlign: "center",
            whiteSpace: "pre-line",
            textShadow: "0 1px 3px rgba(0,0,0,0.95)",
            pointerEvents: "none",
            transition: "bottom 0.2s ease",
          }}
        >
          {activeCueText}
        </div>
      )}

      {/* Center buffering / paused badge */}
      {(buffering || !playing) && !error && (
        <div
          onClick={togglePlay}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 26,
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.58)",
            border: "1px solid rgba(255,255,255,0.22)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {buffering ? (
            <span style={{ fontSize: 12, fontWeight: 600 }}>•••</span>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      )}

      {/* Top gradient bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 29,
          padding: "14px 18px 28px",
          background: "linear-gradient(to bottom, rgba(0,0,0,0.82), transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          opacity: hudVisible ? 1 : 0,
          pointerEvents: hudVisible ? "auto" : "none",
          transition: "opacity 0.2s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span
            style={{
              padding: "3px 9px",
              borderRadius: 999,
              background: "rgba(74, 222, 128, 0.16)",
              border: "1px solid rgba(74, 222, 128, 0.4)",
              color: "#4ade80",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ⚡ Ad-Free
          </span>
          {title && (
            <span
              style={{
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
          )}
        </div>
        <button className="player-overlay-btn" onClick={onExit}>
          ✕ Back to Embed
        </button>
      </div>

      {/* Bottom control bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 29,
          padding: "28px 16px 12px",
          background: "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.45) 55%, transparent)",
          opacity: hudVisible ? 1 : 0,
          pointerEvents: hudVisible ? "auto" : "none",
          transition: "opacity 0.2s ease",
        }}
      >
        {/* Scrub bar */}
        <div
          ref={scrubRef}
          onPointerDown={handleScrubPointerDown}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverPct(ratio * 100);
            setHoverTime(duration > 0 ? ratio * duration : 0);
          }}
          onMouseLeave={() => setHoverTime(null)}
          style={{
            position: "relative",
            height: 16,
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            marginBottom: 6,
          }}
        >
          {hoverTime !== null && duration > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: 20,
                left: `${hoverPct}%`,
                transform: "translateX(-50%)",
                padding: "2px 6px",
                borderRadius: 4,
                background: "rgba(20,20,20,0.95)",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#fff",
                fontSize: 11,
                fontVariantNumeric: "tabular-nums",
                pointerEvents: "none",
              }}
            >
              {formatClock(hoverTime)}
            </div>
          )}
          <div
            style={{
              position: "relative",
              width: "100%",
              height: hoverTime !== null ? 6 : 4,
              borderRadius: 999,
              background: "rgba(255,255,255,0.22)",
              transition: "height 0.12s ease",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${bufferedPct}%`,
                borderRadius: 999,
                background: "rgba(255,255,255,0.34)",
              }}
            />
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${progressPct}%`,
                borderRadius: 999,
                background: "var(--red, #e50914)",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: `${progressPct}%`,
                transform: "translate(-50%, -50%)",
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 0 6px rgba(0,0,0,0.7)",
                opacity: hoverTime !== null ? 1 : 0,
              }}
            />
          </div>
        </div>

        {/* Control row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={togglePlay} title={playing ? "Pause (Space)" : "Play (Space)"} style={iconBtnStyle}>
              {playing ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button onClick={() => seekBy(-10)} title="Back 10s (J / ←)" style={iconBtnStyle}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>↺10</span>
            </button>
            <button onClick={() => seekBy(10)} title="Forward 10s (L / →)" style={iconBtnStyle}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>10↻</span>
            </button>
            <button onClick={toggleMute} title="Mute (M)" style={iconBtnStyle}>
              {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(e.target.value)}
              style={{ width: 68, accentColor: "var(--red, #e50914)", cursor: "pointer" }}
            />
            <span style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {formatClock(currentTime)} / {formatClock(duration)}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
            <button
              onClick={() => setOpenMenu((m) => (m === "cc" ? null : "cc"))}
              style={{
                ...pillBtnStyle,
                borderColor: selectedSubId !== "off" ? "#4ade80" : "rgba(255,255,255,0.22)",
                color: selectedSubId !== "off" ? "#4ade80" : "#fff",
              }}
              title="Subtitles (C)"
            >
              CC
            </button>
            <button
              onClick={() => setOpenMenu((m) => (m === "settings" ? null : "settings"))}
              style={pillBtnStyle}
              title="Quality, Audio & Speed"
            >
              ⚙ {currentLevel === -1 ? "Auto" : levels[currentLevel]?.label || ""}
            </button>
            {document.pictureInPictureEnabled && (
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
                  else v.requestPictureInPicture?.().catch(() => {});
                }}
                style={pillBtnStyle}
                title="Picture in Picture"
              >
                PiP
              </button>
            )}
            <button onClick={toggleFullscreen} style={iconBtnStyle} title="Fullscreen (F)">
              {isFullscreen ? "⛶" : "⛶"}
            </button>

            {/* Subtitles Popover */}
            {openMenu === "cc" && (
              <div style={popoverStyle}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#fff" }}>
                  Subtitles
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 170, overflowY: "auto" }}>
                  <button
                    onClick={() => {
                      setSelectedSubId("off");
                      setOpenMenu(null);
                    }}
                    style={menuItemStyle(selectedSubId === "off")}
                  >
                    Off
                  </button>
                  {hlsSubTracks.map((t) => (
                    <button
                      key={`hls:${t.id}`}
                      onClick={() => {
                        setSelectedSubId(`hls:${t.id}`);
                        setOpenMenu(null);
                      }}
                      style={menuItemStyle(selectedSubId === `hls:${t.id}`)}
                    >
                      HLS · {t.name}
                    </button>
                  ))}
                  {subtitles.map((s, i) => (
                    <button
                      key={`cap:${i}`}
                      onClick={() => {
                        setSelectedSubId(`cap:${i}`);
                        setOpenMenu(null);
                      }}
                      style={menuItemStyle(selectedSubId === `cap:${i}`)}
                    >
                      Embed · {(s.lang || `Sub ${i + 1}`).toUpperCase()}
                    </button>
                  ))}
                  {onlineSubs.map((s) => (
                    <button
                      key={`online:${s.id}`}
                      onClick={() => applyOnlineSub(s)}
                      style={menuItemStyle(selectedSubId === `online:${s.id}`)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {tmdbId && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", marginBottom: 5 }}>
                      Online SubDL / Wyzie {searchingSubs ? "· Searching…" : subStatusMsg ? `· ${subStatusMsg}` : ""}
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      {[
                        { label: "ID", code: "id" },
                        { label: "EN", code: "en" },
                        { label: "All", code: "" },
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          onClick={() => runOnlineSubSearch(opt.code)}
                          disabled={searchingSubs}
                          style={{
                            ...smallChipStyle(false),
                            flex: 1,
                          }}
                        >
                          🔍 {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.12)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                    Sync {subOffsetSec > 0 ? `+${subOffsetSec}s` : `${subOffsetSec}s`}
                  </span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => setSubOffsetSec((v) => +(v - 0.5).toFixed(1))} style={smallChipStyle(false)}>-0.5s</button>
                    <button onClick={() => setSubOffsetSec(0)} style={smallChipStyle(false)}>0</button>
                    <button onClick={() => setSubOffsetSec((v) => +(v + 0.5).toFixed(1))} style={smallChipStyle(false)}>+0.5s</button>
                  </div>
                </div>
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>Size</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      { l: "S", px: 16 },
                      { l: "M", px: 21 },
                      { l: "L", px: 27 },
                    ].map((s) => (
                      <button
                        key={s.l}
                        onClick={() => setSubSizePx(s.px)}
                        style={smallChipStyle(subSizePx === s.px)}
                      >
                        {s.l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Settings Popover (Quality, Audio, Speed) */}
            {openMenu === "settings" && (
              <div style={popoverStyle}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#fff" }}>
                  Quality
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                  <button onClick={() => handleQualityChange(-1)} style={smallChipStyle(currentLevel === -1)}>
                    Auto
                  </button>
                  {levels.map((lv) => (
                    <button
                      key={lv.id}
                      onClick={() => handleQualityChange(lv.id)}
                      style={smallChipStyle(currentLevel === lv.id)}
                    >
                      {lv.label}
                    </button>
                  ))}
                </div>

                {audioTracks.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#fff" }}>
                      Audio Track
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                      {audioTracks.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => handleAudioChange(t.id)}
                          style={menuItemStyle(currentAudio === t.id)}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "#fff" }}>
                  Speed
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {[0.5, 1, 1.25, 1.5, 2].map((r) => (
                    <button
                      key={r}
                      onClick={() => handleSpeedChange(r)}
                      style={smallChipStyle(playbackRate === r)}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 31,
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

const iconBtnStyle = {
  background: "none",
  border: "none",
  color: "#fff",
  cursor: "pointer",
  padding: "4px 6px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
};

const pillBtnStyle = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.22)",
  color: "#fff",
  cursor: "pointer",
  padding: "4px 9px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
};

const popoverStyle = {
  position: "absolute",
  bottom: 42,
  right: 0,
  width: 256,
  padding: 12,
  borderRadius: 10,
  background: "rgba(18, 18, 22, 0.96)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 12px 32px rgba(0,0,0,0.75)",
  backdropFilter: "blur(12px)",
  zIndex: 35,
};

const menuItemStyle = (active) => ({
  textAlign: "left",
  padding: "5px 8px",
  borderRadius: 6,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  background: active ? "rgba(229, 9, 20, 0.85)" : "rgba(255,255,255,0.06)",
  color: "#fff",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const smallChipStyle = (active) => ({
  padding: "4px 8px",
  borderRadius: 6,
  border: active ? "1px solid var(--red, #e50914)" : "1px solid rgba(255,255,255,0.18)",
  background: active ? "rgba(229, 9, 20, 0.85)" : "rgba(255,255,255,0.07)",
  color: "#fff",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
});
