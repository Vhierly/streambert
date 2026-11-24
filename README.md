<div align="center">

<img src="public/logo.svg" alt="Streambert Logo" width="420" />

### Cross-Platform Cinema, Series & Anime Desktop Hub — Zero Ads, Zero Tracking

[![Latest Release](https://img.shields.io/github/v/release/Vhierly/streambert?style=for-the-badge&color=e50914)](https://github.com/Vhierly/streambert/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Vhierly/streambert/total?style=for-the-badge&color=2ea44f)](https://github.com/Vhierly/streambert/releases)
[![CI Status](https://img.shields.io/github/actions/workflow/status/Vhierly/streambert/ci.yml?branch=main&label=CI%20%26%20Tests&style=for-the-badge)](https://github.com/Vhierly/streambert/actions)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue?style=for-the-badge)](LICENSE)

[**⬇ Download Latest Installer (`v3.0.0`)**](https://github.com/Vhierly/streambert/releases/latest) · [**TMDB Token Guide**](tmdb-tutorial.md) · [**Report an Issue**](https://github.com/Vhierly/streambert/issues)

</div>

---

## ✨ Highlights in `Vhierly/streambert` (v3.0)

Streambert combines multi-source web streaming, automatic Blu-Ray torrent streaming, Stremio addons, offline downloads, and two-way cloud tracking in one lightweight Electron desktop app.

| Feature | What It Does |
| :--- | :--- |
| 🧲 **Auto-Search Instant Torrent Streamer** | Click **🧲 Torrent / Addons** on any Movie or Episode to auto-discover `4K` / `1080p Blu-Ray` / `WEB-DL` releases via built-in indexers (**YTS**, **EZTV**, **AnimeTosho**) — no manual magnet copy-pasting. Streams sequentially via a local `127.0.0.1` HTTP 206 Range server directly in-app or in **MPV / VLC**, with live speed/peer stats and auto-clean temp cache. |
| 🧩 **Stremio Addon Bridge** | Install any Stremio v1 stream addon (`https://.../manifest.json` or `stremio://...`) in **Settings → Network & Addons** to unlock HTTP, HLS, Debrid, and P2P streams. |
| 🛡️ **Built-in Anti-ISP Block (DoH)** | Live **DNS-over-HTTPS** toggle using IP-literal resolvers (**Cloudflare `1.1.1.1`**, **Google `8.8.8.8`**, **AdGuard DNS**, **Quad9**, or Custom HTTPS URL) to bypass transparent ISP DNS hijacking without restarting the app. |
| 🔎 **Explore & Smart Search** | Dedicated **Explore (`Ctrl+E`)** discovery catalog (Genre, Network, Year/Decade, Minimum Score, Language, *Surprise Me*) + **Smart Search (`Ctrl+F`)** with category tabs, keyboard navigation, and actor/director filmography views. |
| 📥 **Download Queue & Native `yt-dlp`** | Concurrent download queue (`1x–4x`), **Pause / Resume / Retry**, **Batch Season Download** for anime series, and zero-config **`yt-dlp`** auto-detection on system `PATH` (alongside `vid-dl-cli-only`). |
| 🎬 **Local Player & Smart Intro Skip** | Built-in `streambert-media://` HTTP 206 local video player with `.srt` → WebVTT conversion, subtitle sync offset (`±0.5s`), playback speed controls, **AniSkip** (anime) + **TheIntroDB** (live-action) intro/outro skip, and **Source Health** latency pings. |
| 📚 **Library 2.0 & 1-Click Cloud Sync** | Organize titles by status (`Watching`, `Plan to Watch`, `Completed`, `On Hold`, `Dropped`), build **Custom Collections**, check the **Airing Calendar** & **Watch Stats**, sync two-way with **AniList** & **Trakt.tv** via **1-Click OAuth 2.0 PKCE** (OS Keychain encrypted), or import **IMDb CSV**, **Letterboxd CSV**, and **MyAnimeList XML** lists. |
| 🚫 **Ad & Tracker Blocker + Low-RAM Mode** | Network-level ad/popup blocker, clean Picture-in-Picture pop-out window, gamepad navigation, and Discord Rich Presence. |

---

## 📸 Screenshots

![Explore & Trending](screenshots/trending.png)
![Watch TV Series](screenshots/series.png)
![Watch Movies](screenshots/movie.png)
![Watch Anime](screenshots/anime.png)
![Built-in Ad & Tracker Blocker](screenshots/adblock.png)
![Customization](screenshots/customize-1.png)
![Themes & Layout](screenshots/customize-2.png)
![Subtitles](screenshots/subs.png)
![Downloads](screenshots/download.png)

---

## 🚀 Installation

### 1. Prebuilt Installers (Recommended)

Grab the latest release for your OS from the [**Releases Page**](https://github.com/Vhierly/streambert/releases/latest):

- **Windows**: Download `Streambert Setup *.exe` and run the installer.
- **macOS (Universal — Apple Silicon & Intel)**: Download `Streambert-*-universal.dmg`, open it, and drag **Streambert** to `Applications`.
- **Linux (`.AppImage` / `.deb`)**:
  ```bash
  # AppImage
  chmod +x Streambert-*.AppImage && ./Streambert-*.AppImage

  # Debian / Ubuntu (.deb)
  sudo dpkg -i streambert_*.deb
  ```

### 2. First-Time Setup

1. Launch **Streambert** and enter a free **TMDB API Read Access Token** ([step-by-step guide](tmdb-tutorial.md)). It is stored securely in your OS keychain.
2. *(Optional — Indonesia / Restricted ISPs)*: Open **Settings → Network & Addons** and enable **Anti-ISP Block / Encrypted DNS (DoH)** (`Cloudflare 1.1.1.1`).
3. *(Optional — Offline Downloads & MKV Playback)*:
   - Install [**yt-dlp**](https://github.com/yt-dlp/yt-dlp) + [**ffmpeg**](https://ffmpeg.org/download.html) on your system `PATH` (automatically detected by Streambert), or point to [`vid-dl-cli-only`](https://github.com/truelockmc/vid-dl-cli-only/releases/latest).
   - Install [**MPV**](https://mpv.io/) or [**VLC**](https://www.videolan.org/) if you want one-click hardware-decoded external playback for `4K HEVC / EAC3 / Atmos .mkv` Blu-Ray streams.

---

## 🛠️ Building & Testing from Source

### Prerequisites
- [Node.js](https://nodejs.org/) `>= 22.12.0`

### Commands

```bash
# Install dependencies
npm install

# Run unit tests (21 tests across API, Discover, PKCE Sync, Stremio & Torrent parsers)
npm test

# Start locally in development
npm start

# Build platform installers
npm run dist:win        # Windows NSIS (.exe)
npm run dist:linux      # Linux (.deb, .rpm, .AppImage, .pacman)
npm run dist:appimage   # Linux (.AppImage only)
npm run dist:deb        # Linux (.deb only)
npm run dist:mac        # macOS Universal (.dmg)
```

> [!NOTE]
> On Arch Linux, if building native packaging tools complains about missing shared libraries, install `sudo pacman -S libxcrypt-compat`.

---

## 🗂️ Project Architecture

<details>
<summary>Click to expand directory tree</summary>

```text
Streambert
├── index.js                         # Electron main process, DoH resolver, adblock & streambert-media:// Range protocol
├── preload.js                       # Context-isolated IPC bridge (window.electron)
├── popout-preload.js                # Picture-in-Picture pop-out window preload
├── package.json                     # Scripts, dependencies & electron-builder config
├── vite.config.js                   # Vite 7 production bundler config
├── .github/workflows/
│   ├── ci.yml                       # Automated syntax, unit test & Vite build checks
│   └── release.yml                  # Automated Windows, Linux & macOS release builder
└── src/
    ├── App.jsx                      # App shell, navigation stack, auto-scrobble & state
    ├── components/
    │   ├── AccountSyncSection.jsx   # 1-Click OAuth PKCE (AniList & Trakt) + CSV/XML Importer
    │   ├── BatchDownloadModal.jsx   # Multi-episode season queue modal
    │   ├── DohSettingsSection.jsx   # Encrypted DNS-over-HTTPS live toggle & latency tester
    │   ├── DownloadModal.jsx        # Stream & subtitle downloader (yt-dlp + vid-dl-cli-only)
    │   ├── LocalPlayerModal.jsx     # Built-in offline video player with SRT->VTT & offset
    │   ├── SearchModal.jsx          # Tabbed smart search with keyboard nav & filmography
    │   ├── StremioAddonsSection.jsx # Stremio v1 manifest installer & manager
    │   └── StremioStreamsModal.jsx  # Auto-search Blu-Ray torrent + Stremio stream player
    ├── ipc/
    │   ├── blockStats.js            # Ad & tracker block counter
    │   ├── discordRpc.js            # Discord Rich Presence IPC
    │   ├── downloads.js             # Concurrent download queue, pause/resume & yt-dlp runner
    │   ├── hianime.js               # Anime stream resolver
    │   ├── player.js                # External MPV/VLC launcher, source ping & OAuth PKCE loopback
    │   ├── storage.js               # SafeStorage keychain, DoH host resolver & CORS-free JSON bridge
    │   ├── subtitles.js             # SubDL / Wyzie subtitle search & download
    │   └── torrentStreamer.js       # Pure-JS sequential BitTorrent-to-HTTP 206 Range server
    ├── pages/
    │   ├── DownloadsPage.jsx        # Queue manager, concurrency controls & local playback
    │   ├── ExplorePage.jsx          # Multi-filter TMDB discovery & Surprise Me picker
    │   ├── HomePage.jsx             # Customizable trending rows & Continue Watching
    │   ├── LibraryPage.jsx          # Statuses, Custom Collections, Airing Calendar & Stats
    │   ├── MoviePage.jsx            # Movie player, source health, addons & downloads
    │   ├── SettingsPage.jsx         # Unified app settings with instant search & jump nav
    │   └── TVPage.jsx               # Series/Anime player, episode groups, intro skip & batch DL
    └── utils/
        ├── api.js                   # TMDB, AniList & IMDb ID resolvers
        ├── discover.js              # Pure discover query & search filter builders
        ├── introSkip.js             # Live-action intro/outro lookup (TheIntroDB)
        ├── library.js               # Watch status, calendar & watch-time stats engine
        ├── srtToVtt.js              # On-the-fly SRT to WebVTT converter with time shift
        ├── stremio.js               # Stremio Addon Protocol v1 client & stream ranker
        ├── syncProviders.js         # AniList GraphQL, Trakt REST PKCE & watchlist parsers
        ├── torrentSearch.js         # Built-in YTS, EZTV & AnimeTosho auto-indexers
        └── __tests__/               # Node.js built-in test suite (21 unit tests)
```

</details>

---

## 🔒 Privacy & Credits

- **Privacy**: Streambert runs locally on your machine with **zero telemetry or analytics**. Credentials (TMDB, AniList, Trakt) are encrypted locally via your OS Keychain (`electron.safeStorage`). Third-party providers (TMDB, streaming embeds, public torrent swarms, GitHub Releases) follow their own respective network policies.
- **License**: Open-source under the [**GNU General Public License v3.0 (GPL-3.0)**](LICENSE).
- **Credits**: Maintained by [**@Vhierly**](https://github.com/Vhierly), originally forked from and built upon [**truelockmc/streambert**](https://github.com/truelockmc/streambert).

---

## ⚖️ Legal Disclaimer

**IMPORTANT: This application is provided strictly for educational and personal use.**

- Streambert does **not** host, store, upload, or distribute any copyrighted media files.
- The application operates solely as a client-side metadata interface and protocol aggregator.
- Users are solely responsible for complying with local laws and ensuring they have the legal right to stream or download any media accessed through third-party sources, addons, or peer-to-peer networks.
