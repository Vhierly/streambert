// ── useSourceRecovery: detect a dead player host and hop to a live one ────────
// Detects three failure shapes that all mean "this source is not going to play":
//   1. did-fail-load — DNS dead / TLS error / parked domain
//   2. loaded a page with no <video> after a grace period (Cloudflare wall,
//      "removed" page, embed route 404 served as HTML 200)
//   3. explicit resolve failure from an async (AllManga-family) source
//
// On failure we mark the host down (so the next probe skips it) and switch to the
// best healthy alternative. A manual source pick latches the lock so we never
// yank the user off a source they explicitly chose — they can still hit "retry"
// in the source menu to force another hop.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getHealth,
  nextBestSource,
  reportSourceFailure,
  reportSourceSuccess,
  subscribeHealth,
} from "./sourceHealth";

// How long a host may stay on screen without exposing a <video> before we call
// it dead. Embeds are slow (ads, trackers, Cloudflare), so be generous.
const NO_VIDEO_GRACE_MS = 14000;
// Don't hop more than this many times per play session, so a fully-dead set of
// sources can't put the player in an infinite reload loop.
const MAX_HOPS = 3;

export function useSourceRecovery({
  playing,
  sourceId,
  webviewRef,
  isAnime,
  manualSelectionRef,
  onHop,
  onGiveUp,
  resetKey,
  // Set when the webview is deliberately parked on about:blank because another
  // player owns the screen. Every probe below inspects the webview, so leaving
  // them running would read the blank page as "this source is dead".
  suspended = false,
}) {
  const [health, setHealth] = useState({});
  const [recovering, setRecovering] = useState(false);
  const [lastHop, setLastHop] = useState(null); // { from, to, reason }
  const hopsRef = useRef(0);
  const attemptRef = useRef(0); // bumps per source change; identifies an attempt
  const graceTimerRef = useRef(null);
  const checkingRef = useRef(false);

  // reset hop budget whenever the user starts a fresh play
  useEffect(() => {
    if (playing) {
      hopsRef.current = 0;
      setLastHop(null);
      setRecovering(false);
    }
  }, [playing, resetKey]);

  useEffect(() => {
    setHealth((h) => ({ ...h, [sourceId]: getHealth(sourceId) }));
    return subscribeHealth((map) =>
      setHealth((prev) => ({ ...prev, [sourceId]: map[sourceId] })),
    );
  }, [sourceId]);

  // ── Success: a video element showed up on this host ────────────────────────
  const markAlive = useCallback(() => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    reportSourceSuccess(sourceId);
    // Let the next probe clear the flag; this only debounces within one mount.
    setTimeout(() => {
      checkingRef.current = false;
    }, 3000);
  }, [sourceId]);

  // ── Failure: hop to the next best source ───────────────────────────────────
  const failAndHop = useCallback(
    (reason) => {
      if (!playing) return;
      if (manualSelectionRef?.current) {
        // User picked this source on purpose — surface it, don't hijack.
        onGiveUp?.(reason);
        return;
      }
      if (hopsRef.current >= MAX_HOPS) {
        onGiveUp?.(reason);
        return;
      }
      const next = nextBestSource(sourceId, { isAnime });
      if (!next || next === sourceId) {
        onGiveUp?.(reason);
        return;
      }
      hopsRef.current += 1;
      reportSourceFailure(sourceId);
      setRecovering(true);
      setLastHop({ from: sourceId, to: next, reason });
      onHop?.(next, reason);
      // Clear the "recovering" banner once the new host has had its chance.
      setTimeout(() => setRecovering(false), 2500);
    },
    [playing, manualSelectionRef, sourceId, isAnime, onHop, onGiveUp],
  );

  // ── Wire webview events ────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || suspended) return;
    const wv = webviewRef?.current;
    if (!wv) return;
    attemptRef.current += 1;
    const thisAttempt = attemptRef.current;

    const onFailLoad = (e) => {
      // errorCode -3 is ABORTED, which also fires on our own about:blank
      // navigation during cleanup — ignore it.
      if (e?.errorCode === -3) return;
      if (attemptRef.current !== thisAttempt) return;
      failAndHop("load-failed");
    };
    const onFinishLoad = () => {
      if (attemptRef.current !== thisAttempt) return;
      // Give the embed a moment, then look for a video.
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(async () => {
        if (attemptRef.current !== thisAttempt) return;
        try {
          // Some sources nest the player in a cross-origin iframe, so ask the
          // main process to walk every frame instead of only the top document.
          const wcId = wv.getWebContentsId?.();
          let found = false;
          if (wcId != null && window.electron?.queryVideoProgress) {
            const r = await window.electron.queryVideoProgress(wcId);
            found = !!(r && r.duration > 0);
          }
          if (!found) {
            try {
              found = await wv.executeJavaScript(
                `!!document.querySelector('video')`,
              );
            } catch {
              // executeJavaScript on a cross-origin frame throws; the main-process
              // probe above is the authoritative answer in that case.
            }
          }
          if (!found) {
            if (attemptRef.current === thisAttempt) failAndHop("no-video");
          } else {
            markAlive();
          }
        } catch {
          /* probing failed for an unrelated reason; don't punish the source */
        }
      }, NO_VIDEO_GRACE_MS);
    };

    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("did-finish-load", onFinishLoad);
    return () => {
      clearTimeout(graceTimerRef.current);
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("did-finish-load", onFinishLoad);
    };
  }, [playing, sourceId, failAndHop, markAlive, webviewRef, suspended]);

  // Clean up the grace timer on unmount so a late timer can't fire a hop
  // against a page that's gone.
  useEffect(() => () => clearTimeout(graceTimerRef.current), []);

  return { health, recovering, lastHop, failAndHop, markAlive };
}

export { MAX_HOPS, NO_VIDEO_GRACE_MS };