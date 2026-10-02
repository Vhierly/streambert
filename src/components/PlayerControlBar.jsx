// ── PlayerControlBar ──────────────────────────────────────────────────────────
// Overlay strip inside the player: playback speed, subtitle track + styling,
// audio track, sleep timer. Every action runs through utils/playerControls.js,
// which executes in the player webview's frames via the main process.
//
// Sits next to the existing source/subtitle/adblock/popout buttons in
// MoviePage and TVPage.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  SPEED_OPTIONS,
  nextSpeed,
  resolvePlayerId,
  getSpeed,
  setSpeed,
  listTracks,
  setTextTrack,
  setAudioTrack,
  setSubtitleStyle,
  setSleepTimer,
} from "../utils/playerControls";
import { storage, STORAGE_KEYS } from "../utils/storage";

const SIZE_STEPS = [75, 100, 130, 160];
const TIMER_STEPS = [15, 30, 45, 60, 90];

const DEFAULT_SUB_STYLE = {
  enabled: true,
  size: 100,
  fontFamily: "",
  textColor: "#ffffff",
  outlineColor: "#000000",
  outlineWidth: 2,
  backgroundOpacity: 0,
  bottomOffset: 6,
};

export default function PlayerControlBar({
  playing,
  webviewRef,
  pipIdRef,
  onNotice,
}) {
  const [speed, setSpeedState] = useState(1);
  const [tracks, setTracks] = useState(null);
  const [activeText, setActiveText] = useState(-1);
  const [activeAudio, setActiveAudio] = useState(0);
  const [panel, setPanel] = useState(null); // 'subs' | 'timer' | null
  const [timerLeft, setTimerLeft] = useState(null); // seconds remaining
  const [subStyle, setSubStyle] = useState(() => ({
    ...DEFAULT_SUB_STYLE,
    ...(storage.get(STORAGE_KEYS.SUBTITLE_STYLE) || {}),
  }));

  const playerId = () =>
    resolvePlayerId({ webviewRef, pipId: pipIdRef?.current });

  // Re-read state when playback starts or the source changes: a new embed is a
  // fresh document with fresh tracks and a reset rate.
  useEffect(() => {
    if (!playing) {
      setPanel(null);
      return;
    }
    let cancelled = false;
    const id = playerId();
    if (id == null) return;
    (async () => {
      const [s, t] = await Promise.all([
        getSpeed(id),
        listTracks(id),
      ]);
      if (cancelled) return;
      if (typeof s === "number") setSpeedState(s);
      setTracks(t);
      const showing = t?.text?.find((x) => x.mode === "showing");
      setActiveText(showing ? showing.index : -1);
      const on = t?.audio?.find((x, i) => i === 0) ? 0 : 0;
      setActiveAudio(on);
      // Re-apply the user's subtitle styling to the new document.
      if (subStyle.enabled) setSubtitleStyle(id, subStyle);
    })();
    return () => {
      cancelled = true;
    };
  }, [playing]);

  // Keep the rate honest if the embed reset it (quality change, source switch).
  useEffect(() => {
    if (!playing || speed === 1) return;
    const id = playerId();
    if (id == null) return;
    const t = setInterval(() => {
      getSpeed(id).then((s) => {
        if (typeof s === "number" && Math.abs(s - speed) > 0.01) {
          setSpeed(id, speed);
        }
      });
    }, 4000);
    return () => clearInterval(t);
  }, [playing, speed]);

  const handleSpeed = useCallback(async () => {
    const id = playerId();
    if (id == null) return;
    const target = nextSpeed(speed);
    const applied = await setSpeed(id, target);
    setSpeedState(typeof applied === "number" ? applied : target);
    onNotice?.(`${target}× speed`);
  }, [speed]);

  const handleSpeedPick = useCallback(
    async (rate) => {
      const id = playerId();
      if (id == null) return;
      const applied = await setSpeed(id, rate);
      setSpeedState(typeof applied === "number" ? applied : rate);
    },
    [],
  );

  const handleTextTrack = useCallback(
    async (index) => {
      const id = playerId();
      if (id == null) return;
      await setTextTrack(id, index);
      setActiveText(index);
      onNotice?.(
        index < 0
          ? "Subtitles off"
          : `Subtitles: ${tracks?.text?.[index]?.label ?? "on"}`,
      );
    },
    [tracks, onNotice],
  );

  const handleAudioTrack = useCallback(
    async (index) => {
      const id = playerId();
      if (id == null) return;
      await setAudioTrack(id, index);
      setActiveAudio(index);
      onNotice?.(`Audio: ${tracks?.audio?.[index]?.label ?? index + 1}`);
    },
    [tracks, onNotice],
  );

  const persistStyle = useCallback((next) => {
    setSubStyle(next);
    storage.set(STORAGE_KEYS.SUBTITLE_STYLE, next);
  }, []);

  const applyStyle = useCallback(
    (patch) => {
      const next = { ...subStyle, ...patch };
      persistStyle(next);
      const id = playerId();
      if (id != null) setSubtitleStyle(id, next);
    },
    [subStyle, persistStyle],
  );

  const handleTimer = useCallback(
    async (minutes) => {
      const id = playerId();
      if (id == null) return;
      const res = await setSleepTimer(id, minutes * 60);
      if (res === "no-video") {
        onNotice?.("Sleep timer needs the player to be loaded");
        return;
      }
      setTimerLeft(minutes * 60);
      setPanel(null);
      onNotice?.(`Sleep timer set for ${minutes} min`);
    },
    [onNotice],
  );

  // Countdown for the visible badge.
  useEffect(() => {
    if (timerLeft == null) return;
    const t = setInterval(() => {
      const next = timerLeft - 1;
      setTimerLeft(next <= 0 ? null : next);
    }, 1000);
    return () => clearInterval(t);
  }, [timerLeft]);

  if (!playing) return null;

  const fmtTimer = (s) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const textTracks = tracks?.text ?? [];
  const audioTracks = tracks?.audio ?? [];
  const subSizeIdx = SIZE_STEPS.indexOf(subStyle.size);

  return (
    <>
      <div className="player-overlay-group player-ctl-group">
        <button
          className="player-overlay-btn"
          onClick={handleSpeed}
          title="Cycle playback speed"
        >
          {speed}×
        </button>

        <button
          className={
            "player-overlay-btn" +
            (activeText >= 0 ? " player-overlay-btn--on" : "")
          }
          onClick={() => setPanel((p) => (p === "subs" ? null : "subs"))}
          title="Subtitles &amp; tracks"
        >
          CC
        </button>

        <button
          className="player-overlay-btn"
          onClick={() => setPanel((p) => (p === "timer" ? null : "timer"))}
          title="Sleep timer"
        >
          ⏱
          {timerLeft != null && (
            <span className="player-ctl-badge">{fmtTimer(timerLeft)}</span>
          )}
        </button>
      </div>

      {panel === "subs" && (
        <div className="player-ctl-panel" onClick={(e) => e.stopPropagation()}>
          <div className="player-ctl-panel__title">Speed</div>
          <div className="player-ctl-chips">
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                className={
                  "player-ctl-chip" +
                  (Math.abs(s - speed) < 0.01 ? " player-ctl-chip--on" : "")
                }
                onClick={() => handleSpeedPick(s)}
              >
                {s}×
              </button>
            ))}
          </div>

          <div className="player-ctl-panel__title">Subtitles</div>
          {textTracks.length === 0 ? (
            <div className="player-ctl-note">
              This source exposes no subtitle tracks. Try a different source, or
              use the subtitle downloader.
            </div>
          ) : (
            <div className="player-ctl-chips">
              <button
                className={
                  "player-ctl-chip" +
                  (activeText < 0 ? " player-ctl-chip--on" : "")
                }
                onClick={() => handleTextTrack(-1)}
              >
                Off
              </button>
              {textTracks.map((t) => (
                <button
                  key={t.index}
                  className={
                    "player-ctl-chip" +
                    (activeText === t.index ? " player-ctl-chip--on" : "")
                  }
                  onClick={() => handleTextTrack(t.index)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="player-ctl-panel__title">Subtitle style</div>
          <label className="player-ctl-row">
            <span>Text size</span>
            <button
              className="btn btn-ghost btn-sm"
              disabled={subSizeIdx <= 0}
              onClick={() => {
                const i = Math.max(0, subSizeIdx - 1);
                applyStyle({ size: SIZE_STEPS[i] });
              }}
            >
              A−
            </button>
            <span className="player-ctl-val">{subStyle.size}%</span>
            <button
              className="btn btn-ghost btn-sm"
              disabled={subSizeIdx >= SIZE_STEPS.length - 1}
              onClick={() => {
                const i = Math.min(SIZE_STEPS.length - 1, subSizeIdx + 1);
                applyStyle({ size: SIZE_STEPS[i] });
              }}
            >
              A+
            </button>
          </label>

          <label className="player-ctl-row">
            <span>Background</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(subStyle.backgroundOpacity * 100)}
              onChange={(e) =>
                applyStyle({ backgroundOpacity: Number(e.target.value) / 100 })
              }
            />
          </label>

          <label className="player-ctl-row">
            <span>Text colour</span>
            <input
              type="color"
              value={subStyle.textColor}
              onChange={(e) => applyStyle({ textColor: e.target.value })}
            />
          </label>

          <label className="player-ctl-row">
            <span>Outline</span>
            <input
              type="range"
              min="0"
              max="8"
              value={subStyle.outlineWidth}
              onChange={(e) =>
                applyStyle({ outlineWidth: Number(e.target.value) })
              }
            />
          </label>

          <div className="player-ctl-panel__title">Audio</div>
          {audioTracks.length === 0 ? (
            <div className="player-ctl-note">
              This source offers a single audio track.
            </div>
          ) : (
            <div className="player-ctl-chips">
              {audioTracks.map((a, i) => (
                <button
                  key={i}
                  className={
                    "player-ctl-chip" +
                    (activeAudio === i ? " player-ctl-chip--on" : "")
                  }
                  onClick={() => handleAudioTrack(i)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {panel === "timer" && (
        <div className="player-ctl-panel" onClick={(e) => e.stopPropagation()}>
          <div className="player-ctl-panel__title">Sleep timer</div>
          <div className="player-ctl-chips">
            {TIMER_STEPS.map((m) => (
              <button
                key={m}
                className="player-ctl-chip"
                onClick={() => handleTimer(m)}
              >
                {m} min
              </button>
            ))}
            {timerLeft != null && (
              <button
                className="player-ctl-chip player-ctl-chip--danger"
                onClick={async () => {
                  const id = playerId();
                  if (id != null) await setSleepTimer(id, 0);
                  setTimerLeft(null);
                  onNotice?.("Sleep timer cancelled");
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <div className="player-ctl-note">
            Volume fades out over the last 5 seconds, then playback pauses.
          </div>
        </div>
      )}
    </>
  );
}