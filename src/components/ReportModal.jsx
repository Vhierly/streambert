import { useEffect, useState } from "react";
import { CloseIcon, FlagIcon, WarningIcon } from "./Icons";

const KIND_LABELS = {
  broken_stream: "Broken Stream",
  wrong_metadata: "Wrong Metadata",
  missing_subtitle: "Missing Subtitle",
};

function buildIssueUrl({ kind, mediaType, tmdbId, season, episode, title, sourceId, note }) {
  const kindLabel = KIND_LABELS[kind] || kind;
  let issueTitle = `[${kindLabel}] ${title}`;
  if (mediaType === "tv" && season && episode)
    issueTitle += ` (S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")})`;
  if (sourceId) issueTitle += ` [source: ${sourceId}]`;

  const lines = [
    `**Report type:** ${kindLabel}`,
    `**Media type:** ${mediaType}`,
    `**TMDB ID:** ${tmdbId}`,
  ];
  if (mediaType === "tv" && season && episode)
    lines.push(`**Season / Episode:** S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
  if (title) lines.push(`**Title:** ${title}`);
  if (sourceId) lines.push(`**Source:** ${sourceId}`);
  if (note) lines.push("", "**User note:**", "", note);
  lines.push("", "---", "_Reported via Streambert in-app report_");

  const body = encodeURIComponent(lines.join("\n"));
  const titleEnc = encodeURIComponent(issueTitle);
  return `https://github.com/truelockmc/streambert/issues/new?title=${titleEnc}&body=${body}`;
}

export default function ReportModal({
  mediaType,
  tmdbId,
  title,
  season,
  episode,
  sourceId,
  onClose,
}) {
  const [kind, setKind] = useState("broken_stream");
  const [note, setNote] = useState("");
  const [health, setHealth] = useState(null);
  const [voted, setVoted] = useState(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const effectiveSourceId = kind === "missing_subtitle" ? sourceId : null;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (kind === "missing_subtitle" && sourceId) {
      window.electron?.getSourceHealth?.().then((all) => {
        setHealth(all?.[sourceId] || { up: 0, down: 0 });
      }).catch(() => {});
    }
  }, [kind, sourceId]);

  async function handleVote(vote) {
    if (voted || !sourceId) return;
    try {
      const result = await window.electron?.voteSourceHealth?.(sourceId, vote);
      setHealth(result);
      setVoted(vote);
    } catch {}
  }

  function handleCopy() {
    const text = buildIssueUrl({
      kind, mediaType, tmdbId, season, episode, title,
      sourceId: effectiveSourceId, note,
    });
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  function handleOpenIssue() {
    const url = buildIssueUrl({
      kind, mediaType, tmdbId, season, episode, title,
      sourceId: effectiveSourceId, note,
    });
    window.electron?.openExternal?.(url);
    onClose();
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await window.electron?.addReport?.({
        kind, mediaType, tmdbId, season, episode, title,
        sourceId: effectiveSourceId, note,
      });
      onClose();
    } catch (err) {
      setError(err.message || "Failed to submit report");
      setSubmitting(false);
    }
  }

  return (
    <div className="blocked-modal-overlay" onClick={onClose}>
      <div className="blocked-modal" onClick={(e) => e.stopPropagation()}>
        <div className="blocked-modal-header">
          <div className="blocked-modal-title">
            <FlagIcon size={15} />
            Report Issue
          </div>
          <button className="blocked-modal-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="blocked-modal-subtitle">
          Help improve Streambert by reporting broken streams, wrong metadata, or missing subtitles.
        </div>

        <div className="report-modal-body">
          {/* Kind picker */}
          <div className="report-modal-section">
            <label className="report-modal-label">Issue type</label>
            <div className="report-kind-picker">
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <button
                  key={k}
                  className={`report-kind-btn${kind === k ? " report-kind-btn--active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Source health vote — only for missing_subtitle */}
          {kind === "missing_subtitle" && sourceId && (
            <div className="report-modal-section">
              <label className="report-modal-label">Source health — {sourceId}</label>
              <div className="report-vote-row">
                <button
                  className={`report-vote-btn${voted === "up" ? " report-vote-btn--up-active" : ""}`}
                  onClick={() => handleVote("up")}
                  disabled={!!voted}
                >
                  ▲ Working ({health?.up ?? 0})
                </button>
                <button
                  className={`report-vote-btn${voted === "down" ? " report-vote-btn--down-active" : ""}`}
                  onClick={() => handleVote("down")}
                  disabled={!!voted}
                >
                  ▼ Broken ({health?.down ?? 0})
                </button>
              </div>
            </div>
          )}

          {/* Note */}
          <div className="report-modal-section">
            <label className="report-modal-label">
              Additional details <span className="report-modal-optional">(optional)</span>
            </label>
            <textarea
              className="report-modal-textarea"
              placeholder="Describe the issue..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              rows={3}
            />
          </div>

          {error && (
            <div className="report-modal-error">
              <WarningIcon size={14} />
              {error}
            </div>
          )}
        </div>

        <div className="blocked-modal-footer" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="report-action-btn" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy issue URL"}
            </button>
            <button className="report-action-btn" onClick={handleOpenIssue}>
              Open GitHub Issue
            </button>
          </div>
          <button
            className="report-action-btn report-action-btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Submitting..." : "Submit Report"}
          </button>
        </div>
      </div>
    </div>
  );
}
