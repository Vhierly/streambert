// ── WatchPartyModal ──────────────────────────────────────────────────────────
// Peer-to-peer watch party. There is no server, so "joining a room" means
// exchanging two blobs by hand rather than typing a room code — see
// utils/watchParty.js for why.
//
//   Host:   Create party → copy invite → send it → paste their reply → live
//   Guest:  paste invite → generate reply → send it back → live
//
// The old UI showed a 6-character room code and a "Join Room" box. That code
// only ever resolved locally: the WebSocket that would have carried it to
// another machine was commented out. A code that looks joinable and is not is
// worse than no code at all, so the field is gone.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  watchPartyCreateRoom,
  watchPartyJoinRoom,
  watchPartyAcceptAnswer,
  watchPartyLeaveRoom,
  watchPartySendChat,
  watchPartyGetState,
  watchPartyOnChange,
  watchPartyUpdateState,
  watchPartyGetSyncTarget,
  watchPartyShouldResync,
} from "../utils/watchParty";
import {
  onPlaybackProgress,
  getLastPlaybackProgress,
  requestPlaybackCommand,
} from "../utils/playbackBridge";
import { CloseIcon, CopyIcon, UsersIcon, SendIcon, PlayIcon } from "./Icons";

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

// The handshake has two halves and a different copy in each, so it is modelled
// as an explicit step rather than derived from status. "live" is not a step: it
// is the connected state, which can be arrived at from either side.
const STEP = {
  idle: null,
  hostInvite: "invite",
  hostAnswer: "answer",
  guestReply: "reply",
  live: null,
};

