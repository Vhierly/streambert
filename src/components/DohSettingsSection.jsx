import { useState, useEffect } from "react";
import { isElectron } from "../utils/storage";

const DOH_OPTIONS = [
  {
    id: "cloudflare",
    label: "Cloudflare (1.1.1.1)",
    badge: "Recommended",
    desc: "Fastest global latency, bypasses Indonesian ISP transparent DNS hijacking",
  },
  {
    id: "google",
    label: "Google (8.8.8.8)",
    badge: null,
    desc: "Reliable global encrypted DNS resolver via 8.8.8.8",
  },
  {
    id: "adguard",
    label: "AdGuard DNS",
    badge: "Ad-Block",
    desc: "Encrypted DNS with built-in tracker & ad domain filtering",
  },
  {
    id: "quad9",
    label: "Quad9 (9.9.9.9)",
    badge: "Security",
    desc: "Blocks known malware & phishing domains at DNS level",
  },
  {
    id: "custom",
    label: "Custom URL",
    badge: null,
    desc: "Use your own RFC 8484 DNS-over-HTTPS endpoint (NextDNS, ControlD, etc.)",
  },
];

export default function DohSettingsSection() {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("cloudflare");
  const [customUrl, setCustomUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState(null); // { ok: boolean, msg: string }
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      if (!isElectron || !window.electron?.getDohSettings) {
        setLoading(false);
        return;
      }
      try {
        const cfg = await window.electron.getDohSettings();
        if (active && cfg) {
          setEnabled(!!cfg.enabled);
          setProvider(cfg.provider || "cloudflare");
          setCustomUrl(cfg.customUrl || "");
        }
      } catch {
        // ignore
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const applyConfig = async (next) => {
    setStatus(null);
    if (!isElectron || !window.electron?.setDohSettings) return;
    try {
      const res = await window.electron.setDohSettings(next);
      if (res?.ok) {
        setSavedMsg("✓ Applied live (no restart needed)");
        setTimeout(() => setSavedMsg(""), 2500);
      } else {
        setStatus({ ok: false, msg: res?.error || "Failed to apply DoH config" });
      }
    } catch (e) {
      setStatus({ ok: false, msg: e.message });
    }
  };

  const handleToggle = (val) => {
    setEnabled(val);
    applyConfig({ enabled: val, provider, customUrl });
  };

  const handleProviderSelect = (id) => {
    setProvider(id);
    if (id !== "custom") {
      applyConfig({ enabled, provider: id, customUrl });
    }
  };

  const handleSaveCustom = () => {
    const trimmed = customUrl.trim();
    if (!trimmed.startsWith("https://")) {
      setStatus({ ok: false, msg: "Custom DoH endpoint must start with https://" });
      return;
    }
    applyConfig({ enabled, provider: "custom", customUrl: trimmed });
  };

  const handleTest = async () => {
    if (!isElectron || !window.electron?.testDohConnection) return;
    setTesting(true);
    setStatus(null);
    try {
      const res = await window.electron.testDohConnection();
      if (res?.ok) {
        const loc = res.colo ? ` via ${res.colo}` : "";
        setStatus({
          ok: true,
          msg: `${enabled ? "Encrypted DNS (DoH) active" : "Standard DNS reachable"} · ${res.latencyMs} ms${loc}`,
        });
      } else {
        setStatus({
          ok: false,
          msg: res?.error || "Connection test failed",
        });
      }
    } catch (e) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setTesting(false);
    }
  };

  const activeProviderMeta =
    DOH_OPTIONS.find((o) => o.id === provider) || DOH_OPTIONS[0];

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
          Anti-ISP Block / Encrypted DNS (DoH)
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 99,
            background: enabled
              ? "rgba(72, 199, 116, 0.14)"
              : "rgba(255, 255, 255, 0.06)",
            color: enabled ? "#48c774" : "var(--text3)",
            border: `1px solid ${enabled ? "rgba(72,199,116,0.35)" : "var(--border)"}`,
          }}
        >
          {enabled ? "Protected" : "Off"}
        </span>
      </div>

      <div
        style={{
          fontSize: 13,
          color: "var(--text3)",
          marginBottom: 18,
          lineHeight: 1.6,
        }}
      >
        Encrypts DNS lookups inside Streambert using IP-literal DNS-over-HTTPS so
        ISP transparent DNS blocks (e.g. IndiHome, Telkomsel, Biznet, FirstMedia)
        cannot intercept TMDB, subtitle providers, player sources, or Stremio addons.
      </div>

      {!isElectron ? (
        <div style={{ fontSize: 13, color: "var(--text3)" }}>
          DNS-over-HTTPS configuration is only available in the desktop app.
        </div>
      ) : (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "18px 20px",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {/* Toggle Row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => handleToggle(!enabled)}
                style={{
                  width: 44,
                  height: 24,
                  borderRadius: 99,
                  border: "none",
                  background: enabled ? "var(--red)" : "var(--surface3)",
                  position: "relative",
                  cursor: "pointer",
                  transition: "background 0.2s",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 3,
                    left: enabled ? 23 : 3,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.2s",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                  }}
                />
              </button>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  Enable Encrypted DNS-over-HTTPS
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>
                  Applies immediately across main process, player webviews, and addon bridge
                </div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTest}
              disabled={testing}
              style={{ height: 34, fontSize: 12.5, padding: "0 14px" }}
            >
              {testing ? "Testing…" : "Test Connection"}
            </button>
          </div>

          {/* Provider Selector */}
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text2)",
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              DoH Provider
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {DOH_OPTIONS.map((opt) => {
                const active = provider === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleProviderSelect(opt.id)}
                    style={{
                      height: 36,
                      padding: "0 13px",
                      borderRadius: 8,
                      border: `1px solid ${active ? "var(--red)" : "var(--border)"}`,
                      background: active ? "rgba(229,9,20,0.14)" : "var(--surface2)",
                      color: active ? "#fff" : "var(--text2)",
                      fontSize: 13,
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      fontFamily: "var(--font-body)",
                      transition: "all 0.15s",
                    }}
                  >
                    <span>{opt.label}</span>
                    {opt.badge && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: active
                            ? "var(--red)"
                            : "rgba(255,255,255,0.08)",
                          color: active ? "#fff" : "var(--text3)",
                          fontWeight: 600,
                        }}
                      >
                        {opt.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>
              {activeProviderMeta.desc}
            </div>
          </div>

          {/* Custom DoH URL Input */}
          {provider === "custom" && (
            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 14,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                className="apikey-input"
                style={{ flex: 1, minWidth: 260, marginBottom: 0, height: 36 }}
                placeholder="https://dns.nextdns.io/your-id"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: 36, padding: "0 16px" }}
                onClick={handleSaveCustom}
              >
                Save Endpoint
              </button>
            </div>
          )}

          {/* Live feedback */}
          {(savedMsg || status) && (
            <div
              style={{
                marginTop: 14,
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                fontSize: 12.5,
              }}
            >
              {savedMsg && (
                <span style={{ color: "#48c774", fontWeight: 500 }}>
                  {savedMsg}
                </span>
              )}
              {status && (
                <span
                  style={{
                    color: status.ok ? "#48c774" : "#ff3860",
                    fontWeight: 500,
                  }}
                >
                  {status.ok ? "● " : "⚠ "}
                  {status.msg}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
