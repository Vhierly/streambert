// ── IPC: HiAnime (hianime.at) anime source ────────────────────────────────────
//
// WHY THIS EXISTS
// Streambert previously resolved anime through AllAnime (api.allanime.day).
// As of 2026-09 that provider is broken for episode sources: the episode()
// GraphQL query returns `AA_CRYPTO_MISSING` (search still works, so the failure
// looks random to the user). AllAnime now requires a per-epoch AES-256-GCM
// `aaReq` token whose key is derived from a rotating server "epoch" — brittle
// to reimplement and it breaks again on every rotation. ani-cli itself dropped
// AllAnime in v5 for this reason.
//
// So this provider uses hianime.at, the same scrape ani-cli v5.1.4 uses:
//   1. GET /search?keyword=<q>            -> list of {slug, id, name}
//   2. GET /api/theme/episode/list/<id>   -> JSON {html} with per-ep ids
//   3. GET /api/theme/episode/servers?episodeId=<id>
//                                             -> per-server base64 embed hash
//   4. decode hash (base64) -> embed URL, GET it with the embed host as Referer
//   5. page contains window.__P = base64(json XOR "otaku-embed-v1")
//   6. XOR-decode -> JSON with the m3u8 master + subtitle tracks
// Verified end-to-end 2026-09-26: real MPEG-TS segments served without a proxy.
//
const { ipcMain } = require("electron");
const https = require("https");
const http = require("http");

const HIA_BASE = "https://hianime.at";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// ani-cli pins these ciphers; some Cloudflare edges reject the Node default set.
const CI =
  "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305";
const BLOB_KEY = "otaku-embed-v1";

// ── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(url, { headers = {}, timeout = 15000, method = "GET", retries = 2 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: 0, body: "", error: "invalid url: " + e.message });
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: { "User-Agent": UA, Accept: "*/*", ...headers },
        ciphers: u.protocol === "https:" ? CI : undefined,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ status: 0, body: "", error: e.code || e.message }),
    );
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HiAnime rate-limits bursts: a resolve fires ~12 episode-list requests in
// parallel, and an unlucky burst comes back empty (or 429/403), which looks
// exactly like "no such anime". Retry a couple of times with a short backoff
// before believing the empty result.
async function httpGetRetry(url, opts = {}) {
  let last;
  for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
    last = await httpGet(url, opts);
    if (last.status === 200 && last.body) return last;
    // 4xx other than 429 will not fix themselves
    if (last.status >= 400 && last.status < 500 && last.status !== 429) return last;
    if (attempt < (opts.retries ?? 2)) await sleep(400 * (attempt + 1));
  }
  return last;
}

// m3u8 playlists use bare relative URIs like "800/index.m3u8" — resolve against
// the playlist's own URL, never string-concatenate the host.
function resolveUri(uri, playlistUrl) {
  try {
    return new URL(uri, playlistUrl).href;
  } catch {
    return null;
  }
}

const decodeEntities = (s) =>
  s
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

// ── Blob deobfuscation ───────────────────────────────────────────────────────
// The embed page ships its player config as base64(json XOR "otaku-embed-v1"),
// where the key byte for position i is BLOB_KEY[i % BLOB_KEY.length].
function decodeBlob(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ BLOB_KEY.charCodeAt(i % BLOB_KEY.length);
  }
  return out.toString("utf8");
}

// ── Step 1: search ───────────────────────────────────────────────────────────

async function hiaSearch(query) {
  const r = await httpGetRetry(
    `${HIA_BASE}/search?keyword=${encodeURIComponent(query)}`,
    { headers: { Accept: "text/html,application/xhtml+xml" } },
  );
  if (r.status !== 200) return [];
  if (/Just a moment|challenge-platform/i.test(r.body)) return []; // CF interstitial

  // The sidebar repeats the result markup, so cut it before flattening.
  const cut = r.body.split('id="main-sidebar"')[0].replace(/\n/g, " ");
  const out = [];
  const re =
    /<h3 class="film-name">\s*<a href="[^"]*\/([^"/]*)"\s*title="([^"]*)"/g;
  let m;
  while ((m = re.exec(cut)) !== null) {
    const slug = m[1];
    out.push({
      slug,
      id: slug.split("-").pop(), // episode API wants the numeric id only
      name: decodeEntities(m[2]),
    });
  }
  return out;
}

