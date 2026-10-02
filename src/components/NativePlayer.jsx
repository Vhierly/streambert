// ── NativePlayer ──────────────────────────────────────────────────────────────
// A real <video> player rendered by us instead of a third-party embed page.
//
// Why this exists: every embed (VidSrc, Videasy, …) ships its own player UI, so
// the controls look and behave differently per source. Owning the <video>
// element means one design system for all of them — and the controls become real
// DOM we can style and bind, instead of JavaScript we inject into someone
// else's cross-origin iframe (which is what PlayerControlBar has to do today).
//
// Transport: HLS via hls.js. Safari plays HLS natively, so we hand it to
// <video> directly there instead of instantiating hls.js.
//
// Source of the stream URL
// -----------------------
// Async resolvers (HiAnime/AllManga family) already return a resolved m3u8 plus
// a referer, and src/ipc/hianime.js runs a local proxy that rewrites playlists
// and forwards the Referer/Range headers the CDN demands. This player points
// straight at that proxy, so no CORS or referer problem reaches the renderer.
//
// For plain embed sources we fall back to the embed webview: those URLs are
// session-bound and often DRM-protected, and pretending otherwise turns a
// working source into a broken one. See HybridPlayer.jsx for that decision.

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import Hls from "hls.js";

/**
 * Turn a raw upstream URL into a same-origin proxied one.
 * The proxy is the hianime local server (see src/ipc/hianime.js).
 */
export function proxyStreamUrl(rawUrl, base) {
  if (!rawUrl) return null;
  // Already pointing at our proxy or a local player page — pass through.
  if (/^https?:\/\/127\.0\.0\.1/.test(rawUrl)) return rawUrl;
  if (/^blob:|^data:/.test(rawUrl)) return rawUrl;
  if (!base) return rawUrl;
  return `${base}/proxy?url=${encodeURIComponent(rawUrl)}`;
}

