import { useState, useEffect, useCallback, useRef } from "react";
import {
  watchPartyCreateRoom,
  watchPartyJoinRoom,
  watchPartyLeaveRoom,
  watchPartyGetParticipants,
  watchPartyGetRoomCode,
  watchpartyIsHost,
  watchPartySendChat,
  watchPartyOnChange,
} from "../utils/watchParty";
import { CloseIcon, CopyIcon, UsersIcon, SendIcon, PlayIcon, PauseIcon } from "./Icons";

export default function WatchPartyModal({ onClose, isPlaying, progress, duration }) {
  const [roomCode, setRoomCode] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [joinCode, setJoinCode] = useState("");
  const [userName, setUserName] = useState("Guest");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    // Listen for state changes from watch party
    watchPartyOnChange((state) => {
      // Update local state from host
      setParticipants(watchPartyGetParticipants());
    });
  }, []);

  const handleCreateRoom = useCallback(async () => {
    try {
      const result = await watchPartyCreateRoom(userName);
      setRoomCode(result.roomCode);
      setIsHost(result.isHost);
      setParticipants(watchPartyGetParticipants());
    } catch (e) {
      setError(e.message);
    }
  }, [userName]);

  const handleJoinRoom = useCallback(async () => {
    try {
      const result = await watchPartyJoinRoom(joinCode, userName);
      setRoomCode(result.roomCode);
      setIsHost(result.isHost);
      setParticipants(watchPartyGetParticipants());
    } catch (e) {
      setError(e.message);
    }
  }, [joinCode, userName]);

  const handleLeave = useCallback(() => {
    watchPartyLeaveRoom();
    setRoomCode(null);
    setIsHost(false);
    setParticipants([]);
    setChatMessages([]);
  }, []);

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(roomCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [roomCode]);

  const handleSendChat = useCallback(() => {
    if (!chatInput.trim()) return;
    watchPartySendChat(chatInput.trim());
    setChatMessages((prev) => [
      ...prev,
      { sender: "You", text: chatInput.trim(), timestamp: Date.now() },
    ]);
    setChatInput("");
  }, [chatInput]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const progressPercent = duration > 0 ? Math.round((progress / duration) * 100) : 0;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-box" style={{ maxWidth: 520, width: "92vw" }}>
        {/* Header */}
        <div className="modal-header">
          <div>
            <h2>Watch Party</h2>
            <p className="modal-sub">
              {roomCode
                ? `Room: ${roomCode}`
                : "Create or join a room to watch together"}
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {!roomCode ? (
          /* ── Create / Join ─────────────────────────────────────────────── */
          <div className="watch-party-setup">
            <div className="wp-input-group">
              <label>Your Name</label>
              <input
                type="text"
                className="apikey-input"
                placeholder="Enter your name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                maxLength={20}
              />
            </div>

            <button
              className="btn btn-primary"
              onClick={handleCreateRoom}
              style={{ width: "100%", marginBottom: 12 }}
            >
              <PlayIcon /> Create New Room
            </button>

            <div style={{ textAlign: "center", margin: "8px 0", color: "var(--text3)" }}>
              — or join existing —
            </div>

            <div className="wp-input-group">
              <label>Room Code</label>
              <input
                type="text"
                className="apikey-input"
                placeholder="e.g. ABC123"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                maxLength={6}
                style={{ textTransform: "uppercase", letterSpacing: 3 }}
              />
            </div>

            <button
              className="btn btn-ghost"
              onClick={handleJoinRoom}
              disabled={joinCode.length < 6}
              style={{ width: "100%" }}
            >
              Join Room
            </button>

            {error && (
              <div style={{ marginTop: 12, fontSize: 13, color: "var(--red)" }}>
                ✕ {error}
              </div>
            )}
          </div>
        ) : (
          /* ── Active Room ───────────────────────────────────────────────── */
          <div className="watch-party-active">
            {/* Room info bar */}
            <div className="wp-room-bar">
              <div className="wp-room-code">
                <span className="wp-label">Room</span>
                <span className="wp-code">{roomCode}</span>
                <button className="btn btn-ghost btn-icon" onClick={handleCopyCode} title="Copy code">
                  <CopyIcon />
                </button>
              </div>
              <div className="wp-participants-count">
                <UsersIcon />
                <span>{participants.length}</span>
              </div>
            </div>

            {/* Participants */}
            <div className="wp-participants">
              {participants.map((p, i) => (
                <div key={i} className="wp-participant">
                  <div className="wp-avatar">{p.name[0]?.toUpperCase()}</div>
                  <div className="wp-name">{p.name}</div>
                  {i === 0 && <span className="wp-host-badge">Host</span>}
                </div>
              ))}
            </div>

            {/* Playback status */}
            <div className="wp-playback">
              <div className="wp-playback-icon">
                {isPlaying ? <PlayIcon /> : <PauseIcon />}
              </div>
              <div className="wp-progress">
                <div className="wp-progress-bar">
                  <div
                    className="wp-progress-fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="wp-time">
                  {Math.floor(progress / 60)}:{String(Math.floor(progress % 60)).padStart(2, "0")} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
                </div>
              </div>
            </div>

            {/* Chat */}
            <div className="wp-chat">
              <div className="wp-chat-messages">
                {chatMessages.length === 0 && (
                  <div className="wp-chat-empty">No messages yet</div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className="wp-chat-msg">
                    <span className="wp-chat-sender">{msg.sender}</span>
                    <span className="wp-chat-text">{msg.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="wp-chat-input">
                <input
                  type="text"
                  placeholder="Send a message..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
                />
                <button className="btn btn-ghost btn-icon" onClick={handleSendChat}>
                  <SendIcon />
                </button>
              </div>
            </div>

            {/* Leave button */}
            <button
              className="btn btn-ghost"
              onClick={handleLeave}
              style={{ width: "100%", marginTop: 8 }}
            >
              Leave Room
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
