import { useState, useEffect, useRef, useMemo } from "react";
import Hls from "hls.js";
import { fetchImdbId } from "../utils/api";
import { loadInstalledAddons, queryEnabledAddons } from "../utils/stremio";
import { searchBuiltInTorrents, formatByteSize } from "../utils/torrentSearch";
import { storage, STORAGE_KEYS, isElectron } from "../utils/storage";
import { CloseIcon, PlayIcon, DownloadIcon, SettingsIcon } from "./Icons";

const QUALITY_FILTERS = ["All", "4K", "1080p", "720p", "Direct HTTP", "P2P Blu-Ray"];

function qualityBadgeStyle(q) {
  if (q === "4K") {
    return {
      background: "rgba(245, 197, 24, 0.16)",
      color: "#f5c518",
      border: "1px solid rgba(245, 197, 24, 0.4)",
    };
  }
  if (q === "1080p") {
    return {
      background: "rgba(229, 9, 20, 0.16)",
      color: "#ff5c66",
      border: "1px solid rgba(229, 9, 20, 0.4)",
    };
  }
  if (q === "720p") {
    return {
      background: "rgba(62, 142, 208, 0.16)",
      color: "#67b7f7",
      border: "1px solid rgba(62, 142, 208, 0.4)",
    };
  }
  return {
    background: "rgba(255, 255, 255, 0.07)",
    color: "var(--text2)",
    border: "1px solid var(--border)",
  };
}

