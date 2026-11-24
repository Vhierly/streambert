import { useState, useEffect } from "react";
import {
  FEATURED_COMMUNITY_ADDONS,
  installAddonFromUrl,
  loadInstalledAddons,
  saveInstalledAddons,
} from "../utils/stremio";
import { isElectron } from "../utils/storage";

export default function StremioAddonsSection() {
  const [addons, setAddons] = useState(() => loadInstalledAddons());
  const [manifestInput, setManifestInput] = useState("");
  const [busyUrl, setBusyUrl] = useState(null);
  const [feedback, setFeedback] = useState(null); // { ok: boolean, msg: string }

  useEffect(() => {
    const refresh = () => setAddons(loadInstalledAddons());
    window.addEventListener("streambert:addons-changed", refresh);
    return () => window.removeEventListener("streambert:addons-changed", refresh);
  }, []);

  const doInstall = async (urlToInstall, clearInput = false) => {
    setBusyUrl(urlToInstall);
    setFeedback(null);
    try {
      const { addon, list } = await installAddonFromUrl(urlToInstall);
      setAddons(list);
      if (clearInput) setManifestInput("");
      setFeedback({
        ok: true,
        msg: `✓ Installed "${addon.name}" v${addon.version}`,
      });
    } catch (err) {
      setFeedback({
        ok: false,
        msg: `Could not install addon: ${err.message} (Tip: enable Encrypted DNS / DoH above if your ISP blocks the addon host)`,
      });
    } finally {
      setBusyUrl(null);
    }
  };

  const handleManualSubmit = (e) => {
    e?.preventDefault?.();
    if (!manifestInput.trim()) return;
    doInstall(manifestInput.trim(), true);
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

  const isFeaturedInstalled = (feat) =>
    addons.some(
      (a) =>
        a.id === feat.id ||
        a.manifestUrl?.toLowerCase() === feat.manifestUrl.toLowerCase(),
    );

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
          Stremio Addon Bridge & Community Store
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
        One-click install popular community stream addons below, or paste any custom{" "}
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
        /{" "}
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
        link (e.g. configured with Real-Debrid / TorBox).
      </div>

      {/* 1-Click Featured Community Addons Grid */}
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text2)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 10,
        }}
      >
        Featured Community Addons (1-Click Install)
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
          gap: 10,
          marginBottom: 20,
        }}
      >
        {FEATURED_COMMUNITY_ADDONS.map((feat) => {
          const installed = isFeaturedInstalled(feat);
          const installingThis = busyUrl === feat.manifestUrl;
          return (
            <div
              key={feat.manifestUrl}
              style={{
                background: "var(--surface)",
                border: `1px solid ${installed ? "rgba(72,199,116,0.4)" : "var(--border)"}`,
                borderRadius: 10,
                padding: "13px 15px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                    marginBottom: 5,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                    {feat.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      padding: "1px 7px",
                      borderRadius: 99,
                      background:
                        feat.badge === "Direct HTTP"
                          ? "rgba(72, 199, 116, 0.14)"
                          : "rgba(229, 9, 20, 0.14)",
                      color: feat.badge === "Direct HTTP" ? "#48c774" : "var(--red)",
                    }}
                  >
                    {feat.badge}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: 1.5 }}>
                  {feat.description}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--text3)" }}>{feat.kind}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {feat.configureUrl && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 28, fontSize: 11.5, padding: "0 8px" }}
                      title="Open web configurator (e.g. for Debrid keys)"
                      onClick={() =>
                        isElectron && window.electron?.openExternal
                          ? window.electron.openExternal(feat.configureUrl)
                          : window.open(feat.configureUrl, "_blank", "noopener")
                      }
                    >
                      Configure ↗
                    </button>
                  )}
                  <button
                    type="button"
                    className={installed ? "btn btn-secondary" : "btn btn-primary"}
                    disabled={!!busyUrl || installed}
                    style={{ height: 28, fontSize: 11.5, padding: "0 11px" }}
                    onClick={() => doInstall(feat.manifestUrl)}
                  >
                    {installed
                      ? "✓ Installed"
                      : installingThis
                        ? "Installing…"
                        : "+ Install"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom Manifest Input */}
      <form
        onSubmit={handleManualSubmit}
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
          placeholder="Or paste custom https://.../manifest.json or stremio://... link"
          value={manifestInput}
          onChange={(e) => {
            setManifestInput(e.target.value);
            if (feedback) setFeedback(null);
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!!busyUrl || !manifestInput.trim()}
          style={{ height: 38, padding: "0 16px" }}
        >
          {busyUrl === manifestInput.trim() ? "Installing…" : "+ Add Custom URL"}
        </button>
      </form>

      {feedback && (
        <div
          style={{
            fontSize: 12.5,
            marginBottom: 14,
            color: feedback.ok ? "#48c774" : "#ff5c66",
            fontWeight: 500,
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* Installed Addons List */}
      {addons.length > 0 && (
        <>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text2)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 8,
            }}
          >
            Installed Addons ({addons.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {addons.map((addon) => {
              const isEnabled = addon.enabled !== false;
              return (
                <div
                  key={addon.baseUrl}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "11px 15px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    opacity: isEnabled ? 1 : 0.55,
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      background: "var(--surface2)",
                      border: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                      flexShrink: 0,
                      fontSize: 16,
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
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
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
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => toggleAddon(addon.baseUrl)}
                    style={{ height: 30, fontSize: 12, padding: "0 10px" }}
                  >
                    {isEnabled ? "Enabled" : "Disabled"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => removeAddon(addon.baseUrl)}
                    style={{ height: 30, fontSize: 12, padding: "0 10px", color: "#ff5a79" }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
