import { useState, useEffect } from "react";
import {
  normalizeAddonUrl,
  validateStremioManifest,
  fetchJsonViaBridge,
  loadInstalledAddons,
  saveInstalledAddons,
} from "../utils/stremio";

export default function StremioAddonsSection() {
  const [addons, setAddons] = useState(() => loadInstalledAddons());
  const [manifestInput, setManifestInput] = useState("");
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok: boolean, msg: string }

  useEffect(() => {
    const refresh = () => setAddons(loadInstalledAddons());
    window.addEventListener("streambert:addons-changed", refresh);
    return () => window.removeEventListener("streambert:addons-changed", refresh);
  }, []);

  const handleInstall = async (e) => {
    e?.preventDefault?.();
    const parsed = normalizeAddonUrl(manifestInput);
    if (!parsed) {
      setFeedback({
        ok: false,
        msg: "Enter a valid https://.../manifest.json or stremio://... URL.",
      });
      return;
    }

    setInstalling(true);
    setFeedback(null);
    try {
      const raw = await fetchJsonViaBridge(parsed.manifestUrl);
      const check = validateStremioManifest(raw);
      if (!check.valid) {
        setFeedback({ ok: false, msg: check.reason || "Invalid addon manifest." });
        return;
      }
      if (!check.supportsStream) {
        setFeedback({
          ok: false,
          msg: `"${check.name}" is a catalog/metadata addon only and does not provide streams.`,
        });
        return;
      }

      const nextAddon = {
        id: check.id,
        name: check.name,
        version: check.version,
        description: check.description,
        logo: check.logo,
        types: check.types,
        manifestUrl: parsed.manifestUrl,
        baseUrl: parsed.baseUrl,
        enabled: true,
        installedAt: Date.now(),
      };

      const current = loadInstalledAddons();
      const idx = current.findIndex(
        (a) => a.id === nextAddon.id || a.baseUrl === nextAddon.baseUrl,
      );
      const updated =
        idx >= 0
          ? current.map((a, i) => (i === idx ? { ...a, ...nextAddon } : a))
          : [...current, nextAddon];

      saveInstalledAddons(updated);
      setAddons(updated);
      setManifestInput("");
      setFeedback({
        ok: true,
        msg: `✓ Installed "${check.name}" v${check.version}`,
      });
    } catch (err) {
      setFeedback({
        ok: false,
        msg: `Could not load manifest: ${err.message}`,
      });
    } finally {
      setInstalling(false);
    }
  };

  const toggleAddon = (baseUrl) => {
    const updated = addons.map((a) =>
      a.baseUrl === baseUrl ? { ...a, enabled: a.enabled === false } : a,
    );
    saveInstalledAddons(updated);
    setAddons(updated);
  };

  const removeAddon = (baseUrl) => {
    const updated = addons.filter((a) => a.baseUrl !== baseUrl);
    saveInstalledAddons(updated);
    setAddons(updated);
  };

  return (
    <div style={{ marginBottom: 40 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <div className="settings-section-title" style={{ marginBottom: 0 }}>
          Stremio Addon Bridge
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 99,
            background: "rgba(229,9,20,0.14)",
            color: "var(--red)",
            border: "1px solid rgba(229,9,20,0.3)",
          }}
        >
          {addons.filter((a) => a.enabled !== false).length} Active
        </span>
      </div>

      <div
        style={{
          fontSize: 13,
          color: "var(--text3)",
          marginBottom: 16,
          lineHeight: 1.6,
        }}
      >
        Install any Stremio v1 stream addon via its{" "}
        <code
          style={{
            background: "var(--surface2)",
            padding: "1px 6px",
            borderRadius: 4,
            color: "var(--text2)",
          }}
        >
          manifest.json
        </code>{" "}
        or{" "}
        <code
          style={{
            background: "var(--surface2)",
            padding: "1px 6px",
            borderRadius: 4,
            color: "var(--text2)",
          }}
        >
          stremio://
        </code>{" "}
        link. Direct HTTP/HLS/Debrid streams play natively inside Streambert, MPV/VLC,
        or the download queue, while P2P streams expose one-click Magnet links.
      </div>

      {/* Addon Manifest Installer */}
      <form
        onSubmit={handleInstall}
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <input
          className="apikey-input"
          style={{ flex: 1, minWidth: 280, marginBottom: 0, height: 38 }}
          placeholder="Paste https://.../manifest.json or stremio://... link"
          value={manifestInput}
          onChange={(e) => {
            setManifestInput(e.target.value);
            if (feedback) setFeedback(null);
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={installing || !manifestInput.trim()}
          style={{ height: 38, padding: "0 18px" }}
        >
          {installing ? "Installing…" : "+ Install Addon"}
        </button>
      </form>

      {feedback && (
        <div
          style={{
            fontSize: 12.5,
            marginBottom: 14,
            color: feedback.ok ? "#48c774" : "#ff3860",
            fontWeight: 500,
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* Installed Addons List */}
      {addons.length === 0 ? (
        <div
          style={{
            background: "var(--surface)",
            border: "1px dashed var(--border)",
            borderRadius: 10,
            padding: "20px 22px",
            fontSize: 13,
            color: "var(--text3)",
            lineHeight: 1.6,
          }}
        >
          No Stremio stream addons installed yet. Paste an addon manifest URL above,
          then click <strong style={{ color: "var(--text2)" }}>🧩 Addons</strong> on any
          Movie or TV Show page to fetch streams.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {addons.map((addon) => {
            const isEnabled = addon.enabled !== false;
            return (
              <div
                key={addon.baseUrl}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "13px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  opacity: isEnabled ? 1 : 0.55,
                  transition: "opacity 0.15s",
                }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    background: "var(--surface2)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    flexShrink: 0,
                    fontSize: 18,
                  }}
                >
                  {addon.logo ? (
                    <img
                      src={addon.logo}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    "🧩"
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--text)",
                      }}
                    >
                      {addon.name}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text3)",
                        background: "var(--surface2)",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      v{addon.version || "1.0"}
                    </span>
                    {(addon.types || []).slice(0, 3).map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 10.5,
                          color: "var(--text2)",
                          background: "rgba(255,255,255,0.06)",
                          padding: "1px 6px",
                          borderRadius: 4,
                          textTransform: "capitalize",
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  {addon.description && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text3)",
                        marginTop: 3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {addon.description}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => toggleAddon(addon.baseUrl)}
                  style={{ height: 32, fontSize: 12, padding: "0 12px" }}
                >
                  {isEnabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeAddon(addon.baseUrl)}
                  title="Remove addon"
                  style={{
                    height: 32,
                    fontSize: 12,
                    padding: "0 10px",
                    color: "#ff5a79",
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
