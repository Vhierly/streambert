// ── Custom Metadata Editor ────────────────────────────────────────────────────
// Allows users to override TMDB metadata locally: title, synopsis, poster, tags.
// Stored per-item in localStorage.

const CUSTOM_META_KEY = "streambert_customMetadata";

function loadAll() {
  try {
    const raw = localStorage.getItem(CUSTOM_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAll(data) {
  localStorage.setItem(CUSTOM_META_KEY, JSON.stringify(data));
}

// Get custom metadata for an item
export const getCustomMetadata = (mediaType, id) => {
  const all = loadAll();
  const key = `${mediaType}_${id}`;
  return all[key] || null;
};

// Save custom metadata for an item
export const setCustomMetadata = (mediaType, id, metadata) => {
  const all = loadAll();
  const key = `${mediaType}_${id}`;
  all[key] = {
    ...metadata,
    updatedAt: new Date().toISOString(),
  };
  saveAll(all);
};

// Delete custom metadata for an item
export const deleteCustomMetadata = (mediaType, id) => {
  const all = loadAll();
  const key = `${mediaType}_${id}`;
  delete all[key];
  saveAll(all);
};

// Get all custom metadata (for backup/restore)
export const getAllCustomMetadata = () => loadAll();

// Import custom metadata (from backup)
export const importCustomMetadata = (data) => {
  if (!data || typeof data !== "object") return;
  const all = loadAll();
  Object.assign(all, data);
  saveAll(all);
};

// Search within custom metadata
export const searchCustomMetadata = (query) => {
  const all = loadAll();
  const results = [];
  const q = query.toLowerCase();
  for (const [key, meta] of Object.entries(all)) {
    const title = (meta.title || meta.name || "").toLowerCase();
    const synopsis = (meta.overview || meta.synopsis || "").toLowerCase();
    if (title.includes(q) || synopsis.includes(q)) {
      results.push({ key, ...meta });
    }
  }
  return results;
};

// Get custom tags for an item
export const getCustomTags = (mediaType, id) => {
  const meta = getCustomMetadata(mediaType, id);
  return meta?.tags || [];
};

// Add a custom tag
export const addCustomTag = (mediaType, id, tag) => {
  const meta = getCustomMetadata(mediaType, id) || {};
  const tags = meta.tags || [];
  if (!tags.includes(tag)) {
    tags.push(tag);
  }
  setCustomMetadata(mediaType, id, { ...meta, tags });
};

// Remove a custom tag
export const removeCustomTag = (mediaType, id, tag) => {
  const meta = getCustomMetadata(mediaType, id) || {};
  const tags = (meta.tags || []).filter((t) => t !== tag);
  setCustomMetadata(mediaType, id, { ...meta, tags });
};

// Check if item has custom metadata
export const hasCustomMetadata = (mediaType, id) => {
  const all = loadAll();
  return !!all[`${mediaType}_${id}`];
};
