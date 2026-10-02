// ── health-sync: PROBE_TARGETS must match PLAYER_SOURCES ─────────────────────
//
// The comment in src/ipc/sourceHealth.js claimed this file kept the two lists in
// sync. No such file existed, so the lists drifted until six probe entries
// pointed at removed sources and five pointed at the wrong domain — reporting
// working sources as flaky and demoting them in the source menu.
//
//   node test/health-sync.test.mjs
//
// Exits non-zero with a readable diff on drift, so this fails loudly instead of
// silently rotting again.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── PLAYER_SOURCES: id -> host actually loaded ───────────────────────────────
const api = read("src/utils/api.js");
const block = api.slice(
  api.indexOf("export const PLAYER_SOURCES"),
  api.indexOf("export const getSourceUrl"),
);

const sources = {};
// movieUrl comes in two shapes: `=> \`https://host/...\`` for most sources and
// `=> "https://host"` for HiAnime, which ignores its id. Accept both.
for (const m of block.matchAll(
  /id:\s*"([\w]+)"[\s\S]*?movieUrl:\s*\([^)]*\)\s*=>\s*(?:`|\")https?:\/\/([^/`"$]+)/g,
)) {
  sources[m[1]] = m[2];
}

// ── PROBE_TARGETS: id -> host probed ────────────────────────────────────────
const ipc = read("src/ipc/sourceHealth.js");
const pblock = ipc.slice(
  ipc.indexOf("PROBE_TARGETS = {"),
  ipc.indexOf("};", ipc.indexOf("PROBE_TARGETS = {")),
);
const probes = Object.fromEntries(
  [...pblock.matchAll(/([\w]+):\s*"https?:\/\/([^/"]+)/g)].map((m) => [m[1], m[2]]),
);

const problems = [];

for (const [id, host] of Object.entries(probes)) {
  if (!(id in sources)) {
    problems.push(`PROBE_TARGETS has "${id}" but no such source exists (ghost)`);
  } else if (sources[id] !== host) {
    problems.push(
      `"${id}": probing ${host} but the source loads ${sources[id]} — ` +
        `working source will be reported flaky`,
    );
  }
}
for (const id of Object.keys(sources)) {
  if (!(id in probes)) {
    problems.push(`source "${id}" (${sources[id]}) is never health-checked`);
  }
}

// ── ANIME_SOURCE_IDS must be real ids too ───────────────────────────────────
const sh = read("src/utils/sourceHealth.js");
const am = sh.match(/ANIME_SOURCE_IDS = new Set\(\[(.*?)\]\)/s);
if (am) {
  for (const id of [...am[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
    if (!(id in sources)) {
      problems.push(`ANIME_SOURCE_IDS lists "${id}", which is not a source`);
    }
  }
  if (![...am[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).length) {
    problems.push("ANIME_SOURCE_IDS is empty — anime failover will never prefer an anime source");
  }
}

if (problems.length) {
  console.error(`FAIL — ${problems.length} sync problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(
  `PASS — ${Object.keys(sources).length} sources, ${Object.keys(probes).length} probes, all in sync`,
);