// ── IPC: Miruro (api.hiyori.tv) anime source fallback ───────────────────────
// Miruro aggregates AnimePahe/KickAssAnime/etc. and returns direct HLS URLs.
// Used as a fallback when HiAnime has no match.

const { ipcMain } = require("electron");

const MIRURO_API = "https://api.hiyori.tv";
const ANILIST_API = "https://graphql.anilist.co";

async function anilistSearch(title) {
  const q = `query($s:String){Media(search:$s,type:ANIME){id}}`;
  const r = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: { s: title } }),
  });
  const j = await r.json();
  return j?.data?.Media?.id || null;
}

async function resolveMiruro({ title, seasonNumber = 1, episodeNumber = 1, isMovie = false, translationType = "sub" } = {}) {
  if (!title) return { ok: false, error: "No title" };
  let anilistId;
  try {
    anilistId = await anilistSearch(title);
  } catch (e) {
    return { ok: false, error: "AniList search failed: " + e.message };
  }
  if (!anilistId) return { ok: false, error: `No AniList match for "${title}"` };

  let epData;
  try {
    const r = await fetch(`${MIRURO_API}/episodes/${anilistId}`);
    epData = await r.json();
  } catch (e) {
    return { ok: false, error: "Miruro episodes failed: " + e.message };
  }

  const cat = translationType === "dub" ? "dub" : "sub";
  const providers = epData?.providers || {};
  const targetEp = isMovie ? 1 : Number(episodeNumber) || 1;

  // Find a provider that has the target episode.
  let chosen = null;
  for (const prov of Object.keys(providers)) {
    const eps = providers[prov]?.episodes?.[cat] || [];
    const ep = eps.find((e) => Number(e.number) === targetEp);
    if (ep) { chosen = { prov, ep }; break; }
  }
  if (!chosen) return { ok: false, error: `No Miruro episode ${targetEp}` };

  let watch;
  try {
    const r = await fetch(`${MIRURO_API}/${chosen.ep.id}`);
    watch = await r.json();
  } catch (e) {
    return { ok: false, error: "Miruro watch failed: " + e.message };
  }

  const streams = Array.isArray(watch?.streams) ? watch.streams : [];
  const hls = streams.find((s) => s.type === "hls" && s.url) || streams.find((s) => s.url);
  if (!hls) return { ok: false, error: "No Miruro stream" };

  return {
    ok: true,
    url: hls.url,
    masterUrl: hls.url,
    qualities: null,
    referer: hls.referer || "https://megaplay.buzz/",
    subtitles: [],
    isEmbedPage: false,
    warning: null,
    source: "miruro",
  };
}

function register() {
  ipcMain.handle("resolve-miruro", async (_, args) => {
    try {
      return await resolveMiruro(args || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register, resolveMiruro };
