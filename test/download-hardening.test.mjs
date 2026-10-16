// ── Tests for D1 (write failure crash), D2 (false success), D3 (mvhd offsets) ─
import { strict as assert } from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { download, DownloadError } from "../src/ipc/hlsDownloader.js";
import { parseMvhdDuration } from "../src/ipc/mvhd.js";

let passed = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); passed++; };

// ── D1: Multi-segment write failure must NOT crash the process ───────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-"));
  const segData = Buffer.alloc(512, 0x41);

  // HTTP server serving a 4-segment playlist
  const playlist = `#EXTM3U\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXTINF:1.0,\nseg2.ts\n#EXTINF:1.0,\nseg3.ts\n#EXT-X-ENDLIST\n`;
  const server = http.createServer((req, res) => {
    if (req.url === "/playlist.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(playlist);
    } else if (req.url.startsWith("/seg")) {
      res.writeHead(200, { "Content-Type": "video/MP2T" });
      res.end(segData);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const destDir = path.join(tmpDir, "nonexistent-dir");
    const destPath = path.join(destDir, "output.ts");

    let caught = null;
    try {
      await download(`http://127.0.0.1:${port}/playlist.m3u8`, destPath, () => {}, {});
    } catch (e) {
      caught = e;
    }

    assert.ok(caught, "D1: download should reject");
    assert.ok(caught instanceof DownloadError, "D1: should be DownloadError");
    assert.equal(caught.kind, "write", "D1: kind should be 'write'");
    ok("D1: multi-segment write failure rejects with DownloadError/write (no crash)");
  } finally {
    server.close();
  }
}

// ── D2: Direct-file write failure must NOT resolve ───────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-"));
  const fileData = Buffer.alloc(4096, 0x42);

  const server = http.createServer((req, res) => {
    if (req.url === "/video.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fileData.length });
      res.end(fileData);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const destDir = path.join(tmpDir, "nonexistent-dir");
    const destPath = path.join(destDir, "output.mp4");

    let caught = null;
    try {
      await download(`http://127.0.0.1:${port}/video.mp4`, destPath, () => {}, {});
    } catch (e) {
      caught = e;
    }

    assert.ok(caught, "D2: download should reject");
    assert.ok(caught instanceof DownloadError, "D2: should be DownloadError");
    assert.equal(caught.kind, "write", "D2: kind should be 'write'");
    ok("D2: direct-file write failure rejects with DownloadError/write (no false success)");
  } finally {
    server.close();
  }
}

// ── D3: mvhd duration parsing matches ffprobe ground truth ───────────────────
{
  // Find real MP4 files on the system for ground-truth comparison
  const searchDirs = [
    "/home/vheey/streambert-workspace",
    os.homedir() + "/Downloads",
    "/tmp",
  ];

  function findMp4s(dir, depth = 0) {
    if (depth > 4) return [];
    const results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...findMp4s(full, depth + 1));
      else if (e.isFile() && /\.mp4$/i.test(e.name)) {
        if (fs.statSync(full).size > 10000 && fs.statSync(full).size < 50 * 1024 * 1024) {
          results.push(full);
        }
      }
    }
    return results;
  }

  const mp4s = searchDirs.flatMap((d) => { try { return findMp4s(d); } catch { return []; } });

  if (mp4s.length === 0) {
    console.log("  ⊘ D3: no MP4 files found on system — skipping (test passes vacuously)");
    passed++;
  } else {
    // Test up to 5 files
    const toTest = mp4s.slice(0, 5);
    for (const file of toTest) {
      // ffprobe ground truth
      let ffprobeDuration = null;
      try {
        const out = execFileSync("ffprobe", [
          "-v", "quiet", "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1", file,
        ], { encoding: "utf8", timeout: 10000 });
        ffprobeDuration = parseFloat(out.trim());
      } catch { /* skip files ffprobe can't read */ }

      if (!ffprobeDuration || ffprobeDuration <= 0) continue;

      const parsed = parseMvhdDuration(file);
      const diff = Math.abs(parsed - ffprobeDuration);
      const tolerance = Math.max(0.1, ffprobeDuration * 0.001); // 0.1s or 0.1%

      assert.ok(parsed > 0, `D3: parseMvhdDuration(${path.basename(file)}) should return > 0`);
      assert.ok(diff < tolerance,
        `D3: parseMvhdDuration(${path.basename(file)})=${parsed.toFixed(3)} vs ffprobe=${ffprobeDuration.toFixed(3)} (diff=${diff.toFixed(3)})`);
      ok(`D3: ${path.basename(file)} parsed=${parsed.toFixed(3)}s ffprobe=${ffprobeDuration.toFixed(3)}s`);
    }

    if (toTest.length > 0 && passed === 0) {
      // Only ffprobe-failed files
      console.log("  ⊘ D3: MP4s found but ffprobe could not read any — skipping");
      passed++;
    }
  }

  // Synthetic mvhd v0 test — validates exact byte offsets
  {
    // Build a minimal file with an ftyp + mvhd v0 box
    const ftyp = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), // size=24
      Buffer.from("ftyp"),
      Buffer.from("isom"),
      Buffer.from([0x00, 0x00, 0x02, 0x00]), // minor version
      Buffer.from("isomiso2"),
    ]);

    const mvhdV0 = Buffer.alloc(108);
    mvhdV0.writeUInt32BE(108, 0); // box size
    mvhdV0.write("mvhd", 4, "ascii");
    mvhdV0.writeUInt8(0, 8); // version 0
    mvhdV0.writeUIntBE(0, 9, 3); // flags
    mvhdV0.writeUInt32BE(0, 12); // creation time
    mvhdV0.writeUInt32BE(0, 16); // modification time
    mvhdV0.writeUInt32BE(1000, 20); // timescale = 1000
    mvhdV0.writeUInt32BE(5000, 24); // duration = 5000 → 5.0s

    const tmpFile = path.join(os.tmpdir(), `d3-v0-${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, Buffer.concat([ftyp, mvhdV0]));
    try {
      const dur = parseMvhdDuration(tmpFile);
      assert.ok(Math.abs(dur - 5.0) < 0.001, `D3 synthetic v0: expected 5.0, got ${dur}`);
      ok("D3: synthetic mvhd v0 → 5.0s (offsets correct)");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }

  // Synthetic mvhd v1 test
  {
    const ftyp = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftyp"),
      Buffer.from("isom"),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
      Buffer.from("isomiso2"),
    ]);

    const mvhdV1 = Buffer.alloc(108);
    mvhdV1.writeUInt32BE(108, 0);
    mvhdV1.write("mvhd", 4, "ascii");
    mvhdV1.writeUInt8(1, 8); // version 1
    mvhdV1.writeUIntBE(0, 9, 3); // flags
    mvhdV1.writeBigUInt64BE(0n, 12); // creation time (8 bytes)
    mvhdV1.writeBigUInt64BE(0n, 20); // modification time (8 bytes)
    mvhdV1.writeUInt32BE(30000, 28); // timescale = 30000
    mvhdV1.writeBigUInt64BE(300000n, 32); // duration = 300000 → 10.0s

    const tmpFile = path.join(os.tmpdir(), `d3-v1-${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, Buffer.concat([ftyp, mvhdV1]));
    try {
      const dur = parseMvhdDuration(tmpFile);
      assert.ok(Math.abs(dur - 10.0) < 0.001, `D3 synthetic v1: expected 10.0, got ${dur}`);
      ok("D3: synthetic mvhd v1 → 10.0s (offsets correct)");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }
}

