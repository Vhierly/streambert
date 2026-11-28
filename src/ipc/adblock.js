// ── AdBlock Shield 2.0 ───────────────────────────────────────────────────────
// Combines static blocked hosts, cached community filter lists, and lightweight
// heuristics for VAST/preroll paths, hex ad domains, rotating TLDs, and redirects.

const fs = require("fs");
const path = require("path");

const CACHE_FILENAME = "adblock-domains.txt";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FILTER_LIST_URLS = [
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
];

const TURNSTILE_HOSTS = new Set([
  "challenges.cloudflare.com",
  "turnstile.cloudflare.com",
  "hcaptcha.com",
  "recaptcha.net",
]);

const PROTECTED_HOSTS = new Set([
  ...TURNSTILE_HOSTS,
  "vsembed.su",
  "vidsrc.xyz",
  "vidsrc.to",
  "vidsrc.me",
  "vidsrc.net",
  "vidsrc.cc",
  "vidsrc.in",
  "vidfast.vc",
  "vidlove.cc",
  "aether.ist",
  "vidrift.net",
  "vidrift.in",
  "vidnest.fun",
  "devideosrc.co",
  "frembed.uno",
  "frembed.bar",
  "kinohub.vip",
  "hianime.at",
]);

const PLAYER_ALLOW_HOSTS = new Set([
  "vsembed.su",
  "vidsrc.xyz",
  "vidsrc.to",
  "vidsrc.me",
  "vidsrc.net",
  "vidsrc.cc",
  "vidsrc.in",
  "vidfast.vc",
  "vidlove.cc",
  "aether.ist",
  "vidrift.net",
  "vidrift.in",
  "vidnest.fun",
  "devideosrc.co",
  "frembed.uno",
  "frembed.bar",
  "kinohub.vip",
  "hianime.at",
  "megacloud.tv",
  "megacloud.blog",
  "rabbitstream.net",
  "dokicloud.one",
  "cloudnestra.com",
  "vidlink.pro",
  "smashystream.com",
  "2embed.cc",
  "multiembed.mov",
  "autoembed.cc",
  "moviesapi.club",
]);

const AD_NETWORK_DOMAINS = [
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "monetag.com",
  "adsterra.com",
  "profitableratecpm.com",
  "profitablegatecpm.com",
  "highperformanceformat.com",
  "effectivegatecpm.com",
  "exoclick.com",
  "exosrv.com",
  "realsrv.com",
  "hilltopads.net",
  "juicyads.com",
  "trafficjunky.net",
  "adcash.com",
  "aclib.net",
  "bidvertiser.com",
  "clickadu.com",
  "galaksion.com",
  "richpush.co",
  "evadav.com",
  "onclickalgo.com",
  "onclkds.com",
  "alwingulla.com",
  "pushame.com",
  "wpushsdk.com",
  "pushub.net",
  "notifpush.com",
  "twinrdsrv.com",
  "magsrv.com",
  "admaven.com",
  "ad-maven.com",
  "outbrain.com",
  "taboola.com",
  "revcontent.com",
  "criteo.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "adnxs.com",
  "smartadserver.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "imasdk.googleapis.com",
];

const AD_PATH_RE =
  /(?:^|[/?&._-])(?:popunder|clickunder|vast(?:tag|xml)?|vpaid|preroll|pre-roll|midroll|adserver|adservice|adtag|adbreak|outstream|aclib|pop\.js|pu\.js)(?:$|[/?&._=-])/i;
const CLEAR_AD_URL_RE = /(?:vast|vpaid|preroll|pre-roll|popunder)/i;
const HEX_AD_ROOT_RE = /^[a-f0-9]{24,}\.[a-z]{2,}$/i;
const ROTATING_AD_TLD_RE =
  /\.(?:qpon|cfd|cyou|sbs|rest|click|loan|buzz|monster|icu)$/i;
const AD_TLD_RESOURCE_TYPES = new Set([
  "script",
  "subFrame",
  "xhr",
  "fetch",
  "ping",
  "other",
]);
const MEDIA_EXT_RE = /\.(?:m3u8|vtt|ts|mp4|m4s)(\?|$)/i;
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const VALID_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const blockedDomains = new Set();
const staticExactBlocked = new Set();
let refreshInFlight = false;

function getElectron() {
  try {
    const mod = require("electron");
    return mod && mod.app ? mod : null;
  } catch {
    return null;
  }
}

