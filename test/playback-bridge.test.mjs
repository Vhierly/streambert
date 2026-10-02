// ── playback-bridge: the pub/sub the watch party rides on ───────────────────
//
// The bridge exists because the watch party modal is mounted at the App level
// while the <video> element lives inside TVPage / NativePlayer. There is no
// prop path between them, so the player publishes and the modal subscribes.
//
// Its failure modes are the ones worth pinning down:
//
//   - a leaked listener keeps a dead player alive and, worse, a stale one can
//     still answer a seek command after the source changed
//   - getLastPlaybackProgress returning a mutable object lets a caller corrupt
//     the snapshot for everyone else
//   - a command with a bad currentTime would NaN the player's position
//
//   node test/playback-bridge.test.mjs
//
// Run against a real DOM event target. Node 22 has no window, so the three
// globals the module touches are supplied here — the same way a renderer
// provides them.

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev) {
    for (const fn of [...(this.listeners.get(ev.type) || [])]) fn(ev);
    return true;
  }
  count(type) {
    return (this.listeners.get(type) || []).length;
  }
}

globalThis.window = new FakeEventTarget();
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { pathToFileURL } = await import("node:url");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const bridge = await import(
  pathToFileURL(join(root, "src/utils/playbackBridge.js")).href
);

const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

// ── 1. Progress reaches a subscriber ─────────────────────────────────────────
{
  const seen = [];
  const off = bridge.onPlaybackProgress((d) => seen.push(d));
  bridge.publishPlaybackProgress({ currentTime: 12.5, duration: 100, isPlaying: true });
  bridge.publishPlaybackProgress({ currentTime: 13.5, duration: 100, isPlaying: true });

  ok(seen.length === 2, `expected 2 progress events, got ${seen.length}`);
  ok(seen[0]?.currentTime === 12.5, `currentTime mangled: ${seen[0]?.currentTime}`);
  ok(seen[1]?.currentTime === 13.5, "second event did not arrive in order");

  // Unsubscribing must actually detach, or a remounted player double-reports.
  off();
  bridge.publishPlaybackProgress({ currentTime: 99, duration: 100, isPlaying: false });
  ok(seen.length === 2, "listener still firing after unsubscribe");
  ok(
    window.count("streambert:playback-progress") === 0,
    "unsubscribe left a listener attached",
  );
}

// ── 2. Bad payloads are normalised, not forwarded ───────────────────────────
{
  const seen = [];
  const off = bridge.onPlaybackProgress((d) => seen.push(d));

  bridge.publishPlaybackProgress({ currentTime: NaN, duration: undefined, isPlaying: "yes" });
  ok(seen[0]?.currentTime === 0, `NaN currentTime leaked through: ${seen[0]?.currentTime}`);
  ok(seen[0]?.duration === 0, `undefined duration leaked through: ${seen[0]?.duration}`);
  ok(seen[0]?.isPlaying === true, `truthy string became ${seen[0]?.isPlaying}, expected true`);

  bridge.publishPlaybackProgress(null);
  ok(seen[1]?.currentTime === 0, "null payload produced a non-zero time");

  off();
}

// ── 3. Commands reach the player ─────────────────────────────────────────────
{
  const got = [];
  const off = bridge.onPlaybackCommand((c) => got.push(c));

  bridge.requestPlaybackCommand("seek", 1800, 3600);
  ok(got.length === 1, `expected 1 command, got ${got.length}`);
  ok(got[0]?.type === "seek", `command type mangled: ${got[0]?.type}`);
  ok(got[0]?.currentTime === 1800, `seek target mangled: ${got[0]?.currentTime}`);

  bridge.requestPlaybackCommand("pause");
  ok(got[1]?.type === "pause" && got[1]?.currentTime === 0, "pause command malformed");

  off();
  bridge.requestPlaybackCommand("play");
  ok(got.length === 2, "command listener still firing after unsubscribe");
}

