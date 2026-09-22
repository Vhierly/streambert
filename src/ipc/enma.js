// ── Enma Resolver (main process) ────────────────────────────────────────────
// Resolves anime URLs from Enma by searching the site and extracting the
// internal anime ID from search results.
//
// URL patterns:
//   Search: https://www.enma.lol/search?q=<title>
//   Watch:  https://www.enma.lol/watch/<slug>-<id>?ep=<episode>

const ENMA_BASE = "https://www.enma.lol";

/**
 * Search Enma for an anime by title and return the watch URL with the
 * internal Enma ID. Returns null if no result is found.
 *
 * @param {string} title - Anime title (from TMDB/AniList)
 * @param {number} episode - Episode number (1-indexed)
 * @returns {Promise<{url: string, enmaId: string, slug: string} | null>}
 */
async function resolveEnmaUrl(title, episode) {
  if (!title) return null;

  try {
    // Build search URL
    const searchUrl = `${ENMA_BASE}/search?q=${encodeURIComponent(title)}`;

    // Fetch search page from main process (avoids CORS in renderer)
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Parse search results — look for links like /watch/<slug>-<id>?ep=<N>
    // Pattern: /watch/<slug>-<number>
    const watchRegex = /\/watch\/([a-z0-9-]+)-(\d+)/g;
    let match;
    const results = [];
    while ((match = watchRegex.exec(html)) !== null) {
      results.push({
        slug: match[1],
        enmaId: match[2],
        path: match[0],
      });
    }

    if (results.length === 0) return null;

    // Pick the first result (most relevant)
    const first = results[0];

    // Build watch URL with episode
    const watchUrl = `${ENMA_BASE}/watch/${first.slug}-${first.enmaId}?ep=${episode}`;

    return {
      url: watchUrl,
      enmaId: first.enmaId,
      slug: first.slug,
    };
  } catch (e) {
    console.error("[enma-resolver] Error:", e.message);
    return null;
  }
}

/**
 * Register Enma IPC handlers.
 * The renderer calls window.electron.resolveEnma({ title, episode }) which
 * proxies to the main process (avoids CORS on enma.lol search page).
 */
function register(ipcMain) {
  ipcMain.handle("resolve-enma", async (_, { title, episode } = {}) => {
    if (!title) return { ok: false, error: "No title provided" };
    const result = await resolveEnmaUrl(title, episode || 1);
    if (!result) return { ok: false, error: "No results found on Enma" };
    return { ok: true, ...result };
  });
}

module.exports = {
  register,
  resolveEnmaUrl,
};

