// ── server-client: URL handling and the shapes the UI depends on ────────────
//
// The Jellyfin/Plex feature shipped as five IPC stubs returning [] and a
// renderer module that called paths no server serves:
//
//     fetch(`${url}/jellyfin/Library/VirtualFolders`)
//     fetch(`${url}/plex/library/sections`)
//
// The prefix is the bug — real Jellyfin serves /Library/VirtualFolders at the
// root — and a renderer fetch would have hit CORS regardless. Those calls are
// gone; the transport is now in src/ipc/serverClient.js. What is testable here
// is the part that stays pure: address normalisation, and the item shapes the
// library browser will render.
//
// normaliseUrl is exported for this, and it is the function most likely to
// mishandle real input: people paste "192.168.1.10:8096" far more often than a
// full URL, and a missing scheme otherwise throws inside URL() with a message
// that says nothing about the cause.
//
//   node test/server-client.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The module is CommonJS and does `require("electron")`, so globalThis stubs are
// not consulted — Node resolves the bare specifier through require. There is no
// electron install outside the app's node_modules, so a loader hook stands in.
//
// Only the four members the module touches at load or call time are provided:
// ipcMain to capture channel registration, safeStorage for the config file,
// net.fetch for the probe, and app.getPath for the config location.
const registered = [];
const electronStub = {
  ipcMain: { handle: (channel) => registered.push(channel), on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: (b) => Buffer.from(b).toString("utf8"),
  },
  net: {
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  },
  app: { getPath: () => "/tmp/streambert-test-userdata" },
};

// Wrapped in an async function because a require() next to a top-level await
// leaves Node unable to tell which module format the file is.
const { createRequire } = await import("node:module");
const require_ = createRequire(join(root, "index.js"));
const Module = require_("node:module");

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron";
  return realResolve.call(this, request, ...rest);
};
require_.cache.electron = {
  id: "electron",
  filename: "electron",
  loaded: true,
  exports: electronStub,
};

const mod = require_(join(root, "src/ipc/serverClient.js"));
const { normaliseUrl, register } = mod;

// ── Assertions ──────────────────────────────────────────────────────────────
const problems = [];
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) problems.push(msg);
};

// ── 1. Addresses people actually type ───────────────────────────────────────
// The whole reason this function exists: a bare host:port is the common case.
{
  const cases = [
    ["192.168.1.10:8096", "jellyfin", "http://192.168.1.10:8096"],
    ["http://192.168.1.10:8096", "jellyfin", "http://192.168.1.10:8096"],
    ["https://media.example.com", "jellyfin", "https://media.example.com"],
    // Trailing slashes are pasted out of browser bars constantly.
    ["http://192.168.1.10:8096/", "jellyfin", "http://192.168.1.10:8096"],
    ["http://192.168.1.10:8096///", "jellyfin", "http://192.168.1.10:8096"],
    // localhost is how a self-hosting user first tries this.
    ["localhost:8096", "jellyfin", "http://localhost:8096"],
  ];
  for (const [input, type, expected] of cases) {
    const got = normaliseUrl(input, type);
    checks++;
    if (got !== expected) {
      problems.push(`normaliseUrl(${JSON.stringify(input)}) = ${got}, expected ${expected}`);
    }
  }
}

// ── 2. Plex always gets its port ────────────────────────────────────────────
// Plex listens on 32400 and nothing else. Omitting it produces a connection
// refused on port 80, which looks like the server is down rather than that the
// port was left off.
{
  const plex = normaliseUrl("192.168.1.20", "plex");
  checks++;
  if (plex !== "http://192.168.1.20:32400") {
    problems.push(`Plex port not defaulted: ${plex}`);
  }

  // An explicit port is respected.
  const explicit = normaliseUrl("http://192.168.1.20:9999", "plex");
  checks++;
  if (explicit !== "http://192.168.1.20:9999") {
    problems.push(`Plex explicit port was overwritten: ${explicit}`);
  }

  // Jellyfin has no conventional port and must not get one invented.
  const jelly = normaliseUrl("192.168.1.10", "jellyfin");
  checks++;
  if (jelly !== "http://192.168.1.10") {
    problems.push(`Jellyfin gained a port it should not have: ${jelly}`);
  }
}

