// ── Pure-Node HLS downloader ─────────────────────────────────────────────────
//
// Replaces the external `vid-dl-cli-only` binary (and the ffmpeg it needed).
// Fetches the playlist, pulls segments with bounded concurrency, and writes
// them in playlist order.
//
// No remux: there is no ffmpeg. Concatenated MPEG-TS segments are a valid .ts
// file, and fMP4 fragments (EXT-X-MAP) concatenate into a playable .mp4 — which
// is why the extension comes from the playlist instead of being hardcoded.
//
// Every failure is thrown as a DownloadError carrying a `kind` and a message
// that names what went wrong, so the download row shows "Network error: …"
// rather than the old `spawn UNKNOWN` / `spawn EFTYPE`.

const fs = require("fs");
const https = require("https");
const http = require("http");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
const CONCURRENCY = 6;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;

class DownloadError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "DownloadError";
    this.kind = kind;
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function get(url, headers, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new DownloadError("network", `Invalid URL: ${url}`));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(
        new DownloadError("network", `Unsupported protocol: ${u.protocol}`),
      );
    }
    if (signal?.aborted) {
      return reject(new DownloadError("cancelled", "Download cancelled"));
    }

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": UA, Accept: "*/*", ...headers } },
      resolve,
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error("request timed out")),
    );
    req.on("error", (e) =>
      reject(
        new DownloadError(
          signal?.aborted ? "cancelled" : "network",
          signal?.aborted
            ? "Download cancelled"
            : `Network error: ${url} (${e.code || e.message})`,
        ),
      ),
    );

    if (signal) {
      const onAbort = () => req.destroy();
      signal.addEventListener("abort", onAbort);
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

/** Follows redirects and hands back the still-unread response. */
async function open(url, { headers = {}, signal, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await get(current, headers, signal);
    const code = res.statusCode;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume();
      try {
        current = new URL(res.headers.location, current).href;
      } catch {
        throw new DownloadError("network", `Bad redirect from ${current}`);
      }
      continue;
    }
    return { res, url: current };
  }
  throw new DownloadError("network", `Too many redirects: ${url}`);
}

async function readAll(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function fetchBuffer(url, headers, signal, range) {
  const reqHeaders = range
    ? { ...headers, Range: `bytes=${range.start}-${range.end}` }
    : headers;
  const { res } = await open(url, { headers: reqHeaders, signal });
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    throw new DownloadError("network", `HTTP ${res.statusCode} from ${url}`);
  }
  const body = await readAll(res);
  // A 200 for a ranged request means the origin ignored Range and sent the
  // whole resource — slice locally so the output stays correct.
  if (range && res.statusCode === 200) {
    return body.subarray(range.start, range.end + 1);
  }
  return body;
}

// ── Output writer ────────────────────────────────────────────────────────────
// Serialises writes through a promise chain and reports a failing disk as a
// write error rather than letting it surface as an unhandled stream event.

function createWriter(destPath) {
  let failure = null;
  const out = fs.createWriteStream(destPath);
  out.on("error", (e) => {
    failure = new DownloadError(
      "write",
      `Write error: ${destPath} (${e.message})`,
    );
  });

  return {
    write: (buf) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        if (out.destroyed) {
          return reject(new DownloadError("write", `Write aborted: ${destPath}`));
        }
        if (out.write(buf)) return resolve();
        out.once("drain", () => (failure ? reject(failure) : resolve()));
      }),
    close: () =>
      new Promise((resolve, reject) =>
        out.end(() => (failure ? reject(failure) : resolve())),
      ),
    abort: () =>
      new Promise((resolve) => {
        try {
          out.destroy();
        } catch {}
        resolve();
      }),
  };
}

// ── Playlist parsing ─────────────────────────────────────────────────────────