// ── D6: HLS .ts downloads have duration (EXTINF sum) ─────────────────────────

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "d6-"));
  const segData = Buffer.alloc(512, 0x41);

  const playlist = `#EXTM3U\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXTINF:1.0,\nseg2.ts\n#EXTINF:1.0,\nseg3.ts\n#EXTINF:1.0,\nseg4.ts\n#EXT-X-ENDLIST\n`;
  const server = http.createServer((req, res) => {
    if (req.url === "/playlist.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(playlist);
    } else if (req.url.startsWith("/seg")) {
      res.writeHead(200, { "Content-Type": "video/MP2T" });
      res.end(segData);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const destPath = path.join(tmpDir, "assembled.ts");
    const result = await download(
      `http://127.0.0.1:${port}/playlist.m3u8`,
      destPath,
      () => {},
      {},
    );
    assert.equal(result.ext, ".ts", "D6: extension should be .ts");
    assert.equal(result.segments, 5, "D6: 5 segments");
    assert.ok(Math.abs(result.durationSecs - 5.0) < 0.01,
      `D6: durationSecs should be ~5.0, got ${result.durationSecs}`);
    assert.ok(!fs.readFileSync(destPath).includes("mvhd"),
      "D6: .ts file has no mvhd box");
    ok("D6: HLS .ts download returns durationSecs=5.0 (EXTINF sum, no mvhd needed)");
  } finally {
    server.close();
  }
}

console.log(`\nPASS — download-hardening: ${passed} checks (D1 crash, D2 false-success, D3 mvhd, D6 ts-duration)`);
