import { useState, useEffect, useRef } from "react";
import { storage, secureStorage, STORAGE_KEYS } from "../utils/storage";
import { tmdbFetch } from "../utils/api";
import {
  verifyAnilistToken,
  pullAnilistWatchlist,
  verifyTraktCredentials,
  pullTraktWatchlist,
  parseWatchlistImport,
} from "../utils/syncProviders";

async function mergeImportedCandidates(candidates, apiKey, onProgress) {
  const saved = storage.get(STORAGE_KEYS.SAVED) || {};
  const savedOrder = storage.get(STORAGE_KEYS.SAVED_ORDER) || Object.keys(saved);
  const statusMap = storage.get(STORAGE_KEYS.LIBRARY_STATUS) || {};
  let added = 0;

  const capped = candidates.slice(0, 150);
  for (let i = 0; i < capped.length; i++) {
    const entry = capped[i];
    onProgress?.(i + 1, capped.length);
    try {
      let resolved = null;

      if (entry.tmdbId && entry.mediaType) {
        const d = await tmdbFetch(`/${entry.mediaType}/${entry.tmdbId}`, apiKey);
        if (d?.id) resolved = { ...d, media_type: entry.mediaType };
      } else if (entry.imdbId && apiKey) {
        const f = await tmdbFetch(
          `/find/${entry.imdbId}?external_source=imdb_id`,
          apiKey,
        );
        const hit = f?.movie_results?.[0]
          ? { ...f.movie_results[0], media_type: "movie" }
          : f?.tv_results?.[0]
            ? { ...f.tv_results[0], media_type: "tv" }
            : null;
        resolved = hit;
      } else if (entry.title && apiKey) {
        const s = await tmdbFetch(
          `/search/multi?query=${encodeURIComponent(entry.title)}&page=1`,
          apiKey,
        );
        const list = (s?.results || []).filter(
          (r) => r.media_type === "movie" || r.media_type === "tv",
        );
        resolved =
          list.find((r) => r.media_type === entry.mediaHint) || list[0] || null;
      }

      if (!resolved?.id) continue;
      const mt = resolved.media_type || entry.mediaHint || "movie";
      const key = `${mt}_${resolved.id}`;

      if (!saved[key]) {
        saved[key] = {
          id: resolved.id,
          title: resolved.title || resolved.name || entry.title,
          poster_path: resolved.poster_path || null,
          media_type: mt,
          vote_average: resolved.vote_average || 0,
          year: (
            resolved.release_date ||
            resolved.first_air_date ||
            entry.year ||
            ""
          ).slice(0, 4),
        };
        if (!savedOrder.includes(key)) savedOrder.push(key);
        added++;
      }
      if (entry.status && !statusMap[key]) {
        statusMap[key] = entry.status;
      }
    } catch {}
  }

  storage.set(STORAGE_KEYS.SAVED, saved);
  storage.set(STORAGE_KEYS.SAVED_ORDER, savedOrder);
  storage.set(STORAGE_KEYS.LIBRARY_STATUS, statusMap);
  window.dispatchEvent(new CustomEvent("streambert:library-imported"));
  return added;
}

