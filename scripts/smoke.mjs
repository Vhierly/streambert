#!/usr/bin/env node
/**
 * Runtime smoke test — mounts every route and fails on any runtime error.
 *
 * Why this exists
 * ---------------
 * `vite build` cannot catch a missing hook import, or anything else that only
 * breaks when a component actually mounts. v2.7.0 shipped with
 * "useCallback is not defined" on the Settings route and the build was green,
 * because Settings is lazy-loaded and nothing exercised it.
 *
 * So: boot the real app, walk every route, collect window errors, and exit
 * non-zero if any appear. This is the check that was missing.
 *
 * Usage:  node scripts/smoke.mjs [--routes home,settings,...] [--timeout 60]
 *
 * Requires a GUI session (WSLg / X11). Runs headless-ish: it never asserts on
 * pixels, only on DOM presence and error state.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf("port", 9455));
const BOOT_TIMEOUT = Number(argOf("timeout", 90)) * 1000;

// Every top-level route. Settings is the one that silently shipped broken
// before, so it is deliberately first-class here rather than incidental.
const DEFAULT_ROUTES = ["home", "history", "downloads", "settings"];
const ROUTES = argOf("routes", "downloads,settings").split(",").map((r) => r.trim()).filter(Boolean);

// ── CDP client (minimal websocket, no deps) ───────────────────────────────────
async function httpJson(pathname) {
  // node:http rather than fetch — undici honours proxy env vars and has been
  // observed swallowing loopback requests to the DevTools endpoint.
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => req.destroy(new Error("cdp timeout")));
    req.end();
  });
}

async function waitForCdp(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson("/json/list");
      const pages = targets.filter((t) => t.type === "page");
      if (pages.length) return pages[0];
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`DevTools endpoint never came up on :${PORT}`);
}

function connect(wsUrl) {
  const u = new URL(wsUrl);
  return import("node:net").then(({ createConnection }) => {
    const sock = createConnection({ host: u.hostname, port: Number(u.port) }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    return new Promise((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      const onData = (d) => {
        handshake = Buffer.concat([handshake, d]);
        const idx = handshake.indexOf("\r\n\r\n");
        if (idx === -1) return;
        sock.off("data", onData);
        if (!handshake.subarray(0, idx).toString().includes("101")) {
          return reject(new Error("websocket upgrade refused"));
        }
        resolve(makeClient(sock));
      };
      sock.on("data", onData);
      sock.on("error", reject);
    });
  });
}

function makeClient(sock) {
  let buf = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();

  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode !== 1) continue;
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  function evaluate(expression, timeoutMs = 20000) {
    const id = ++nextId;
    const body = JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    });
    const mask = crypto.randomBytes(4);
    const data = Buffer.from(body, "utf8");
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
    sock.write(Buffer.concat([header, mask, masked]));

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        const r = msg.result || {};
        if (r.exceptionDetails) {
          resolve({
            exception: String(
              r.exceptionDetails.exception?.description ?? r.exceptionDetails,
            ),
          });
        } else {
          resolve({ value: r.result?.value });
        }
      });
    });
  }

  return { evaluate, close: () => sock.end() };
}

// ── run ───────────────────────────────────────────────────────────────────────
const child = spawn(
  "npx",
  ["electron", ".", `--remote-debugging-port=${PORT}`],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
const appLog = [];
child.stdout.on("data", (d) => appLog.push(d.toString()));
child.stderr.on("data", (d) => appLog.push(d.toString()));

let failed = false;
const results = [];

try {
  const target = await waitForCdp(Date.now() + BOOT_TIMEOUT);
  const cdp = await connect(target.webSocketDebuggerUrl);

  // Collect anything that throws from here on.
  await cdp.evaluate(`
    window.__smokeErrors = [];
    window.addEventListener('error', e => window.__smokeErrors.push('error: ' + (e.message || '')));
    window.addEventListener('unhandledrejection', e => window.__smokeErrors.push('rejection: ' + String(e.reason)));
    'armed'
  `);

  // Fresh profile otherwise stops at the TMDB setup screen and no route is
  // reachable. This is exactly what hid the Settings bug: earlier runs never got
  // past this gate.
  //
  // Wait for the shell to exist at all first — clicking before React has mounted
  // the setup screen silently finds zero buttons and every route then reports
  // "missing", which looks like a routing failure but is really a race.
  const readyDeadline = Date.now() + 30000;
  let skipped = { value: false };
  while (Date.now() < readyDeadline) {
    const state = await cdp.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const hasSkip = !!btns.find(x => (x.innerText||'').trim().toLowerCase().startsWith('skip'));
        const hasNav  = !!btns.find(x => (x.innerText||'').trim().toLowerCase() === 'home');
        return JSON.stringify({ hasSkip, hasNav });
      })()
    `);
    let st = {};
    try {
      st = JSON.parse(state.value ?? "{}");
    } catch {}
    if (st.hasNav) break;
    if (st.hasSkip) {
      skipped = await cdp.evaluate(`
        (() => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(x => (x.innerText||'').trim().toLowerCase().startsWith('skip'));
          if (!b) return false;
          b.click();
          return true;
        })()
      `);
      break;
    }
    await sleep(1000);
  }

  if (skipped.value) {
    // The whole app shell remounts after skipping; wait for the sidebar rather
    // than sleeping a guessed interval.
    const navDeadline = Date.now() + 20000;
    while (Date.now() < navDeadline) {
      const ready = await cdp.evaluate(`
        !!Array.from(document.querySelectorAll('button,[role=button],a'))
          .find(b => (b.innerText||'').trim().toLowerCase() === 'home')
      `);
      if (ready.value) break;
      await sleep(1000);
    }
  }

  for (const route of ROUTES) {
    const clicked = await cdp.evaluate(`
      (() => {
        const label = ${JSON.stringify(route)};
        // Sidebar buttons are matched on their visible label, which is not always
        // the route name: the History route is labelled "Library & History".
        // Matching on exact text alone therefore reported "missing" for a route
        // that exists and works — a false negative that reads like an app bug.
        const buttons = Array.from(
          document.querySelectorAll('button,[role=button],a')
        ).filter(b => (b.innerText||'').trim());
        const norm = s => s.toLowerCase();
        const exact = buttons.find(
          b => norm(b.innerText.trim()) === label
        );
        const el = exact || buttons.find(b => {
          const t = norm(b.innerText.trim());
          return t === label ||
            t.split(/\\s*&\\s*|\\s*\\/\\s*/).some(part => part.trim() === label);
        });
        if (!el) return 'missing';
        el.click();
        return 'clicked';
      })()
    `);
    await sleep(3500);

    const state = await cdp.evaluate(`
      JSON.stringify({
        errors: window.__smokeErrors || [],
        rootChildren: document.getElementById('root')?.children.length ?? 0,
        bodyLength: (document.body.innerText||'').length,
        boundary: /Something went wrong|useCallback is not defined|ReferenceError/i.test(document.body.innerText||''),
        text: (document.body.innerText||'').slice(0,120).replace(/\\s+/g,' ')
      })
    `);
    let parsed = {};
    try {
      parsed = JSON.parse(state.value ?? "{}");
    } catch {}

    const errors = parsed.errors ?? [];
    const ok =
      clicked.value === "clicked" &&
      parsed.rootChildren > 0 &&
      errors.length === 0 &&
      !parsed.boundary;
    results.push({ route, ok, errors, boundary: parsed.boundary, text: parsed.text });
    if (!ok) failed = true;

    // On failure, surface what the error boundary actually says. A route that
    // fails without its message is a bug report nobody can act on.
    let detail = "";
    if (parsed.boundary) {
      const b = await cdp.evaluate(`
        (() => {
          const el = document.querySelector('.error-boundary, [class*="error-boundary"]');
          return el ? (el.innerText||'').slice(0,400) : (document.body.innerText||'').slice(0,400);
        })()
      `);
      detail = `\n        boundary: ${(b.value ?? "").replace(/\\s+/g, " ").slice(0, 300)}`;
    }

    console.log(
      `${ok ? "PASS" : "FAIL"}  ${route}` +
        (errors.length ? `\n        errors: ${errors.join(" | ")}` : "") +
        (parsed.boundary ? "\n        error boundary visible" + detail : "") +
        (clicked.value !== "clicked" ? `\n        nav: ${clicked.value}` : ""),
    );

    // Reset the collector so one route's error can't be charged to the next.
    await cdp.evaluate("window.__smokeErrors = []; 'ok'");
  }

  cdp.close();
} catch (err) {
  console.error(`\nsmoke test could not run: ${err.message}`);
  console.error(appLog.join("").slice(-1500));
  failed = true;
} finally {
  child.kill("SIGTERM");
}

console.log(
  `\n${results.length} route(s) checked — ${failed ? "FAILED" : "PASSED"}`,
);
process.exit(failed ? 1 : 0);