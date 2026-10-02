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
    id: "hianime",
    name: "HiAnime",
    version: "1.0.0",
    type: "stream-source",
    description: "Stream anime from HiAnime (hianime.at)",
    author: "Streambert",
    builtIn: true,
  },
];

let _addons = new Map(); // id → addon object
let _loaded = false;

// ── Persistence: installed community addons ──────────────────────────────────
// Saved in localStorage so getAllSources() in api.js can read synchronously
const INSTALLED_ADDONS_KEY = "streambert_installedAddons";

function loadInstalledAddons() {
  try {
    const raw = localStorage.getItem(INSTALLED_ADDONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveInstalledAddons(addons) {
  try {
    localStorage.setItem(INSTALLED_ADDONS_KEY, JSON.stringify(addons));
  } catch {}
}

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

  // Load previously installed community addons from localStorage
  const installed = loadInstalledAddons();
  for (const addon of installed) {
    _addons.set(addon.id, { ...addon, status: "active", builtIn: false });
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
/**
 * Tell open pages the source list changed.
 *
 * The pages snapshot getAllSources() into state on mount, so an addon installed
 * from Settings was not pickable until the app was restarted. Same event
 * convention as the rest of the app (see playbackBridge / TVPage settings).
 */
function announceRegistryChange() {
  try {
    // getAddonSources(), not getAllSources(): that one lives in api.js, which
    // imports this module — reaching for it here threw a ReferenceError that the
    // catch below swallowed, so the event was never dispatched and the pages
    // never heard about a change. An empty catch hid the entire feature.
    window.dispatchEvent(
      new CustomEvent("streambert:addons-changed", {
        detail: getAddonSources(),
      }),
    );
  } catch {
    // Only a genuinely absent window (tests, a non-renderer context) is fine to
    // ignore here.
  }
}

export function registerAddon(manifest) {
  if (!manifest.id || !manifest.name) {
    throw new Error("Addon must have id and name");
  }
  const addon = {
    ...manifest,
    status: "active",
    builtIn: false,
  };
  _addons.set(manifest.id, addon);

  // Persist to localStorage so getAllSources() can read it
  const installed = loadInstalledAddons().filter((a) => a.id !== manifest.id);
  installed.push(addon);
  saveInstalledAddons(installed);
  announceRegistryChange();
}

export function unregisterAddon(id) {
  const addon = _addons.get(id);
  if (addon?.builtIn) return false; // Can't remove built-in addons
  _addons.delete(id);

  // Remove from localStorage
  const installed = loadInstalledAddons().filter((a) => a.id !== id);
  saveInstalledAddons(installed);
  announceRegistryChange();
  return true;
}

export function toggleAddon(id, enabled) {
  const addon = _addons.get(id);
  if (!addon) return null;
  addon.status = enabled ? "active" : "disabled";
  _addons.set(id, addon);

  // Update localStorage
  const installed = loadInstalledAddons().filter((a) => a.id !== id);
  if (enabled) installed.push(addon);
  saveInstalledAddons(installed);
  // A disabled addon must leave the source menu too, not just stop working.
  announceRegistryChange();
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
/**
 * Look up an installed addon by the id the player uses as a source id.
 *
 * api.js imports this rather than the whole registry, and calls it with no
 * arguments from getSourceUrl. That matters: resolveWithAddon used to delegate
 * back into api.getSourceUrl, which looked the id up in PLAYER_SOURCES, failed
 * to find it (addons are not in that list), and fell through to
 * `?? PLAYER_SOURCES[0]`. So installing an addon and pressing play silently
 * substituted a different source — the addon looked installed and worked, while
 * playing something else entirely.
 *
 * Returns null rather than throwing for an unknown or disabled id: a missing
 * source is an ordinary condition here, not an error worth crashing a click on.
 */
export function getAddonSource(sourceId) {
  if (!sourceId) return null;
  const addon = _addons.get(sourceId);
  if (!addon) return null;
  if (addon.status !== "active") return null;
  // A manifest with no URL builders cannot resolve anything; treat it as absent
  // so the caller falls back to a real source.
  const { movieUrl, tvUrl } = addon.manifest || {};
  if (typeof movieUrl !== "function" && typeof tvUrl !== "function") return null;
  return addon;
}

/**
 * Every active addon that declares a URL builder, shaped exactly like a
 * PLAYER_SOURCES entry.
 *
 * This is what makes an installed addon selectable: the source menu renders
 * whatever list it is given, and before this existed the only list was the
 * hardcoded PLAYER_SOURCES, so an addon could be installed, listed in Settings
 * and still be unreachable as a playback choice.
 */
export function getAddonSources() {
  return [..._addons.values()]
    .filter((a) => getAddonSource(a.id))
    .map((a) => ({
      id: a.id,
      // `label`, not `name`: the source menu renders entry.label, and PLAYER_SOURCES
      // entries carry that field. Emitting `name` here produced a menu full of
      // "undefined" rows.
      label: a.name,
      name: a.name,
      fromAddon: true,
      movieUrl: a.manifest.movieUrl,
      tvUrl: a.manifest.tvUrl,
      params: a.manifest.params || {},
      colorParam: a.manifest.colorParam ?? null,
      langParam: a.manifest.langParam ?? null,
      supportsProgress: a.manifest.supportsProgress ?? false,
      searchUrl: a.manifest.searchUrl ?? null,
    }));
}

/**
 * Resolve a stream URL through an addon.
 *
 * Thin on purpose: api.getSourceUrl already understands addon ids (see
 * getAddonSource), so this only validates and forwards. Delegating from here
 * into that function is what produced the silent fallback described above.
 */
export async function resolveWithAddon(addonId, type, id, season, ep, params = {}) {
  const addon = getAddonSource(addonId);
  if (!addon) {
    throw new Error(`Addon ${addonId} not found or inactive`);
  }
  // Checked here rather than after the call: api.getSourceUrl deliberately falls
  // back to a working source when an addon cannot serve the requested type, so
  // this explicit API has to be the one that refuses — handing back a different
  // source to a caller that named this addon is the silent-substitution bug all
  // over again, one layer up.
  const builder =
    type === "movie" ? addon.manifest.movieUrl : addon.manifest.tvUrl;
  if (typeof builder !== "function") {
    throw new Error(`Addon ${addonId} does not provide ${type} playback`);
  }
  const { getSourceUrl } = await import("./api");
  return getSourceUrl(addonId, type, id, season, ep, params);
}

// Initialize on module load
loadAddons();
