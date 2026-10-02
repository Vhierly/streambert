// ── Player controls: speed, subtitle track, subtitle styling ──────────────────
// The player is a <webview> pointing at a third-party embed, often with the
// real <video> nested in a cross-origin iframe. We can't reach it from the
// renderer, so every command is executed by the main process across all frames
// (see ipcMain "player-exec" in src/ipc/player.js).
//
// All snippets below are self-contained IIFEs built from validated values only
// — no interpolation of page content — and return JSON-serialisable state.

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const SPEED_OPTIONS = SPEEDS;

// ── Low-level: run a snippet across frames ────────────────────────────────────

async function runInPlayer(webContentsId, expr) {
  if (webContentsId == null) return null;
  if (!window.electron?.playerExec) return null;
  try {
    return await window.electron.playerExec(webContentsId, expr);
  } catch {
    return null;
  }
}

/** Resolve the webContents id that currently owns the picture. */
export function resolvePlayerId({ webviewRef, pipId }) {
  if (pipId != null) return pipId;
  try {
    const id = webviewRef?.current?.getWebContentsId?.();
    return id ?? null;
  } catch {
    return null;
  }
}

// ── Playback speed ────────────────────────────────────────────────────────────

export async function getSpeed(webContentsId) {
  return runInPlayer(
    webContentsId,
    `(() => { const v = document.querySelector('video'); return v ? v.playbackRate : null; })()`,
  );
}

export async function setSpeed(webContentsId, rate) {
  const safe = Number(rate);
  if (!Number.isFinite(safe) || safe < 0.25 || safe > 4) return null;
  // Re-apply on 'ratechange' because many players reset speed when quality or
  // source changes, which silently undoes the user's choice.
  return runInPlayer(
    webContentsId,
    `(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const apply = () => { try { v.playbackRate = ${safe}; } catch {} };
      apply();
      if (!v.__sbSpeedHooked) {
        v.__sbSpeedHooked = true;
        v.__sbSpeed = ${safe};
        ['ratechange','loadedmetadata','loadstart','emptied'].forEach(ev =>
          v.addEventListener(ev, () => {
            if (v.__sbSpeed && Math.abs(v.playbackRate - v.__sbSpeed) > 0.01) {
              try { v.playbackRate = v.__sbSpeed; } catch {}
            }
          })
        );
      }
      return v.playbackRate;
    })()`,
  );
}

export function nextSpeed(current) {
  const i = SPEEDS.findIndex((s) => Math.abs(s - current) < 0.01);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

// ── Subtitle tracks ───────────────────────────────────────────────────────────
// Sources expose subtitles inconsistently: some as native <track> elements,
// some as a custom caption panel we can't drive. We handle the native case and
// report honestly when a source has nothing to switch.

export async function listTracks(webContentsId) {
  const raw = await runInPlayer(
    webContentsId,
    `(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const dump = (list) => Array.from(list || []).map((t, i) => ({
        index: i,
        kind: t.kind,
        label: t.label || t.language || (t.kind === 'captions' ? 'Captions' : 'Subtitles'),
        language: t.language || '',
        mode: t.mode,
      }));
      return {
        audio: dump(v.audioTracks),
        text: dump(v.textTracks),
      };
    })()`,
  );
  if (!raw) return null;
  // Chromium only populates these lists once the player opts in via
  // `mode`/`load`; many embeds don't, so an empty list is normal, not an error.
  return { audio: raw.audio || [], text: raw.text || [] };
}

export async function setTextTrack(webContentsId, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < -1) return null;
  return runInPlayer(
    webContentsId,
    `(() => {
      const v = document.querySelector('video');
      if (!v || !v.textTracks) return null;
      const tracks = v.textTracks;
      for (let k = 0; k < tracks.length; k++) tracks[k].mode = 'disabled';
      if (${i} >= 0 && tracks[${i}]) {
        tracks[${i}].mode = 'showing';
        return tracks[${i}].label || tracks[${i}].language || 'Subtitles';
      }
      return 'off';
    })()`,
  );
}

export async function setAudioTrack(webContentsId, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return null;
  return runInPlayer(
    webContentsId,
    `(() => {
      const v = document.querySelector('video');
      if (!v || !v.audioTracks || !v.audioTracks[${i}]) return null;
      v.audioTracks[${i}].enabled = true;
      return v.audioTracks[${i}].label || v.audioTracks[${i}].language || 'Audio';
    })()`,
  );
}

