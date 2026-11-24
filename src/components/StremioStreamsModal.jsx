import { useState, useEffect, useRef, useMemo } from "react";
import Hls from "hls.js";
import { fetchImdbId } from "../utils/api";
import {
  FEATURED_COMMUNITY_ADDONS,
  installAddonFromUrl,
  loadInstalledAddons,
  queryEnabledAddons,
} from "../utils/stremio";
import { searchBuiltInTorrents, formatByteSize } from "../utils/torrentSearch";
import { parseSubtitleCues } from "../utils/srtToVtt";
import { storage, secureStorage, STORAGE_KEYS, isElectron } from "../utils/storage";
import { CloseIcon, PlayIcon, DownloadIcon, SettingsIcon, SubtitlesIcon } from "./Icons";

const QUALITY_FILTERS = ["All", "4K", "1080p", "720p", "Direct HTTP", "P2P Blu-Ray"];
const SUB_QUICK_LANGS = [
  { code: "id", label: "Indonesian" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ms", label: "Malay" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
  { code: "", label: "All" },
];
const SUB_FONT_SIZES = [
  { id: "S", px: 16 },
  { id: "M", px: 21 },
  { id: "L", px: 26 },
  { id: "XL", px: 32 },
];
const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

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

function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${m}:${String(rem).padStart(2, "0")}`;
}

export default function StremioStreamsModal({
  mediaType,
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
  const [addonsVersion, setAddonsVersion] = useState(0);

  // Community Addons quick drawer inside modal
  const [showAddonCatalog, setShowAddonCatalog] = useState(false);
  const [installingAddonUrl, setInstallingAddonUrl] = useState(null);

  // Active playback state
  const [activeStream, setActiveStream] = useState(null);
  const [startingTorrentId, setStartingTorrentId] = useState(null);
  const [torrentStats, setTorrentStats] = useState(null);
  const [keepTorrentFiles, setKeepTorrentFiles] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [extMsg, setExtMsg] = useState(null);

  // Audio Remux & Timeline state (fixes silent AC3/EAC3/DTS 5.1 torrents!)
  const [useRemux, setUseRemux] = useState(false);
  const [audioTrackIdx, setAudioTrackIdx] = useState(0);
  const [remuxStartSec, setRemuxStartSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [nativeDurationSec, setNativeDurationSec] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Subtitle engine state (Online SubDL/Wyzie + Embedded MKV + Local .srt/.vtt)
  const [availableSubs, setAvailableSubs] = useState([]); // { id, label, url?, rawText? }
  const [selectedSubId, setSelectedSubId] = useState("off");
  const [parsedCues, setParsedCues] = useState([]);
  const [activeCueText, setActiveCueText] = useState("");
  const [subOffsetSec, setSubOffsetSec] = useState(0);
  const [subFontSize, setSubFontSize] = useState("M");
  const [showSubSearch, setShowSubSearch] = useState(false);
  const [subLangFilter, setSubLangFilter] = useState(
    () => storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "id",
  );
  const [onlineSubResults, setOnlineSubResults] = useState([]);
  const [searchingSubs, setSearchingSubs] = useState(false);
  const [subSearchErr, setSubSearchErr] = useState(null);

  // Optional custom magnet bar
  const [showCustomMagnet, setShowCustomMagnet] = useState(false);
  const [customMagnet, setCustomMagnet] = useState("");

  const playerStageRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const seekedInitialRef = useRef(false);
  const autoSwitchedAudioRef = useRef(false);
  const keepFilesRef = useRef(false);
  keepFilesRef.current = keepTorrentFiles;

  const installedAddons = useMemo(
    () => loadInstalledAddons(),
    [addonsVersion],
  );
  const enabledAddons = useMemo(
    () => installedAddons.filter((a) => a && a.enabled !== false),
    [installedAddons],
  );

  useEffect(() => {
    const onChanged = () => setAddonsVersion((v) => v + 1);
    window.addEventListener("streambert:addons-changed", onChanged);
    return () => window.removeEventListener("streambert:addons-changed", onChanged);
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const activeProgressKey =
    mediaType === "tv"
      ? `tv_${tmdbId}_s${curSeason}e${curEpisode}`
      : progressKey || `movie_${tmdbId}`;

  const totalDurationSec = useMemo(() => {
    if (activeStream?.durationSec > 0) return activeStream.durationSec;
    if (nativeDurationSec > 0 && Number.isFinite(nativeDurationSec)) {
      return nativeDurationSec;
    }
    return 0;
  }, [activeStream, nativeDurationSec]);

  // Stop background torrent session when modal unmounts
  useEffect(() => {
    return () => {
      if (isElectron && window.electron?.stopTorrentStream) {
        window.electron.stopTorrentStream({ keepFiles: keepFilesRef.current });
      }
    };
  }, []);

  // Poll live BitTorrent swarm telemetry
  useEffect(() => {
    if (
      !activeStream?.isTorrentSession ||
      !isElectron ||
      !window.electron?.getTorrentStatus
    ) {
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
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {}
    }
    if (
      activeStream?.isTorrentSession &&
      isElectron &&
      window.electron?.stopTorrentStream
    ) {
      await window.electron.stopTorrentStream({ keepFiles: keepFilesRef.current });
    }
    setActiveStream(null);
    setTorrentStats(null);
    setPlayerError(null);
    setShowSubSearch(false);
    setParsedCues([]);
    setActiveCueText("");
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !document.fullscreenElement) {
        if (showSubSearch) setShowSubSearch(false);
        else if (activeStream) stopCurrentPlayback();
        else onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeStream, showSubSearch, onClose]);

  // Auto-search Built-in Indexers + Installed Stremio Addons
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

        const combined = [...(addonRes.streams || []), ...(builtInList || [])];
        const seen = new Set();
        const unique = combined.filter((item) => {
          const key =
            item.directUrl || item.infoHash || item.magnetUrl || item.externalUrl;
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
  }, [
    mediaType,
    tmdbId,
    apiKey,
    curSeason,
    curEpisode,
    title,
    enabledAddons.length,
    addonsVersion,
  ]);

  // Compute effective playback URL (Remux Stereo AAC vs Raw Direct)
  const effectivePlayUrl = useMemo(() => {
    if (!activeStream) return null;
    if (useRemux && activeStream.remuxBaseUrl) {
      return `${activeStream.remuxBaseUrl}?start=${Math.floor(remuxStartSec)}&audio=${audioTrackIdx}`;
    }
    return activeStream.directUrl;
  }, [activeStream, useRemux, remuxStartSec, audioTrackIdx]);

  // Load media into <video> / hls.js whenever `effectivePlayUrl` changes
  useEffect(() => {
    const video = videoRef.current;
    if (!effectivePlayUrl || !video) return;

    setPlayerError(null);
    const isHls = /\.m3u8(\?|$)/i.test(effectivePlayUrl);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(effectivePlayUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.playbackRate = playbackRate;
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          setPlayerError(
            "Stream blocked by hoster CORS/codec. Click 'MPV / VLC' below to watch smoothly.",
          );
        }
      });
    } else {
      video.src = effectivePlayUrl;
      video.playbackRate = playbackRate;
      video.play().catch(() => {});
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [effectivePlayUrl]);

  // Load & parse cues whenever `selectedSubId` changes
  useEffect(() => {
    let cancelled = false;
    setActiveCueText("");
    if (!selectedSubId || selectedSubId === "off") {
      setParsedCues([]);
      return;
    }
    const target = availableSubs.find((s) => s.id === selectedSubId);
    if (!target) {
      setParsedCues([]);
      return;
    }

    (async () => {
      try {
        let raw = target.rawText || "";
        if (!raw && target.url) {
          const r = await fetch(target.url);
          if (r.ok) raw = await r.text();
        }
        if (!cancelled && raw) {
          setParsedCues(parseSubtitleCues(raw));
        }
      } catch {
        if (!cancelled) setParsedCues([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSubId, availableSubs]);

  // Update active subtitle cue whenever `currentTimeSec` or `subOffsetSec` changes
  useEffect(() => {
    if (!parsedCues.length || selectedSubId === "off") {
      setActiveCueText("");
      return;
    }
    const t = currentTimeSec - subOffsetSec;
    const matches = parsedCues.filter((c) => t >= c.start && t <= c.end);
    setActiveCueText(matches.map((m) => m.text).join("\n"));
  }, [currentTimeSec, subOffsetSec, parsedCues, selectedSubId]);

  const initializePlayerForStream = (streamObj) => {
    const initialSubs = (streamObj.subtitles || []).map((s, idx) => ({
      id: `init_${idx}`,
      label: s.label || s.lang || `Subtitle ${idx + 1}`,
      url: s.url,
    }));
    setAvailableSubs(initialSubs);
    setSelectedSubId(initialSubs.length > 0 ? initialSubs[0].id : "off");
    setSubOffsetSec(0);
    setAudioTrackIdx(0);
    setUseRemux(!!streamObj.useRemuxByDefault);

    // Resume from savedPct if duration is already known in remux mode
    const initStart =
      streamObj.useRemuxByDefault &&
      streamObj.durationSec > 0 &&
      savedPct > 2 &&
      savedPct < 94
        ? Math.floor((savedPct / 100) * streamObj.durationSec)
        : 0;
    setRemuxStartSec(initStart);
    setCurrentTimeSec(initStart);
    setNativeDurationSec(0);
    seekedInitialRef.current = initStart > 0;
    autoSwitchedAudioRef.current = false;
    setActiveStream(streamObj);
  };

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
        remuxBaseUrl: res.remuxBaseUrl || null,
        useRemuxByDefault: !!res.useRemuxByDefault,
        durationSec: res.durationSec || 0,
        audioTracks: res.audioTracks || [],
        subtitles: [...(res.subtitles || []), ...(stream.subtitles || [])],
        details: `${res.fileName} (${formatByteSize(res.fileSize)})`,
        isTorrentSession: true,
        isMkv: !!res.isMkv,
      };
      initializePlayerForStream(sessionObj);

      if (openInExternalPlayer) {
        await launchMpvOrVlc(res.streamUrl, sessionObj.subtitles, {});
      }
    } catch (err) {
      setExtMsg(`⚠ ${err.message}`);
    } finally {
      setStartingTorrentId(null);
    }
  };

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

  // Search Online Subtitles (SubDL + Wyzie) directly inside player!
  const runOnlineSubtitleSearch = async (langOverride) => {
    if (!isElectron || !window.electron?.searchSubtitles) return;
    const lang = langOverride !== undefined ? langOverride : subLangFilter;
    setSearchingSubs(true);
    setSubSearchErr(null);
    try {
      const [subdlApiKey, wyzieApiKey] = await Promise.all([
        secureStorage.get(STORAGE_KEYS.SUBDL_API_KEY),
        secureStorage.get(STORAGE_KEYS.WYZIE_API_KEY),
      ]);
      const res = await window.electron.searchSubtitles({
        tmdbId,
        mediaType,
        season: mediaType === "tv" ? curSeason : undefined,
        episode: mediaType === "tv" ? curEpisode : undefined,
        languages: lang || "",
        subdlApiKey: subdlApiKey || "",
        wyzieApiKey: wyzieApiKey || "",
      });
      if (!res?.ok) {
        setSubSearchErr(res?.error || "No subtitles found");
        setOnlineSubResults([]);
      } else {
        setOnlineSubResults(res.results || []);
      }
    } catch (e) {
      setSubSearchErr(e.message);
      setOnlineSubResults([]);
    } finally {
      setSearchingSubs(false);
    }
  };

  const handleApplyOnlineSub = async (subItem) => {
    if (!isElectron || !window.electron?.fetchSubtitleText) return;
    setExtMsg("Loading subtitle…");
    try {
      const res = await window.electron.fetchSubtitleText({
        fileId: subItem.file_id,
        directUrl: subItem.direct_url,
      });
      if (!res?.ok || !res.text) {
        setExtMsg(`⚠ ${res?.error || "Failed to download subtitle"}`);
        return;
      }
      const id = `online_${subItem.file_id}`;
      const label = `${(subItem.language || "SUB").toUpperCase()} · ${subItem.release || res.name || "Online"}`;
      setAvailableSubs((prev) => {
        const filtered = prev.filter((p) => p.id !== id);
        return [{ id, label, rawText: res.text }, ...filtered];
      });
      setSelectedSubId(id);
      setShowSubSearch(false);
      setExtMsg(`✓ Subtitle loaded: ${label}`);
      setTimeout(() => setExtMsg(null), 3000);
    } catch (e) {
      setExtMsg(`⚠ ${e.message}`);
    }
  };

  const handlePickLocalSubtitle = async () => {
    if (!isElectron || !window.electron?.pickSubtitleFile) return;
    const res = await window.electron.pickSubtitleFile();
    if (!res?.ok || !res.text) return;
    const id = `local_${Date.now()}`;
    const label = `Local · ${res.name}`;
    setAvailableSubs((prev) => [{ id, label, rawText: res.text }, ...prev]);
    setSelectedSubId(id);
  };

  const handleSeekTo = (targetSec) => {
    const clamped = Math.max(
      0,
      totalDurationSec > 0 ? Math.min(targetSec, totalDurationSec - 1) : targetSec,
    );
    setCurrentTimeSec(clamped);
    if (useRemux && activeStream?.remuxBaseUrl) {
      setRemuxStartSec(Math.floor(clamped));
    } else if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  };

  const handleTimeUpdate = (e) => {
    const v = e.currentTarget;
    if (v.duration && Number.isFinite(v.duration)) {
      setNativeDurationSec(v.duration);
    }

    // Automatic silent-audio fallback: if playing raw stream for >1.5s and Chromium decoded 0 audio bytes, switch to FFmpeg Stereo AAC Remux!
    if (
      !useRemux &&
      !autoSwitchedAudioRef.current &&
      activeStream?.remuxBaseUrl &&
      v.currentTime > 1.5 &&
      typeof v.webkitAudioDecodedByteCount === "number" &&
      v.webkitAudioDecodedByteCount === 0
    ) {
      autoSwitchedAudioRef.current = true;
      setRemuxStartSec(Math.floor(v.currentTime));
      setUseRemux(true);
      return;
    }

    const actualSec = (useRemux ? remuxStartSec : 0) + (v.currentTime || 0);
    setCurrentTimeSec(actualSec);

    const dur = totalDurationSec || v.duration;
    if (!dur || !Number.isFinite(dur) || dur <= 0) return;

    if (!useRemux && !seekedInitialRef.current && savedPct > 2 && savedPct < 94) {
      seekedInitialRef.current = true;
      v.currentTime = (savedPct / 100) * dur;
      return;
    }
    seekedInitialRef.current = true;

    const pct = Math.min(100, Math.round((actualSec / dur) * 100));
    onSaveProgress?.(activeProgressKey, pct);
    const threshold = Number(storage.get(STORAGE_KEYS.WATCHED_THRESHOLD) ?? 20);
    if (dur - actualSec <= threshold) {
      onMarkWatched?.(activeProgressKey);
    }
  };

  const toggleFullscreen = () => {
    if (!playerStageRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      playerStageRef.current.requestFullscreen().catch(() => {});
    }
  };

  const handleQuickInstallAddon = async (feat) => {
    setInstallingAddonUrl(feat.manifestUrl);
    try {
      await installAddonFromUrl(feat.manifestUrl);
      setExtMsg(`✓ Installed ${feat.name}! Refreshing streams…`);
      setTimeout(() => setExtMsg(null), 3000);
    } catch (e) {
      setExtMsg(`⚠ ${e.message}`);
    } finally {
      setInstallingAddonUrl(null);
    }
  };

  const filteredStreams = useMemo(() => {
    if (qualityFilter === "All") return streams;
    if (qualityFilter === "Direct HTTP") return streams.filter((s) => s.isDirect);
    if (qualityFilter === "P2P Blu-Ray") return streams.filter((s) => !!s.magnetUrl);
    return streams.filter((s) => s.quality === qualityFilter);
  }, [streams, qualityFilter]);

  const fontSizePx =
    SUB_FONT_SIZES.find((f) => f.id === subFontSize)?.px || 21;

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
        background: "rgba(0, 0, 0, 0.85)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={handleModalClose}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          width: activeStream ? 980 : 840,
          maxWidth: "96vw",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 28px 80px rgba(0, 0, 0, 0.75)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 20px",
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
                ? `${activeStream.addonName} · ${useRemux ? "🔊 FFmpeg Stereo AAC Active" : "Direct Stream"}`
                : `Auto Blu-Ray Finder + ${enabledAddons.length} Active Addon${enabledAddons.length === 1 ? "" : "s"}`}
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
              <>
                <button
                  type="button"
                  className={showAddonCatalog ? "btn btn-primary" : "btn btn-secondary"}
                  style={{ height: 32, fontSize: 12, padding: "0 11px" }}
                  onClick={() => setShowAddonCatalog((v) => !v)}
                >
                  🧩 Community Addons ({enabledAddons.length})
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ height: 32, fontSize: 12, padding: "0 9px" }}
                  onClick={() => setShowCustomMagnet((v) => !v)}
                >
                  + Magnet
                </button>
              </>
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
                style={{ height: 32, fontSize: 12, padding: "0 9px" }}
                onClick={async () => {
                  await stopCurrentPlayback();
                  onClose?.();
                  onOpenSettings("addons");
                }}
                title="Open Network & Addon Settings"
              >
                <SettingsIcon size={14} />
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

        {/* Inline 1-Click Community Addons Store */}
        {showAddonCatalog && !activeStream && (
          <div
            style={{
              padding: "14px 20px",
              borderBottom: "1px solid var(--border)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text2)",
                marginBottom: 10,
              }}
            >
              1-Click Install Popular Community Addons (automatically refreshes streams):
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                gap: 8,
              }}
            >
              {FEATURED_COMMUNITY_ADDONS.map((feat) => {
                const isInst = installedAddons.some(
                  (a) =>
                    a.id === feat.id ||
                    a.manifestUrl?.toLowerCase() === feat.manifestUrl.toLowerCase(),
                );
                return (
                  <div
                    key={feat.manifestUrl}
                    style={{
                      background: "var(--surface2)",
                      border: `1px solid ${isInst ? "rgba(72,199,116,0.4)" : "var(--border)"}`,
                      borderRadius: 8,
                      padding: "9px 12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        {feat.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)" }}>
                        {feat.badge} · {feat.kind}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={isInst ? "btn btn-ghost" : "btn btn-primary"}
                      disabled={isInst || !!installingAddonUrl}
                      style={{ height: 28, fontSize: 11.5, padding: "0 10px", flexShrink: 0 }}
                      onClick={() => handleQuickInstallAddon(feat)}
                    >
                      {isInst
                        ? "✓ Active"
                        : installingAddonUrl === feat.manifestUrl
                          ? "…"
                          : "+ Install"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Optional Custom Magnet Bar */}
        {showCustomMagnet && !activeStream && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!customMagnet.trim().startsWith("magnet:?")) return;
              handleStartMagnetStream({
                id: "custom_magnet",
                addonName: "Custom Magnet",
                quality: "Auto",
                magnetUrl: customMagnet.trim(),
                subtitles: [],
              });
            }}
            style={{
              padding: "10px 20px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
            }}
          >
            <input
              className="apikey-input"
              style={{ flex: 1, marginBottom: 0, height: 34, fontSize: 12.5 }}
              placeholder="Paste magnet:?xt=urn:btih:... link"
              value={customMagnet}
              onChange={(e) => setCustomMagnet(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              style={{ height: 34, fontSize: 12.5, padding: "0 14px" }}
            >
              ▶ Stream
            </button>
          </form>
        )}

        {/* Active Player View */}
        {activeStream ? (
          <div
            style={{
              padding: "14px 20px 18px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {/* Swarm Telemetry + Audio Mode Bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                padding: "7px 12px",
                borderRadius: 8,
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {activeStream.isTorrentSession && (
                  <>
                    <span style={{ color: "#48c774", fontWeight: 600 }}>
                      ⚡ {formatSpeed(torrentStats?.downloadSpeed)}
                    </span>
                    <span style={{ color: "var(--text2)" }}>
                      👥 {torrentStats?.numPeers ?? 0} peers
                    </span>
                    <span style={{ color: "var(--text2)" }}>
                      📦 {torrentStats?.progressPct ?? 0}%
                    </span>
                  </>
                )}

                {activeStream.remuxBaseUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setRemuxStartSec(Math.floor(currentTimeSec));
                      setUseRemux((v) => !v);
                    }}
                    style={{
                      height: 24,
                      padding: "0 9px",
                      borderRadius: 99,
                      border: `1px solid ${useRemux ? "rgba(72,199,116,0.45)" : "var(--border)"}`,
                      background: useRemux ? "rgba(72,199,116,0.14)" : "var(--surface)",
                      color: useRemux ? "#48c774" : "var(--text3)",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    title="Transcodes Dolby AC3/EAC3/DTS 5.1 audio to Stereo AAC on the fly"
                  >
                    🔊 Dolby/DTS Audio Fix: {useRemux ? "ON" : "OFF"}
                  </button>
                )}

                {activeStream.audioTracks?.length > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ color: "var(--text3)" }}>Audio:</span>
                    {activeStream.audioTracks.map((at) => (
                      <button
                        key={at.audioIdx}
                        type="button"
                        onClick={() => {
                          setRemuxStartSec(Math.floor(currentTimeSec));
                          setUseRemux(true);
                          setAudioTrackIdx(at.audioIdx);
                        }}
                        style={{
                          height: 24,
                          padding: "0 8px",
                          borderRadius: 6,
                          border: `1px solid ${audioTrackIdx === at.audioIdx ? "var(--red)" : "var(--border)"}`,
                          background:
                            audioTrackIdx === at.audioIdx
                              ? "rgba(229,9,20,0.16)"
                              : "var(--surface)",
                          color: "#fff",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {at.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {activeStream.isTorrentSession && (
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
                  Keep file on close
                </label>
              )}
            </div>

            {/* Video Stage + Custom Subtitle Overlay + Custom Scrubber */}
            <div
              ref={playerStageRef}
              style={{
                background: "#000",
                borderRadius: isFullscreen ? 0 : 10,
                overflow: "hidden",
                position: "relative",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              }}
            >
              <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9" }}>
                <video
                  ref={videoRef}
                  playsInline
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    if (v.paused) v.play().catch(() => {});
                    else v.pause();
                  }}
                  onPlay={() => setIsPaused(false)}
                  onPause={() => setIsPaused(true)}
                  onTimeUpdate={handleTimeUpdate}
                  onError={() =>
                    setPlayerError(
                      "Video codec requires hardware external player (e.g. 10-bit HEVC without Windows HEVC extension). Click 'Open in MPV / VLC' below.",
                    )
                  }
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "#000",
                    cursor: "pointer",
                  }}
                />

                {/* Crisp Custom Subtitle Overlay */}
                {activeCueText && selectedSubId !== "off" && (
                  <div
                    style={{
                      position: "absolute",
                      left: "6%",
                      right: "6%",
                      bottom: isFullscreen ? 64 : 18,
                      textAlign: "center",
                      pointerEvents: "none",
                      zIndex: 10,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        background: "rgba(0, 0, 0, 0.72)",
                        color: "#fff",
                        padding: "4px 12px",
                        borderRadius: 6,
                        fontSize: isFullscreen ? fontSizePx + 6 : fontSizePx,
                        fontWeight: 500,
                        lineHeight: 1.42,
                        whiteSpace: "pre-line",
                        textShadow: "0 2px 4px rgba(0,0,0,0.95)",
                      }}
                    >
                      {activeCueText}
                    </span>
                  </div>
                )}
              </div>

              {/* Unified Player Control Bar (supports instant FFmpeg Remux Seeking!) */}
              <div
                style={{
                  background: "rgba(14, 14, 18, 0.96)",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                  padding: "8px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {/* Seek Slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--text2)",
                      fontVariantNumeric: "tabular-nums",
                      minWidth: 44,
                    }}
                  >
                    {formatClock(currentTimeSec)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(totalDurationSec || 100))}
                    value={Math.min(
                      Math.floor(totalDurationSec || 100),
                      Math.floor(currentTimeSec),
                    )}
                    disabled={!totalDurationSec}
                    onChange={(e) => handleSeekTo(Number(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--red)", cursor: "pointer" }}
                  />
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--text3)",
                      fontVariantNumeric: "tabular-nums",
                      minWidth: 44,
                      textAlign: "right",
                    }}
                  >
                    {totalDurationSec ? formatClock(totalDurationSec) : "LIVE"}
                  </span>
                </div>

                {/* Transport, Volume, Speed & Fullscreen Controls */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, padding: "0 10px", fontSize: 12.5 }}
                      onClick={() => {
                        const v = videoRef.current;
                        if (!v) return;
                        if (v.paused) v.play().catch(() => {});
                        else v.pause();
                      }}
                    >
                      {isPaused ? "▶ Play" : "⏸ Pause"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, padding: "0 8px", fontSize: 11.5 }}
                      onClick={() => handleSeekTo(currentTimeSec - 10)}
                    >
                      -10s
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, padding: "0 8px", fontSize: 11.5 }}
                      onClick={() => handleSeekTo(currentTimeSec + 10)}
                    >
                      +10s
                    </button>

                    {/* Volume */}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, padding: "0 8px", fontSize: 12 }}
                      onClick={() => {
                        const next = !isMuted;
                        setIsMuted(next);
                        if (videoRef.current) videoRef.current.muted = next;
                      }}
                    >
                      {isMuted || volume === 0 ? "🔇" : "🔊"}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setVolume(val);
                        setIsMuted(val === 0);
                        if (videoRef.current) {
                          videoRef.current.volume = val;
                          videoRef.current.muted = val === 0;
                        }
                      }}
                      style={{ width: 68, accentColor: "var(--red)" }}
                    />
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {PLAYBACK_SPEEDS.map((sp) => (
                      <button
                        key={sp}
                        type="button"
                        onClick={() => {
                          setPlaybackRate(sp);
                          if (videoRef.current) videoRef.current.playbackRate = sp;
                        }}
                        style={{
                          height: 24,
                          padding: "0 7px",
                          borderRadius: 5,
                          border: "1px solid var(--border)",
                          background:
                            playbackRate === sp ? "var(--red)" : "var(--surface2)",
                          color: "#fff",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {sp}x
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, padding: "0 10px", fontSize: 13 }}
                      onClick={toggleFullscreen}
                      title="Fullscreen"
                    >
                      ⛶
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Complete Subtitle Control Strip */}
            <div
              style={{
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                padding: "9px 12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)" }}>
                  <SubtitlesIcon /> Subtitles:
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedSubId("off")}
                  style={{
                    height: 26,
                    padding: "0 9px",
                    borderRadius: 6,
                    border: `1px solid ${selectedSubId === "off" ? "var(--red)" : "var(--border)"}`,
                    background:
                      selectedSubId === "off" ? "rgba(229,9,20,0.16)" : "var(--surface)",
                    color: "#fff",
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  Off
                </button>
                {availableSubs.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => setSelectedSubId(sub.id)}
                    style={{
                      height: 26,
                      padding: "0 9px",
                      borderRadius: 6,
                      border: `1px solid ${selectedSubId === sub.id ? "var(--red)" : "var(--border)"}`,
                      background:
                        selectedSubId === sub.id
                          ? "rgba(229,9,20,0.16)"
                          : "var(--surface)",
                      color: "#fff",
                      fontSize: 11.5,
                      cursor: "pointer",
                      maxWidth: 190,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sub.label}
                  </button>
                ))}

                {isElectron && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ height: 26, fontSize: 11.5, padding: "0 10px" }}
                      onClick={() => {
                        const next = !showSubSearch;
                        setShowSubSearch(next);
                        if (next && onlineSubResults.length === 0) {
                          runOnlineSubtitleSearch(subLangFilter);
                        }
                      }}
                    >
                      🔍 Find Online Subtitles
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ height: 26, fontSize: 11.5, padding: "0 9px" }}
                      onClick={handlePickLocalSubtitle}
                    >
                      📂 Load .srt
                    </button>
                  </>
                )}
              </div>

              {/* Offset & Font Size */}
              {selectedSubId !== "off" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11.5, color: "var(--text3)" }}>Sync:</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 24, padding: "0 7px", fontSize: 11 }}
                    onClick={() =>
                      setSubOffsetSec((s) => Math.round((s - 0.5) * 10) / 10)
                    }
                  >
                    -0.5s
                  </button>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--text)",
                      minWidth: 38,
                      textAlign: "center",
                    }}
                  >
                    {subOffsetSec > 0 ? `+${subOffsetSec}s` : `${subOffsetSec}s`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 24, padding: "0 7px", fontSize: 11 }}
                    onClick={() =>
                      setSubOffsetSec((s) => Math.round((s + 0.5) * 10) / 10)
                    }
                  >
                    +0.5s
                  </button>

                  <span style={{ fontSize: 11.5, color: "var(--text3)", marginLeft: 4 }}>
                    Size:
                  </span>
                  {SUB_FONT_SIZES.map((sz) => (
                    <button
                      key={sz.id}
                      type="button"
                      onClick={() => setSubFontSize(sz.id)}
                      style={{
                        height: 24,
                        padding: "0 7px",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background:
                          subFontSize === sz.id ? "var(--red)" : "var(--surface)",
                        color: "#fff",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {sz.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Inline Online Subtitle Search Drawer */}
            {showSubSearch && (
              <div
                style={{
                  background: "var(--surface2)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {SUB_QUICK_LANGS.map((l) => {
                      const active = subLangFilter === l.code;
                      return (
                        <button
                          key={l.label}
                          type="button"
                          onClick={() => {
                            setSubLangFilter(l.code);
                            runOnlineSubtitleSearch(l.code);
                          }}
                          style={{
                            height: 26,
                            padding: "0 10px",
                            borderRadius: 99,
                            border: `1px solid ${active ? "var(--red)" : "var(--border)"}`,
                            background: active
                              ? "rgba(229,9,20,0.16)"
                              : "var(--surface)",
                            color: "#fff",
                            fontSize: 11.5,
                            cursor: "pointer",
                          }}
                        >
                          {l.label}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 24, fontSize: 11.5, padding: "0 8px" }}
                    onClick={() => setShowSubSearch(false)}
                  >
                    Close
                  </button>
                </div>

                {searchingSubs ? (
                  <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "10px 0" }}>
                    Searching SubDL & Wyzie subtitles…
                  </div>
                ) : subSearchErr ? (
                  <div style={{ fontSize: 12, color: "#ff6b7a" }}>{subSearchErr}</div>
                ) : onlineSubResults.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>
                    No subtitles found for this language. Try English or All.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {onlineSubResults.slice(0, 20).map((sub) => (
                      <div
                        key={sub.file_id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "6px 10px",
                          background: "var(--surface)",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        <div
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--text2)",
                          }}
                        >
                          <strong style={{ color: "var(--text)" }}>
                            [{(sub.language || "SUB").toUpperCase()}]
                          </strong>{" "}
                          {sub.release || sub.file_name || "Subtitle"}
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ height: 24, fontSize: 11, padding: "0 10px", flexShrink: 0 }}
                          onClick={() => handleApplyOnlineSub(sub)}
                        >
                          Apply
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {playerError && (
              <div
                style={{
                  fontSize: 12.5,
                  color: "#ffb74d",
                  background: "rgba(255, 183, 77, 0.1)",
                  border: "1px solid rgba(255, 183, 77, 0.3)",
                  borderRadius: 8,
                  padding: "9px 14px",
                }}
              >
                {playerError}
              </div>
            )}

            {/* Footer Action Row */}
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
                    className="btn btn-secondary"
                    style={{ height: 32, fontSize: 12 }}
                    onClick={() =>
                      launchMpvOrVlc(
                        activeStream.directUrl,
                        activeStream.subtitles || [],
                        activeStream.streamHeaders || {},
                      )
                    }
                  >
                    Open in MPV / VLC
                  </button>
                )}
                {!activeStream.isTorrentSession && onDownloadStream && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ height: 32, fontSize: 12 }}
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
          /* Stream List View */
          <div
            style={{
              padding: "16px 20px 20px",
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
                  : ""}{" "}
                for <strong>{title}</strong>…
              </div>
            ) : fatalError ? (
              <div style={{ padding: "24px", textAlign: "center", color: "#ff5c66" }}>
                ⚠ {fatalError}
              </div>
            ) : (
              <>
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
                    🧲 Connecting to BitTorrent swarm & probing Dolby/DTS audio tracks…
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
                      padding: "30px 16px",
                      textAlign: "center",
                      color: "var(--text3)",
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    No streams found for this filter yet. Click{" "}
                    <strong style={{ color: "var(--text)" }}>🧩 Community Addons</strong>{" "}
                    above to 1-click install <strong>Torrentio</strong> or{" "}
                    <strong>WebStreamr</strong>, and make sure{" "}
                    <strong style={{ color: "var(--text)" }}>Encrypted DNS (DoH)</strong>{" "}
                    is enabled in Settings!
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
                                  onClick={() => initializePlayerForStream(s)}
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
                                  >
                                    MPV / VLC
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  style={{ height: 32, fontSize: 12, padding: "0 9px" }}
                                  onClick={async () => {
                                    await navigator.clipboard
                                      .writeText(s.magnetUrl)
                                      .catch(() => {});
                                    setCopiedId(s.id);
                                    setTimeout(() => setCopiedId(null), 2000);
                                  }}
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