// ── 4. Progress and command channels do not cross ────────────────────────────
// A seek command must not be readable as playback progress, or the modal could
// treat its own request as the player's answer and stop correcting drift.
{
  const progress = [];
  const commands = [];
  const offP = bridge.onPlaybackProgress((d) => progress.push(d));
  const offC = bridge.onPlaybackCommand((d) => commands.push(d));

  bridge.publishPlaybackProgress({ currentTime: 5, duration: 10, isPlaying: true });
  bridge.requestPlaybackCommand("seek", 9, 10);

  ok(progress.length === 1, `progress saw ${progress.length} events, expected 1`);
  ok(commands.length === 1, `commands saw ${commands.length} events, expected 1`);
  ok(progress[0]?.currentTime === 5, "progress was polluted by a command");

  offP();
  offC();
}

// ── 5. getLastPlaybackProgress is a snapshot, not the live object ────────────
{
  bridge.publishPlaybackProgress({ currentTime: 42, duration: 100, isPlaying: true });
  const snap = bridge.getLastPlaybackProgress();
  snap.currentTime = 9999; // a caller scribbling on it must not leak

  const again = bridge.getLastPlaybackProgress();
  ok(
    again.currentTime === 42,
    `getLastPlaybackProgress returned a mutable reference: ${again.currentTime}`,
  );

  // And it must reflect the latest publish, not the first.
  bridge.publishPlaybackProgress({ currentTime: 77, duration: 100, isPlaying: false });
  ok(
    bridge.getLastPlaybackProgress().currentTime === 77,
    "snapshot did not advance with the stream",
  );
}

// ── 6. Both publishers/subscribers are actually used somewhere ──────────────
// The bridge only earns its keep if the player publishes and the modal
// subscribes. A rename on one side that misses the other passes every test
// above and still leaves the feature inert, so check the call sites directly.
{
  const { readFileSync } = await import("node:fs");
  const player = readFileSync(join(root, "src/components/NativePlayer.jsx"), "utf8");
  const modal = readFileSync(join(root, "src/components/WatchPartyModal.jsx"), "utf8");

  checks++;
  if (!player.includes("publishPlaybackProgress"))
    problems.push("NativePlayer never publishes — the watch party would sit at 0:00");
  checks++;
  if (!player.includes("onPlaybackCommand"))
    problems.push("NativePlayer never subscribes to commands — a guest could not follow");
  checks++;
  if (!modal.includes("onPlaybackProgress"))
    problems.push("WatchPartyModal never subscribes to progress");
  checks++;
  if (!modal.includes("requestPlaybackCommand"))
    problems.push("WatchPartyModal never issues commands — drift would never be corrected");

  // Usage is not enough — the import has to be there too. An earlier version of
  // this check only grepped for usage and passed while the import was missing,
  // which is the exact bug class this file exists to catch: vite compiles an
  // unimported identifier as a global, so the build is green and only mounting
  // throws.
  const modalImports = new Set();
  for (const m of modal.matchAll(/import\s+([\s\S]+?)\s+from\s+["'][^"']+["']/g)) {
    const braced = m[1].match(/\{([\s\S]*?)\}/);
    if (braced)
      for (const part of braced[1].split(","))
        modalImports.add(part.split(/\s+as\s+/).pop().trim());
  }
  for (const name of [
    "onPlaybackProgress",
    "getLastPlaybackProgress",
    "requestPlaybackCommand",
  ]) {
    checks++;
    if (!modal.includes(name))
      problems.push(`WatchPartyModal never mentions ${name} — the bridge is unused`);
    if (!modalImports.has(name))
      problems.push(
        `WatchPartyModal uses ${name} but does not import it — compiles clean, throws on mount`,
      );
  }

  // The modal must not still be reading props that App never passes. It was
  // mounted with only onClose, so a leftover destructured prop would be
  // undefined forever and silently blank the progress bar.
  checks++;
  const sig = modal.match(/export default function WatchPartyModal\(([^)]*)\)/)?.[1] ?? "";
  if (/isPlaying|progress|duration/.test(sig)) {
    problems.push(
      `WatchPartyModal still destructures playback props (${sig.trim()}) that App does not pass`,
    );
  }
  checks++;
  const app = readFileSync(join(root, "src/App.jsx"), "utf8");
  const modalMount = app.slice(
    app.indexOf("showWatchParty &&"),
    app.indexOf("showWatchParty &&") + 240,
  );
  if (/isPlaying=|progress=|duration=/.test(modalMount)) {
    problems.push("App still passes playback props to WatchPartyModal");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`FAIL — playback-bridge: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — playback-bridge: ${checks} checks, publish/subscribe/isolation`);