// ── 3. Rejected rather than half-built ──────────────────────────────────────
// A URL that cannot be parsed must come back null so the handler says
// "could not parse", not a string that fails later inside fetch.
{
  for (const bad of ["", "   ", null, undefined, "http://", "://nope"]) {
    const got = normaliseUrl(bad, "jellyfin");
    checks++;
    if (got !== null) {
      problems.push(`normaliseUrl(${JSON.stringify(bad)}) returned ${got}, expected null`);
    }
  }
}

// ── 4. The invented path prefixes are gone ──────────────────────────────────
// This is the assertion that matters most: the previous renderer module called
// `/jellyfin/…` and `/plex/…`, which no server serves. A stray occurrence means
// the old broken path is back somewhere.
{
  const src = readFileSync(join(root, "src/ipc/serverClient.js"), "utf8");
  for (const bad of ['${JELLYFIN_API}', '${PLEX_API}', '"/jellyfin', '"/plex/']) {
    checks++;
    if (src.includes(bad)) {
      problems.push(`src/ipc/serverClient.js still references ${bad} — the invented prefix is back`);
    }
  }

  // And the renderer module must not fetch directly any more: the whole reason
  // for the main-process bridge is CORS plus keeping the token out of the
  // renderer.
  const renderer = readFileSync(join(root, "src/utils/serverClient.js"), "utf8");
  checks++;
  if (/\bfetch\s*\(\s*`\$\{_serverConfig\.url\}/.test(renderer)) {
    problems.push(
      "src/utils/serverClient.js still fetches the server from the renderer — CORS and token exposure",
    );
  }
}

// ── 5. The real endpoints are the ones a server serves ─────────────────────
{
  const src = readFileSync(join(root, "src/ipc/serverClient.js"), "utf8");
  // Jellyfin's virtual-folder listing and system info, both at the root.
  checks++;
  if (!src.includes('"/Library/VirtualFolders"')) {
    problems.push("Jellyfin library endpoint missing");
  }
  checks++;
  if (!src.includes('"/System/Info"')) {
    problems.push("Jellyfin probe endpoint missing — a saved config is never verified");
  }
  // Plex's section listing.
  checks++;
  if (!src.includes('"/library/sections"')) {
    problems.push("Plex library endpoint missing");
  }
}

// ── 6. The token does not come back to the renderer ─────────────────────────
// get-server-config must report whether a key exists, not hand it over.
{
  register();
  const needed = [
    "get-server-config",
    "set-server-config",
    "clear-server-config",
    "server-api",
    "server-get-libraries",
    "server-get-items",
    "server-report-progress",
  ];
  for (const channel of needed) {
    checks++;
    if (!registered.includes(channel)) {
      problems.push(`handler "${channel}" was never registered`);
    }
  }

  const handler = registered.filter((c) => c === "get-server-config");
  checks++;
  if (handler.length !== 1) {
    problems.push(`get-server-config registered ${handler.length} times`);
  }
}

// ── 7. Jellyfin progress is reported in ticks ───────────────────────────────
// Jellyfin measures position in 10,000,000ths of a second. Off by a factor of a
// million and the server shows an absurd resume position for every title.
{
  const src = readFileSync(join(root, "src/ipc/serverClient.js"), "utf8");
  checks++;
  if (!src.includes("10_000_000")) {
    problems.push("Jellyfin ticks-per-second constant is missing");
  }
  checks++;
  if (!src.includes("PositionTicks")) {
    problems.push("progress is not reported in PositionTicks");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`FAIL — server-client: ${problems.length}/${checks} checks failed:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`PASS — server-client: ${checks} checks, addressing + endpoints + handlers`);