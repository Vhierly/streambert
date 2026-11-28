import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adblock = require("../../ipc/adblock.js");

adblock.init([
  "*://doubleclick.net/*",
  "*://*.doubleclick.net/*",
  "*://tmstr4.cloudnestra.com/*",
  "*://73ed366d3137ec936bd60b1184467776.com/*",
]);

test("parseDomainList handles hosts, ABP rules, comments, exceptions, and protected hosts", () => {
  const sample = [
    "# comment",
    "! adblock header",
    "@@||allowed-exception.com^",
    "0.0.0.0 tracker.example.com",
    "127.0.0.1 localhost",
    "127.0.0.1 ads.badhost.org",
    "||pop.adservice.net^$third-party",
    "||challenges.cloudflare.com^",
    "||vidfast.vc^",
    "||ignored-path.com/banner.js^",
    "plain-ad-domain.xyz",
  ].join("\n");

  const parsed = adblock.parseDomainList(sample);
  assert.equal(parsed.has("tracker.example.com"), true);
  assert.equal(parsed.has("ads.badhost.org"), true);
  assert.equal(parsed.has("pop.adservice.net"), true);
  assert.equal(parsed.has("plain-ad-domain.xyz"), true);

  assert.equal(parsed.has("localhost"), false);
  assert.equal(parsed.has("allowed-exception.com"), false);
  assert.equal(parsed.has("challenges.cloudflare.com"), false);
  assert.equal(parsed.has("vidfast.vc"), false);
  assert.equal(parsed.has("ignored-path.com"), false);
});

test("isDomainBlocked matches exact and subdomain entries while protecting Turnstile", () => {
  const dynamicSet = new Set(["rotator-ad.com"]);
  assert.equal(adblock.isDomainBlocked("sub.rotator-ad.com", dynamicSet), true);
  assert.equal(adblock.isDomainBlocked("challenges.cloudflare.com", dynamicSet), false);
  // Static exact match like tmstr4.cloudnestra.com remains blocked
  assert.equal(adblock.isDomainBlocked("tmstr4.cloudnestra.com"), true);
});

test("shouldBlockRequest blocks ad lists, hex domains, VAST/popunder, and rotating TLDs without breaking streams or Turnstile", () => {
  // Static & curated ad networks
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://sub.doubleclick.net/pagead/js",
      resourceType: "script",
      referrer: "https://vidfast.vc/movie/123",
    }).block,
    true,
  );
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://cdn.adsterra.com/invoke.js",
      resourceType: "script",
      referrer: "https://vidnest.fun/movie/123",
    }).block,
    true,
  );

  // 32-char hex ad domains
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://abcdef0123456789abcdef0123456789.com/script.js",
      resourceType: "script",
      referrer: "https://vsembed.su/embed/movie/123",
    }).block,
    true,
  );

  // VAST / pre-roll / popunder paths
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://cdn.unknown-partner.io/vast.xml?preroll=1",
      resourceType: "xhr",
      referrer: "https://vidlove.cc/embed/movie/123",
    }).block,
    true,
  );

  // Rotating 3rd-party ad TLDs
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://freshrotator123.cyou/loader.js",
      resourceType: "script",
      referrer: "https://vidfast.vc/movie/123",
    }).block,
    true,
  );

  // Allowlist: Cloudflare Turnstile, first-party .m3u8, and .vtt subtitles
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://challenges.cloudflare.com/turnstile/v0/api.js",
      resourceType: "script",
      referrer: "https://vsembed.su/embed/movie/123",
    }).block,
    false,
  );
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://cdn.vidfast.vc/hls/master.m3u8",
      resourceType: "xhr",
      referrer: "https://vidfast.vc/movie/123",
    }).block,
    false,
  );
  assert.equal(
    adblock.shouldBlockRequest({
      url: "https://subtitles.example.cyou/preroll_en.vtt",
      resourceType: "xhr",
      referrer: "https://vidfast.vc/movie/123",
    }).block,
    false,
  );
});

test("shouldBlockNavigation allows same-site, player hosts, and Turnstile while blocking external ad redirects", () => {
  assert.equal(
    adblock.shouldBlockNavigation(
      "https://vidfast.vc/movie/550",
      "https://vidfast.vc/movie/550?server=2",
    ).block,
    false,
  );
  assert.equal(
    adblock.shouldBlockNavigation(
      "https://vsembed.su/embed/movie/550",
      "https://cloudnestra.com/rcp/abc",
    ).block,
    false,
  );
  assert.equal(
    adblock.shouldBlockNavigation(
      "https://vsembed.su/embed/movie/550",
      "https://challenges.cloudflare.com/cdn-cgi/challenge",
    ).block,
    false,
  );
  assert.equal(
    adblock.shouldBlockNavigation(
      "https://vidnest.fun/movie/550",
      "https://slot-gacor-redirect.com/promo",
    ).block,
    true,
  );
});

test("isNativeHlsTarget scopes CORS/header injection to active HLS hosts and media segments only", () => {
  const active = { host: "edge1.vidfastcdn.net", rootHost: "vidfastcdn.net" };

  assert.equal(adblock.isNativeHlsTarget("https://edge1.vidfastcdn.net/master.m3u8", active), true);
  assert.equal(adblock.isNativeHlsTarget("https://edge2.vidfastcdn.net/seg-1.ts", active), true);
  assert.equal(adblock.isNativeHlsTarget("https://cdn.other-mirror.com/sub.vtt?lang=id", active), true);

  // Never intercept TMDB, localhost, or unrelated pages, or when inactive
  assert.equal(adblock.isNativeHlsTarget("https://image.tmdb.org/t/p/w500/abc.jpg", active), false);
  assert.equal(adblock.isNativeHlsTarget("https://api.themoviedb.org/3/movie/1", active), false);
  assert.equal(adblock.isNativeHlsTarget("http://127.0.0.1:8080/chunk", active), false);
  assert.equal(adblock.isNativeHlsTarget("https://example.com/page.html", active), false);
  assert.equal(adblock.isNativeHlsTarget("https://edge1.vidfastcdn.net/master.m3u8", null), false);
});
