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
