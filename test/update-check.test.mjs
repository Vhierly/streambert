// ── update-check: verify all 6 acceptance criteria for v2.6.6 ──────────────
//
//   node test/update-check.test.mjs
//
// Each criterion is checked against the actual source code at v2.6.6.
// Exits non-zero with a readable report on any failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const updatesJs = read("src/utils/updates.js");
const updateModalJsx = read("src/components/UpdateModal.jsx");
const settingsPageJsx = read("src/pages/SettingsPage.jsx");
const indexJs = read("index.js");

const results = [];
let passed = 0;
let failed = 0;

function check(id, desc, ok, detail) {
  results.push({ id, desc, ok, detail });
  if (ok) passed++;
  else failed++;
}

// ── Criterion 1: Get current app version via IPC (window.electron.getAppVersion) ──
{
  const hasIPC = updatesJs.includes("window.electron?.getAppVersion") &&
    updatesJs.includes("getAppVersion");
  check(
    "1",
    "Get current app version via IPC (window.electron.getAppVersion)",
    hasIPC,
    hasIPC ? "Found window.electron.getAppVersion() call" : "MISSING: no getAppVersion IPC call",
  );
}

// ── Criterion 2: Fetch latest release from GitHub API ──
{
  const hasFetch = updatesJs.includes("api.github.com") &&
    updatesJs.includes("/releases") &&
    updatesJs.includes("fetch(");
  check(
    "2",
    "Fetch latest release from GitHub API",
    hasFetch,
    hasFetch ? "Found GitHub API fetch call" : "MISSING: no GitHub API fetch",
  );
}

// ── Criterion 3: Compare versions using semverGt ──
{
  const hasSemver = updatesJs.includes("function semverGt") &&
    updatesJs.includes("semverGt(");
  check(
    "3",
    "Compare versions using semverGt",
    hasSemver,
    hasSemver ? "Found semverGt function and usage" : "MISSING: no semverGt",
  );
}

// ── Criterion 4: Display "v{current} → v{latest}" when update available ──
{
  // In UpdateModal, when hasUpdate is true, it should show v{current} → v{latest}
  const hasArrowInModal = updateModalJsx.includes("v{current}") &&
    updateModalJsx.includes("→") &&
    updateModalJsx.includes("v{latest}");
  check(
    "4",
    'Display "v{current} → v{latest}" when update available',
    hasArrowInModal,
    hasArrowInModal
      ? "UpdateModal shows v{current} → v{latest}"
      : "MISSING: UpdateModal does not show version arrow",
  );
}

// ── Criterion 5: Display "v{current} → v{latest}" when up to date ──
{
  // In SettingsPage, when !hasUpdate, it should show v{current} → v{latest}
  // v2.6.6 shows "✓ You're up to date" WITHOUT version info
  const upToDateSection = settingsPageJsx.match(
    /!result\.hasUpdate[\s\S]*?up to date[\s\S]*?\)/,
  );
  const hasVersionInUpToDate = upToDateSection &&
    upToDateSection[0].includes("v{result.current}") &&
    upToDateSection[0].includes("v{result.latest}");
  check(
    "5",
    'Display "v{current} → v{latest}" when up to date',
    !!hasVersionInUpToDate,
    hasVersionInUpToDate
      ? "SettingsPage shows version arrow when up to date"
      : 'MISSING: SettingsPage "up to date" message does not show v{current} → v{latest}',
  );
}

// ── Criterion 6: Allow install via UpdateModal (Windows auto-updater, Linux download) ──
{
  const hasInstall = updateModalJsx.includes("handleInstall") &&
    updateModalJsx.includes("downloadAndInstallUpdate");
  const hasWindows = updateModalJsx.includes("exe") || updateModalJsx.includes("Windows");
  const hasLinux = updateModalJsx.includes("appimage") || updateModalJsx.includes("deb");
  check(
    "6",
    "Allow install via UpdateModal (Windows auto-updater, Linux download)",
    hasInstall && hasWindows && hasLinux,
    hasInstall
      ? `Install handler found (Windows: ${hasWindows}, Linux: ${hasLinux})`
      : "MISSING: no install handler in UpdateModal",
  );
}

// ── Report ──
console.log("\n── Update Check Verification (v2.6.6) ──────────────────────────────\n");
for (const r of results) {
  const icon = r.ok ? "✓" : "✗";
  console.log(`  ${icon} [${r.id}] ${r.desc}`);
  if (!r.ok) console.log(`      ${r.detail}`);
}
console.log(
  `\n${"═".repeat(60)}\n` +
    (failed
      ? `FAIL — ${passed}/${results.length} passed, ${failed} failed`
      : `PASS — all ${results.length} criteria verified`),
);
process.exit(failed ? 1 : 0);
