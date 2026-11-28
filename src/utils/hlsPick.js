// ── Master HLS Playlist Selector ─────────────────────────────────────────────
// Prevents video-only or audio-only child playlists from overwriting a
// previously captured master multi-variant playlist.

const NON_MAIN_TRACK_RE =
  /(?:^|[/_.-])(?:audio|aud|sound|sub|subs|subtitle|subtitles|caption|captions|vtt|cc)(?:[/_.-]|$)/i;
const VARIANT_PLAYLIST_RE =
  /(?:^|[/_.-])(?:chunklist|video|vid|2160p?|1440p?|1080p?|720p?|480p?|360p?|240p?|4k|hevc|avc|h264|media_\d+|level_\d+|index[_-]\d+|seg|frag|stream[_-]?\d+)(?:[/_.-]|$)/i;
const MASTER_PLAYLIST_RE =
  /(?:^|[/_.-])(?:master|playlist|manifest|multi|index)(?:[/_.-]|$)/i;

export function scoreM3u8Url(url) {
  if (typeof url !== "string" || !url) return -999;
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {}
  if (NON_MAIN_TRACK_RE.test(pathname)) return -100;
  if (VARIANT_PLAYLIST_RE.test(pathname)) return -50;
  if (MASTER_PLAYLIST_RE.test(pathname)) return 100;
  return 0;
}

export function pickPreferredM3u8(prev, incoming) {
  if (!incoming) return prev || null;
  if (!prev) return incoming;
  if (prev === incoming) return prev;
  const inScore = scoreM3u8Url(incoming);
  if (inScore <= -100) return prev;
  return inScore > scoreM3u8Url(prev) ? incoming : prev;
}
