// ── Taste: what the recommendations row should actually reflect ──────────────
//
// The home page already fetched recommendations — TMDB /recommendations per
// recent history item, interleaved and deduped. It worked, and it was blind:
// five thrillers and twenty comedies produced the same row, because nothing ever
// looked at the history as a whole. analyzeWatchHistory in aiRecommendations.js
// could do exactly that and had no callers.
//
// This module holds the decisions; HomePage keeps doing the fetching, because it
// already owns the AbortController, the dedupe and the interleaving.
//
// Three things it is careful about:
//
//   - Rating weighting. Frequency alone treats dislike as preference: someone who
//     watched six comedies and rated them all 3 has told you something, and it is
//     not that they want comedies.
//   - No mutation. pickBecauseYouWatched must not sort the caller's array —
//     HomePage passes its real history, and reordering it changes the row's own
//     dependency under it.
//   - A fresh install still gets a row. Taste is an enhancement; the existing
//     similarity path stays the floor, so a user with no history sees something
//     rather than an empty home page.

import { analyzeWatchHistory } from "./aiRecommendations";

const CONFIG = {
  // Enough to span a taste without letting one person's three films define it.
  GENRES_FOR_DISCOVER: 3,
  // Below this, a genre has not been seen often enough to describe anyone.
  MIN_COUNT: 2,
  // How much a rating shifts the score. 1.0 means a 10/10 counts double a 5/5;
  // above that, one strong opinion starts outweighing a habit.
  RATING_WEIGHT: 1.0,
  // An item with no rating should neither help nor hurt.
  NEUTRAL_RATING: 5,
};

/**
 * The genre ids that describe this history best, most significant first.
 *
 * Weighted by how often a genre appears and how well it was received, so a
 * genre watched twice and rated 9 outranks one watched three times and rated 4.
 */
export function pickTasteGenres(history, limit = CONFIG.GENRES_FOR_DISCOVER) {
  if (!Array.isArray(history) || history.length === 0) return [];

  // Count and weighted score are tracked separately. They answer different
  // questions: "has this shown up more than once" is about evidence, while the
  // score is about how well it was received. Filtering on the score instead —
  // as this did first — dropped a genre seen once and rated 7, because 7 points
  // times one item lands under the threshold that three mediocre items clear.
  const counts = new Map();
  const scores = new Map();

  for (const item of history) {
    // TMDB returns { id, name }; stored history sometimes holds bare ids. Both
    // parse here — a stored id coming back as "undefined" would produce a profile
    // that silently ranks nothing.
    const genres = Array.isArray(item?.genres) ? item.genres : [];
    const rating = Number(item?.vote_average);
    const hasRating = Number.isFinite(rating) && rating > 0;
    const weight = hasRating
      ? CONFIG.NEUTRAL_RATING +
        (rating - CONFIG.NEUTRAL_RATING) * CONFIG.RATING_WEIGHT
      : CONFIG.NEUTRAL_RATING;

    for (const genre of genres) {
      const id = typeof genre === "object" && genre ? genre.id : genre;
      const numeric = Number(id);
      if (!Number.isFinite(numeric)) continue;
      counts.set(numeric, (counts.get(numeric) || 0) + 1);
      scores.set(numeric, (scores.get(numeric) || 0) + Math.max(0, weight));
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= CONFIG.MIN_COUNT)
    .sort((a, b) => {
      const byScore = (scores.get(b[0]) || 0) - (scores.get(a[0]) || 0);
      // Count breaks ties, so a genre seen once but rated 10 cannot outrank
      // everything — it has to earn the lead on evidence as well as reception.
      return byScore || b[1] - a[1];
    })
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

/**
 * The title to attribute the row to, plus the sentence to show.
 *
 * Returns null rather than a placeholder when there is nothing usable — an
 * undated entry is not "the most recent thing you watched", and claiming it is
 * would put a title in the heading that the user cannot verify.
 */
export function pickBecauseYouWatched(history) {
  if (!Array.isArray(history) || history.length === 0) return null;

  // Copied before sorting. history.sort() mutates in place, and the caller's
  // array is the page's real state.
  let mostRecent = null;
  let mostRecentTime = -Infinity;

  for (const item of history) {
    if (!item?.watchedAt) continue;
    const t = new Date(item.watchedAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > mostRecentTime) {
      mostRecentTime = t;
      mostRecent = item;
    }
  }

  if (!mostRecent) return null;

  const title = mostRecent.title || mostRecent.name;
  if (!title) return null;

  return {
    id: mostRecent.id,
    mediaType: mostRecent.media_type || "movie",
    title,
    genres: Array.isArray(mostRecent.genres) ? mostRecent.genres : [],
    note: `Because you watched "${title}"`,
  };
}

/**
 * Everything the row needs, in one call.
 *
 * Splitting it lets HomePage ask only for what it will render; a caller wanting
 * just the genres should not pay for the streak calculation.
 */
export function buildTasteProfile(history, limit = CONFIG.GENRES_FOR_DISCOVER) {
  const genres = pickTasteGenres(history, limit);
  const basedOn = pickBecauseYouWatched(history);
  const analysis = analyzeWatchHistory(history || []);

  return {
    genres,
    discoverQuery: genres.length ? buildDiscoverQuery(genres) : null,
    basedOn,
    totalWatched: analysis.totalWatched,
    // Only surfaced once there is something behind it: "you watch most on
    // Saturday" after one item is noise, not an insight.
    mostActiveDay:
      analysis.totalWatched >= 5 ? analysis.mostActiveDay : null,
    watchStreak: analysis.watchStreak,
  };
}

/**
 * TMDB /discover path for a genre set.
 *
 * with_genres takes a comma list where the values are OR-ed, which is what a
 * taste profile wants: the row should span the genres, not narrow to one.
 * Sorted by popularity because a taste profile narrows the candidates; it does
 * not rank them. Without a sort TMDB returns by default score, which over-weights
 * recent blockbusters and puts the same titles on every user's row.
 */
export function buildDiscoverQuery(genreIds) {
  if (!Array.isArray(genreIds) || genreIds.length === 0) return null;
  return `/discover/movie?with_genres=${genreIds.join(",")}&sort_by=popularity.desc&page=1`;
}