// ── Step 2: episode list ─────────────────────────────────────────────────────

async function hiaEpisodes(animeId) {
  const r = await httpGetRetry(`${HIA_BASE}/api/theme/episode/list/${animeId}`);
  if (r.status !== 200) return [];
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return [];
  }
  const html = (j.html || "").replace(/\\\|/g, "|");
  const out = [];
  const re =
    /data-number="([^"]*)"[^>]*data-id="([0-9]+)"[^>]*href="[^"]*\/watch\/[^"?]*\?ep=\1"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ ep: m[1], id: m[2], number: parseInt(m[1], 10) });
  }
  if (!out.length) {
    // looser fallback, still in document order
    const re2 = /data-number="([^"]*)"[\s\S]{0,120}?data-id="([0-9]+)"/g;
    while ((m = re2.exec(html)) !== null) {
      out.push({ ep: m[1], id: m[2], number: parseInt(m[1], 10) });
    }
  }
  return out;
}

// ── Step 3: servers for an episode ───────────────────────────────────────────

async function hiaServers(epId) {
  const r = await httpGetRetry(
    `${HIA_BASE}/api/theme/episode/servers?episodeId=${epId}`,
  );
  if (r.status !== 200) return [];
  const sv = r.body.replace(/\\"/g, '"').replace(/server-item/g, "\nserver-item");
  const out = [];
  for (const chunk of sv.split("\nserver-item").slice(1)) {
    const type = (chunk.match(/data-type="([^"]*)"/) || [])[1];
    const name = (chunk.match(/data-server-name="([^"]*)"/) || [])[1];
    const hash = (chunk.match(/data-hash="([^"]*)"/) || [])[1];
    if (name && hash) out.push({ type: type || "sub", name, hash });
  }
  return out;
}

// ── Step 4-6: embed page -> m3u8 ────────────────────────────────────────────

async function hiaResolveEmbed(hashB64) {
  let embedUrl;
  try {
    embedUrl = Buffer.from(hashB64, "base64").toString("utf8");
  } catch {
    return { ok: false, error: "bad embed hash" };
  }
  // The stream host validates that Referer points at the embed site.
  const referer = embedUrl.replace(/^(https?:\/\/[^/]*).*$/, "$1/");

  // The embed site is a separate, slower host than hianime.at — give it a longer
  // timeout and retry, because one dropped request here means "no source".
  const r = await httpGetRetry(embedUrl, {
    headers: { Referer: referer },
    timeout: 20000,
  });
  if (r.status !== 200)
    return { ok: false, error: `embed HTTP ${r.status || "fail"}`, embedUrl, referer };

  const blob = (r.body.match(/window\.__P="([^"]*)"/) || [])[1];
  if (!blob) return { ok: false, error: "no __P blob on embed page", embedUrl, referer };

  let json;
  try {
    json = decodeBlob(blob);
  } catch (e) {
    return { ok: false, error: "blob decode: " + e.message, embedUrl, referer };
  }

  const m3u8 = (json.match(/"src":"([^"]*\.m3u8[^"]*)"/) || [])[1];
  if (!m3u8)
    return { ok: false, error: "no m3u8 in decoded config", embedUrl, referer, json: json.slice(0, 300) };

  const subtitles = [];
  const subBlock = (json.match(/"subtitles":\[([\s\S]*?)\}\]/) || [])[1];
  if (subBlock)
    for (const m of subBlock.matchAll(/"src":"([^"]*)"/g)) subtitles.push(m[1]);

  return { ok: true, m3u8, referer, embedUrl, subtitles };
}

// ── Master playlist -> quality variants ──────────────────────────────────────

