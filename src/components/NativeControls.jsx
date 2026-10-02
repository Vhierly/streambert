// ── NativeControls ────────────────────────────────────────────────────────────
// Controls for NativePlayer. These bind straight to the <video> element, which
// is the whole point of owning the player: no injecting script into a
// cross-origin iframe, and the UI is real DOM we can style consistently.
//
// PlayerControlBar (used by the embed path) does the same jobs via
// main-process JS injection — keep the two visually identical on purpose, so
// switching between native and embed doesn't feel like a different app.

import { useState, useEffect, useCallback, useRef } from "react";
import { storage, STORAGE_KEYS } from "../utils/storage";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SIZE_STEPS = [75, 100, 130, 160];
const TIMER_STEPS = [15, 30, 45, 60, 90];

const DEFAULT_SUB_STYLE = {
  size: 100,
  textColor: "#ffffff",
  outlineColor: "#000000",
  outlineWidth: 2,
  backgroundOpacity: 0,
};

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
};

export default function NativeControls({ videoRef, title, onNotice }) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [panel, setPanel] = useState(null); // 'subs' | 'timer' | null
  const [tracks, setTracks] = useState([]);
  const [activeTrack, setActiveTrack] = useState(-1);
  const [timerLeft, setTimerLeft] = useState(null);
  const [subStyle, setSubStyle] = useState(() => ({
    ...DEFAULT_SUB_STYLE,
    ...(storage.get(STORAGE_KEYS.SUBTITLE_STYLE) || {}),
  }));

  const seekBarRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [visible, setVisible] = useState(true);

  const v = () => videoRef?.current;

  // ── Media element wiring ───────────────────────────────────────────────────
  useEffect(() => {
    const el = v();
    if (!el) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrent(el.currentTime || 0);
    const onMeta = () => {
      setDuration(el.duration || 0);
      setVolume(el.volume);
      setMuted(el.muted);
      // Discover text tracks. The browser only populates them once the track
      // element has loaded, hence the slight delay.
      setTimeout(() => {
        try {
          const list = Array.from(el.textTracks || []).map((t, i) => ({
            index: i,
            label: t.label || t.language || `Subtitle ${i + 1}`,
            lang: t.language || "",
            mode: t.mode,
          }));
          setTracks(list);
          const showing = list.find((t) => t.mode === "showing");
          setActiveTrack(showing ? showing.index : -1);
        } catch {}
      }, 600);
    };
    const onVol = () => {
      setVolume(el.volume);
      setMuted(el.muted);
    };
    const onRate = () => setSpeed(el.playbackRate);

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("volumechange", onVol);
    el.addEventListener("ratechange", onRate);

    if (el.paused) setPlaying(false);
    else setPlaying(true);
    setCurrent(el.currentTime || 0);
    if (el.duration) setDuration(el.duration);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("volumechange", onVol);
      el.removeEventListener("ratechange", onRate);
    };
  }, [videoRef]);

  // ── Auto-hide the bar so it doesn't sit over the picture ──────────────────
  const poke = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), 2600);
  }, []);
  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimerRef.current);
  }, [poke]);

  // ── Subtitle styling, applied to the real <video> ──────────────────────────
  useEffect(() => {
    const el = v();
    if (!el) return;
    let style = document.getElementById("__sb_native_cue");
    if (!style) {
      style = document.createElement("style");
      style.id = "__sb_native_cue";
      document.head.appendChild(style);
    }
    const s = subStyle;
    style.textContent = `
      .native-player__video::cue {
        font-size: ${((s.size / 100) * 2.6).toFixed(2)}vw !important;
        color: ${s.textColor} !important;
        -webkit-text-stroke: ${s.outlineWidth}px ${s.outlineColor} !important;
        text-shadow: 0 0 ${s.outlineWidth * 2}px ${s.outlineColor} !important;
        line-height: 1.35 !important;
        ${s.backgroundOpacity > 0 ? `background: rgba(0,0,0,${s.backgroundOpacity}) !important;` : ""}
      }`;
    return () => {};
  }, [subStyle, videoRef]);

  const applyStyle = useCallback(
    (patch) => {
      const next = { ...subStyle, ...patch };
      setSubStyle(next);
      storage.set(STORAGE_KEYS.SUBTITLE_STYLE, next);
    },
    [subStyle],
  );

  // ── Actions ────────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    const el = v();
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, [videoRef]);

  const seekBy = useCallback((d) => {
    const el = v();
    if (!el) return;
    try {
      el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + d));
    } catch {}
  }, [videoRef]);

  const pickSpeed = useCallback((r) => {
    const el = v();
    if (!el) return;
    el.playbackRate = r;
    setSpeed(r);
    onNotice?.(`${r}× speed`);
  }, [videoRef, onNotice]);

  const pickTrack = useCallback((i) => {
    const el = v();
    if (!el || !el.textTracks) return;
    Array.from(el.textTracks).forEach((t, k) => {
      t.mode = k === i ? "showing" : "disabled";
    });
    setActiveTrack(i);
    onNotice?.(i < 0 ? "Subtitles off" : `Subtitles: ${tracks[i]?.label ?? "on"}`);
  }, [videoRef, tracks, onNotice]);

  const armTimer = useCallback((minutes) => {
    const endAt = Date.now() + minutes * 60000;
    setTimerLeft(minutes * 60);
    setPanel(null);
    onNotice?.(`Sleep timer set for ${minutes} min`);
    clearInterval(armTimer._iv);
    armTimer._iv = setInterval(() => {
      const left = endAt - Date.now();
      if (left <= 0) {
        clearInterval(armTimer._iv);
        const el = v();
        if (el) {
          el.pause();
          el.volume = 1;
        }
        setTimerLeft(null);
      } else if (left < 6000) {
        // Fade over the last six seconds.
        const el = v();
        if (el) el.volume = Math.max(0, el.volume * 0.9);
      } else {
        setTimerLeft(Math.ceil(left / 1000));
      }
    }, 1000);
  }, [videoRef, onNotice]);

  useEffect(() => () => clearInterval(armTimer._iv), [armTimer]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (!v()) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); toggle(); break;
        case "ArrowLeft": e.preventDefault(); seekBy(-10); break;
        case "ArrowRight": e.preventDefault(); seekBy(10); break;
        case "ArrowUp": e.preventDefault(); { const el = v(); if (el) el.volume = Math.min(1, el.volume + 0.1); } break;
        case "ArrowDown": e.preventDefault(); { const el = v(); if (el) el.volume = Math.max(0, el.volume - 0.1); } break;
        case "m": { const el = v(); if (el) el.muted = !el.muted; } break;
        case "f": { const el = v(); if (el?.requestFullscreen) el.requestFullscreen(); } break;
        case "c": setPanel((p) => (p === "subs" ? null : "subs")); break;
        default:
          if (e.key >= "0" && e.key <= "9" && e.key !== "0") {
            const el = v();
            if (el?.duration) { el.currentTime = (el.duration * Number(e.key)) / 10; }
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [videoRef, toggle, seekBy]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const subSizeIdx = SIZE_STEPS.indexOf(subStyle.size);

  return (
    <div
      className={"native-ctl" + (visible ? "" : " native-ctl--hidden")}
      onMouseMove={poke}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Seek bar */}
      <div
        className="native-ctl__seek"
        onClick={(e) => {
          const el = v();
          if (!el || !duration) return;
          const r = e.currentTarget.getBoundingClientRect();
          el.currentTime = ((e.clientX - r.left) / r.width) * duration;
        }}
      >
        <div className="native-ctl__seek-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="native-ctl__row">
        <button className="native-ctl__btn" onClick={toggle} title={playing ? "Pause (Space)" : "Play (Space)"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="native-ctl__btn" onClick={() => seekBy(-10)} title="Back 10s (←)">⏪</button>
        <button className="native-ctl__btn" onClick={() => seekBy(10)} title="Forward 10s (→)">⏩</button>

        <span className="native-ctl__time">
          {fmtTime(current)} / {fmtTime(duration)}
        </span>

        <button
          className="native-ctl__btn"
          onClick={() => {
            const el = v();
            if (el) el.muted = !el.muted;
          }}
          title="Mute (M)"
        >
          {muted || volume === 0 ? "🔇" : "🔊"}
        </button>
        <input
          className="native-ctl__vol"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          onChange={(e) => {
            const el = v();
            if (!el) return;
            el.volume = Number(e.target.value);
            el.muted = Number(e.target.value) === 0;
          }}
          title="Volume (↑/↓)"
        />

        <div className="native-ctl__spacer" />

        <button className="native-ctl__btn" onClick={() => pickSpeed(speed === 1 ? 1.25 : speed >= 3 ? 0.5 : SPEEDS.find((s) => s > speed) ?? 1)} title="Playback speed">
          {speed}×
        </button>
        <button className="native-ctl__btn" onClick={() => setPanel((p) => (p === "subs" ? null : "subs"))} title="Subtitles (C)">
          CC
        </button>
        <button className="native-ctl__btn" onClick={() => setPanel((p) => (p === "timer" ? null : "timer"))} title="Sleep timer">
          {timerLeft != null ? fmtTime(timerLeft) : "⏱"}
        </button>
        <button
          className="native-ctl__btn"
          onClick={() => { const el = v(); if (el?.requestFullscreen) el.requestFullscreen(); }}
          title="Fullscreen (F)"
        >
          ⛶
        </button>
      </div>

      {panel === "subs" && (
        <div className="native-ctl__panel" onClick={(e) => e.stopPropagation()}>
          <div className="player-ctl-panel__title">Speed</div>
          <div className="player-ctl-chips">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={"player-ctl-chip" + (Math.abs(speed - s) < 0.01 ? " player-ctl-chip--on" : "")}
                onClick={() => pickSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>

          <div className="player-ctl-panel__title">Subtitles</div>
          {tracks.length === 0 ? (
            <div className="player-ctl-note">No subtitle tracks for this stream.</div>
          ) : (
            <div className="player-ctl-chips">
              <button className={"player-ctl-chip" + (activeTrack < 0 ? " player-ctl-chip--on" : "")} onClick={() => pickTrack(-1)}>
                Off
              </button>
              {tracks.map((t) => (
                <button
                  key={t.index}
                  className={"player-ctl-chip" + (activeTrack === t.index ? " player-ctl-chip--on" : "")}
                  onClick={() => pickTrack(t.index)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="player-ctl-panel__title">Subtitle style</div>
          <label className="player-ctl-row">
            <span>Text size</span>
            <button className="btn btn-ghost btn-sm" disabled={subSizeIdx <= 0} onClick={() => applyStyle({ size: SIZE_STEPS[Math.max(0, subSizeIdx - 1)] })}>A−</button>
            <span className="player-ctl-val">{subStyle.size}%</span>
            <button className="btn btn-ghost btn-sm" disabled={subSizeIdx >= SIZE_STEPS.length - 1} onClick={() => applyStyle({ size: SIZE_STEPS[Math.min(SIZE_STEPS.length - 1, subSizeIdx + 1)] })}>A+</button>
          </label>
          <label className="player-ctl-row">
            <span>Background</span>
            <input type="range" min="0" max="100" value={Math.round(subStyle.backgroundOpacity * 100)}
              onChange={(e) => applyStyle({ backgroundOpacity: Number(e.target.value) / 100 })} />
          </label>
          <label className="player-ctl-row">
            <span>Text colour</span>
            <input type="color" value={subStyle.textColor} onChange={(e) => applyStyle({ textColor: e.target.value })} />
          </label>
          <label className="player-ctl-row">
            <span>Outline</span>
            <input type="range" min="0" max="8" value={subStyle.outlineWidth}
              onChange={(e) => applyStyle({ outlineWidth: Number(e.target.value) })} />
          </label>
        </div>
      )}

      {panel === "timer" && (
        <div className="native-ctl__panel" onClick={(e) => e.stopPropagation()}>
          <div className="player-ctl-panel__title">Sleep timer</div>
          <div className="player-ctl-chips">
            {TIMER_STEPS.map((m) => (
              <button key={m} className="player-ctl-chip" onClick={() => armTimer(m)}>{m} min</button>
            ))}
            {timerLeft != null && (
              <button className="player-ctl-chip player-ctl-chip--danger" onClick={() => { clearInterval(armTimer._iv); setTimerLeft(null); onNotice?.("Sleep timer cancelled"); }}>
                Cancel
              </button>
            )}
          </div>
          <div className="player-ctl-note">Volume fades out over the last few seconds.</div>
        </div>
      )}
    </div>
  );
}

export { SPEEDS, TIMER_STEPS };