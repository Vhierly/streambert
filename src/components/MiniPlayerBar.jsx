// ── MiniPlayerBar ─────────────────────────────────────────────────────────────
// Always-on-top mini player. The main-process side already existed
// (open-mini-player / close / set-size / always-on-top in index.js) but nothing
// ever called it. This is the missing UI.
//
// Relationship to the existing pop-out (pipWindow):
//   - pop-out   → separate window with the full player chrome, main webview blanks
//   - mini      → small always-on-top strip, main webview also blanks
// Only one stream may run at a time, so opening the mini player closes the
// pop-out first.
//
// Because the main webview has to be blanked while the mini window streams, we
// capture the playback position on open and seek back to it on close —
// otherwise closing the mini player would dump the user at 0:00.

import { useState, useCallback, useRef } from "react";

const SIZES = [
  { label: "S", width: 320, height: 180 },
  { label: "M", width: 480, height: 270 },
  { label: "L", width: 640, height: 360 },
];

export default function MiniPlayerBar({
  playing,
  webviewRef,
  playerUrl,
  title,
  onNotice,
}) {
  const [miniOpen, setMiniOpen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  // WebContents id of the mini window, so we can read its playback position
  // when the user closes it.
  const miniWcIdRef = useRef(null);
  // Fallback seek target, used when the mini window can't be queried.
  const [resumeAt, setResumeAt] = useState(0);

  /** Read the current playback position from whichever webview is live. */
  const capturePosition = useCallback(async () => {
    try {
      const id = webviewRef?.current?.getWebContentsId?.();
      if (id == null) return 0;
      const r = await window.electron?.queryVideoProgress?.(id);
      return r?.currentTime ?? 0;
    } catch {
      return 0;
    }
  }, [webviewRef]);

  /** Restore the main webview and seek back to where the user left off. */
  const restoreMainPlayer = useCallback(
    async (seekTo) => {
      const wv = webviewRef?.current;
      if (!wv) return;
      try {
        wv.reload();
      } catch {}
      // The embed needs a moment before <video> exists; poll briefly then seek.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const id = wv.getWebContentsId?.();
          if (id == null) return;
          const r = await window.electron?.queryVideoProgress?.(id);
          if (r?.duration > 0) break;
        } catch {
          return;
        }
      }
      if (!seekTo) return;
      const expr = `(() => {
        const v = document.querySelector('video');
        if (!v || !v.duration) return null;
        v.currentTime = Math.min(${Number(seekTo)}, Math.max(0, v.duration - 5));
        return v.currentTime;
      })()`;
      try {
        const id = wv.getWebContentsId?.();
        if (id != null) await window.electron?.playerExec?.(id, expr);
      } catch {}
    },
    [webviewRef],
  );

  const closePopoutIfOpen = useCallback(async () => {
    try {
      const id = await window.electron?.getPipWebContentsId?.();
      if (id != null) {
        await window.electron.closePipWindow();
        return true;
      }
    } catch {}
    return false;
  }, []);

  const handleOpen = useCallback(async () => {
    if (!playerUrl) {
      onNotice?.("Player isn't ready yet");
      return;
    }
    const at = await capturePosition();
    const hadPopout = await closePopoutIfOpen();
    try {
      const res = await window.electron?.openMiniPlayer?.(playerUrl, title);
      if (res?.ok) {
        setMiniOpen(true);
        miniWcIdRef.current = res.windowId ?? null;
        // Blank the in-page webview so only the mini window streams.
        try {
          const wv = webviewRef?.current;
          if (wv) wv.src = "about:blank";
        } catch {}
        setResumeAt(at);
        onNotice?.(
          hadPopout
            ? "Pop-out closed — mini player is streaming"
            : "Mini player opened — keep watching while you work",
        );
      } else {
        onNotice?.("Could not open the mini player");
      }
    } catch {
      onNotice?.("Could not open the mini player");
    }
  }, [
    playerUrl,
    title,
    capturePosition,
    closePopoutIfOpen,
    webviewRef,
    onNotice,
  ]);

  const handleClose = useCallback(async () => {
    // While the mini window is live the main webview is blank, so read the
    // position from the mini window's own webContents instead.
    let seekTo = resumeAt;
    try {
      if (miniWcIdRef.current != null) {
        const r = await window.electron?.queryVideoProgress?.(
          miniWcIdRef.current,
        );
        seekTo = r?.currentTime ?? seekTo;
      }
    } catch {}
    await window.electron?.closeMiniPlayer?.();
    miniWcIdRef.current = null;
    setMiniOpen(false);
    await restoreMainPlayer(seekTo);
    onNotice?.("Back in the main player");
  }, [restoreMainPlayer, onNotice, resumeAt]);

  const handleSize = useCallback(async (size) => {
    try {
      await window.electron?.setMiniPlayerSize?.(size.width, size.height);
    } catch {}
  }, []);

  const handleTop = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try {
      await window.electron?.setMiniPlayerAlwaysOnTop?.(next);
    } catch {}
  }, [alwaysOnTop]);

  if (!playing) return null;

  return (
    <div className="player-overlay-group player-mini-group">
      <button
        className="player-overlay-btn"
        onClick={handleOpen}
        disabled={!playerUrl}
        title="Open a small always-on-top player"
      >
        ⧉ Mini
      </button>

      {miniOpen && (
        <>
          <button
            className="player-overlay-btn"
            onClick={handleClose}
            title="Close the mini player and go back"
          >
            ✕ Back
          </button>
          <button
            className="player-overlay-btn"
            onClick={handleTop}
            title={alwaysOnTop ? "Always on top" : "Not pinned"}
            style={alwaysOnTop ? { color: "var(--red)" } : undefined}
          >
            {alwaysOnTop ? "📌" : "📍"}
          </button>
          {SIZES.map((s) => (
            <button
              key={s.label}
              className="player-overlay-btn"
              onClick={() => handleSize(s)}
              title={`Resize to ${s.width}×${s.height}`}
            >
              {s.label}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export { SIZES };