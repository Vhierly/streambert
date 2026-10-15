// ── hls-downloader: parsePlaylist + download against a local HTTP server ────
import { strict as assert } from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { download, parsePlaylist, DownloadError } from "../src/ipc/hlsDownloader.js";

// ── parsePlaylist ────────────────────────────────────────────────────────────

// Media playlist with two segments
const mediaM3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
seg1.ts
#EXTINF:9.0,
seg2.ts
#EXT-X-ENDLIST
`;
const parsed = parsePlaylist(mediaM3u8, "http://example.com/playlist.m3u8");
assert.equal(parsed.segments.length, 2);
assert.equal(parsed.segments[0].url, "http://example.com/seg1.ts");
assert.equal(parsed.segments[1].url, "http://example.com/seg2.ts");
assert.ok(Math.abs(parsed.durationSecs - 18) < 0.01);

// Master playlist with variants
const masterM3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000
high.m3u8
`;
const master = parsePlaylist(masterM3u8, "http://example.com/master.m3u8");
assert.equal(master.variants.length, 2);
assert.equal(master.variants[0].bandwidth, 800000);
assert.equal(master.variants[1].bandwidth, 2000000);

// fMP4 with EXT-X-MAP
const fmp4M3u8 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
frag1.m4s
#EXT-X-ENDLIST
`;
const fmp4 = parsePlaylist(fmp4M3u8, "http://example.com/v.mp4.m3u8");
assert.equal(fmp4.initSegment.url, "http://example.com/init.mp4");
assert.equal(fmp4.segments.length, 1);
assert.equal(fmp4.segments[0].url, "http://example.com/frag1.m4s");

// ── download (direct file) ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-test-"));
const directFile = path.join(tmpDir, "test.mp4");
fs.writeFileSync(directFile, Buffer.alloc(1024, 0x61));

const server = http.createServer((req, res) => {
  if (req.url === "/video.mp4") {
    const data = fs.readFileSync(directFile);
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length });
    res.end(data);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

try {
  const destPath = path.join(tmpDir, "output.mp4");
  const result = await download(`http://127.0.0.1:${port}/video.mp4`, destPath, () => {}, {});
  assert.equal(result.ext, ".mp4");
  assert.equal(result.bytes, 1024);
  assert.ok(fs.statSync(destPath).size === 1024);
} finally {
  server.close();
}

// ── download (HLS media playlist) ────────────────────────────────────────────
const seg1Data = Buffer.alloc(2048, 0x62);
const seg2Data = Buffer.alloc(1024, 0x63);
const mediaFile = path.join(tmpDir, "media.m3u8");
fs.writeFileSync(mediaFile, mediaM3u8);
const seg1File = path.join(tmpDir, "seg1.ts");
fs.writeFileSync(seg1File, seg1Data);
const seg2File = path.join(tmpDir, "seg2.ts");
fs.writeFileSync(seg2File, seg2Data);

const hlsServer = http.createServer((req, res) => {
  if (req.url === "/playlist.m3u8") {
    const data = fs.readFileSync(mediaFile);
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end(data);
  } else if (req.url === "/seg1.ts") {
    res.writeHead(200, { "Content-Type": "video/MP2T" });
    res.end(seg1Data);
  } else if (req.url === "/seg2.ts") {
    res.writeHead(200, { "Content-Type": "video/MP2T" });
    res.end(seg2Data);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => hlsServer.listen(0, r));
const hlsPort = hlsServer.address().port;

// Rewrite URLs to point at our local server
const localM3u8 = mediaM3u8
  .replace(/seg1\.ts/g, `http://127.0.0.1:${hlsPort}/seg1.ts`)
  .replace(/seg2\.ts/g, `http://127.0.0.1:${hlsPort}/seg2.ts`);
fs.writeFileSync(mediaFile, localM3u8);

try {
  const destPath = path.join(tmpDir, "output.ts");
  let lastProgress = null;
  const result = await download(
    `http://127.0.0.1:${hlsPort}/playlist.m3u8`,
    destPath,
    (p) => { lastProgress = p; },
    {},
  );
  assert.equal(result.ext, ".ts");
  assert.ok(result.bytes >= 3072); // seg1 + seg2
  assert.ok(fs.statSync(destPath).size >= 3072);
  assert.ok(lastProgress && lastProgress.completed === 2);
} finally {
  hlsServer.close();
}

// ── error paths ──────────────────────────────────────────────────────────────

// Network error (connection refused)
const err1 = await download("http://127.0.0.1:1/test.m3u8", path.join(tmpDir, "x"), () => {}, {}).catch((e) => e);
assert.ok(err1 instanceof DownloadError);
assert.equal(err1.kind, "network");

// Parse error (URL looks like a playlist but returns non-m3u8 content)
const notPl = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
  res.end("<html>not a playlist</html>");
});
await new Promise((r) => notPl.listen(0, r));
const notPlPort = notPl.address().port;
try {
  const err2 = await download(`http://127.0.0.1:${notPlPort}/fake.m3u8`, path.join(tmpDir, "x"), () => {}, {}).catch((e) => e);
  assert.ok(err2 instanceof DownloadError);
  assert.equal(err2.kind, "parse");
} finally {
  notPl.close();
}

// Unsupported encrypted HLS
const encM3u8 = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"
#EXTINF:10.0,
seg.ts
#EXT-X-ENDLIST
`;
const encParsed = parsePlaylist(encM3u8, "http://example.com/enc.m3u8");
assert.equal(encParsed.encryption, "AES-128");

// Cancellation
const ac = new AbortController();
ac.abort();
const err3 = await download("http://127.0.0.1:1/test.m3u8", path.join(tmpDir, "x"), () => {}, { signal: ac.signal }).catch((e) => e);
assert.ok(err3 instanceof DownloadError);
assert.equal(err3.kind, "cancelled");

console.log("PASS — hls-downloader: 12 checks, parse + download + errors");