// ── Subtitle styling ──────────────────────────────────────────────────────────
// Injected as a stylesheet the page can't easily clobber (specificity + late
// insertion). We restyle ::cue on the native text track, which is the only
// styling surface that works cross-origin without touching the embed's own DOM.

const STYLE_ID = "__sb_sub_style";

export async function setSubtitleStyle(webContentsId, style) {
  const {
    enabled = true,
    size = 100, // percent
    fontFamily = "",
    textColor = "#ffffff",
    outlineColor = "#000000",
    outlineWidth = 2,
    backgroundOpacity = 0,
    bottomOffset = 6, // percent from bottom
  } = style || {};

  const clamp = (n, lo, hi, dflt) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };

  const expr = `(() => {
    const cfg = {
      size: ${clamp(size, 50, 300, 100)},
      fontFamily: ${JSON.stringify(String(fontFamily).slice(0, 80))},
      textColor: ${JSON.stringify(String(textColor).slice(0, 32))},
      outlineColor: ${JSON.stringify(String(outlineColor).slice(0, 32))},
      outlineWidth: ${clamp(outlineWidth, 0, 8, 2)},
      backgroundOpacity: ${clamp(backgroundOpacity, 0, 1, 0)},
      bottomOffset: ${clamp(bottomOffset, 0, 40, 6)},
      enabled: ${enabled ? "true" : "false"},
    };
    let el = document.getElementById(${JSON.stringify(STYLE_ID)});
    if (!cfg.enabled) { if (el) el.remove(); return 'off'; }
    if (!el) {
      el = document.createElement('style');
      el.id = ${JSON.stringify(STYLE_ID)};
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = [
      'video::cue {',
      '  font-size: ' + (cfg.size / 100 * 2.6).toFixed(2) + 'vw !important;',
      cfg.fontFamily ? '  font-family: ' + cfg.fontFamily + ' !important;' : '',
      '  color: ' + cfg.textColor + ' !important;',
      '  -webkit-text-stroke: ' + cfg.outlineWidth + 'px ' + cfg.outlineColor + ' !important;',
      '  text-shadow: 0 0 ' + (cfg.outlineWidth * 2) + 'px ' + cfg.outlineColor + ' !important;',
      cfg.backgroundOpacity > 0
        ? '  background: rgba(0,0,0,' + cfg.backgroundOpacity + ') !important;'
        : '',
      '  line-height: 1.35 !important;',
      '}',
      'video { position: relative !important; }',
      '::cue { margin-bottom: ' + cfg.bottomOffset + 'vh !important; }',
    ].filter(Boolean).join('\\n');
    return 'ok';
  })()`;
  return runInPlayer(webContentsId, expr);
}

// ── Sleep timer ───────────────────────────────────────────────────────────────
// Pauses playback and steps the volume down over the last few seconds so it
// fades rather than cutting. Runs in the page; we only arm/disarm it.

export async function setSleepTimer(webContentsId, seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) {
    return runInPlayer(
      webContentsId,
      `(() => {
        const v = document.querySelector('video');
        if (!v) return 'no-video';
        if (v.__sbSleep) { clearInterval(v.__sbSleep.timer); v.__sbSleep = null; }
        try { v.volume = v.__sbVol != null ? v.__sbVol : 1; } catch {}
        return 'cancelled';
      })()`,
    );
  }

  return runInPlayer(
    webContentsId,
    `(() => {
      const v = document.querySelector('video');
      if (!v) return 'no-video';
      if (v.__sbSleep) { clearInterval(v.__sbSleep.timer); v.__sbSleep = null; }
      if (v.__sbVol == null) v.__sbVol = v.volume;
      const startVol = v.volume;
      const endAt = Date.now() + ${Math.round(s * 1000)};
      const FADE_MS = 5000;
      const state = { timer: null };
      state.timer = setInterval(() => {
        const left = endAt - Date.now();
        if (left <= 0) {
          clearInterval(state.timer);
          v.__sbSleep = null;
          try { v.pause(); } catch {}
          try { v.volume = v.__sbVol != null ? v.__sbVol : 1; } catch {}
          return;
        }
        if (left < FADE_MS) {
          try { v.volume = startVol * (left / FADE_MS); } catch {}
        }
      }, 250);
      v.__sbSleep = state;
      return 'armed';
    })()`,
  );
}

export { SPEEDS };