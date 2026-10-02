// ── watch-party: the invite/answer codec and host-clock math ────────────────
//
// The watch party transport is WebRTC, so the part worth testing is everything
// around it: does a blob survive a round trip, and does the guest's idea of
// where the host is stay correct as the message ages.
//
// The module is loaded against a stub RTCPeerConnection. It touches the
// network only through that constructor and through ICE gathering, so the
// handshake's own failure paths can be exercised without a browser or a peer.
//
//   node test/watch-party.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Minimal RTCPeerConnection stub ───────────────────────────────────────────
// Records what the module asks for and lets a test decide when gathering is
// done, so waitForIceGathering's timeout path is reachable without a real
// network.
let gatherState = "complete";
let created = [];

class FakePeer {
  constructor(cfg) {
    this.config = cfg;
    this.iceServers = cfg?.iceServers ?? [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceGatheringState = "gathering";
    this.signalingState = "stable";
    this.channels = [];
    this.listeners = {};
    created.push(this);
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  removeEventListener(ev, fn) {
    this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
  }
  _fire(ev) {
    for (const fn of this.listeners[ev] || []) fn();
  }
  /** Complete gathering the way the browser eventually would. */
  finishGathering() {
    this.iceGatheringState = "complete";
    this._fire("icegatheringstatechange");
  }
  createDataChannel(label) {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    this.dataChannel = ch;
    return ch;
  }
  async createOffer() {
    this.signalingState = "have-local-offer";
    this.offer = { type: "offer", sdp: `v=0\r\no=- FAKEHOST 1 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2130706431 192.0.2.1 54321 typ host\r\n` };
    return this.offer;
  }
  async createAnswer() {
    this.signalingState = "have-local-offer";
    this.answer = { type: "answer", sdp: `v=0\r\no=- FAKEGUEST 2 IN IP4 127.0.0.1\r\na=candidate:2 1 udp 2130706431 192.0.2.2 54322 typ host\r\n` };
    return this.answer;
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    if (gatherState === "complete") queueMicrotask(() => this.finishGathering());
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    if (desc.type === "answer") this.signalingState = "stable";
  }
  close() {
    this.iceGatheringState = "closed";
  }
}

class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.sent = [];
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  deliver(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

globalThis.RTCPeerConnection = FakePeer;
// Node 22 ships globalThis.crypto and globalThis.btoa already. They are
// getter-only accessors, so assigning to them throws — only define what is
// actually missing.
if (!globalThis.crypto) {
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}
if (typeof globalThis.btoa !== "function") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

const mod = await import(
  pathToFileURL(join(root, "src/utils/watchParty.js")).href
);

// A second, independent copy of the module.
//
// The module holds its session in module-level state, so one instance cannot be
// both host and guest at once — calling createRoom then joinRoom in a single
// instance has the second reset() wipe the first's peer, which is exactly what
// happens in one window. Real users do not hit this: every Electron window has
// its own copy of the module (src/ipc/* are main-process, this is bundled into
// the renderer per window), so two windows are two module instances for free.
// The tests need the same thing, and loading the file twice by distinct query
// strings gives two genuinely separate instances under one FakePeerConnection.
const modB = await import(
  pathToFileURL(join(root, "src/utils/watchParty.js")).href + "?peer=2"
);

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

const reset = () => {
  created = [];
  gatherState = "complete";
  mod.watchPartyLeaveRoom();
  modB.watchPartyLeaveRoom();
};

/**
 * Drive a real handshake between two independent module instances and return
 * the paired fake channels, wired to each other in both directions, so a test
 * can deliver a message from either side the way a connected channel would.
 *
 * Each side owns its own FakeChannel. `wireChannel` is only reached through
 * `ondatachannel`, and the module assigns `channel.onmessage` there — so the
 * guest's handler has to be attached by that callback, not assigned here, or
 * messages to the guest land on a null handler and vanish.
 */
async function pairUp(hostName = "Alice", guestName = "Bob") {
  const hostRes = await mod.watchPartyCreateRoom(hostName);
  const guestRes = await modB.watchPartyJoinRoom(hostRes.invite, guestName);
  await mod.watchPartyAcceptAnswer(guestRes.answer);

  // created[0] is the host's peer, created[1] the guest's.
  const hostPeer = created[0];
  const guestPeer = created[1];
  const hostCh = hostPeer.dataChannel;

  // The guest's channel, delivered through ondatachannel so the guest module
  // wires its own onmessage. Each side's send() pushes to the *other* side's
  // handler, which is what a connected data channel does.
  const guestCh = {
    onopen: null,
    onclose: null,
    onmessage: null,
    readyState: "connecting",
    send(d) {
      hostCh.onmessage?.({ data: d });
    },
  };

  // The host created its own channel, so route its send at the guest. deliver()
  // is the same route with the message already serialised, for tests that want
  // to push a frame in the host's name.
  hostCh.send = (d) => guestCh.onmessage?.({ data: d });
  hostCh.deliver = (msg) => guestCh.onmessage?.({ data: JSON.stringify(msg) });

  guestPeer.ondatachannel({ channel: guestCh });

  // Order matters: wire both sides' handlers (via open) before announcing, so
  // the hello each side sends on open is actually received by the other. The
  // browser does this by firing both onopen events once the DTLS handshake
  // completes.
  hostCh.readyState = "open";
  guestCh.readyState = "open";
  hostCh.onopen?.();
  guestCh.onopen?.();

  return { hostCh, guestCh, host: mod, guest: modB };
}

// ── 1. Codec round trip ──────────────────────────────────────────────────────
{
  reset();
  const host = await mod.watchPartyCreateRoom("Alice");
  ok(typeof host.invite === "string" && host.invite.length > 0, "host invite is empty");
  ok(!/[\s+/=]/.test(host.invite), "invite must be base64url: no whitespace, +, / or =");
  ok(/^[A-Za-z0-9_-]+$/.test(host.invite), `invite has illegal chars: ${host.invite.slice(0, 40)}`);

  // The guest must be able to read it after the host's own copy is gone, which
  // is what a chat app round trip amounts to.
  const guest = await modB.watchPartyJoinRoom(host.invite, "Bob");
  ok(typeof guest.answer === "string" && guest.answer.length > 0, "guest answer is empty");
  ok(/^[A-Za-z0-9_-]+$/.test(guest.answer), "answer has illegal chars");

  // And the host must accept it back.
  let accepted = false;
  try {
    await mod.watchPartyAcceptAnswer(guest.answer);
    accepted = true;
  } catch (e) {
    problems.push(`host rejected its own guest's answer: ${e.message}`);
  }
  checks++;
  ok(accepted, "handshake did not complete");

  const hostPeer = created[0];
  ok(
    hostPeer.remoteDescription?.type === "answer",
    "host never applied the answer",
  );
  ok(
    hostPeer.remoteDescription?.sdp?.includes("FAKEGUEST"),
    "answer SDP did not reach the host",
  );
  ok(
    created[1].remoteDescription?.sdp?.includes("FAKEHOST"),
    "invite SDP did not reach the guest",
  );
}

// ── 2. Bad blobs are rejected, not silently accepted ─────────────────────────
for (const [label, blob] of [
  ["empty", ""],
  ["plain text", "hello there"],
  ["whitespace", "   \n  "],
  ["truncated base64", "eyJ2IjoxLCJyb2xlI"],
  ["valid base64 but not JSON", Buffer.from("nonsense").toString("base64url")],
]) {
  reset();
  let threw = false;
  try {
    await mod.watchPartyJoinRoom(blob, "Bob");
  } catch {
    threw = true;
  }
  checks++;
  ok(threw, `joining with ${label} should have thrown, but was accepted`);
}

// A guest blob handed to the host must not be accepted as an answer, or the two
// roles could be swapped by pasting the wrong thing.
{
  reset();
  const host = await mod.watchPartyCreateRoom("Alice");
  let threw = false;
  try {
    await mod.watchPartyAcceptAnswer(host.invite);
  } catch {
    threw = true;
  }
  checks++;
  ok(threw, "host accepted its own invite as an answer");
}

// ── 3. Accepting twice is refused ────────────────────────────────────────────
{
  reset();
  const host = await mod.watchPartyCreateRoom("Alice");
  const guest = await modB.watchPartyJoinRoom(host.invite, "Bob");
  await mod.watchPartyAcceptAnswer(guest.answer);
  let threw = false;
  try {
    await mod.watchPartyAcceptAnswer(guest.answer);
  } catch {
    threw = true;
  }
  checks++;
  ok(threw, "a second answer was accepted; signalingState is no longer have-local-offer");
}

// ── 4. ICE gathering that never completes fails fast ─────────────────────────
// Without this the guest waits on a blob that can never connect, with no
// message. The wait is 8s, so the test allows generously for that.
{
  reset();
  gatherState = "never";
  const started = Date.now();
  let msg = null;
  try {
    await mod.watchPartyCreateRoom("Alice");
  } catch (e) {
    msg = e.message;
  }
  const elapsed = Date.now() - started;
  checks++;
  ok(!!msg, "create succeeded with incomplete ICE instead of throwing");
  ok(
    /connection address|network/i.test(msg || ""),
    `unhelpful ICE failure message: ${msg}`,
  );
  ok(elapsed < 20_000, `ICE timeout took ${elapsed}ms, too slow to fail usefully`);
  gatherState = "complete";
}

// ── 5. Host clock: age compensation is the whole point ───────────────────────
// The guest must aim at where the host is *now*, not where it was when the
// message left, or every guest sits permanently behind by the round trip.
{
  reset();
  await pairUp("Alice", "Bob");
  const hostCh = created[0].dataChannel;

  mod.watchPartyUpdateState({ isPlaying: true, progress: 100, duration: 3600 });
  // The host broadcasts on a 5s heartbeat. Fire one straight at the guest
  // instead of waiting for the timer.
  hostCh.deliver({
    type: "state",
    id: "host-id",
    name: "Alice",
    state: { isPlaying: true, progress: 100, duration: 3600 },
  });

  const target = modB.watchPartyGetSyncTarget();
  ok(!!target, "guest has no sync target after receiving host state");
  ok(target?.isPlaying === true, "guest lost the host's playing state");
  ok(
    Math.abs(target.target - 100) < 2,
    `expected target ≈100s immediately after the message, got ${target?.target}`,
  );

  // Age the message: the guest received this 3s ago and the host was still
  // playing, so the guest's target must be 103s, not 100s. This is the
  // behaviour that keeps the two players together instead of permanently offset.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3000;
    const aged = modB.watchPartyGetSyncTarget();
    ok(
      Math.abs(aged.target - 103) < 2,
      `a 3s-old playing report should target ≈103s, got ${aged.target}`,
    );
  } finally {
    Date.now = realNow;
  }

  // A paused host does NOT advance: the age must be ignored entirely, or a
  // paused video would drift forward on every guest.
  reset();
  await pairUp("Alice", "Bob");
  const hostCh2 = created[0].dataChannel;
  hostCh2.deliver({
    type: "state",
    id: "host-id",
    name: "Alice",
    state: { isPlaying: false, progress: 250, duration: 3600 },
  });
  const paused = modB.watchPartyGetSyncTarget();
  ok(paused?.isPlaying === false, "guest did not pick up the host's paused state");
  ok(
    Math.abs(paused.target - 250) < 2,
    `a paused host's clock must not advance, got ${paused.target}`,
  );

  // An explicit host seek must be honoured exactly, not aged.
  reset();
  await pairUp("Alice", "Bob");
  const hostCh3 = created[0].dataChannel;
  modB.watchPartyUpdateState({ isPlaying: false, progress: 10, duration: 3600 });
  hostCh3.deliver({
    type: "host-event",
    event: "seek",
    progress: 1800,
    isPlaying: true,
    duration: 3600,
  });
  const seeked = modB.watchPartyGetSyncTarget();
  ok(
    Math.abs(seeked.target - 1800) < 2,
    `host seek to 1800s was not applied, guest at ${seeked.target}`,
  );
}

// ── 6. Chat and state actually traverse the channel ──────────────────────────
{
  reset();
  const { hostCh, guestCh } = await pairUp("Alice", "Bob");

  // Host sends chat → guest receives it.
  mod.watchPartyUpdateState({ isPlaying: true, progress: 42, duration: 100 });
  mod.watchPartySendChat("hello from Alice");
  const guestState = modB.watchPartyGetState();
  ok(
    guestState.chat.some((m) => m.text === "hello from Alice" && m.sender === "Alice"),
    "guest never received the host's chat",
  );

  // Guest's own chat lands in the host's transcript.
  guestCh.send(
    JSON.stringify({ type: "chat", id: "g1", name: "Bob", text: "hi Alice" }),
  );
  const hostState = mod.watchPartyGetState();
  ok(
    hostState.chat.some((m) => m.text === "hi Alice" && m.sender === "Bob"),
    "host never recorded the guest's chat",
  );

  // Oversized chat is clamped rather than sent whole.
  mod.watchPartySendChat("x".repeat(5000));
  const afterBig = mod.watchPartyGetState();
  const last = afterBig.chat[afterBig.chat.length - 1];
  ok(last.text.length <= 500, `chat not clamped: ${last.text.length} chars`);

  // Empty/blank chat is dropped instead of being broadcast as noise.
  const before = afterBig.chat.length;
  mod.watchPartySendChat("   ");
  ok(
    mod.watchPartyGetState().chat.length === before,
    "blank chat message was recorded",
  );

  // Both sides must know about each other by name once connected.
  ok(
    modB.watchPartyGetState().participants.some((p) => p.name === "Alice"),
    "guest never learned the host's name",
  );
  ok(
    mod.watchPartyGetState().participants.some((p) => p.name === "Bob"),
    "host never learned the guest's name",
  );

  // Leaving tells the other side, so it does not sit waiting on a dead peer.
  guestCh.send(JSON.stringify({ type: "bye", id: "g1" }));
  void hostCh;
}

// ── 7. A peer that stops heartbeating is dropped ─────────────────────────────
{
  reset();
  const host = await mod.watchPartyCreateRoom("Alice");
  const hostCh = created[0].dataChannel;
  hostCh.open();

  hostCh.deliver({ type: "hello", id: "ghost", name: "Ghost" });
  let state = mod.watchPartyGetState();
  ok(
    state.participants.some((p) => p.id === "ghost"),
    "peer did not appear after hello",
  );

  // Rewind every participant's lastSeen past the stale window, then wait for a
  // heartbeat tick to prune. The interval is 5s and the window 12s, so this
  // takes one tick.
  const realNow = Date.now;
  try {
    const rewind = 20_000;
    Date.now = () => realNow() + rewind;
    await new Promise((r) => setTimeout(r, 5300));
  } finally {
    Date.now = realNow;
  }
  state = mod.watchPartyGetState();
  ok(
    !state.participants.some((p) => p.id === "ghost"),
    "a peer that stopped heartbeating was never pruned",
  );
  ok(
    state.participants.some((p) => p.isLocal),
    "the local participant was pruned too",
  );
}

// ── 8. Every exported name is one the modal actually imports ─────────────────
// A rename that leaves the modal calling the old name fails at runtime, not
// here. This at least catches an export the UI no longer reaches.
{
  const modal = readFileSync(join(root, "src/components/WatchPartyModal.jsx"), "utf8");

  // Only the names this module is meant to provide. The modal imports from
  // playbackBridge and ./Icons too, and asserting those against watchParty.js
  // reported three false failures on code that was correct.
  const { pathToFileURL: pfu } = await import("node:url");
  const bridge = await import(pfu(join(root, "src/utils/playbackBridge.js")).href);

  // Read each import statement separately and pull the named bindings out of
  // the one whose specifier matches.
  //
  // Not a single regex across the file: brace-to-specifier matching with a lazy
  // quantifier runs past statement boundaries, and earlier attempts swallowed
  // the React import and reported useState as if it came from watchParty.js.
  // Splitting on the `from "...";` terminator keeps each statement whole.
  const fromClause = (src, spec) => {
    const out = [];
    const re = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']\s*;/g;
    for (const m of src.matchAll(re)) {
      const [, clause, module] = m;
      if (module !== spec) continue;
      const braced = clause.match(/\{([\s\S]*?)\}/);
      if (!braced) continue;
      for (const part of braced[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (name) out.push(name);
      }
    }
    return out;
  };

  const watchNames = fromClause(modal, "../utils/watchParty");
  const bridgeNames = fromClause(modal, "../utils/playbackBridge");

  ok(
    watchNames.length >= 8,
    `modal imports from watchParty look wrong: ${watchNames.length} names`,
  );
  ok(bridgeNames.length === 3, `expected 3 bridge imports, got ${bridgeNames.length}`);

  for (const name of watchNames) {
    checks++;
    if (typeof mod[name] !== "function") {
      problems.push(`WatchPartyModal imports "${name}" but watchParty.js does not export it`);
    }
  }
  for (const name of bridgeNames) {
    checks++;
    if (typeof bridge[name] !== "function") {
      problems.push(
        `WatchPartyModal imports "${name}" but playbackBridge.js does not export it`,
      );
    }
  }

  // And the two modules must not both claim the same name — a collision would
  // mean the modal's import resolves to one of them and the other is dead.
  for (const name of watchNames) {
    checks++;
    if (bridgeNames.includes(name)) {
      problems.push(`"${name}" is imported from both watchParty.js and playbackBridge.js`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
reset();
if (problems.length) {
  console.error(`FAIL — watch-party: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — watch-party: ${checks} checks, codec + handshake + sync + pruning`);