function parsePlaylist(text, baseUrl) {
  if (!text.includes("#EXTM3U")) {
    throw new DownloadError("parse", `Invalid playlist: missing #EXTM3U in ${baseUrl}`);
  }

  const variants = [];
  const segments = [];
  let pendingVariant = null;
  let pendingInf = null;
  let initSegment = null;
  let encryption = null;
  let durationSecs = 0;
  // EXT-X-BYTERANGE: the offset defaults to the end of the previous range, so
  // both parts have to be carried across lines.
  let pendingRange = null;
  let rangeCursor = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bw = line.match(/BANDWIDTH=(\d+)/);
      pendingVariant = { bandwidth: bw ? parseInt(bw[1], 10) : 0 };
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      pendingInf = parseFloat(line.slice(line.indexOf(":") + 1).split(",")[0]);
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      pendingRange = parseByteRange(line.slice(line.indexOf(":") + 1), rangeCursor);
      if (pendingRange) rangeCursor = pendingRange.end + 1;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) {
        try {
          initSegment = {
            url: new URL(m[1], baseUrl).href,
            range: parseByteRange(
              (line.match(/BYTERANGE="([^"]+)"/) || [])[1],
              0,
            ),
          };
        } catch {}
      }
      continue;
    }
    if (line.startsWith("#EXT-X-KEY")) {
      const method = (line.match(/METHOD=([^,]+)/) || [])[1];
      if (method && method.trim() !== "NONE") encryption = method.trim();
      continue;
    }
    if (line.startsWith("#")) continue;

    let abs;
    try {
      abs = new URL(line, baseUrl).href;
    } catch {
      continue;
    }
    if (pendingVariant) {
      variants.push({ ...pendingVariant, url: abs });
      pendingVariant = null;
      continue;
    }
    segments.push({ url: abs, range: pendingRange });
    pendingRange = null;
    if (Number.isFinite(pendingInf)) durationSecs += pendingInf;
    pendingInf = null;
  }

  return { variants, segments, initSegment, encryption, durationSecs };
}

/** `EXT-X-BYTERANGE` value → { start, end }, or null when absent/unparseable. */
function parseByteRange(value, cursor) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d+)(?:@(\d+))?$/);
  if (!m) return null;
  const len = parseInt(m[1], 10);
  const start = m[2] !== undefined ? parseInt(m[2], 10) : cursor;
  return { start, end: start + len - 1 };
}

/** A master playlist carries variants, not segments — descend into the best one. */
async function resolveMediaPlaylist(text, baseUrl, headers, signal, depth = 0) {
  const parsed = parsePlaylist(text, baseUrl);
  if (parsed.encryption || parsed.segments.length) return parsed;
  if (!parsed.variants.length || depth >= 3) return parsed;

  const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const { res, url } = await open(best.url, { headers, signal });
  if (res.statusCode !== 200) {
    res.resume();
    throw new DownloadError("network", `HTTP ${res.statusCode} from ${url}`);
  }
  return resolveMediaPlaylist(
    (await readAll(res)).toString("utf8"),
    url,
    headers,
    signal,
    depth + 1,
  );
}

function extFor(url, segments) {
  if (!segments?.length) {
    const m = String(url).match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i);
    return m ? `.${m[1].toLowerCase()}` : ".mp4";
  }
  const last = segments[segments.length - 1].url;
  return /\.(m4s|mp4|m4a|m4v)(\?|$)/i.test(last) ? ".mp4" : ".ts";
}

// ── Segment fetching ─────────────────────────────────────────────────────────

