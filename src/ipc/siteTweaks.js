// ── Site tweaks ───────────────────────────────────────────────────────────────
// Per-host CSS that is injected into the player webview (and the pop-out
// window) to strip a streaming site down to just its player.
//
// Add a new entry to SITE_RULES to tweak another site. `hosts` matches the
// hostname itself and all its subdomains.

// Builds the CSS that hides the whole page except `selector`, which then fills
// the entire view on a black background.
function onlyElementCss(selector) {
  return `
    html, body {
      overflow: hidden !important;
      background: #000 !important;
    }
    /* Hide everything ... */
    body * {
      visibility: hidden !important;
    }
    /* ... except the target element and its content */
    ${selector},
    ${selector} * {
      visibility: visible !important;
    }
    /* Let the target fill the whole view */
    ${selector} {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      margin: 0 !important;
      z-index: 2147483647 !important;
      background: #000 !important;
      overflow: auto !important;
    }
  `;
}

// Builds the CSS that simply hides the given selectors.
function hideCss(...selectors) {
  return `${selectors.join(",\n")} { display: none !important; }`;
}

const UNIVERSAL_AD_CSS = `
  .popup-selector,
  #overlay-id,
  [class*="popunder"],
  a[target="_blank"][style*="position: fixed"],
  a[target="_blank"][style*="position:fixed"] {
    display: none !important;
    pointer-events: none !important;
  }
`;

// Injected across player main frame & nested iframes to neutralize transparent
// full-screen click-trap overlays and synthetic cross-origin anchor redirects.
const ANTI_CLICKJACK_JS = `(() => {
  if (window.__sbShield) return;
  window.__sbShield = true;

  const ensureStyle = () => {
    const parent = document.head || document.documentElement;
    if (!parent || document.querySelector("style[data-sb-shield]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-sb-shield", "1");
    style.textContent = ${JSON.stringify(UNIVERSAL_AD_CSS)};
    parent.appendChild(style);
  };
  ensureStyle();

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const target = (this.getAttribute("target") || "").toLowerCase();
      const href = this.href || "";
      if (target === "_blank") return;
      if (/^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin) {
        return;
      }
    } catch {}
    return origClick.apply(this, arguments);
  };

  const isPlayerSafe = (el) => {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName;
    if (tag === "VIDEO" || tag === "CANVAS" || tag === "BODY" || tag === "HTML") return true;
    if (el.querySelector && el.querySelector("video")) return true;
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    if (/(vjs-|jw-|plyr|art-|hls|control)/.test(cls)) return true;
    const src = (el.getAttribute && (el.getAttribute("src") || el.getAttribute("data-src") || "")) || "";
    if (/cloudflare|turnstile|hcaptcha|recaptcha/i.test(src + " " + cls + " " + (el.id || ""))) return true;
    return false;
  };

  const isTransparentBg = (cs) => {
    const op = parseFloat(cs.opacity);
    if (!Number.isNaN(op) && op < 0.08) return true;
    const bg = cs.backgroundColor || "";
    if (bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return true;
    const m = bg.match(/rgba\\([^,]+,[^,]+,[^,]+,\\s*([0-9.]+)\\)/i);
    return m ? parseFloat(m[1]) < 0.08 : false;
  };

  // shortcut: heuristic overlay detection may miss obfuscated canvas/shadow-DOM ad traps, upgrade with site-specific selectors if reported
  const cleanOverlays = () => {
    ensureStyle();
    if (!document.body) return;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh) return;
    const candidates = document.querySelectorAll("body > *, a, div, iframe");
    const limit = Math.min(candidates.length, 250);
    for (let i = 0; i < limit; i++) {
      const el = candidates[i];
      if (isPlayerSafe(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.pointerEvents === "none") continue;
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      const z = parseInt(cs.zIndex, 10);
      if (Number.isNaN(z) || z < 999) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.6 || rect.height < vh * 0.6) continue;

      const isBlankAnchor =
        el.tagName === "A" &&
        ((el.getAttribute("target") || "").toLowerCase() === "_blank" ||
          (/^https?:/i.test(el.href || "") && new URL(el.href, location.href).origin !== location.origin));
      const hasMediaChild = !!(el.querySelector && el.querySelector("video, canvas, iframe"));
      const hasText = (el.textContent || "").trim().length > 0;
      if (isBlankAnchor || (isTransparentBg(cs) && !hasText && !hasMediaChild)) {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("pointer-events", "none", "important");
      }
    }
  };

  cleanOverlays();
  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      cleanOverlays();
    }, 350);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();`;

const SITE_RULES = [
  {
    // KinoHub: player picker + player only
    hosts: ["on.kinohub.vip"],
    css: onlyElementCss("section.player_section"),
  },
  {
    hosts: ["aether.ist"],
    css: hideCss(
      "div:has(> .top-content)",
      // top bar
      ".top-content",
      // Episode selector
      '[id="__overlayRouter::episodes"]',
      '[id="__overlayRouter::episodes"] + button',
      // Back to home button
      'a.tabbable[class*="cancelHover"]',
      // Skip to next episode button
      'button.tabbable.p-2.rounded-full:has(> span.text-xl > svg[width="18"][height="18"])',
    ),
  },

  // try to remove popup ads (doesnt really work)
  {
    hosts: ["vidnest.fun"],
    css: hideCss(".popup-selector", "#overlay-id"),
  },
  {
    hosts: ["frembed.uno"],
    css: hideCss(".popup-selector"),
  },
];

function findRule(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return (
    SITE_RULES.find((rule) =>
      rule.hosts.some((h) => host === h || host.endsWith("." + h)),
    ) ?? null
  );
}

function applyShieldToFrame(frame) {
  try {
    if (!frame || frame.isDestroyed()) return;
    const url = frame.url || "";
    if (!/^https?:\/\//i.test(url)) return;
    if (/challenges\.cloudflare\.com|turnstile\.cloudflare\.com/i.test(url)) return;
    frame.executeJavaScript(ANTI_CLICKJACK_JS).catch(() => {});
  } catch {}
}

/**
 * Attach the tweaks to a player webContents (webview or pop-out window).
 * CSS is (re)inserted after every navigation of the main frame, and the
 * anti-clickjack shield is injected across main frame and nested iframes.
 */
function attach(wc) {
  if (!wc || wc.isDestroyed()) return;

  const apply = () => {
    try {
      if (wc.isDestroyed()) return;
      const rule = findRule(wc.getURL());
      if (!rule) return;
      // "user" origin: !important beats the site's own !important rules
      wc.insertCSS(rule.css, { cssOrigin: "user" }).catch(() => {});
    } catch {}
  };

  const applyShieldAllFrames = () => {
    try {
      if (wc.isDestroyed() || !wc.mainFrame) return;
      const frames = wc.mainFrame.framesInSubtree || [wc.mainFrame];
      for (const frame of frames) {
        applyShieldToFrame(frame);
      }
    } catch {}
  };

  // Early (right after the navigation committed) to avoid a visible flash,
  // plus dom-ready / in-page navigation as fallbacks (SPA route changes).
  wc.on("did-frame-navigate", (_e, _url, _code, _text, isMainFrame) => {
    if (isMainFrame) apply();
  });
  wc.on("did-frame-finish-load", () => applyShieldAllFrames());
  wc.on("dom-ready", () => {
    apply();
    applyShieldAllFrames();
  });
  wc.on("did-navigate-in-page", () => {
    apply();
    applyShieldAllFrames();
  });
}

module.exports = {
  attach,
  findRule,
  SITE_RULES,
  UNIVERSAL_AD_CSS,
  ANTI_CLICKJACK_JS,
};
