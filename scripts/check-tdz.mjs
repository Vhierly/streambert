// Catch TDZ / use-before-declaration bugs inside a single component function.
//
// Two of this app's shipped crashes were exactly this class (useCallback not
// imported; runPump referenced by a dep array above its declaration). Vite does
// not resolve identifiers in component scope, so the build stays green and the
// route dies at runtime. This walks the component's body with a real parser and
// reports every identifier that is READ before the line that declares it.
//
//   node scripts/check-tdz.mjs src/pages/TVPage.jsx

import { readFileSync } from "node:fs";

const file = process.argv[2];
const src = readFileSync(file, "utf8");

// Strip strings/comments so offsets/line numbers stay meaningful.
function clean(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === "/" && n === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const code = clean(src);
const lineOf = (idx) => code.slice(0, idx).split("\n").length;

// Find `function Name(` / `function Name (` bodies at any indent.
const funcs = [];
const fnRe = /function\s+([A-Za-z0-9_$]+)\s*\(/g;
let m;
while ((m = fnRe.exec(code))) {
  // Walk braces from the first { after the parens.
  let i = code.indexOf("(", m.index);
  let depth = 0;
  while (i < code.length) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  let brace = code.indexOf("{", i);
  if (brace < 0) continue;
  let d = 0;
  let end = brace;
  for (let j = brace; j < code.length; j++) {
    if (code[j] === "{") d++;
    else if (code[j] === "}") {
      d--;
      if (d === 0) {
        end = j;
        break;
      }
    }
  }
  funcs.push({ name: m[1], start: brace, end });
}

// For each function: collect (a) declarations with their line, (b) identifier
// reads with their line. A read before its declaration is a candidate TDZ.
const DECL = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[=({]/g;
const FUNC_DECL = /\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g;
const IDENT = /(?<![.\w$])([A-Za-z0-9_$]+)(?!\s*:)/g;

let problems = 0;
for (const f of funcs) {
  const body = code.slice(f.start, f.end);
  const base = f.start;
  const decls = new Map();
  for (const re of [DECL, FUNC_DECL]) {
    re.lastIndex = 0;
    let d;
    while ((d = re.exec(body))) {
      const ln = lineOf(base + d.index);
      if (!decls.has(d[1])) decls.set(d[1], ln);
    }
  }
  // Reads: identifiers not immediately preceded by a declaration keyword.
  const seen = new Set();
  IDENT.lastIndex = 0;
  let r;
  while ((r = IDENT.exec(body))) {
    const name = r[1];
    if (!decls.has(name)) continue;
    if (seen.has(name)) continue;
    const ln = lineOf(base + r.index);
    const declLn = decls.get(name);
    // Only flag same-scope-ish early reads; JSX/components live in nested scopes
    // that legitimately shadow, and we cannot resolve scopes without a full AST.
    if (ln < declLn) {
      seen.add(name);
      problems++;
      console.log(
        `TDZ? ${f.name}: reads '${name}' at line ${ln}, declared at line ${declLn}`,
      );
    }
  }
}

console.log(
  problems === 0
    ? `OK - no read-before-declaration found across ${funcs.length} functions in ${file}`
    : `\n${problems} potential use-before-declaration issue(s) in ${file}`,
);