async function hiaQualities(m3u8, referer) {
  const abs = resolveUri(m3u8, HIA_BASE + "/");
  const r = await httpGet(abs, { headers: { Referer: referer } });
  if (r.status !== 200) return [];
  const lines = r.body.split("\n").map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1];
    const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0, 10);
    const uri = lines[i + 1];
    if (!uri || uri.startsWith("#")) continue;
    out.push({ resolution: res || "?", bandwidth: bw, url: resolveUri(uri, abs) });
  }
  out.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

// ── Title matching ───────────────────────────────────────────────────────────

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Scores how well a result name matches the requested title. Ties are common
// because HiAnime returns many sibling entries ("Demon Slayer", "Demon Slayer:
// Kimetsu no Yaiba", "Demon Slayer: Mt. Natagumo Arc"), so the caller needs a
// second signal to break them.
function nameScore(candidateName, want) {
  const have = norm(candidateName);
  if (have === want) return 1000;
  if (have.startsWith(want) || want.startsWith(have)) return 500;
  const words = want.split(" ").filter((w) => w.length > 2);
  if (!words.length) return 0;
  const matched = words.filter((w) => have.includes(w)).length;
  return (matched / words.length) * 100;
}

function pickBest(candidates, title) {
  const want = norm(title);
  if (!want) return null;
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = nameScore(c.name, want);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore > 25 ? best : null;
}

// Test-only helpers: the resolver ranks inline so the episode-presence bonus
// can be applied, but exporting these lets the unit tests pin the ranking rules
// without hitting the network.

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve an anime episode to a playable stream.
 * @returns {Promise<{ok: boolean, url?: string, qualities?: Array, subtitles?: string[], referer?: string, error?: string, diagnostics?: object}>}
 */