function normalizeHost(host) {
  if (typeof host !== "string") return "";
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

function hostMatchesSet(host, set) {
  let cur = normalizeHost(host);
  while (cur) {
    if (set.has(cur)) return true;
    const dot = cur.indexOf(".");
    if (dot === -1) break;
    cur = cur.slice(dot + 1);
  }
  return false;
}

function rootDomain(host) {
  const norm = normalizeHost(host);
  if (!norm) return "";
  const parts = norm.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : norm;
}

function isTurnstileHost(host) {
  return hostMatchesSet(host, TURNSTILE_HOSTS);
}

function isPlayerAllowHost(host) {
  return hostMatchesSet(host, PLAYER_ALLOW_HOSTS);
}

function isProtectedHost(host) {
  return hostMatchesSet(host, PROTECTED_HOSTS);
}

function isDomainBlocked(host, domainSet = blockedDomains) {
  const norm = normalizeHost(host);
  if (!norm) return false;
  if (staticExactBlocked.has(norm) && domainSet === blockedDomains) return true;
  if (isProtectedHost(norm)) return false;
  return hostMatchesSet(norm, domainSet);
}

function parseDomainList(text) {
  const domains = new Set();
  if (typeof text !== "string" || !text) return domains;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("@@")) {
      continue;
    }

    let candidate = "";
    if (line.startsWith("||")) {
      let rule = line.slice(2);
      const optIdx = rule.indexOf("$");
      if (optIdx !== -1) {
        const opts = rule.slice(optIdx + 1).toLowerCase().split(",").filter(Boolean);
        const allowedOpts = new Set(["third-party", "popup", "all", "document"]);
        if (!opts.every((o) => allowedOpts.has(o))) continue;
        rule = rule.slice(0, optIdx);
      }
      if (rule.includes("/") || rule.includes("*")) continue;
      const caretIdx = rule.indexOf("^");
      candidate = caretIdx !== -1 ? rule.slice(0, caretIdx) : rule;
    } else if (/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/.test(line)) {
      const parts = line.split(/\s+/);
      candidate = parts[1] || "";
    } else if (!/[\s/*$]/.test(line)) {
      candidate = line;
    }

    candidate = normalizeHost(candidate);
    if (
      !candidate ||
      candidate === "localhost" ||
      IP_RE.test(candidate) ||
      !VALID_DOMAIN_RE.test(candidate) ||
      isProtectedHost(candidate)
    ) {
      continue;
    }
    domains.add(candidate);
  }
  return domains;
}

function getCacheFilePath() {
  const el = getElectron();
  if (!el) return null;
  try {
    return path.join(el.app.getPath("userData"), CACHE_FILENAME);
  } catch {
    return null;
  }
}

function init(staticHostPatterns = []) {
  blockedDomains.clear();
  staticExactBlocked.clear();

  for (const d of AD_NETWORK_DOMAINS) {
    blockedDomains.add(normalizeHost(d));
  }

  for (const pat of staticHostPatterns) {
    if (typeof pat !== "string") continue;
    const hostPat = normalizeHost(
      pat.replace(/^\*:\/\//, "").split("/")[0].replace(/^\*\./, ""),
    );
    if (!hostPat || !VALID_DOMAIN_RE.test(hostPat)) continue;
    staticExactBlocked.add(hostPat);
    if (!isProtectedHost(hostPat)) {
      blockedDomains.add(hostPat);
    }
  }

  const cacheFile = getCacheFilePath();
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const text = fs.readFileSync(cacheFile, "utf8");
      for (const d of parseDomainList(text)) {
        blockedDomains.add(d);
      }
    } catch {}
  }
}

async function refreshBlocklistIfStale() {
  if (refreshInFlight) return false;
  const el = getElectron();
  const cacheFile = getCacheFilePath();
  if (!el || !el.net || !cacheFile) return false;

  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < CACHE_TTL_MS) return false;
    }
  } catch {}

  refreshInFlight = true;
  try {
    const merged = new Set();
    for (const url of FILTER_LIST_URLS) {
      try {
        const res = await el.net.fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        for (const d of parseDomainList(text)) {
          merged.add(d);
        }
      } catch {}
    }

    if (merged.size > 0) {
      for (const d of merged) blockedDomains.add(d);
      const tmpFile = `${cacheFile}.tmp`;
      fs.writeFileSync(tmpFile, Array.from(merged).join("\n"), "utf8");
      fs.renameSync(tmpFile, cacheFile);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    refreshInFlight = false;
  }
}

function safeParseHttpUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function shouldBlockRequest(details = {}, domainSet = blockedDomains) {
  const parsed = safeParseHttpUrl(details.url);
  if (!parsed) return { block: false };

  const host = normalizeHost(parsed.hostname);
  if (!host || isTurnstileHost(host)) return { block: false };

  if (isDomainBlocked(host, domainSet)) {
    return { block: true, reason: "list" };
  }

  const resourceType = details.resourceType || "";
  const isVtt = /\.vtt(\?|$)/i.test(details.url);
  const isMedia = MEDIA_EXT_RE.test(details.url);

  const pageParsed =
    safeParseHttpUrl(details.referrer) || safeParseHttpUrl(details.webContentsUrl);
  const pageHost = pageParsed ? normalizeHost(pageParsed.hostname) : "";
  const hasKnownPage = Boolean(pageHost);
  const isSameRoot = hasKnownPage && rootDomain(host) === rootDomain(pageHost);
  const isThirdParty = hasKnownPage ? !isSameRoot : false;

  if (!isVtt && resourceType !== "mainFrame") {
    const pathAndQuery = `${parsed.pathname}${parsed.search}`;
    if (
      AD_PATH_RE.test(pathAndQuery) &&
      (isThirdParty || (!hasKnownPage && CLEAR_AD_URL_RE.test(pathAndQuery)) || CLEAR_AD_URL_RE.test(pathAndQuery))
    ) {
      return { block: true, reason: "heuristic-path" };
    }
  }

  if (resourceType !== "mainFrame" && HEX_AD_ROOT_RE.test(rootDomain(host))) {
    return { block: true, reason: "hex-domain" };
  }

  if (
    isThirdParty &&
    !isMedia &&
    !isPlayerAllowHost(host) &&
    ROTATING_AD_TLD_RE.test(host) &&
    AD_TLD_RESOURCE_TYPES.has(resourceType)
  ) {
    return { block: true, reason: "ad-tld" };
  }

  return { block: false };
}

function shouldBlockNavigation(currentUrl, targetUrl, domainSet = blockedDomains) {
  if (!targetUrl || targetUrl === "about:blank") return { block: false };
  const targetParsed = safeParseHttpUrl(targetUrl);
  if (!targetParsed) return { block: false };

  const targetHost = normalizeHost(targetParsed.hostname);
  if (!targetHost || isTurnstileHost(targetHost)) return { block: false };

  if (isDomainBlocked(targetHost, domainSet)) {
    return { block: true, reason: "list" };
  }

  if (HEX_AD_ROOT_RE.test(rootDomain(targetHost))) {
    return { block: true, reason: "hex-domain" };
  }

  const currentParsed = safeParseHttpUrl(currentUrl);
  if (currentParsed) {
    const currentHost = normalizeHost(currentParsed.hostname);
    if (rootDomain(currentHost) === rootDomain(targetHost)) {
      return { block: false };
    }
    if (isPlayerAllowHost(targetHost)) {
      return { block: false };
    }
    return { block: true, reason: "external-redirect" };
  }

  return { block: false };
}

const NATIVE_HLS_EXCLUDED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "image.tmdb.org",
  "api.themoviedb.org",
]);
const NATIVE_HLS_EXT_RE = /\.(?:m3u8|ts|m4s|key|vtt|aac|mp4)(\?|$)/i;

function isNativeHlsTarget(url, activeState) {
  if (!activeState || !activeState.host) return false;
  const parsed = safeParseHttpUrl(url);
  if (!parsed) return false;
  const host = normalizeHost(parsed.hostname);
  if (!host || NATIVE_HLS_EXCLUDED_HOSTS.has(host)) return false;
  if (host === activeState.host) return true;
  if (activeState.rootHost && rootDomain(host) === activeState.rootHost) return true;
  return NATIVE_HLS_EXT_RE.test(url);
}

module.exports = {
  init,
  refreshBlocklistIfStale,
  isDomainBlocked,
  parseDomainList,
  shouldBlockRequest,
  shouldBlockNavigation,
  isNativeHlsTarget,
  PLAYER_ALLOW_HOSTS,
  isTurnstileHost,
};
