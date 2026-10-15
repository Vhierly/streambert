// Render check: ProfilePicker actually renders its controls (TES-122).
// Bundles the real component with esbuild, then server-renders it.
// Run: node test/profile-picker.render.test.mjs
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bundle inside the repo so `react` resolves from node_modules.
const outDir = mkdtempSync(join(process.cwd(), ".tmp-test-"));
const out = join(outDir, "bundle.mjs");

await build({
  entryPoints: ["test/profile-picker.entry.jsx"],
  bundle: true,
  format: "esm",
  outfile: out,
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
  logLevel: "error",
});

const { ProfilePicker } = await import(out);
rmSync(outDir, { recursive: true, force: true });

let passed = 0;
const failures = [];
const check = (name, cond) => (cond ? passed++ : failures.push(name));

const profiles = [
  { id: "default", name: "Main", color: "#e50914" },
  { id: "p2", name: "Kids", color: "#22c55e" },
];

// Two profiles: delete buttons must be available.
let html = renderToStaticMarkup(
  createElement(ProfilePicker, {
    profiles,
    currentId: "default",
    onCreate() {},
    onSwitch() {},
    onDelete() {},
    onClose() {},
  }),
);
check("renders picker overlay", html.includes("profile-picker-overlay"));
check("renders prompt text", html.includes("Who&#x27;s watching?") || html.includes("Who's watching?"));
check("renders both profile names", html.includes("Main") && html.includes("Kids"));
check("renders delete buttons when >1 profile", html.includes("profile-delete-btn"));
check("renders add-profile affordance", html.includes("Add Profile"));
check("marks active profile", html.includes("profile-active-badge"));

// Single profile: delete must be impossible (last profile is protected).
html = renderToStaticMarkup(
  createElement(ProfilePicker, {
    profiles: [profiles[0]],
    currentId: "default",
    onCreate() {},
    onSwitch() {},
    onDelete() {},
    onClose() {},
  }),
);
check("no delete button when only one profile", !html.includes("profile-delete-btn"));

console.log(`\npassed: ${passed}`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all checks green");