async function resolveHianime({ title, seasonNumber = 1, episodeNumber = 1, translationType = "sub" } = {}) {
  const diags = { title, season: seasonNumber, episode: episodeNumber, translationType };
  if (!title) return { ok: false, error: "No title provided", diagnostics: diags };

  const mode = translationType === "dub" ? "dub" : "sub";

  // 1) search — try the season-suffixed title first, then the bare title
  const searchTerms = [];
  if (seasonNumber > 1) {
    searchTerms.push(`${title} season ${seasonNumber}`);
    searchTerms.push(`${title} ${ordinal(seasonNumber)} season`);
  }
  searchTerms.push(title);

  let candidates = [];
  let usedTerm = title;
  for (const term of searchTerms) {
    candidates = await hiaSearch(term);
    diags.searchResults = candidates.length;
    if (candidates.length) {
      usedTerm = term;
      break;
    }
  }
  if (!candidates.length)
    return { ok: false, error: `No HiAnime results for "${title}"`, diagnostics: diags };

  diags.usedSearchTerm = usedTerm;

  // Episode lists double as the disambiguation signal: HiAnime returns many
  // sibling entries per series, and a short arc ("Demon Slayer: Mt. Natagumo
  // Arc", 1 ep) can outrank the real show purely by search order. Fetch them
  // for the top candidates — in small batches, because a wide parallel burst
  // trips the site's rate limiter and comes back empty.
  const topN = candidates.slice(0, 12);
  const epLists = [];
  const BATCH = 4;
  for (let i = 0; i < topN.length; i += BATCH) {
    const slice = topN.slice(i, i + BATCH);
    const got = await Promise.all(slice.map((c) => hiaEpisodes(c.id)));
    epLists.push(...got);
    if (i + BATCH < topN.length) await sleep(250);
  }
  topN.forEach((c, i) => {
    c._episodes = epLists[i];
    c.episodeCount = epLists[i].length;
  });

  // Rank by: does it actually HAVE the requested episode (required — a 1-episode
  // arc can never serve episode 26), then title similarity, then episode count
  // so the full series wins over a similarly named sibling.
  const want = norm(title);
  const withEp = topN.filter((c) =>
    c._episodes.some((e) => e.number === episodeNumber),
  );
  const pool = withEp.length ? withEp : topN;
  diags.candidatesWithEpisode = withEp.length;
  diags.candidatesTotal = topN.length;

  let show = null;
  let bestScore = -1;
  for (const c of pool) {
    let score = nameScore(c.name, want);
    if (withEp.length) score += 1000; // having the episode dominates everything
    score += Math.min(c.episodeCount, 60) / 100; // long-run series win ties
    if (score > bestScore) {
      bestScore = score;
      show = c;
    }
  }
  if (!show) show = topN[0];
  diags.matchedShow = `${show.name} (${show.id})`;
  diags.matchedEpisodes = show.episodeCount;

  // 2) episode list (already fetched above)
  const eps = show._episodes || [];
  if (!eps.length)
    return { ok: false, error: `No episodes listed for ${show.name}`, diagnostics: diags };

  // Some shows are split across "seasons" (cour) in one flat list — an entry
  // whose data-number restarts at 1 for a later cour is handled by matching on
  // the number the API reports, which is what the watch URL uses.
  const wanted = eps.filter((e) => e.number === episodeNumber);
  const epEntry = wanted[0] || eps.find((e) => e.number === episodeNumber) || null;
  if (!epEntry) {
    const max = Math.max(...eps.map((e) => e.number || 0));
    return {
      ok: false,
      error: `Episode ${episodeNumber} not released (${max} available)`,
      diagnostics: diags,
    };
  }
  diags.episodeId = epEntry.id;

  // 3) servers, filtered to the requested audio type
  const servers = await hiaServers(epEntry.id);
  diags.servers = servers.map((s) => `${s.name}:${s.type}`);
  if (!servers.length)
    return { ok: false, error: "No servers returned for episode", diagnostics: diags };

  const forMode = servers.filter((s) => s.type === mode);
  const ordered = [
    // ZokoAnime is the only server using the XOR blob; put it first, then any
    // remaining server of the right type as fallback candidates.
    ...forMode.filter((s) => s.name === "ZokoAnime"),
    ...forMode.filter((s) => s.name !== "ZokoAnime"),
  ];

  const errors = [];
  // Zokoanime is an *embed* service: the page is a self-contained player, so if
  // the blob scrape fails we can still hand the renderer the embed URL and let a
  // webview load it — a real page sets its own Referer, so nothing 403s. This is
  // the same path the app already uses for Enma / 9Anime / AnimePahe.
  let embedFallback = null;
  for (const srv of ordered) {
    if (!embedFallback && srv.hash) {
      try {
        embedFallback = Buffer.from(srv.hash, "base64").toString("utf8");
      } catch {
        /* fall through — blob path may still work */
      }
    }
    const res = await hiaResolveEmbed(srv.hash);
    if (!res.ok) {
      errors.push(`${srv.name}: ${res.error}`);
      continue;
    }
    const qualities = await hiaQualities(res.m3u8, res.referer);
    if (!qualities.length) {
      // A single-variant stream can serve the master URL itself; only fail if
      // the master is also unreachable.
      errors.push(`${srv.name}: master playlist empty`);
      const probe = await httpGet(res.m3u8, { headers: { Referer: res.referer } });
      if (probe.status !== 200) continue;
      return {
        ok: true,
        url: res.m3u8,
        qualities: [{ resolution: "auto", bandwidth: 0, url: res.m3u8 }],
        subtitles: res.subtitles,
        referer: res.referer,
        server: srv.name,
        source: "hianime",
        diagnostics: diags,
      };
    }
    return {
      ok: true,
      url: qualities[0].url,
      qualities,
      subtitles: res.subtitles,
      referer: res.referer,
      embedUrl: res.embedUrl || embedFallback,
      server: srv.name,
      source: "hianime",
      diagnostics: diags,
    };
  }

  // Every server's blob scrape failed — but the embed pages themselves are
  // playable, so report success with the embed URL and let the renderer decide
  // (webview it, like Enma/9Anime). Downgrading to ok:true here beats showing
  // "no source" when a working source exists.
  if (embedFallback) {
    return {
      ok: true,
      url: embedFallback,
      isEmbedPage: true,
      referer: null,
      server: ordered[0]?.name || "ZokoAnime",
      source: "hianime",
      diagnostics: diags,
      warning: "Blob scrape failed (" + errors.join(" | ") + "); using embed page",
    };
  }

  return {
    ok: false,
    error: "No playable source: " + (errors.join(" | ") || "unknown"),
    diagnostics: diags,
  };
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Local HLS proxy ──────────────────────────────────────────────────────────
// The HLS hosts (hls2.aniwatchtv.uk and friends) sit behind Cloudflare and
// reject any request without the embed site's Referer:
//
//   WITH Referer    -> 200
//   WITHOUT Referer -> 403 Forbidden
//
// We cannot fix that from the renderer: "Referer" is a forbidden header name in
// Chromium, so hls.js's `xhr.setRequestHeader('Referer', …)` is silently dropped
// and the fetch goes out with the app's own referrer. (AllManga got away with the
// broken approach only because its CDN never checked the header.)
//
// So the playlist and every segment are streamed through a loopback HTTP server
// in the main process, which CAN set the header. Playlist bodies are rewritten so
// their URIs point back at this proxy; segments are passed through untouched.

let _proxyServer = null;
let _proxyReferer = "https://zokoanime.video/";
let _proxySubs = [];

// Track upstream -> local path so a playlist rewrite is stable within a session.
const _proxyPaths = new Map();
function proxyPathFor(upstreamUrl) {
  if (!_proxyPaths.has(upstreamUrl)) {
    _proxyPaths.set(upstreamUrl, "/proxy?url=" + encodeURIComponent(upstreamUrl));
  }
  return _proxyPaths.get(upstreamUrl);
}

function upstreamFetch(url, { method = "GET", headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ status: 0, headers: {}, body: Buffer.alloc(0) });
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: { "User-Agent": UA, Accept: "*/*", ...headers },
        ciphers: u.protocol === "https:" ? CI : undefined,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0) });
    });
    req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    req.end();
  });
}

