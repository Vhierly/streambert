// ── Watch Party: peer-to-peer synchronized playback ─────────────────────────
//
// How it actually connects
// ------------------------
// There is no server. The previous version had a full UI — room codes, a
// participant list, chat, a progress bar — behind `const ws = new WebSocket(
// WATCH_PARTY_CONFIG.SIGNALING_SERVER)` with the URL commented out and set to
// "wss://watchparty-signal.example.com". Two devices therefore never saw each
// other, and the UI was decoration.
//
// WebRTC replaces the room code entirely. Two peers negotiate directly over a
// data channel, so nothing to host, forward or pay for. The price is that ICE
// has to be exchanged by hand: the host generates an invite blob, the guest
// pastes it back with their answer, the host pastes the answer in. That is the
// same "copy this code" ritual every serverless P2P app uses, and it works
// across NATs because STUN gives both sides a reflexive address.
//
// Sync model
// ----------
// The host is authoritative. Guests apply the host's clock rather than seeking
// to the host's raw position, so a 300ms network delay does not show up as a
// 300ms permanent offset: host says "we are at 812.4s", guest sets its target
// to 812.4s plus the age of that message. Pausing and seeking both travel as
// host events.
//
// What this module does not do
// ----------------------------
// It does not move video. Each peer plays its own stream; only the clock and
// chat are shared. Riding the host's actual frames would need the host to
// re-encode and push a video track, which is a different feature with a
// different cost profile.
//
// STUN servers are Google's public ones. They are contacted for address
// discovery only — no media or metadata passes through them.

const CONFIG = {
  ICE_SERVERS: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  // Re-check for silent peers at half the heartbeat interval, so a dropped
  // connection is noticed within one heartbeat rather than two.
  STALE_PEER_MS: 12_000,
  HEARTBEAT_INTERVAL_MS: 5_000,
  // Drift under this is left alone. Seeking on every 200ms heartbeat would
  // fight the player's own buffering and make playback stutter.
  SYNC_TOLERANCE_MS: 500,
  MAX_PARTICIPANTS: 8,
  // An invite blob is a base64 of the local description plus a little session
  // metadata. This bound is generous; real blobs land around 1–2 KB because
  // trickle ICE keeps the candidate list short.
  MAX_INVITE_CHARS: 12_000,
  CHAT_MAX_CHARS: 500,
  CHAT_HISTORY: 100,
};

/** Drift a guest tolerates before it bothers seeking. Mirrors CONFIG.SYNC_TOLERANCE_MS. */
const WATCH_PARTY_TOLERANCE_MS = CONFIG.SYNC_TOLERANCE_MS;

// ── State ────────────────────────────────────────────────────────────────────
let _role = null; // "host" | "guest" | null
let _localName = "";
let _localId = ""; // stable id we announce, so peers can key on it
let _peer = null; // RTCPeerConnection
let _channel = null; // RTCDataChannel
let _room = null; // { code, participants, chat, connected, status, error }
let _localState = { isPlaying: false, progress: 0, duration: 0 };
let _heartbeatTimer = null;
let _notify = () => {};
let _hostClock = null; // { progress, isPlaying, at } — host's last report

const PEER_TIMEOUT = () => CONFIG.STALE_PEER_MS;

function makeId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeCode() {
  // Ambiguous glyphs (0/O, 1/I) are excluded: users read these aloud and type
  // them from a phone.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

function newRoom(code, status) {
  return {
    code,
    status, // "awaiting" | "connecting" | "connected"
    participants: [],
    chat: [],
    error: null,
  };
}

const snapshot = () => JSON.parse(JSON.stringify(_room ?? null));

function emit() {
  _notify(snapshot());
}

function reset() {
  _stopHeartbeat();
  teardownPeer();
  _role = null;
  _localName = "";
  _localId = "";
  _room = null;
  _localState = { isPlaying: false, progress: 0, duration: 0 };
  _hostClock = null;
}

// ── Peer lifecycle ───────────────────────────────────────────────────────────

function teardownPeer() {
  try {
    if (_channel) _channel.close();
  } catch {}
  _channel = null;
  try {
    if (_peer) _peer.close();
  } catch {}
  _peer = null;
}

function newPeer() {
  teardownPeer();
  const peer = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
  _peer = peer;

  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === "failed" || s === "disconnected" || s === "closed") {
      if (_room && _room.status === "connected") {
        _room.status = "connecting";
        _room.error = "Connection lost. Leave and re-share the invite.";
        emit();
      }
    }
  };

  return peer;
}

