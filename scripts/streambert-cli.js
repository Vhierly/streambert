#!/usr/bin/env node
// ── Streambert CLI ─────────────────────────────────────────────────────────
// Command-line interface for Streambert automation.
// Can be used to add media, trigger downloads, or integrate with scripts.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

// CLI runs in a lightweight mode — no window, just IPC bridge to a running instance
const CLI_VERSION = "1.0.0";

// ── Commands ─────────────────────────────────────────────────────────────────
const commands = {
  help: {
    description: "Show this help message",
    usage: "streambert-cli help",
    action: () => {
      console.log(`Streambert CLI v${CLI_VERSION}\n`);
      console.log("Commands:");
      for (const [name, cmd] of Object.entries(commands)) {
        console.log(`  ${name.padEnd(16)} ${cmd.description}`);
        console.log(`    Usage: ${cmd.usage}`);
      }
    },
  },

  version: {
    description: "Show CLI version",
    usage: "streambert-cli version",
    action: () => console.log(`Streambert CLI v${CLI_VERSION}`),
  },

  status: {
    description: "Check if Streambert is running",
    usage: "streambert-cli status",
    action: () => {
      // Check if single-instance lock is held
      const gotLock = app.requestSingleInstanceLock();
      if (gotLock) {
        console.log("Streambert is NOT running (lock acquired)");
        app.releaseSingleInstanceLock();
      } else {
        console.log("Streambert is running (lock held by another instance)");
      }
    },
  },

  "add-movie": {
    description: "Add a movie to watchlist by TMDB ID",
    usage: "streambert-cli add-movie <tmdb-id> [--title <title>]",
    action: (args) => {
      const id = args[0];
      if (!id) {
        console.error("Error: TMDB ID required");
        process.exit(1);
      }
      console.log(`Adding movie ${id} to watchlist...`);
      // In a full implementation, this would send IPC to the running app
      console.log(`✓ Movie ${id} added (simulated)`);
    },
  },

  "add-show": {
    description: "Add a TV show to watchlist by TMDB ID",
    usage: "streambert-cli add-show <tmdb-id> [--title <title>]",
    action: (args) => {
      const id = args[0];
      if (!id) {
        console.error("Error: TMDB ID required");
        process.exit(1);
      }
      console.log(`Adding show ${id} to watchlist...`);
      console.log(`✓ Show ${id} added (simulated)`);
    },
  },

  "download": {
    description: "Download a movie or episode",
    usage: "streambert-cli download <m3u8-url> [--output <path>]",
    action: (args) => {
      const url = args[0];
      if (!url) {
        console.error("Error: m3u8 URL required");
        process.exit(1);
      }
      console.log(`Downloading from ${url}...`);
      console.log(`✓ Download queued (simulated)`);
    },
  },

  "backup": {
    description: "Export backup to file",
    usage: "streambert-cli backup <output-path>",
    action: (args) => {
      const output = args[0] || `streambert-backup-${Date.now()}.json`;
      console.log(`Exporting backup to ${output}...`);
      console.log(`✓ Backup exported (simulated)`);
    },
  },

  "import": {
    description: "Import backup from file",
    usage: "streambert-cli import <input-path>",
    action: (args) => {
      const input = args[0];
      if (!input) {
        console.error("Error: input path required");
        process.exit(1);
      }
      console.log(`Importing backup from ${input}...`);
      console.log(`✓ Backup imported (simulated)`);
    },
  },

  "search": {
    description: "Search for movies/shows",
    usage: "streambert-cli search <query> [--type movie|tv]",
    action: (args) => {
      const query = args[0];
      if (!query) {
        console.error("Error: query required");
        process.exit(1);
      }
      console.log(`Searching for "${query}"...`);
      console.log(`✓ Search completed (simulated)`);
    },
  },
};

// ── Entry Point ──────────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  commands.help.action();
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  commands.version.action();
  process.exit(0);
}

const cmd = commands[command];
if (!cmd) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run 'streambert-cli help' for usage`);
  process.exit(1);
}

// Initialize Electron app (needed for single-instance check)
app.whenReady().then(() => {
  try {
    cmd.action(args);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  // Exit after command completes (except status which should be instant)
  if (command !== "status") {
    setTimeout(() => app.quit(), 100);
  }
});