const PASS_THROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
];

function getPlayerServer() {
  if (_proxyServer) return Promise.resolve(_proxyServer);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");

      if (u.pathname === "/player") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(buildPlayerHtml());
        return;
      }

      if (u.pathname === "/proxy") {
        const target = u.searchParams.get("url");
        if (!target) {
          res.writeHead(400);
          return res.end();
        }

        // Forward Range so seeking works, and the Referer the CDN demands.
        const up = await upstreamFetch(target, {
          headers: {
            Referer: _proxyReferer,
            Origin: _proxyReferer.replace(/\/$/, ""),
            Range: req.headers.range || "",
          },
        });

        if (!up.status) {
          res.writeHead(502, { "Access-Control-Allow-Origin": "*" });
          return res.end();
        }

        const ctype = up.headers["content-type"] || "";
        const isPlaylist =
          /mpegurl|vnd\.apple\.mpegurl/i.test(ctype) ||
          /\.m3u8(\?|$)/i.test(target);

        if (isPlaylist && up.status === 200) {
          // Rewrite every non-comment URI to point back through this proxy,
          // otherwise the player would fetch segments directly and get 403.
          const base = target;
          const rewritten = up.body
            .toString("utf8")
            .split("\n")
            .map((line) => {
              const t = line.trim();
              if (!t || t.startsWith("#")) return line;
              let abs;
              try {
                abs = new URL(t, base).href;
              } catch {
                return line;
              }
              return proxyPathFor(abs);
            })
            .join("\n");
          res.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          });
          return res.end(rewritten);
        }

        const out = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
        for (const h of PASS_THROUGH_HEADERS) if (up.headers[h]) out[h] = up.headers[h];
        res.writeHead(up.status, out);
        return res.end(up.body);
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      _proxyServer = server;
      resolve(server);
    });
    server.on("error", reject);
  });
}

// The player page only ever talks to our own loopback origin, so hls.js fetches
// the (already-rewritten, already-Referer'd) playlist over plain HTTP.
function buildPlayerHtml() {
  // Normalise whatever the resolver produced (bare URLs, or {src,lang,label}
  // objects) into track descriptors, and route each through the proxy so the
  // VTT request also carries the Referer the CDN demands.
  const tracks = (_proxySubs || []).map((s, i) => {
    const o = typeof s === "string" ? { src: s } : s;
    return {
      src: proxyPathFor(o.src),
      lang: o.lang || "ja",
      label: o.label || (i === 0 ? "Subtitle" : "Subtitle " + (i + 1)),
    };
  });
  const subs = JSON.stringify(tracks);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block}</style>