export default function WatchPartyModal({ onClose }) {
  const [name, setName] = useState("Guest");
  const [step, setStep] = useState(STEP.idle);
  const [room, setRoom] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [invite, setInvite] = useState("");
  const [reply, setReply] = useState("");
  const [blobInput, setBlobInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  // Playback comes from the bridge rather than props: the modal is mounted at
  // the App level while the <video> lives several components down, so there is
  // no prop path between them.
  const [play, setPlay] = useState(() => getLastPlaybackProgress());
  const chatEndRef = useRef(null);

  // One subscription drives every piece of room state. The module pushes on
  // each change rather than letting callers poll, so participants, chat and
  // connection status cannot disagree with each other.
  useEffect(() => {
    watchPartyOnChange((next) => {
      setRoom(next);
      if (next?.status === "connected") {
        setStep((cur) => (cur === STEP.live ? cur : STEP.live));
        setBlobInput("");
      }
    });
  }, []);

  // Follow the player wherever it is: native <video> or an embed webview both
  // publish here, so the watch party does not care which is live.
  useEffect(() => onPlaybackProgress(setPlay), []);

  // Report our own clock so the host's participant list can show it.
  useEffect(() => {
    watchPartyUpdateState({
      isPlaying: play.isPlaying,
      progress: play.currentTime,
      duration: play.duration,
    });
  }, [play]);

  // Guests obey the host: correct real drift, ignore sub-tolerance jitter.
  // The tolerance check lives in the module so this stays a policy decision
  // rather than a magic number here.
  useEffect(() => {
    if (!room || room.status !== "connected" || isHost) return;
    const id = setInterval(() => {
      if (!watchPartyShouldResync(play.currentTime)) return;
      const t = watchPartyGetSyncTarget();
      if (!t) return;
      requestPlaybackCommand(
        t.isPlaying ? "play" : "pause",
        t.target,
        t.duration,
      );
      if (Math.abs(t.target - play.currentTime) > 1.5) {
        requestPlaybackCommand("seek", t.target, t.duration);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [room?.status, isHost, play.currentTime]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.chat]);

  const copy = useCallback((text, which) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(which);
        setTimeout(() => setCopied(null), 1600);
      })
      .catch(() =>
        setError("Couldn't reach the clipboard — select the text and copy it manually."),
      );
  }, []);

  const handleHostStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await watchPartyCreateRoom(name || "Host");
      setInvite(r.invite);
      setRoom(watchPartyGetState());
      setIsHost(true);
      setStep(STEP.hostInvite);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [name]);

  const handleAcceptReply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await watchPartyAcceptAnswer(blobInput);
      setBlobInput("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [blobInput]);

  const handleJoinStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await watchPartyJoinRoom(blobInput, name || "Guest");
      setReply(r.answer);
      setRoom(watchPartyGetState());
      setIsHost(false);
      setStep(STEP.guestReply);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [blobInput, name]);

  const handleLeave = useCallback(() => {
    watchPartyLeaveRoom();
    setRoom(null);
    setStep(STEP.idle);
    setInvite("");
    setReply("");
    setBlobInput("");
    setError(null);
  }, []);

  const handleSendChat = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    watchPartySendChat(text);
    setChatInput("");
  }, [chatInput]);

  // Closing via the X has to tear the peer down too, otherwise the data channel
  // stays open and the other side keeps broadcasting into a window nobody sees.
  const handleClose = useCallback(() => {
    if (step !== STEP.idle) watchPartyLeaveRoom();
    onClose();
  }, [step, onClose]);

  const participants = room?.participants ?? [];
  const connected = room?.status === "connected";
  const pendingStep = STEP[step];
  const blobForCopy = step === STEP.hostInvite ? invite : reply;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div className="modal-box" style={{ maxWidth: 520, width: "92vw" }}>
        <div className="modal-header">
          <div>
            <h2>Watch Party</h2>
            <p className="modal-sub">
              {connected
                ? `${participants.length} watching together`
                : "Watch with someone — no account, no server"}
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={handleClose}>
            <CloseIcon />
          </button>
        </div>

        {step === STEP.idle && (
          <div className="watch-party-setup">
            <div className="wp-input-group">
              <label>Your Name</label>
              <input
                type="text"
                className="apikey-input"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
              />
            </div>

            <button
              className="btn btn-primary"
              onClick={handleHostStart}
              disabled={busy}
              style={{ width: "100%", marginBottom: 12 }}
            >
              <PlayIcon /> {busy ? "Setting up…" : "Create a Party"}
            </button>

            <div style={{ textAlign: "center", margin: "8px 0", color: "var(--text3)" }}>
              — or join one you were sent —
            </div>

            <div className="wp-input-group">
              <label>Invite Code</label>
              <input
                type="text"
                className="apikey-input"
                placeholder="Paste the invite your friend sent"
                value={blobInput}
                onChange={(e) => setBlobInput(e.target.value)}
              />
            </div>

            <button
              className="btn btn-ghost"
              onClick={handleJoinStart}
              disabled={busy || !blobInput.trim()}
              style={{ width: "100%" }}
            >
              {busy ? "Working…" : "Join"}
            </button>

            {error && (
              <div style={{ marginTop: 12, fontSize: 13, color: "var(--red)" }}>
                ✕ {error}
              </div>
            )}
          </div>
        )}

        {/* ── Handshake: an invite out, a reply back ───────────────────────── */}
        {pendingStep && (
          <div className="watch-party-setup">
            <ol className="wp-steps">
              <li className={pendingStep === "invite" ? "now" : "done"}>
                {pendingStep === "invite"
                  ? "Copy your invite and send it to your friend"
                  : "Invite sent"}
              </li>
              <li
                className={
                  pendingStep === "reply"
                    ? "now"
                    : pendingStep === "answer"
                      ? "now"
                      : ""
                }
              >
                {pendingStep === "reply"
                  ? "Send your reply back to the host"
                  : pendingStep === "answer"
                    ? "Paste the reply they send back"
                    : "Waiting for their reply"}
              </li>
              <li>Watching together</li>
            </ol>

            {(step === STEP.hostInvite || step === STEP.guestReply) && (
              <div className="wp-input-group">
                <label>
                  {step === STEP.hostInvite
                    ? "Your invite"
                    : "Your reply — send this back to the host"}
                </label>
                <textarea
                  className="apikey-input wp-blob"
                  readOnly
                  value={blobForCopy}
                  rows={4}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => copy(blobForCopy, step)}
                  style={{ marginTop: 6 }}
                >
                  <CopyIcon /> {copied === step ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            {step === STEP.hostAnswer && (
              <div className="wp-input-group">
                <label>Their reply</label>
                <textarea
                  className="apikey-input wp-blob"
                  placeholder="Paste it here"
                  value={blobInput}
                  onChange={(e) => setBlobInput(e.target.value)}
                  rows={3}
                />
              </div>
            )}

            {step === STEP.hostAnswer && (
              <button
                className="btn btn-primary"
                onClick={handleAcceptReply}
                disabled={busy || !blobInput.trim()}
                style={{ width: "100%" }}
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            )}

            {step === STEP.hostInvite && (
              <p className="wp-hint">
                Your friend pastes this, sends their reply back, then you paste
                that below to go live.
              </p>
            )}

            {step === STEP.guestReply && (
              <p className="wp-hint">
                Send that to the host. You&apos;ll connect as soon as they paste
                it in.
              </p>
            )}

            {room?.error && (
              <div style={{ marginTop: 12, fontSize: 13, color: "var(--red)" }}>
                ✕ {room.error}
              </div>
            )}

            <button
              className="btn btn-ghost"
              onClick={handleLeave}
              style={{ width: "100%", marginTop: 10 }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Live room ────────────────────────────────────────────────────── */}
        {step === STEP.live && (
          <div className="watch-party-active">
            <div className="wp-room-bar">
              <div className="wp-participants-count">
                <UsersIcon />
                <span>
                  {participants.length}{" "}
                  {participants.length === 1 ? "person" : "people"}
                </span>
              </div>
              {isHost && <span className="wp-host-badge">You&apos;re hosting</span>}
            </div>

            <div className="wp-participants">
              {participants.map((p) => (
                <div key={p.id} className="wp-participant">
                  <div className="wp-avatar">{p.name?.[0]?.toUpperCase()}</div>
                  <div className="wp-name">
                    {p.isLocal ? `${p.name} (you)` : p.name}
                  </div>
                  {p.isHost && <span className="wp-host-badge">Host</span>}
                </div>
              ))}
            </div>

            <div className="wp-playback">
              <div className="wp-playback-icon">
                <PlayIcon />
              </div>
              <div className="wp-progress">
                <div className="wp-progress-bar">
                  <div
                    className="wp-progress-fill"
                    style={{
                      width:
                        play.duration > 0
                          ? `${Math.min(100, Math.round((play.currentTime / play.duration) * 100))}%`
                          : "0%",
                    }}
                  />
                </div>
                <div className="wp-time">
                  {fmtTime(play.currentTime)} / {fmtTime(play.duration)}
                </div>
              </div>
            </div>

            {!isHost && (
              <p className="wp-hint">
                Playback follows the host — if they pause, seek or resume, so do you.
              </p>
            )}

            <div className="wp-chat">
              <div className="wp-chat-messages">
                {!room?.chat?.length && (
                  <div className="wp-chat-empty">No messages yet</div>
                )}
                {room?.chat?.map((m) => (
                  <div
                    key={m.id}
                    className={"wp-chat-msg" + (m.mine ? " wp-chat-msg--mine" : "")}
                  >
                    <span className="wp-chat-sender">{m.sender}</span>
                    <span className="wp-chat-text">{m.text}</span>
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

            <button
              className="btn btn-ghost"
              onClick={handleLeave}
              style={{ width: "100%", marginTop: 8 }}
            >
              Leave Party
            </button>
          </div>
        )}
      </div>
    </div>
  );
}