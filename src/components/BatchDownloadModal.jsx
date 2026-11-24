import { useState, useEffect } from "react";
import { CloseIcon, DownloadIcon } from "./Icons";
import { storage, STORAGE_KEYS, isElectron } from "../utils/storage";

export default function BatchDownloadModal({
  showTitle,
  searchTitles = [],
  seasonNumber,
  episodes = [],
  watched = {},
  tmdbId,
  posterPath,
  dubMode = "sub",
  onDownloadStarted,
  onClose,
}) {
  const [selectedEps, setSelectedEps] = useState(() => {
    const unwatched = episodes
      .filter((ep) => !watched?.[`tv_${tmdbId}_s${seasonNumber}e${ep.episode_number}`])
      .map((ep) => ep.episode_number);
    return unwatched.length > 0
      ? unwatched
      : episodes.map((ep) => ep.episode_number);
  });
  const [downloadPath, setDownloadPath] = useState(
    () => storage.get(STORAGE_KEYS.DOWNLOAD_PATH) || "",
  );
  const [downloader, setDownloader] = useState(null);
  const [enqueueState, setEnqueueState] = useState(null); // null | { current, total, queued, errors }

  useEffect(() => {
    if (!isElectron) return;
    const folder = storage.get(STORAGE_KEYS.DOWNLOADER_FOLDER) || "";
    window.electron.checkDownloader(folder).then(setDownloader);
  }, []);

  const toggleEp = (epNum) => {
    setSelectedEps((prev) =>
      prev.includes(epNum)
        ? prev.filter((n) => n !== epNum)
        : [...prev, epNum].sort((a, b) => a - b),
    );
  };

  const handleStartBatch = async () => {
    if (!isElectron || !downloader?.token || !downloadPath || !selectedEps.length) {
      return;
    }
    let queued = 0;
    let errors = 0;
    setEnqueueState({ current: 0, total: selectedEps.length, queued: 0, errors: 0 });

    for (let i = 0; i < selectedEps.length; i++) {
      const epNum = selectedEps[i];
      setEnqueueState({
        current: i + 1,
        total: selectedEps.length,
        queued,
        errors,
      });
      try {
        const res = await window.electron.resolveHiAnime({
          titles: searchTitles.filter(Boolean),
          episode: epNum,
          dub: dubMode === "dub",
        });
        if (!res?.ok || !res.m3u8Url) {
          errors++;
          continue;
        }
        const epObj = episodes.find((e) => e.episode_number === epNum);
        const epLabel = `S${String(seasonNumber).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;
        const mediaName = `${showTitle} - ${epLabel}${epObj?.name ? ` - ${epObj.name}` : ""}`;
        const subs = Array.isArray(res.subtitles)
          ? res.subtitles
              .filter((s) => s?.file && s?.kind !== "thumbnails")
              .map((s) => ({
                url: s.file,
                lang: (s.label || "en").slice(0, 12).toLowerCase(),
              }))
          : [];

        const dlRes = await window.electron.runDownload({
          token: downloader.token,
          m3u8Url: res.m3u8Url,
          streamHeaders: res.referer ? { referer: res.referer } : null,
          subtitles: subs,
          name: mediaName,
          downloadPath,
          mediaId: tmdbId,
          mediaType: "tv",
          season: seasonNumber,
          episode: epNum,
          posterPath: posterPath || null,
          tmdbId,
        });

        if (dlRes?.ok) {
          queued++;
          onDownloadStarted?.({
            id: dlRes.id,
            name: mediaName,
            m3u8Url: res.m3u8Url,
            downloadPath,
            filePath: null,
            status: dlRes.status || "queued",
            progress: 0,
            speed: "",
            size: "",
            totalFragments: 0,
            lastMessage:
              dlRes.status === "queued"
                ? "Queued — waiting for slot"
                : "Starting…",
            startedAt: Date.now(),
            completedAt: null,
            mediaId: tmdbId,
            mediaType: "tv",
            season: seasonNumber,
            episode: epNum,
            posterPath: posterPath || null,
            tmdbId,
            subtitles: subs,
            subtitlePaths: [],
          });
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }

    setEnqueueState({
      current: selectedEps.length,
      total: selectedEps.length,
      queued,
      errors,
      done: true,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="download-modal"
        style={{ width: 540, maxWidth: "95vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="download-modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DownloadIcon /> Batch Season Download — Season {seasonNumber}
          </span>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Folder picker if missing */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ color: "var(--text3)" }}>Save to:</span>
            <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {downloadPath || "Not set"}
            </code>
            <button
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={async () => {
                const f = await window.electron?.pickFolder?.();
                if (f) {
                  setDownloadPath(f);
                  storage.set(STORAGE_KEYS.DOWNLOAD_PATH, f);
                }
              }}
            >
              Browse
            </button>
          </div>

          {!downloader?.exists && (
            <div className="download-error">
              Downloader not configured. Install <code>yt-dlp</code> on your system
              or select your <code>vid-dl-cli-only</code> folder in any single
              episode Download dialog first.
            </div>
          )}

          {/* Selection quick actions */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500 }}>
              {selectedEps.length} of {episodes.length} episodes selected ({dubMode.toUpperCase()})
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => setSelectedEps(episodes.map((e) => e.episode_number))}
              >
                All
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => setSelectedEps([])}
              >
                None
              </button>
            </div>
          </div>

          {/* Episode checklist */}
          <div
            style={{
              maxHeight: 260,
              overflowY: "auto",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(115px, 1fr))",
              gap: 6,
              padding: 4,
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            {episodes.map((ep) => {
              const checked = selectedEps.includes(ep.episode_number);
              return (
                <button
                  key={ep.episode_number}
                  type="button"
                  onClick={() => toggleEp(ep.episode_number)}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 6,
                    border: `1px solid ${checked ? "var(--red)" : "var(--border)"}`,
                    background: checked ? "var(--red-dim)" : "var(--surface)",
                    color: checked ? "var(--text)" : "var(--text2)",
                    fontSize: 12,
                    fontWeight: checked ? 600 : 400,
                    cursor: "pointer",
                    textAlign: "left",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={ep.name || `Episode ${ep.episode_number}`}
                >
                  {checked ? "✓ " : ""}Ep {ep.episode_number}
                </button>
              );
            })}
          </div>

          {enqueueState && (
            <div style={{ fontSize: 13, color: "var(--text2)" }}>
              {enqueueState.done
                ? `✓ Queued ${enqueueState.queued} episode${enqueueState.queued !== 1 ? "s" : ""}${enqueueState.errors ? ` (${enqueueState.errors} unavailable)` : ""}.`
                : `Resolving stream ${enqueueState.current} / ${enqueueState.total}… (${enqueueState.queued} queued)`}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            {enqueueState?.done ? (
              <button
                className="btn btn-primary"
                style={{ flex: 1, justifyContent: "center" }}
                onClick={onClose}
              >
                Done — View in Downloads
              </button>
            ) : (
              <button
                className="btn btn-primary"
                style={{ flex: 1, justifyContent: "center" }}
                disabled={
                  !downloader?.exists ||
                  !downloadPath ||
                  selectedEps.length === 0 ||
                  !!enqueueState
                }
                onClick={handleStartBatch}
              >
                <DownloadIcon />
                {enqueueState
                  ? "Queueing Episodes…"
                  : `Queue ${selectedEps.length} Episode${selectedEps.length !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
