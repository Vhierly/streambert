// ── Pure SRT / ASS -> WebVTT converter for LocalPlayerModal ─────────────────

export function srtToVtt(raw) {
  if (!raw || typeof raw !== "string") return "WEBVTT\n\n";
  const cleaned = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (/^WEBVTT\b/i.test(cleaned)) return cleaned + "\n";

  // Convert SRT timestamp commas (00:01:23,456 --> 00:01:25,789) to WebVTT dots
  const vttBody = cleaned.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2 --> $3.$4",
  );
  return `WEBVTT\n\n${vttBody}\n`;
}

/**
 * Shift all WebVTT cue timestamps by `offsetSec` seconds (clamped >= 0).
 */
export function shiftVttTimestamps(vttText, offsetSec = 0) {
  if (!offsetSec || !vttText) return vttText;
  const toSecs = (hms, ms) => {
    const parts = hms.split(":").map(Number);
    const s =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    return s + Number(ms) / 1000;
  };
  const fmt = (sec) => {
    const clamped = Math.max(0, sec);
    const whole = Math.floor(clamped);
    const ms = Math.round((clamped - whole) * 1000);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return (
      [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") +
      "." +
      String(Math.min(999, ms)).padStart(3, "0")
    );
  };
  return vttText.replace(
    /(\d{1,2}:\d{2}:\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})\.(\d{3})/g,
    (_, aHms, aMs, bHms, bMs) =>
      `${fmt(toSecs(aHms, aMs) + offsetSec)} --> ${fmt(toSecs(bHms, bMs) + offsetSec)}`,
  );
}

function parseTimestampSec(raw) {
  const clean = String(raw || "").trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return NaN;
}

/**
 * Parse .srt, .vtt, or .ass/.ssa subtitle text into `{ start, end, text }[]` cues
 * for zero-flicker custom overlay rendering with live offset & font-size controls.
 */
export function parseSubtitleCues(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const lines = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues = [];

  // 1. Check ASS/SSA Dialogue lines
  const assRe =
    /^Dialogue:\s*\d+,(\d+:\d{2}:\d{2}\.\d{1,3}),(\d+:\d{2}:\d{2}\.\d{1,3}),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/i;
  for (const line of lines) {
    const m = assRe.exec(line);
    if (m) {
      const start = parseTimestampSec(m[1]);
      const end = parseTimestampSec(m[2]);
      const text = m[3]
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .trim();
      if (Number.isFinite(start) && Number.isFinite(end) && text) {
        cues.push({ start, end, text });
      }
    }
  }
  if (cues.length > 0) {
    return cues.sort((a, b) => a.start - b.start);
  }

  // 2. Parse SRT / WebVTT cue blocks
  const timeRe =
    /((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})/;
  let i = 0;
  while (i < lines.length) {
    const m = timeRe.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = parseTimestampSec(m[1]);
    const end = parseTimestampSec(m[2]);
    i++;
    const body = [];
    while (i < lines.length && lines[i].trim() !== "") {
      body.push(lines[i]);
      i++;
    }
    const text = body
      .join("\n")
      .replace(/\{[^}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) {
      cues.push({ start, end, text });
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}