export default function NativePlayer({
  playing,
  src,
  masterSrc,
  proxyBase,
  poster,
  title,
  startTime = 0,
  subtitles = [],
  accentColor = null,
  onProgress,
  onEnded,
  onError,
  onTimeUpdate,
  onDuration,
  onPlayingChange,
  onReady,
  onVideoElement,
}) {
  const localVideoRef = useRef(null);
  // Hand the element up to NativeStage. It has to be state there, not a ref:
  // the element does not exist until this component mounts, and an effect keyed
  // on a ref object never re-runs when the ref fills in.
  const setVideoRef = useCallback(
    (node) => {
      localVideoRef.current = node;
      onVideoElement?.(node);
    },
    [onVideoElement],
  );
  const videoRef = localVideoRef;
  const hlsRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [level, setLevel] = useState(-1); // -1 = auto
  const [status, setStatus] = useState("idle"); // idle|loading|ready|error
  const [errorMsg, setErrorMsg] = useState(null);
  const [retry, setRetry] = useState(0);

  const effectiveSrc = useMemo(() => {
    // Prefer the master playlist so hls.js can expose every rendition and switch
    // between them without reloading the whole player.
    return proxyStreamUrl(masterSrc || src, proxyBase);
  }, [src, masterSrc, proxyBase]);

  const subtitleTracks = useMemo(
    () =>
      (subtitles || [])
        .filter((s) => s && (s.url || s.src))
        .map((s, i) => ({
          index: i,
          src: proxyStreamUrl(s.url || s.src, proxyBase),
          label: s.label || s.lang || s.language || `Subtitle ${i + 1}`,
          lang: s.lang || s.language || "",
          default: !!s.default,
        })),
    [subtitles, proxyBase],
  );

  // ── Tear down any previous hls instance before attaching a new one ─────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }
  }, []);

  useEffect(() => destroyHls, [destroyHls]);

  useEffect(() => {
    if (!playing || !effectiveSrc) return;
    const video = videoRef.current;
    if (!video) return;

    setStatus("loading");
    setErrorMsg(null);

    const onLoaded = () => {
      setStatus("ready");
      // Resume where the user left off, but only forward — re-seeking backwards
      // fights the source's own "continue watching" behaviour.
      if (startTime > 1 && video.currentTime < 1) {
        try {
          video.currentTime = startTime;
        } catch {}
      }
      // Autoplay has to be requested from inside the load event: Chromium
      // rejects play() issued during page load, and hls.js only reaches
      // MANIFEST_PARSED once the playlist has been fetched.
      video.play().catch(() => {});
      onReady?.();
    };

    // Safari / iOS: native HLS, no library needed.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = effectiveSrc;
      const bail = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onErr);
      };
      const onErr = () => {
        bail();
        setStatus("error");
        setErrorMsg("This source couldn't be played");
        onError?.("native-hls-failed");
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onErr);
      return () => bail();
    }

    if (!Hls.isSupported()) {
      setStatus("error");
      setErrorMsg("HLS playback isn't supported on this system");
      onError?.("hls-unsupported");
      return;
    }

    const hls = new Hls({
      // Keep latency low for VOD; the sources are on-demand streams.
      lowLatencyMode: false,
      enableWorker: true,
      backBufferLength: 60,
      maxBufferLength: 30,
    });
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      const lvls = (data.levels || []).map((l, i) => ({
        index: i,
        height: l.height || 0,
        bitrate: l.bitrate || 0,
        label: l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)}kbps`,
      }));
      setLevels(lvls);
      onLoaded();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const h = hls.levels?.[data.level]?.height;
      if (h) setLevel((cur) => (cur === -1 ? -1 : cur));
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // Ephemeral playlist URLs are the common cause: one retry with a fresh
          // load usually recovers, a retry loop would not.
          setErrorMsg("Stream interrupted — retrying…");
          setRetry((n) => n + 1);
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          setErrorMsg("Playback error — recovering…");
          try {
            hls.recoverMediaError();
          } catch {
            setRetry((n) => n + 1);
          }
          break;
        default:
          setStatus("error");
          setErrorMsg(data.details || "Playback failed");
          onError?.(data.details || "fatal");
      }
    });

    hls.loadSource(effectiveSrc);
    hls.attachMedia(video);

    return () => {
      try {
        hls.destroy();
      } catch {}
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [playing, effectiveSrc, retry, startTime, onReady, onError]);

  // ── Report progress upward (matches the shape query-video-progress returns) ─
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    onTimeUpdate?.({ currentTime: v.currentTime, duration: v.duration || 0 });
  }, [onTimeUpdate]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tick = () => onProgress?.({
      currentTime: v.currentTime,
      duration: v.duration || 0,
      recentUserSeek: false,
      lastUserSeekTo: null,
    });
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [onProgress]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !onDuration) return;
    const onMeta = () => onDuration(v.duration || 0);
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [onDuration]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !onEnded) return;
    const h = () => onEnded();
    v.addEventListener("ended", h);
    return () => v.removeEventListener("ended", h);
  }, [onEnded]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !onPlayingChange) return;
    const play = () => onPlayingChange(true);
    const pause = () => onPlayingChange(false);
    v.addEventListener("play", play);
    v.addEventListener("pause", pause);
    return () => {
      v.removeEventListener("play", play);
      v.removeEventListener("pause", pause);
    };
  }, [onPlayingChange]);

  // Pause when the page stops playing, so audio never continues off-screen.
  useEffect(() => {
    const v = videoRef.current;
    if (!playing && v && !v.paused) {
      try {
        v.pause();
      } catch {}
    }
  }, [playing]);

  const switchLevel = useCallback((idx) => {
    setLevel(idx);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = idx;
    }
  }, []);

  return (
    <div className="native-player">
      <video
        ref={setVideoRef}
        className="native-player__video"
        poster={poster || undefined}
        playsInline
        crossOrigin="anonymous"
        onTimeUpdate={handleTimeUpdate}
        controls={false}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />

      {/* Native <track> elements so the browser renders subtitles itself —
          this is what lets our ::cue styling apply. crossOrigin is required:
          the track comes off the loopback proxy, which is a different origin
          than the app document, and a cross-origin <track> without it is
          silently dropped. */}
      {subtitleTracks.map((t) => (
        <track
          key={t.index}
          kind="subtitles"
          src={t.src}
          srcLang={t.lang || "en"}
          label={t.label}
          default={t.default}
          crossOrigin="anonymous"
        />
      ))}

      {levels.length > 1 && (
        <div className="native-player__levels">
          <button
            className={
              "player-ctl-chip" + (level === -1 ? " player-ctl-chip--on" : "")
            }
            onClick={() => switchLevel(-1)}
          >
            Auto
          </button>
          {levels.map((l) => (
            <button
              key={l.index}
              className={
                "player-ctl-chip" + (level === l.index ? " player-ctl-chip--on" : "")
              }
              onClick={() => switchLevel(l.index)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      {status === "error" && (
        <div className="native-player__error">
          <div>{errorMsg || "Playback failed"}</div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setStatus("loading");
              setRetry((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}