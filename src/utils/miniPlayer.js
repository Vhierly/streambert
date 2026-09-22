// ── Mini Player Mode ─────────────────────────────────────────────────────────
// Always-on-top small window for picture-in-picture style viewing.
// Opens in the main process (index.js) via IPC.

// This module exposes the renderer-side API. The actual window lives in main.
let _miniPlayerWindowId = null;

export const miniPlayerOpen = async (url, title) => {
  if (!window.electron?.openMiniPlayer) return { ok: false, reason: "not-electron" };
  const result = await window.electron.openMiniPlayer(url, title);
  if (result.ok) _miniPlayerWindowId = result.windowId;
  return result;
};

export const miniPlayerClose = async () => {
  if (!window.electron?.closeMiniPlayer) return { ok: false };
  const result = await window.electron.closeMiniPlayer();
  _miniPlayerWindowId = null;
  return result;
};

export const miniPlayerSetSize = async (width, height) => {
  if (!window.electron?.setMiniPlayerSize) return { ok: false };
  return window.electron.setMiniPlayerSize(width, height);
};

export const miniPlayerSetAlwaysOnTop = async (enabled) => {
  if (!window.electron?.setMiniPlayerAlwaysOnTop) return { ok: false };
  return window.electron.setMiniPlayerAlwaysOnTop(enabled);
};

export const miniPlayerIsOpen = () => _miniPlayerWindowId !== null;
