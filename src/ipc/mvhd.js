// ── Pure-Node mvhd duration parser ──────────────────────────────────────────
// Parses the mvhd box from MP4/MOV files. Returns duration in seconds, or 0 if not found.
const fs = require("fs");

function parseMvhdDuration(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);

    for (let i = 0; i < data.length - 8; i++) {
      if (
        data[i + 4] === 0x6d && // m
        data[i + 5] === 0x76 && // v
        data[i + 6] === 0x68 && // h
        data[i + 7] === 0x64    // d
      ) {
        const boxSize = data.readUInt32BE(i);
        if (boxSize < 24) continue;

        // mvhd v0: version(1) + flags(3) + creation(4) + modification(4) + timescale(4) + duration(4)
        // mvhd v1: version(1) + flags(3) + creation(8) + modification(8) + timescale(4) + duration(8)
        // Offsets below are from i+8 (payload start), i.e. after size(4)+type(4).
        const version = data[i + 8];
        let timescale, duration;
        if (version === 1) {
          timescale = data.readUInt32BE(i + 28);
          duration = Number(data.readBigUInt64BE(i + 32));
        } else {
          timescale = data.readUInt32BE(i + 20);
          duration = data.readUInt32BE(i + 24);
        }
        if (timescale > 0 && duration > 0) {
          return duration / timescale;
        }
      }
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { parseMvhdDuration };