function formatSpeed(bytesPerSec) {
  const n = Number(bytesPerSec || 0);
  if (n <= 0) return "0 KB/s";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(n / 1024)} KB/s`;
}

export default function StremioStreamsModal({
  mediaType, // "movie" | "tv"
  tmdbId,
  apiKey,
  title,
  season = 1,
  episode = 1,
  maxEpisodes = null,
  progressKey,
  savedPct = 0,
  onSaveProgress,
  onMarkWatched,
  onOpenSettings,
  onDownloadStream,
  onClose,
}) {
  const [curSeason, setCurSeason] = useState(Number(season || 1));
  const [curEpisode, setCurEpisode] = useState(Number(episode || 1));
  const [loading, setLoading] = useState(true);
  const [imdbId, setImdbId] = useState(null);
  const [streams, setStreams] = useState([]);
  const [errors, setErrors] = useState([]);
  const [fatalError, setFatalError] = useState(null);
  const [qualityFilter, setQualityFilter] = useState("All");

  // Active playback state (Direct HTTP or Local Loopback Sequential Torrent)
  const [activeStream, setActiveStream] = useState(null);
  const [startingTorrentId, setStartingTorrentId] = useState(null);
  const [torrentStats, setTorrentStats] = useState(null);
  const [keepTorrentFiles, setKeepTorrentFiles] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [extMsg, setExtMsg] = useState(null);

  // Optional manual magnet bar (collapsed by default since auto-search is automatic)
  const [showCustomMagnet, setShowCustomMagnet] = useState(false);
  const [customMagnet, setCustomMagnet] = useState("");

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const seekedInitialRef = useRef(false);
  const keepFilesRef = useRef(false);
  keepFilesRef.current = keepTorrentFiles;

  const installedAddons = useMemo(() => loadInstalledAddons(), []);
  const enabledAddons = useMemo(
    () => installedAddons.filter((a) => a && a.enabled !== false),
    [installedAddons],
  );

  const activeProgressKey =
    mediaType === "tv"
      ? `tv_${tmdbId}_s${curSeason}e${curEpisode}`
      : progressKey || `movie_${tmdbId}`;

  // Stop background torrent session when modal unmounts
  useEffect(() => {
    return () => {
      if (isElectron && window.electron?.stopTorrentStream) {
        window.electron.stopTorrentStream({ keepFiles: keepFilesRef.current });
      }
    };
  }, []);

  // Poll live BitTorrent swarm speed & peer count while streaming a torrent
  useEffect(() => {
    if (!activeStream?.isTorrentSession || !isElectron || !window.electron?.getTorrentStatus) {
      setTorrentStats(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const st = await window.electron.getTorrentStatus();
        if (alive && st?.active) setTorrentStats(st);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 1200);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeStream]);

  const stopCurrentPlayback = async () => {
    if (activeStream?.isTorrentSession && isElectron && window.electron?.stopTorrentStream) {
      await window.electron.stopTorrentStream({ keepFiles: keepFilesRef.current });
    }
    setActiveStream(null);
    setTorrentStats(null);
    setPlayerError(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (activeStream) stopCurrentPlayback();
        else onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeStream, onClose]);

  // Automatic parallel search across Built-in Indexers (YTS / EZTV / AnimeTosho) + Stremio Addons
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFatalError(null);
      setStreams([]);
      setErrors([]);
      try {
        const resolvedImdb = await fetchImdbId(mediaType, tmdbId, apiKey);
        if (cancelled) return;
        setImdbId(resolvedImdb || null);

        const [builtInList, addonRes] = await Promise.all([
          searchBuiltInTorrents({
            mediaType,
            imdbId: resolvedImdb,
            title,
            season: curSeason,
            episode: curEpisode,
          }),
          resolvedImdb && enabledAddons.length > 0
            ? queryEnabledAddons({
                mediaType,
                imdbId: resolvedImdb,
                season: mediaType === "tv" ? curSeason : null,
                episode: mediaType === "tv" ? curEpisode : null,
                title,
              })
            : Promise.resolve({ streams: [], errors: [] }),
        ]);

        if (cancelled) return;

        // Deduplicate by infoHash/directUrl while keeping Direct HTTP first, then high-quality/high-seeder P2P
        const combined = [...(addonRes.streams || []), ...(builtInList || [])];
        const seen = new Set();
        const unique = combined.filter((item) => {
          const key = item.directUrl || item.infoHash || item.magnetUrl || item.externalUrl;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const qRank = { "4K": 5, "1080p": 4, "720p": 3, Auto: 2, "480p": 1, CAM: 0 };
        unique.sort((a, b) => {
          if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
          const rDiff = (qRank[b.quality] ?? 1) - (qRank[a.quality] ?? 1);
          if (rDiff !== 0) return rDiff;
          return (b.seeds || 0) - (a.seeds || 0);
        });

        setStreams(unique);
        setErrors(addonRes.errors || []);
      } catch (err) {
        if (!cancelled) setFatalError(err.message || "Failed to search streams");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaType, tmdbId, apiKey, curSeason, curEpisode, title, enabledAddons.length]);

  // Attach hls.js or native playback when `activeStream` is selected
  useEffect(() => {
    const video = videoRef.current;
    if (!activeStream?.directUrl || !video) return;

    setPlayerError(null);
    seekedInitialRef.current = false;
    const url = activeStream.directUrl;
    const isHls = /\.m3u8(\?|$)/i.test(url);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          setPlayerError(
            "Browser codec/CORS blocked direct playback. Click 'MPV / VLC' below to play smoothly.",
          );
        }
      });
    } else {
      video.src = url;
      video.play().catch(() => {});
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeStream]);

  const filteredStreams = useMemo(() => {
    if (qualityFilter === "All") return streams;
    if (qualityFilter === "Direct HTTP") return streams.filter((s) => s.isDirect);
    if (qualityFilter === "P2P Blu-Ray") return streams.filter((s) => !!s.magnetUrl);
    return streams.filter((s) => s.quality === qualityFilter);
  }, [streams, qualityFilter]);

  const launchMpvOrVlc = async (url, subtitles = [], headers = {}) => {
    if (!isElectron || !window.electron?.openStreamExternal) return;
    setExtMsg("Launching MPV / VLC…");
    try {
      const fullTitle =
        mediaType === "tv"
          ? `${title} - S${String(curSeason).padStart(2, "0")}E${String(curEpisode).padStart(2, "0")}`
          : title;
      const res = await window.electron.openStreamExternal({
        url,
        title: fullTitle,
        subtitles,
        headers,
      });
      if (res?.ok) {
        setExtMsg(`✓ Playing in ${res.player || "external player"}`);
      } else {
        setExtMsg(`⚠ ${res?.error || "Install MPV or VLC to open external streams"}`);
      }
    } catch (e) {
      setExtMsg(`⚠ ${e.message}`);
    }
    setTimeout(() => setExtMsg(null), 4500);
  };

  // Start instant sequential streaming for a magnet stream (in-app or MPV/VLC)
  const handleStartMagnetStream = async (stream, openInExternalPlayer = false) => {
    if (!isElectron || !window.electron?.startTorrentStream) {
      setExtMsg("⚠ Instant torrent streaming requires the Streambert desktop app.");
      return;
    }
    setStartingTorrentId(stream.id);
    setExtMsg(null);
    try {
      const res = await window.electron.startTorrentStream({
        magnet: stream.magnetUrl,
        fileIdx: stream.fileIdx ?? null,
        season: mediaType === "tv" ? curSeason : null,
        episode: mediaType === "tv" ? curEpisode : null,
      });
      if (!res?.ok) {
        setExtMsg(`⚠ ${res?.error || "Could not start torrent stream"}`);
        return;
      }

      const sessionObj = {
        ...stream,
        directUrl: res.streamUrl,
        subtitles: [...(res.subtitles || []), ...(stream.subtitles || [])],
        details: `${res.fileName} (${formatByteSize(res.fileSize)})`,
        isTorrentSession: true,
        isMkv: !!res.isMkv,
      };
      setActiveStream(sessionObj);

      if (openInExternalPlayer) {
        await launchMpvOrVlc(res.streamUrl, sessionObj.subtitles, {});
      }
    } catch (err) {
      setExtMsg(`⚠ ${err.message}`);
    } finally {
      setStartingTorrentId(null);
    }
  };

  const handleCustomMagnetPlay = (e) => {
    e?.preventDefault?.();
    const clean = customMagnet.trim();
    if (!clean.startsWith("magnet:?")) {
      setExtMsg("⚠ Paste a valid magnet:?xt=urn:btih:... link");
      return;
    }
    handleStartMagnetStream({
      id: "custom_magnet",
      addonName: "Custom Magnet",
      quality: "Auto",
      magnetUrl: clean,
      subtitles: [],
    });
  };

  const handleCopyMagnet = async (stream) => {
    if (!stream.magnetUrl) return;
    try {
      await navigator.clipboard.writeText(stream.magnetUrl);
      setCopiedId(stream.id);
      setTimeout(() => setCopiedId(null), 2200);
    } catch {}
  };

  const handleTimeUpdate = (e) => {
    const v = e.currentTarget;
    if (!v.duration || !Number.isFinite(v.duration)) return;
    if (!seekedInitialRef.current && savedPct > 1 && savedPct < 95) {
      seekedInitialRef.current = true;
      v.currentTime = (savedPct / 100) * v.duration;
      return;
    }
    seekedInitialRef.current = true;
    const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
    onSaveProgress?.(activeProgressKey, pct);
    const threshold = Number(storage.get(STORAGE_KEYS.WATCHED_THRESHOLD) ?? 20);
    if (v.duration - v.currentTime <= threshold) {
      onMarkWatched?.(activeProgressKey);
    }
  };

  const handleModalClose = async () => {
    await stopCurrentPlayback();
    onClose?.();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.84)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={handleModalClose}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          width: activeStream ? 960 : 800,
          maxWidth: "96vw",
          maxHeight: "89vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 28px 80px rgba(0, 0, 0, 0.72)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "15px 22px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "var(--surface2)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                🧲 {title}
              </span>
              {imdbId && (
                <span
                  style={{
                    fontSize: 11,
                    padding: "1px 7px",
                    borderRadius: 4,
                    background: "rgba(245, 197, 24, 0.14)",
                    color: "#f5c518",
                    fontFamily: "monospace",
                  }}
                >
                  {imdbId}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
              {activeStream
                ? `Instant Streaming via ${activeStream.addonName} (${activeStream.quality})`
                : `Auto Blu-Ray/Torrent Finder + ${enabledAddons.length} Stremio Addon${enabledAddons.length === 1 ? "" : "s"}`}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {mediaType === "tv" && !activeStream && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "3px 8px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--text3)" }}>S</span>
                <input
                  type="number"
                  min={1}
                  value={curSeason}
                  onChange={(e) => setCurSeason(Math.max(1, Number(e.target.value) || 1))}
                  style={{
                    width: 38,
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    fontWeight: 600,
                    textAlign: "center",
                  }}
                />
                <span style={{ color: "var(--text3)" }}>E</span>
                <input
                  type="number"
                  min={1}
                  max={maxEpisodes || undefined}
                  value={curEpisode}
                  onChange={(e) => setCurEpisode(Math.max(1, Number(e.target.value) || 1))}
                  style={{
                    width: 42,
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    fontWeight: 600,
                    textAlign: "center",
                  }}
                />
              </div>
            )}

            {!activeStream && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 32, fontSize: 12, padding: "0 10px" }}
                onClick={() => setShowCustomMagnet((v) => !v)}
                title="Paste a custom magnet link"
              >
                + Magnet
              </button>
            )}

            {activeStream && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ height: 32, fontSize: 12, padding: "0 12px" }}
                onClick={stopCurrentPlayback}
              >
                ← All Streams
              </button>
            )}

            {onOpenSettings && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 32, fontSize: 12, padding: "0 10px" }}
                onClick={async () => {
                  await stopCurrentPlayback();
                  onClose?.();
                  onOpenSettings("addons");
                }}
                title="Manage Stremio Addons & DoH in Settings"
              >
                <SettingsIcon size={14} /> Addons
              </button>
            )}

            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }}
              onClick={handleModalClose}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Optional Custom Magnet Bar */}
        {showCustomMagnet && !activeStream && (
          <form
            onSubmit={handleCustomMagnetPlay}
            style={{
              padding: "10px 22px",
              borderBottom: "1px solid var(--border)",
              background: "rgba(255,255,255,0.02)",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <input
              className="apikey-input"
              style={{ flex: 1, marginBottom: 0, height: 34, fontSize: 12.5 }}
              placeholder="Optional: paste magnet:?xt=urn:btih:... to stream directly"
              value={customMagnet}
              onChange={(e) => setCustomMagnet(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={startingTorrentId === "custom_magnet"}
              style={{ height: 34, fontSize: 12.5, padding: "0 14px" }}
            >
              {startingTorrentId === "custom_magnet" ? "Connecting…" : "▶ Instant Stream"}
            </button>
          </form>
        )}

        {/* Active Playback View (Direct HTTP or Instant Sequential Torrent) */}
        {activeStream ? (
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Live Swarm Telemetry Bar for Torrents */}
            {activeStream.isTorrentSession && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: "var(--surface2)",
                  border: "1px solid var(--border)",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <span style={{ color: "#48c774", fontWeight: 600 }}>
                    ⚡ {formatSpeed(torrentStats?.downloadSpeed)}
                  </span>
                  <span style={{ color: "var(--text2)" }}>
                    👥 {torrentStats?.numPeers ?? 0} peers
                  </span>
                  <span style={{ color: "var(--text2)" }}>
                    📦 Buffered {torrentStats?.progressPct ?? 0}%
                  </span>
                </div>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    color: "var(--text3)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={keepTorrentFiles}
                    onChange={(e) => setKeepTorrentFiles(e.target.checked)}
                  />
                  Keep cache file after closing
                </label>
              </div>
            )}

            <div
              style={{
                background: "#000",
                borderRadius: 10,
                overflow: "hidden",
                aspectRatio: "16 / 9",
                width: "100%",
                position: "relative",
              }}
            >
              <video
                ref={videoRef}
                controls
                playsInline
                crossOrigin="anonymous"
                onTimeUpdate={handleTimeUpdate}
                onError={() =>
                  setPlayerError(
                    "Blu-Ray MKV / EAC3 / HEVC audio-video detected. Click 'MPV / VLC' below to stream smoothly with full audio & soft-subtitles while Streambert keeps buffering!",
                  )
                }
                style={{ width: "100%", height: "100%", background: "#000" }}
              >
                {(activeStream.subtitles || []).map((sub, i) => (
                  <track
                    key={`${sub.url}_${i}`}
                    kind="subtitles"
                    src={sub.url}
                    srcLang={sub.lang}
                    label={sub.lang}
                    default={i === 0}
                  />
                ))}
              </video>
            </div>

            {(playerError || activeStream.isMkv) && (
              <div
                style={{
                  fontSize: 12.5,
                  color: playerError ? "#ffb74d" : "var(--text2)",
                  background: playerError
                    ? "rgba(255, 183, 77, 0.1)"
                    : "rgba(255, 255, 255, 0.04)",
                  border: `1px solid ${playerError ? "rgba(255, 183, 77, 0.3)" : "var(--border)"}`,
                  borderRadius: 8,
                  padding: "9px 14px",
                }}
              >
                {playerError ||
                  "Tip: For .mkv Blu-Ray files with 5.1/Atmos audio or embedded subtitles, click 'MPV / VLC' to watch with full hardware decoding (keep this modal open while watching)."}
              </div>
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text3)", flex: 1, minWidth: 200 }}>
                {activeStream.details}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {isElectron && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ height: 34, fontSize: 12.5 }}
                    onClick={() =>
                      launchMpvOrVlc(
                        activeStream.directUrl,
                        activeStream.subtitles || [],
                        activeStream.streamHeaders || {},
                      )
                    }
                  >
                    ▶ Open in MPV / VLC
                  </button>
                )}
                {!activeStream.isTorrentSession && onDownloadStream && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ height: 34, fontSize: 12.5 }}
                    onClick={() => onDownloadStream(activeStream)}
                  >
                    <DownloadIcon /> Download
                  </button>
                )}
              </div>
            </div>
            {extMsg && (
              <div style={{ fontSize: 12, color: "#48c774" }}>{extMsg}</div>
            )}
          </div>
        ) : (
          /* Auto-Discovered Stream List */
          <div
            style={{
              padding: "16px 22px 20px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {loading ? (
              <div
                style={{
                  padding: "44px 20px",
                  textAlign: "center",
                  color: "var(--text2)",
                  fontSize: 13.5,
                }}
              >
                Searching Blu-Ray / WEB-DL torrents
                {enabledAddons.length > 0
                  ? ` & ${enabledAddons.length} Stremio addon${enabledAddons.length === 1 ? "" : "s"}`
                  : ""}
                {" "}for <strong>{title}</strong>…
              </div>
            ) : fatalError ? (
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  color: "#ff5c66",
                  fontSize: 13.5,
                }}
              >
                ⚠ {fatalError}
              </div>
            ) : (
              <>
                {/* Filter Bar */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {QUALITY_FILTERS.map((qf) => {
                      const active = qualityFilter === qf;
                      return (
                        <button
                          key={qf}
                          type="button"
                          onClick={() => setQualityFilter(qf)}
                          style={{
                            height: 30,
                            padding: "0 12px",
                            borderRadius: 99,
                            border: `1px solid ${active ? "var(--red)" : "var(--border)"}`,
                            background: active
                              ? "rgba(229, 9, 20, 0.16)"
                              : "var(--surface2)",
                            color: active ? "#fff" : "var(--text2)",
                            fontSize: 12,
                            fontWeight: active ? 600 : 500,
                            cursor: "pointer",
                          }}
                        >
                          {qf}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>
                    {filteredStreams.length} stream
                    {filteredStreams.length === 1 ? "" : "s"} found
                  </div>
                </div>

                {startingTorrentId && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "rgba(229, 9, 20, 0.12)",
                      border: "1px solid rgba(229, 9, 20, 0.35)",
                      color: "#fff",
                      fontSize: 12.5,
                    }}
                  >
                    🧲 Connecting to BitTorrent swarm & prioritizing opening video pieces…
                  </div>
                )}

                {extMsg && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: extMsg.startsWith("⚠") ? "#ff6b7a" : "#48c774",
                    }}
                  >
                    {extMsg}
                  </div>
                )}

                {filteredStreams.length === 0 ? (
                  <div
                    style={{
                      padding: "32px 16px",
                      textAlign: "center",
                      color: "var(--text3)",
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    No streams matched for this title/filter yet. Enable{" "}
                    <strong style={{ color: "var(--text2)" }}>Encrypted DNS (DoH)</strong> or
                    add a Stremio addon (like Torrentio) in Settings for wider coverage.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {filteredStreams.map((s) => {
                      const isConnecting = startingTorrentId === s.id;
                      return (
                        <div
                          key={s.id}
                          style={{
                            background: "var(--surface2)",
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            padding: "12px 14px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 14,
                            flexWrap: "wrap",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                flexWrap: "wrap",
                                marginBottom: 4,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  padding: "1px 7px",
                                  borderRadius: 4,
                                  ...qualityBadgeStyle(s.quality),
                                }}
                              >
                                {s.quality}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  padding: "1px 7px",
                                  borderRadius: 4,
                                  background: s.isDirect
                                    ? "rgba(72, 199, 116, 0.14)"
                                    : "rgba(170, 120, 255, 0.14)",
                                  color: s.isDirect ? "#48c774" : "#c39bff",
                                }}
                              >
                                {s.isDirect
                                  ? "Direct HTTP"
                                  : s.magnetUrl
                                    ? "Instant Torrent"
                                    : "External"}
                              </span>
                              <span
                                style={{
                                  fontSize: 12.5,
                                  fontWeight: 600,
                                  color: "var(--text)",
                                }}
                              >
                                {s.sourceLabel}
                              </span>
                              <span style={{ fontSize: 11.5, color: "var(--text3)" }}>
                                · {s.addonName}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--text2)",
                                whiteSpace: "pre-line",
                                lineHeight: 1.45,
                              }}
                            >
                              {s.details}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexShrink: 0,
                            }}
                          >
                            {s.isDirect && (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  style={{ height: 32, fontSize: 12, padding: "0 12px" }}
                                  onClick={() => setActiveStream(s)}
                                >
                                  <PlayIcon /> Play
                                </button>
                                {isElectron && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ height: 32, fontSize: 12, padding: "0 10px" }}
                                    onClick={() =>
                                      launchMpvOrVlc(
                                        s.directUrl,
                                        s.subtitles || [],
                                        s.streamHeaders || {},
                                      )
                                    }
                                  >
                                    MPV / VLC
                                  </button>
                                )}
                                {onDownloadStream && (
                                  <button
                                    type="button"
                                    className="btn btn-ghost"
                                    style={{ height: 32, fontSize: 12, padding: "0 10px" }}
                                    onClick={() => onDownloadStream(s)}
                                    title="Download stream"
                                  >
                                    <DownloadIcon />
                                  </button>
                                )}
                              </>
                            )}

                            {!s.isDirect && s.magnetUrl && (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={!!startingTorrentId}
                                  style={{ height: 32, fontSize: 12, padding: "0 12px" }}
                                  onClick={() => handleStartMagnetStream(s, false)}
                                >
                                  <PlayIcon />{" "}
                                  {isConnecting ? "Buffering…" : "Instant Play"}
                                </button>
                                {isElectron && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    disabled={!!startingTorrentId}
                                    style={{ height: 32, fontSize: 12, padding: "0 10px" }}
                                    onClick={() => handleStartMagnetStream(s, true)}
                                    title="Stream directly into MPV or VLC"
                                  >
                                    MPV / VLC
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  style={{ height: 32, fontSize: 12, padding: "0 9px" }}
                                  onClick={() => handleCopyMagnet(s)}
                                  title="Copy magnet URI"
                                >
                                  {copiedId === s.id ? "✓" : "🧲"}
                                </button>
                              </>
                            )}

                            {!s.isDirect && !s.magnetUrl && s.externalUrl && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ height: 32, fontSize: 12, padding: "0 12px" }}
                                onClick={() =>
                                  window.electron?.openExternal
                                    ? window.electron.openExternal(s.externalUrl)
                                    : window.open(s.externalUrl, "_blank", "noopener")
                                }
                              >
                                Open ↗
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {errors.length > 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>
                    Addon warnings:{" "}
                    {errors.map((e) => `${e.addon} (${e.error})`).join(", ")}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
