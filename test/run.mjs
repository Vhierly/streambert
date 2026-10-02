// ── test runner ─────────────────────────────────────────────────────────────
//
// `node test/run.mjs` runs every test/*.test.mjs and reports one summary.
//
// There was no runner and no `npm test` script, so test/health-sync.test.mjs
// only ran when someone remembered it by hand — and the lists it guards drifted
// anyway (see commit 6ed204d). A test nobody runs is a test that does not exist,
// so CI runs this on every push and it must exit non-zero on any failure.
//
// Each test file is executed as its own process so one crashing test cannot take
// the rest of the suite down with it, and so a test that calls process.exit()
// reports its own exit code honestly.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

if (!files.length) {
  console.error("FAIL — no test files found in test/");
  process.exit(1);
}

const failures = [];
let passed = 0;

for (const file of files) {
  const label = file.replace(/\.test\.mjs$/, "");
  process.stdout.write(`\n── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}\n`);

  const res = spawnSync(process.execPath, [join(testDir, file)], {
    cwd: root,
    encoding: "utf8",
    // Keep the child's output visible; some suites reason about tty state.
    stdio: ["ignore", "pipe", "pipe"],
  });

  const out = (res.stdout || "") + (res.stderr || "");
  process.stdout.write(out.replace(/\n$/, "") + "\n");

  if (res.status === 0) {
    passed++;
  } else {
    // A signal (status null) means it was killed — usually an unhandled throw
    // that took the process down instead of calling process.exit.
    const why =
      res.signal
        ? `killed by ${res.signal}`
        : `exit ${res.status}`;
    failures.push({ file, why });
  }
}

const total = files.length;
process.stdout.write(
  `\n${"═".repeat(60)}\n` +
    (failures.length
      ? `FAIL — ${passed}/${total} passed, ${failures.length} failed\n`
      : `PASS — all ${total} test files passed\n`),
);

for (const f of failures) {
  process.stdout.write(`  ✗ ${f.file} (${f.why})\n`);
}

process.exit(failures.length ? 1 : 0);