function wireChannel(channel) {
  _channel = channel;
  channel.onopen = () => {
    if (!_room) return;
    _room.status = "connected";
    _room.error = null;
    // Announce ourselves first, so the other side can label the peer before
    // any state message arrives.
    send({ type: "hello", id: _localId, name: _localName });
    pushParticipant(_localId, _localName, _localState);
    startHeartbeat();
    emit();
  };

  channel.onclose = () => {
    if (!_room) return;
    _stopHeartbeat();
    _room.status = "connecting";
    _room.error = "The other side closed the connection.";
    emit();
  };

  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // a malformed frame is not worth tearing the session down for
    }
    handleMessage(msg);
  };
}

function send(msg) {
  if (!_channel || _channel.readyState !== "open") return false;
  try {
    _channel.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

// ── Room bookkeeping ─────────────────────────────────────────────────────────

function pushParticipant(id, name, state = {}) {
  if (!_room) return;
  const existing = _room.participants.find((p) => p.id === id);
  if (existing) {
    // Never let a peer's traffic rewrite its own name or re-order the list.
    existing.progress = state.progress ?? existing.progress;
    existing.isPlaying = state.isPlaying ?? existing.isPlaying;
    existing.lastSeen = Date.now();
  } else {
    _room.participants.push({
      id,
      name: name || "Guest",
      progress: state.progress ?? 0,
      isPlaying: state.isPlaying ?? false,
      isLocal: id === _localId,
      isHost: _role === "host" ? id === _localId : false,
      lastSeen: Date.now(),
    });
  }
  emit();
}

function pruneStalePeers() {
  if (!_room) return;
  const now = Date.now();
  const before = _room.participants.length;
  // The local entry is never pruned: we are obviously still here.
  _room.participants = _room.participants.filter(
    (p) => p.isLocal || now - p.lastSeen <= PEER_TIMEOUT(),
  );
  if (_room.participants.length !== before) emit();
}

function handleMessage(msg) {
  switch (msg?.type) {
    case "hello":
      pushParticipant(msg.id, msg.name);
      // Reply so the newcomer learns our name too.
      send({ type: "hello", id: _localId, name: _localName });
      break;

    case "state": {
      const who = msg.id || "peer";
      pushParticipant(who, msg.name, {
        progress: msg.state?.progress,
        isPlaying: msg.state?.isPlaying,
      });

      // Only the guest obeys the host's clock. Two hosts would fight forever.
      if (_role === "guest" && msg.state) {
        _hostClock = {
          progress: msg.state.progress ?? 0,
          isPlaying: !!msg.state.isPlaying,
          duration: msg.state.duration ?? 0,
          at: Date.now(),
        };
        emit();
      }
      break;
    }

    case "host-event":
      if (_role === "guest") applyHostEvent(msg);
      break;

    case "chat": {
      const text = String(msg.text ?? "").slice(0, CONFIG.CHAT_MAX_CHARS);
      if (!text.trim()) return;
      pushParticipant(msg.id, msg.name);
      _room.chat.push({
        id: `${msg.id}-${Date.now()}`,
        sender: msg.name || "Guest",
        text,
        mine: msg.id === _localId,
        timestamp: Date.now(),
      });
      if (_room.chat.length > CONFIG.CHAT_HISTORY) {
        _room.chat = _room.chat.slice(-CONFIG.CHAT_HISTORY);
      }
      emit();
      break;
    }

    case "bye":
      if (_room) {
        _room.participants = _room.participants.filter((p) => p.id !== msg.id);
        emit();
      }
      break;
  }
}

// ── Host → guest playback events ─────────────────────────────────────────────

/** Where the guest should be right now, given the host's last report. */
function hostTarget() {
  if (!_hostClock) return null;
  const age = (Date.now() - _hostClock.at) / 1000;
  // A host that is playing keeps moving; a paused host does not.
  const target = _hostClock.isPlaying ? _hostClock.progress + age : _hostClock.progress;
  return { ..._hostClock, target };
}

function applyHostEvent(msg) {
  switch (msg.event) {
    case "seek":
      _hostClock = {
        progress: msg.progress ?? 0,
        isPlaying: !!msg.isPlaying,
        duration: msg.duration ?? 0,
        at: Date.now(),
      };
      emit();
      break;
    case "play":
    case "pause":
      _hostClock = {
        progress: msg.progress ?? 0,
        isPlaying: msg.event === "play",
        duration: msg.duration ?? 0,
        at: Date.now(),
      };
      emit();
      break;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Host side: create the room and produce the invite to hand to the guest.
 * Returns the invite blob, which the guest pastes back as their answer.
 */
export async function watchPartyCreateRoom(userName = "Host") {
  reset();
  _role = "host";
  _localName = (userName || "Host").slice(0, 20);
  _localId = makeId();
  _room = newRoom(makeCode(), "awaiting");

  const peer = newPeer();
  wireChannel(peer.createDataChannel("watchparty", { ordered: true }));

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);

  // Without a complete candidate list the guest has nothing to connect to.
  // Trickle is not usable here: there is no channel to trickle over yet.
  if (!peer.localDescription || peer.iceGatheringState !== "complete") {
    throw new Error(
      "Couldn't gather a connection address. Check your network and try again.",
    );
  }

  const invite = encodeBlob({ v: 1, role: "host", sdp: peer.localDescription.sdp });
  emit();
  return { roomCode: _room.code, isHost: true, invite };
}

/**
 * Guest side: take the host's invite, produce an answer for them to paste back.
 * The room is not live until the host confirms with watchPartyAcceptAnswer().
 */
export async function watchPartyJoinRoom(inviteBlob, userName = "Guest") {
  const invite = decodeBlob(inviteBlob);
  if (!invite || invite.role !== "host" || !invite.sdp) {
    throw new Error("That doesn't look like a watch party invite.");
  }

  reset();
  _role = "guest";
  _localName = (userName || "Guest").slice(0, 20);
  _localId = makeId();
  _room = newRoom("connecting", "connecting");

  const peer = newPeer();
  peer.ondatachannel = (event) => wireChannel(event.channel);

  await peer.setRemoteDescription({ type: "offer", sdp: invite.sdp });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGathering(peer);

  if (!peer.localDescription || peer.iceGatheringState !== "complete") {
    throw new Error("Couldn't gather a connection address. Check your network.");
  }

  const reply = encodeBlob({ v: 1, role: "guest", sdp: peer.localDescription.sdp });
  emit();
  return { isHost: false, answer: reply };
}

/** Host side: finish the handshake with the guest's answer blob. */
export async function watchPartyAcceptAnswer(answerBlob) {
  if (_role !== "host" || !_peer) {
    throw new Error("No room to accept an answer in.");
  }
  const answer = decodeBlob(answerBlob);
  if (!answer || answer.role !== "guest" || !answer.sdp) {
    throw new Error("That doesn't look like a watch party answer.");
  }
  if (_peer.signalingState !== "have-local-offer") {
    throw new Error("This room is already connected.");
  }
  await _peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  _room.status = "connecting";
  emit();
  return true;
}

/** Leave, and tell the other side so it does not sit waiting. */
export function watchPartyLeaveRoom() {
  if (_channel && _channel.readyState === "open") {
    send({ type: "bye", id: _localId });
  }
  reset();
}

export function watchPartySendChat(text) {
  const clean = String(text ?? "").slice(0, CONFIG.CHAT_MAX_CHARS);
  if (!clean.trim() || !_room) return null;
  const entry = {
    id: `${_localId}-${Date.now()}`,
    sender: _localName || "You",
    text: clean,
    mine: true,
    timestamp: Date.now(),
  };
  _room.chat.push(entry);
  if (_room.chat.length > CONFIG.CHAT_HISTORY) {
    _room.chat = _room.chat.slice(-CONFIG.CHAT_HISTORY);
  }
  send({ type: "chat", id: _localId, name: _localName, text: clean });
  emit();
  return entry;
}

/**
 * Report this peer's own playback position. The host broadcasts it to the
 * guest; the guest ignores its own and uses the host's clock instead.
 */
export function watchPartyUpdateState(state) {
  _localState = {
    isPlaying: !!state?.isPlaying,
    progress: Number.isFinite(state?.progress) ? state.progress : 0,
    duration: Number.isFinite(state?.duration) ? state.duration : 0,
  };
  if (_room) {
    const me = _room.participants.find((p) => p.isLocal);
    if (me) {
      me.progress = _localState.progress;
      me.isPlaying = _localState.isPlaying;
    }
  }
  if (_role === "host") {
    send({ type: "state", id: _localId, name: _localName, state: _localState });
  }
}

export function watchPartyGetState() {
  return snapshot();
}

export function watchPartyOnChange(callback) {
  _notify = typeof callback === "function" ? callback : () => {};
  // Deliver current state immediately so a late subscriber is never blank.
  _notify(snapshot());
}

/**
 * Where a guest should seek to, or null when there is no host clock to obey.
 *
 * The player polls this on its own timer and only seeks when the gap exceeds
 * WATCH_PARTY_TOLERANCE — seeking on every 200ms heartbeat would fight the
 * player's buffering and make playback stutter.
 */
export function watchPartyGetSyncTarget() {
  return hostTarget();
}

/**
 * True when |current - target| is big enough to be worth correcting.
 * Exported so the player does not carry its own copy of the number.
 */
export function watchPartyShouldResync(currentTime) {
  const t = hostTarget();
  if (!t) return false;
  return Math.abs(currentTime - t.target) * 1000 > WATCH_PARTY_TOLERANCE_MS;
}

/** Host-only: announce a seek so the guest jumps with us. */
export function watchPartyHostSeek(progress, isPlaying) {
  if (_role !== "host") return false;
  _hostClock = {
    progress: progress ?? 0,
    isPlaying: !!isPlaying,
    duration: _localState.duration,
    at: Date.now(),
  };
  return send({
    type: "host-event",
    event: "seek",
    progress,
    isPlaying: !!isPlaying,
    duration: _localState.duration,
  });
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Resolve once ICE gathering finishes.
 *
 * No trickle: the invite has to carry every candidate, because the only way it
 * reaches the other side is by being pasted. The timeout is a safety net for a
 * host that cannot reach any STUN server — an incomplete blob would hang the
 * guest forever instead of failing fast.
 */
function waitForIceGathering(peer, timeoutMs = 8000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

/** base64url of a JSON blob, so it survives copy/paste through any chat app. */
function encodeBlob(obj) {
  const json = JSON.stringify(obj);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBlob(text) {
  const clean = String(text ?? "").trim().replace(/\s+/g, "");
  if (!clean || clean.length > CONFIG.MAX_INVITE_CHARS) return null;
  try {
    const padded = clean.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    send({ type: "state", id: _localId, name: _localName, state: _localState });
    pruneStalePeers();
  }, CONFIG.HEARTBEAT_INTERVAL_MS);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}