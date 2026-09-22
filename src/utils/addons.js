// ── Plugin/Addon System ──────────────────────────────────────────────────────
// Community addon framework: JSON manifest + fetch function.
// Addons are loaded from the addons/ directory or user-provided paths.

const ADDONS_DIR = "addons";
const ADDON_MANIFEST = "addon.json";

// Built-in addon registry (shipped with the app)
const BUILTIN_ADDONS = [
  {
    id: "videasy",
    name: "Videasy",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from Videasy player",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidsrc",
    name: "VidSrc",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidSrc embed",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidking",
    name: "Vidking",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from Vidking",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidlink",
    name: "VidLink",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidLink (vidlink.pro)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidspark",
    name: "VidSpark",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidSpark (vidspark.to)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidfast",
    name: "VidFast",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidFast (vidfast.vc)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidcore",
    name: "VidCore",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidCore (vidcore.org)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidphantom",
    name: "VidPhantom",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidPhantom (vidphantom.com)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "cinextream",
    name: "CineXtream",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from CineXtream (cinextream.cc)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "vidsrc3",
    name: "VidSrc3",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream from VidSrc3 (vidsrc3.created.app)",
    author: "Streambert",
    builtIn: true,
  },
  {
    id: "allmanga",
    name: "AllManga",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream anime from AllManga.to",
    author: "Streambert",
    builtIn: true,
  },
];

let _addons = new Map(); // id → addon object
let _loaded = false;

// ── Addon Manifest Schema ────────────────────────────────────────────────────
// {
//   "id": "my-addon",
//   "name": "My Addon",
//   "version": "1.0.0",
//   "type": "stream-source" | "metadata" | "subtitles",
//   "description": "What this addon does",
//   "author": "Your Name",
//   "main": "index.js",          // optional: path to JS module
//   "config": { ... }            // optional: config schema
// }

export function getBuiltinAddons() {
  return BUILTIN_ADDONS;
}

export function getAddons() {
  return Array.from(_addons.values());
}

export function getAddon(id) {
  return _addons.get(id) || null;
}

export function isAddonLoaded(id) {
  return _addons.has(id);
}

// ── Load addons from directory (Electron) or registry (web) ─────────────────
export async function loadAddons() {
  _addons.clear();
  
  // Always load built-in addons
  for (const addon of BUILTIN_ADDONS) {
    _addons.set(addon.id, { ...addon, status: "active" });
  }
  
  // Load user addons (from addons/ directory in userData)
  if (window.electron?.getInstallPath) {
    try {
      const installPath = await window.electron.getInstallPath();
      // In a real implementation, this would read the addons directory
      // and dynamically load each addon's manifest
    } catch {}
  }
  
  _loaded = true;
  return getAddons();
}

// ── Addon Management ─────────────────────────────────────────────────────────
export function registerAddon(manifest) {
  if (!manifest.id || !manifest.name) {
    throw new Error("Addon must have id and name");
  }
  _addons.set(manifest.id, {
    ...manifest,
    status: "active",
    builtIn: false,
  });
}

export function unregisterAddon(id) {
  const addon = _addons.get(id);
  if (addon?.builtIn) return false; // Can't remove built-in addons
  _addons.delete(id);
  return true;
}

export function toggleAddon(id, enabled) {
  const addon = _addons.get(id);
  if (!addon) return null;
  addon.status = enabled ? "active" : "disabled";
  _addons.set(id, addon);
  return addon;
}

// ── Addon Gallery (for Settings UI) ──────────────────────────────────────────
export function getAddonGallery() {
  return getAddons().map((a) => ({
    id: a.id,
    name: a.name,
    version: a.version,
    type: a.type,
    description: a.description,
    author: a.author,
    builtIn: !!a.builtIn,
    status: a.status,
  }));
}

// ── Resolve stream URL via addon ─────────────────────────────────────────────
export async function resolveWithAddon(addonId, type, id, season, ep, params = {}) {
  const addon = _addons.get(addonId);
  if (!addon || addon.status !== "active") {
    throw new Error(`Addon ${addonId} not found or inactive`);
  }
  
  // Built-in addons use the existing PLAYER_SOURCES system
  // Custom addons would call their main module's resolve function
  const { getSourceUrl } = await import("./api");
  return getSourceUrl(addonId, type, id, season, ep, params);
}

// Initialize on module load
loadAddons();