export default function AccountSyncSection({ apiKey }) {
  const [anilistToken, setAnilistToken] = useState("");
  const [anilistEnabled, setAnilistEnabled] = useState(
    () => !!storage.get(STORAGE_KEYS.ANILIST_SYNC_ENABLED),
  );
  const [anilistMsg, setAnilistMsg] = useState(null);

  const [traktClientId, setTraktClientId] = useState("");
  const [traktToken, setTraktToken] = useState("");
  const [traktEnabled, setTraktEnabled] = useState(
    () => !!storage.get(STORAGE_KEYS.TRAKT_SYNC_ENABLED),
  );
  const [traktMsg, setTraktMsg] = useState(null);

  const [importMsg, setImportMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      secureStorage.get(STORAGE_KEYS.ANILIST_TOKEN),
      secureStorage.get(STORAGE_KEYS.TRAKT_CLIENT_ID),
      secureStorage.get(STORAGE_KEYS.TRAKT_TOKEN),
    ]).then(([al, tCid, tTok]) => {
      if (!mounted) return;
      if (al) setAnilistToken(al);
      if (tCid) setTraktClientId(tCid);
      if (tTok) setTraktToken(tTok);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSaveAnilist = async () => {
    setBusy(true);
    setAnilistMsg(null);
    try {
      const trimmed = anilistToken.trim();
      await secureStorage.set(STORAGE_KEYS.ANILIST_TOKEN, trimmed);
      if (!trimmed) {
        storage.set(STORAGE_KEYS.ANILIST_SYNC_ENABLED, false);
        setAnilistEnabled(false);
        setAnilistMsg({ ok: true, text: "AniList token cleared." });
      } else {
        const user = await verifyAnilistToken(trimmed);
        storage.set(STORAGE_KEYS.ANILIST_SYNC_ENABLED, true);
        setAnilistEnabled(true);
        setAnilistMsg({
          ok: true,
          text: `✓ Connected as ${user?.name || "AniList user"}`,
        });
      }
    } catch (e) {
      setAnilistMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handlePullAnilist = async () => {
    if (!anilistToken.trim() || !apiKey) return;
    setBusy(true);
    setAnilistMsg({ ok: true, text: "Fetching AniList library…" });
    try {
      const entries = await pullAnilistWatchlist(anilistToken.trim());
      const added = await mergeImportedCandidates(
        entries,
        apiKey,
        (cur, tot) =>
          setAnilistMsg({
            ok: true,
            text: `Matching with TMDB (${cur}/${tot})…`,
          }),
      );
      setAnilistMsg({
        ok: true,
        text: `✓ Imported ${added} new anime title${added !== 1 ? "s" : ""} from AniList`,
      });
    } catch (e) {
      setAnilistMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTrakt = async () => {
    setBusy(true);
    setTraktMsg(null);
    try {
      const cid = traktClientId.trim();
      const tok = traktToken.trim();
      await secureStorage.set(STORAGE_KEYS.TRAKT_CLIENT_ID, cid);
      await secureStorage.set(STORAGE_KEYS.TRAKT_TOKEN, tok);
      if (!cid || !tok) {
        storage.set(STORAGE_KEYS.TRAKT_SYNC_ENABLED, false);
        setTraktEnabled(false);
        setTraktMsg({ ok: true, text: "Trakt credentials cleared." });
      } else {
        const user = await verifyTraktCredentials({ clientId: cid, token: tok });
        storage.set(STORAGE_KEYS.TRAKT_SYNC_ENABLED, true);
        setTraktEnabled(true);
        setTraktMsg({
          ok: true,
          text: `✓ Connected as ${user?.username || "Trakt user"}`,
        });
      }
    } catch (e) {
      setTraktMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handlePullTrakt = async () => {
    if (!traktClientId.trim() || !traktToken.trim() || !apiKey) return;
    setBusy(true);
    setTraktMsg({ ok: true, text: "Fetching Trakt watchlist…" });
    try {
      const entries = await pullTraktWatchlist({
        clientId: traktClientId.trim(),
        token: traktToken.trim(),
      });
      const added = await mergeImportedCandidates(
        entries,
        apiKey,
        (cur, tot) =>
          setTraktMsg({ ok: true, text: `Importing (${cur}/${tot})…` }),
      );
      setTraktMsg({
        ok: true,
        text: `✓ Imported ${added} new title${added !== 1 ? "s" : ""} from Trakt`,
      });
    } catch (e) {
      setTraktMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleFileImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !apiKey) return;
    setBusy(true);
    setImportMsg({ ok: true, text: `Reading ${file.name}…` });
    try {
      const text = await file.text();
      const parsed = parseWatchlistImport(text, file.name);
      if (!parsed.length) {
        setImportMsg({
          ok: false,
          text: "No recognizable IMDb, Letterboxd, or MAL entries found.",
        });
        return;
      }
      const added = await mergeImportedCandidates(parsed, apiKey, (cur, tot) =>
        setImportMsg({
          ok: true,
          text: `Matching ${cur} / ${tot} titles…`,
        }),
      );
      setImportMsg({
        ok: true,
        text: `✓ Imported ${added} new title${added !== 1 ? "s" : ""} (${parsed.length} parsed)`,
      });
    } catch (err) {
      setImportMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 40 }}>
      <div className="settings-section-title">
        Account Sync &amp; Watchlist Import
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text3)",
          marginBottom: 18,
          lineHeight: 1.6,
        }}
      >
        Sync watched episodes and movies directly with AniList or Trakt.tv
        (tokens are encrypted locally via your OS keychain), or import existing
        lists from IMDb CSV, Letterboxd CSV, or MyAnimeList XML.
      </div>

      {/* AniList Card */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "18px 20px",
          marginBottom: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>AniList 2-Way Sync</span>
          <label style={{ fontSize: 12, color: "var(--text2)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={anilistEnabled}
              onChange={(e) => {
                setAnilistEnabled(e.target.checked);
                storage.set(STORAGE_KEYS.ANILIST_SYNC_ENABLED, e.target.checked);
              }}
            />
            Auto-scrobble anime
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="password"
            className="apikey-input"
            style={{ flex: 1, minWidth: 220, marginBottom: 0 }}
            placeholder="AniList Personal Access Token…"
            value={anilistToken}
            onChange={(e) => setAnilistToken(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={handleSaveAnilist}
          >
            Save &amp; Verify
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy || !anilistToken.trim() || !apiKey}
            onClick={handlePullAnilist}
          >
            Pull Watchlist
          </button>
        </div>
        {anilistMsg && (
          <div style={{ fontSize: 12, color: anilistMsg.ok ? "#48c774" : "var(--red)" }}>
            {anilistMsg.text}
          </div>
        )}
      </div>

      {/* Trakt Card */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "18px 20px",
          marginBottom: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Trakt.tv Scrobbling</span>
          <label style={{ fontSize: 12, color: "var(--text2)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={traktEnabled}
              onChange={(e) => {
                setTraktEnabled(e.target.checked);
                storage.set(STORAGE_KEYS.TRAKT_SYNC_ENABLED, e.target.checked);
              }}
            />
            Auto-scrobble movies &amp; series
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            className="apikey-input"
            style={{ flex: 1, minWidth: 180, marginBottom: 0 }}
            placeholder="Trakt Client ID…"
            value={traktClientId}
            onChange={(e) => setTraktClientId(e.target.value)}
          />
          <input
            type="password"
            className="apikey-input"
            style={{ flex: 1, minWidth: 180, marginBottom: 0 }}
            placeholder="Trakt Access Token…"
            value={traktToken}
            onChange={(e) => setTraktToken(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={handleSaveTrakt}
          >
            Save &amp; Verify
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy || !traktClientId.trim() || !traktToken.trim() || !apiKey}
            onClick={handlePullTrakt}
          >
            Pull Watchlist
          </button>
        </div>
        {traktMsg && (
          <div style={{ fontSize: 12, color: traktMsg.ok ? "#48c774" : "var(--red)" }}>
            {traktMsg.text}
          </div>
        )}
      </div>

      {/* CSV / XML Import Card */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "18px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Import CSV / XML Watchlist
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
            Supports IMDb Watchlist (.csv), Letterboxd (.csv), and MyAnimeList (.xml)
          </div>
          {importMsg && (
            <div style={{ fontSize: 12, marginTop: 6, color: importMsg.ok ? "#48c774" : "var(--red)" }}>
              {importMsg.text}
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xml"
          style={{ display: "none" }}
          onChange={handleFileImport}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !apiKey}
          onClick={() => fileRef.current?.click()}
        >
          Import File…
        </button>
      </div>
    </div>
  );
}
