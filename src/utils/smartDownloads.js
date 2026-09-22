// ── Smart Downloads: Auto-download + Queue Management ─────────────────────────
// Handles auto-download rules, bandwidth scheduling, and queue priority.

const SMART_DL_KEY = "streambert_smartDownloads";
const DL_QUEUE_KEY = "streambert_downloadQueue";

// ── Settings ───────────────────────────────────────────────────────────────────
export function getSmartDownloadSettings() {
  try {
    const raw = localStorage.getItem(SMART_DL_KEY);
    return raw ? JSON.parse(raw) : {
      enabled: false,
      autoDownloadNewEpisodes: true,
      preferredQuality: "1080p", // 720p, 1080p, 4K
      scheduleEnabled: false,
      scheduleStartHour: 2, // 2 AM
      scheduleEndHour: 6, // 6 AM
      maxConcurrent: 2,
      maxBandwidth: 0, // 0 = unlimited (MB/s)
      autoConvert: false,
      convertFormat: "h265", // h265, h264, aac
      convertPreset: "medium", // fast, medium, slow
    };
  } catch {
    return getSmartDownloadSettings(); // safe fallback
  }
}

export function saveSmartDownloadSettings(settings) {
  localStorage.setItem(SMART_DL_KEY, JSON.stringify(settings));
}

// ── Download Queue ────────────────────────────────────────────────────────────
export function getDownloadQueue() {
  try {
    const raw = localStorage.getItem(DL_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDownloadQueue(queue) {
  localStorage.setItem(DL_QUEUE_KEY, JSON.stringify(queue));
}

export function addToQueue(item, priority = 0) {
  const queue = getDownloadQueue();
  if (queue.find((q) => q.id === item.id)) return queue; // dedupe
  const entry = {
    ...item,
    id: `${item.media_type}_${item.id}_${item.season || 0}_${item.episode || 0}`,
    priority, // 0 = normal, 1 = high, 2 = urgent
    addedAt: new Date().toISOString(),
    status: "queued", // queued, downloading, paused, complete, error
    progress: 0,
  };
  queue.push(entry);
  // Sort by priority desc, then addedAt asc
  queue.sort((a, b) => b.priority - a.priority || new Date(a.addedAt) - new Date(b.addedAt));
  saveDownloadQueue(queue);
  return queue;
}

export function removeFromQueue(id) {
  const queue = getDownloadQueue().filter((q) => q.id !== id);
  saveDownloadQueue(queue);
}

export function updateQueueItem(id, updates) {
  const queue = getDownloadQueue();
  const idx = queue.findIndex((q) => q.id === id);
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], ...updates };
    saveDownloadQueue(queue);
  }
  return queue;
}

// ── Schedule Check ────────────────────────────────────────────────────────────
export function isWithinSchedule(settings) {
  if (!settings.scheduleEnabled) return true;
  const now = new Date();
  const hour = now.getHours();
  const { scheduleStartHour, scheduleEndHour } = settings;
  if (scheduleStartHour <= scheduleEndHour) {
    return hour >= scheduleStartHour && hour < scheduleEndHour;
  }
  // Wraps around midnight (e.g., 22:00 - 06:00)
  return hour >= scheduleStartHour || hour < scheduleEndHour;
}

// ── Auto-download Check ───────────────────────────────────────────────────────
export function shouldAutoDownload(animeEntry, settings, followList) {
  if (!settings.enabled || !settings.autoDownloadNewEpisodes) return false;
  if (!animeEntry || animeEntry.media_type !== "tv") return false;
  // Only auto-download if following this show
  const isFollowing = followList?.some((f) => f.id === animeEntry.id);
  if (!isFollowing) return false;
  // Only if new episode is out (Airing status)
  return animeEntry.status === "Airing";
}

// ── Quality Matching ──────────────────────────────────────────────────────────
export function matchesQuality(streamUrl, preferredQuality) {
  if (!streamUrl) return false;
  const qMap = {
    "720p": ["720", "480", "360", "SD"],
    "1080p": ["1080", "720", "HD", "FHD"],
    "4K": ["2160", "4k", "UHD", "4K"],
  };
  const preferred = qMap[preferredQuality] || qMap["1080p"];
  const lower = streamUrl.toLowerCase();
  return preferred.some((tag) => lower.includes(tag.toLowerCase()));
}

// ── Bandwidth Throttle ────────────────────────────────────────────────────────
export function getCurrentBandwidthUsage(queue) {
  const active = queue.filter((q) => q.status === "downloading");
  return active.reduce((sum, q) => sum + (q.speed || 0), 0); // MB/s
}

export function canStartDownload(queue, settings) {
  const active = queue.filter((q) => q.status === "downloading");
  if (active.length >= settings.maxConcurrent) return false;
  if (settings.maxBandwidth > 0) {
    const current = getCurrentBandwidthUsage(queue);
    if (current >= settings.maxBandwidth) return false;
  }
  return true;
}
