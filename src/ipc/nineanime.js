// ── 9Anime Resolver (main process) ──────────────────────────────────────────
// Searches 9anime.or.at and extracts episode embed URLs.
// Uses fetch + regex parsing (no headless browser needed).

const NINEANIME_BASE = "https://9anime.or.at";

/**
 * Search 9anime for an anime by title and return the watch page URL.
 * Returns { url, animeId, slug } or null.
 */
async function search9anime(title) {
  if (!title) return null;

  try {
    // 9anime search page
    const searchUrl = `${NINEANIME_BASE}/search?keyword=${encodeURIComponent(title)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const html = await res.text();

    // 9anime URL pattern: /watch/{slug}-{id} or /anime/{slug}-{id}
    const watchRegex = /\/watch\/([a-z0-9-]+)-(\d+)/g;
    let match;
    const results = [];
    while ((match = watchRegex.exec(html)) !== null) {
      results.push({ slug: match[1], animeId: match[2], path: match[0] });
    }

    if (results.length === 0) return null;

    // Pick the first result
    const first = results[0];
    return {
      url: `${NINEANIME_BASE}/watch/${first.slug}-${first.animeId}`,
      animeId: first.animeId,
      slug: first.slug,
    };
  } catch (e) {
    console.error("[9anime-resolver] Search error:", e.message);
    return null;
  }
}

/**
 * Build a 9anime episode URL directly (no search needed) using known patterns.
 * 9anime uses internal anime IDs that can be found via search.
 */
async function resolve9animeUrl(title, episode) {
  // First search for the anime
  const searchResult = await search9anime(title);
  if (!searchResult) return { ok: false, error: "Not found on 9anime" };

  try {
    // Fetch the watch page to find episode list
    const res = await fetch(searchResult.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return { ok: false, error: "Failed to load 9anime page" };

    const html = await res.text();

    // Look for episode links: /watch/{slug}-{id}?ep={episode}
    const epRegex = new RegExp(
      `/watch/${searchResult.slug}-${searchResult.animeId}\\?ep=(\\d+)`,
      "g",
    );
    let match;
    while ((match = epRegex.exec(html)) !== null) {
      if (parseInt(match[1], 10) === parseInt(episode, 10)) {
        const epUrl = `${NINEANIME_BASE}/watch/${searchResult.slug}-${searchResult.animeId}?ep=${episode}`;
        return { ok: true, url: epUrl, animeId: searchResult.animeId };
      }
    }

    // If specific episode not found, return the watch page URL anyway
    // (user can select episode on the page)
    return { ok: true, url: searchResult.url, animeId: searchResult.animeId };
  } catch (e) {
    console.error("[9anime-resolver] Episode error:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Register 9anime IPC handlers.
 */
function register(ipcMain) {
  ipcMain.handle("resolve-9anime", async (_, { title, episode } = {}) => {
    if (!title) return { ok: false, error: "No title provided" };
    const result = await resolve9animeUrl(title, episode || 1);
    return result;
  });
}

module.exports = {
  register,
  search9anime,
  resolve9animeUrl,
};
