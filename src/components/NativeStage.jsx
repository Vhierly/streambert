// ── NativeStage ──────────────────────────────────────────────────────────────
// The in-app player: our own <video> element fed by the loopback HLS proxy.
//
// Why not just point the existing <webview> at the stream? Because every embed
// ships its own transport UI, so controls look and behave differently per
// source — and the app-level controls that *are* shared (PlayerControlBar) can
// only reach that transport by injecting JavaScript into someone else's
// cross-origin frame, which is brittle and easy to break with a site redesign.
//
// Owning the element fixes both: one design system for every anime source, and
// controls that are real DOM we bind to directly (see NativeControls).
//
// It renders alongside the webview rather than replacing it. TVPage has a lot of
// machinery wired to that webview — progress polling, AniSkip seeks, the pop-out
// window, controller support — and all of it has to keep working for every other
// source. So this component is additive: TVPage mounts both, and hides whichever
// one is not playing.
//
// Decision of *whether* to go native happens upstream (TVPage), because only it
// knows whether the resolver produced a real m3u8 or just an embed page.

import { useCallback, useEffect, useRef, useState } from "react";
import NativePlayer from "./NativePlayer";
import NativeControls from "./NativeControls";

export default function NativeStage({
  playing,
  // { src, masterSrc, proxyBase, subtitles } from window.electron.hianimeNativeStream
  stream,
  startTime = 0,
  poster,
  title,
  // The caller owns the element so it can read playback position for progress
  // saving and AniSkip, exactly as it reads them out of the webview today.
  videoRef,
  onProgress,
  onEnded,
  onDuration,
  onError,
  onNotice,
}) {
  // Kept as state as well so the control bar mounts on the same commit the
  // element exists — a ref would still be null when NativeControls' effects
  // first run, and they'd never re-bind.
  const [videoEl, setVideoEl] = useState(null);
  const localRef = useRef(null);

  // Prefer the caller's ref when given, but always keep our own current so the
  // fallback path (no videoRef prop) still works.
  const onElement = useCallback(
    (node) => {
      localRef.current = node;
      setVideoEl(node);
      if (videoRef) videoRef.current = node;
    },
    [videoRef],
  );

  if (!stream?.src) return null;

  return (
    <div
      className="native-stage"
      style={{
        position: "absolute",
        inset: 0,
        background: "#000",
        display: playing ? "block" : "none",
        zIndex: 2,
      }}
    >
      <NativePlayer
        playing={playing}
        src={stream.src}
        masterSrc={stream.masterSrc}
        proxyBase={stream.proxyBase}
        poster={poster}
        title={title}
        startTime={startTime}
        subtitles={stream.subtitles}
        onVideoElement={onElement}
        onProgress={onProgress}
        onEnded={onEnded}
        onDuration={onDuration}
        onError={onError}
      />
      {videoEl && (
        <NativeControls videoEl={videoEl} title={title} onNotice={onNotice} />
      )}
    </div>
  );
}