</head><body>
<video id="v" autoplay controls playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
  const video=document.getElementById('v');
  const src=new URLSearchParams(location.search).get('src')||'';
  const startTime=parseFloat(new URLSearchParams(location.search).get('t')||'0');

  // Attach subtitle tracks BEFORE any media is loaded. Flipping a text track's
  // mode after playback has started makes Chromium tear down and re-arm the
  // media pipeline, which shows up as a stalled video (readyState 0, paused).
  const subs=${subs};
  if(subs.length){
    subs.forEach((s,i)=>{
      const t=document.createElement('track');
      t.kind='subtitles';
      t.label=s.label||(i===0?'Subtitle':'Subtitle '+(i+1));
      t.srclang=s.lang||'ja';
      t.src=s.src;
      t.default=(i===0);
      video.appendChild(t);
    });
  }

  function start(){
    if(startTime>0)video.currentTime=startTime;
    video.play().catch(()=>{});
  }
  // Chromium leaves an appended <track> in mode "disabled" and never fetches it,
  // so no cues ever appear. Set the modes here, before loadSource.
  for(let i=0;i<video.textTracks.length;i++){
    try{video.textTracks[i].mode=(i===0?'showing':'hidden')}catch(e){}
  }

  if(Hls.isSupported()){
    const hls=new Hls({enableWorker:false});
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,start);
    hls.on(Hls.Events.ERROR,(e,d)=>{
      if(d.fatal)console.error('HLS fatal',d.type,d.details);
    });
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=src;
    video.addEventListener('loadedmetadata',start,{once:true});
  }
</script>
</body></html>`;
}

/**
 * Build a local player URL for a resolved HiAnime stream. The returned page
 * streams everything through the loopback proxy that supplies the Referer the
 * HLS CDN requires.
 */
async function buildHianimePlayerUrl({ url, referer, subtitles, startTime = 0 }) {
  _proxyReferer = referer || "https://zokoanime.video/";
  _proxySubs = Array.isArray(subtitles) ? subtitles : [];
  // Keep the rewrite map bounded — a long session would otherwise grow forever.
  if (_proxyPaths.size > 500) _proxyPaths.clear();
  const server = await getPlayerServer();
  const port = server.address().port;
  const proxied = proxyPathFor(url);
  return `http://127.0.0.1:${port}/player?src=${encodeURIComponent(proxied)}&t=${startTime || 0}`;
}

// ── IPC registration ─────────────────────────────────────────────────────────

function register() {
  ipcMain.handle("resolve-hianime", async (_, args) => {
    try {
      return await resolveHianime(args || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("search-hianime", async (_, { query } = {}) => {
    try {
      return { ok: true, results: await hiaSearch(query) };
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  });

  ipcMain.handle("hianime-episodes", async (_, { animeId } = {}) => {
    try {
      return { ok: true, episodes: await hiaEpisodes(animeId) };
    } catch (e) {
      return { ok: false, error: e.message, episodes: [] };
    }
  });

  // Hand the renderer a loopback player URL whose fetches carry the Referer the
  // HLS CDN requires. Without this the player gets 403 on the master playlist.
  ipcMain.handle("hianime-player-url", async (_, args) => {
    try {
      const { url, referer, subtitles, startTime } = args || {};
      if (!url) return { ok: false, error: "No url provided" };
      const playerUrl = await buildHianimePlayerUrl({
        url,
        referer,
        subtitles,
        startTime,
      });
      return { ok: true, playerUrl, rawUrl: url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  resolveHianime,
  hiaSearch,
  hiaEpisodes,
  hiaServers,
  hiaResolveEmbed,
  hiaQualities,
  decodeBlob,
  nameScore,
  norm,
  pickBest,
  buildHianimePlayerUrl,
  upstreamFetch,
};
