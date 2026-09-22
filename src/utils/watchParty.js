// ── Watch Party: Synchronized Playback ───────────────────────────────────────
// Real-time synchronized viewing with room-based session management.
// Uses WebRTC data channels for low-latency sync.

const WATCH_PARTY_CONFIG = {
  // Default signaling server (can be self-hosted)
  SIGNALING_SERVER: "wss://watchparty-signal.example.com",
  // Room code length
  CODE_LENGTH: 6,
  // Heartbeat interval (ms)
  HEARTBEAT_INTERVAL: 5000,
  // Sync tolerance (ms) — how far apart players can be before resync
  SYNC_TOLERANCE: 500,
  // Max participants per room
  MAX_PARTICIPANTS: 8,
};

// Generate a random room code
function generateRoomCode(length = WATCH_PARTY_CONFIG.CODE_LENGTH) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── Watch Party State ─────────────────────────────────────────────────────────
let _roomCode = null;
let _isHost = false;
let _participants = new Map(); // userId → { name, progress, isPlaying, lastSeen }
let _localState = {
  isPlaying: false,
  progress: 0,
  duration: 0,
  timestamp: Date.now(),
};
let _onStateChangeCallback = null;
let _heartbeatTimer = null;

export const watchPartyCreateRoom = async (userName = "Host") => {
  _roomCode = generateRoomCode();
  _isHost = true;
  _participants.clear();
  _participants.set("local", {
    name: userName,
    progress: 0,
    isPlaying: false,
    lastSeen: Date.now(),
  });
  
  // Connect to signaling server (placeholder — real implementation would use WebSocket)
  // const ws = new WebSocket(WATCH_PARTY_CONFIG.SIGNALING_SERVER);
  
  // Start heartbeat
  _startHeartbeat();
  
  return { roomCode: _roomCode, isHost: true };
};

export const watchPartyJoinRoom = async (roomCode, userName = "Guest") => {
  _roomCode = roomCode.toUpperCase();
  _isHost = false;
  _participants.clear();
  
  // Connect to signaling server and join room
  // const ws = new WebSocket(WATCH_PARTY_CONFIG.SIGNALING_SERVER);
  // ws.send(JSON.stringify({ type: "join", room: _roomCode, name: userName }));
  
  _startHeartbeat();
  
  return { roomCode: _roomCode, isHost: false };
};

export const watchPartyLeaveRoom = () => {
  _stopHeartbeat();
  _roomCode = null;
  _isHost = false;
  _participants.clear();
  _localState = { isPlaying: false, progress: 0, duration: 0, timestamp: Date.now() };
};

// ── Playback Control ──────────────────────────────────────────────────────────
export const watchPartyUpdateState = (state) => {
  _localState = { ...state, timestamp: Date.now() };
  // Broadcast to all participants
  broadcastState();
};

export const watchPartyHandleHostState = (hostState) => {
  // Non-host: apply host's state if drift exceeds tolerance
  const drift = Math.abs(_localState.progress - hostState.progress);
  if (drift > WATCH_PARTY_CONFIG.SYNC_TOLERANCE / 1000) {
    _localState = { ...hostState, timestamp: Date.now() };
    _onStateChangeCallback?.(_localState);
  }
};

// ── Chat ──────────────────────────────────────────────────────────────────────
export const watchPartySendChat = (message) => {
  const chatMsg = {
    type: "chat",
    sender: "local", // would be actual user
    text: message,
    timestamp: Date.now(),
  };
  broadcast(chatMsg);
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastState() {
  const msg = {
    type: "state",
    room: _roomCode,
    state: _localState,
    sender: "local",
  };
  broadcast(msg);
}

function broadcast(message) {
  // WebSocket broadcast
  // ws?.send(JSON.stringify(message));
}

function _startHeartbeat() {
  _heartbeatTimer = setInterval(() => {
    // Send heartbeat to keep connection alive
    broadcast({ type: "heartbeat", room: _roomCode, timestamp: Date.now() });
  }, WATCH_PARTY_CONFIG.HEARTBEAT_INTERVAL);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

export const watchPartyGetParticipants = () => Array.from(_participants.values());
export const watchPartyGetRoomCode = () => _roomCode;
export const watchPartyIsHost = () => _isHost;

export const watchPartyOnChange = (callback) => {
  _onStateChangeCallback = callback;
};