async function fetchSegments(media, destPath, headers, onProgress, signal) {
  const { segments, initSegment, durationSecs } = media;
  const writer = createWriter(destPath);
  const pending = new Map();
  const total = segments.length;
  let next = 0;
  let writeIdx = 0;
  let completed = 0;
  let bytes = 0;
  let chain = Promise.resolve();

  // Writes go through one chain so out-of-order segment completions still land
  // in playlist order.
  const flush = () => {
    while (pending.has(writeIdx)) {
      const buf = pending.get(writeIdx);
      pending.delete(writeIdx);
      writeIdx++;
      bytes += buf.length;
      chain = chain.then(() => writer.write(buf));
    }
  };

  try {
    if (initSegment) {
      const init = await fetchBuffer(
        initSegment.url,
        headers,
        signal,
        initSegment.range,
      );
      await writer.write(init);
      bytes += init.length;
    }

    const worker = async () => {
      while (next < total) {
        const i = next++;
        const seg = segments[i];
        const buf = await fetchBuffer(seg.url, headers, signal, seg.range);
        pending.set(i, buf);
        completed++;
        flush();
        onProgress({ completed, total, bytes, durationSecs });
        // Keep at most ~2x concurrency buffered when the disk is the bottleneck.
        if (pending.size >= CONCURRENCY * 2) await chain;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, worker),
    );
    flush();
    await chain;
    await writer.close();
  } catch (e) {
    await chain.catch(() => {});
    await writer.abort();
    throw e;
  }

  return bytes;
}

async function streamToFile(res, destPath, onProgress, totalBytes) {
  const writer = createWriter(destPath);
  let bytes = 0;
  try {
    for await (const chunk of res) {
      await writer.write(chunk);
      bytes += chunk.length;
      onProgress({
        completed: 0,
        total: 0,
        bytes,
        totalBytes,
        durationSecs: null,
        percent: totalBytes ? Math.round((bytes / totalBytes) * 100) : null,
      });
    }
    await writer.close();
  } catch (e) {
    await writer.abort();
    throw e;
  }
  return bytes;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Download `url` to `destPath` (caller owns naming/renaming).
 *
 * @param {string} url        m3u8 playlist, or a direct media file URL
 * @param {string} destPath   file to write (a .part temp path)
 * @param {Function} onProgress  ({ completed, total, bytes, totalBytes, durationSecs })
 * @param {object} opts       { referer, signal }
 * @returns {Promise<{filePath, ext, bytes, segments, durationSecs}>}
 */
async function download(url, destPath, onProgress = () => {}, opts = {}) {
  const { referer, signal } = opts;
  const headers = referer ? { Referer: referer } : {};

  const { res, url: finalUrl } = await open(url, { headers, signal });
  if (res.statusCode !== 200) {
    res.resume();
    throw new DownloadError("network", `HTTP ${res.statusCode} from ${finalUrl}`);
  }

  const type = String(res.headers["content-type"] || "");
  const looksPlaylist =
    /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(finalUrl);

  // Direct media file — AllManga and friends hand out plain .mp4.
  if (!looksPlaylist) {
    const totalBytes = parseInt(res.headers["content-length"] || "0", 10) || 0;
    const bytes = await streamToFile(res, destPath, onProgress, totalBytes);
    return {
      filePath: destPath,
      ext: extFor(finalUrl, null),
      bytes,
      segments: 0,
      durationSecs: null,
    };
  }

  const text = (await readAll(res)).toString("utf8");
  if (!text.includes("#EXTM3U")) {
    throw new DownloadError(
      "parse",
      `Invalid playlist: ${finalUrl} did not return an m3u8`,
    );
  }

  const media = await resolveMediaPlaylist(text, finalUrl, headers, signal);
  if (media.encryption) {
    // shortcut: AES-128/SAMPLE-AES key handling is not implemented — upgrade
    // if a source users care about starts serving encrypted HLS.
    throw new DownloadError(
      "unsupported",
      `Encrypted HLS (${media.encryption}) is not supported`,
    );
  }
  if (!media.segments.length) {
    throw new DownloadError("parse", `Invalid playlist: no segments in ${finalUrl}`);
  }

  const bytes = await fetchSegments(media, destPath, headers, onProgress, signal);
  return {
    filePath: destPath,
    ext: extFor(finalUrl, media.segments),
    bytes,
    segments: media.segments.length,
    durationSecs: media.durationSecs > 0 ? media.durationSecs : null,
  };
}

module.exports = { download, parsePlaylist, DownloadError };
