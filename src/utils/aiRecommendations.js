// ── AI-Powered Recommendations ───────────────────────────────────────────────
// Analyzes watch history and generates personalized recommendations.
// Uses a simple content-based filtering approach (no external AI API needed).

import { storage, STORAGE_KEYS } from "./storage";
import { tmdbFetch } from "./api";

// ── Genre affinity scoring ────────────────────────────────────────────────────
function buildGenreAffinity(history) {
  const genreCounts = {};
  const genreRatings = {};
  
  for (const item of history) {
    const genres = item.genres || [];
    const rating = item.vote_average || 5;
    const weight = rating / 10; // Normalize to 0-1
    
    for (const genre of genres) {
      const id = genre.id || genre;
      genreCounts[id] = (genreCounts[id] || 0) + weight;
      genreRatings[id] = (genreRatings[id] || 0) + rating;
    }
  }
  
  // Normalize by count to get average rating per genre
  const affinity = {};
  for (const [id, count] of Object.entries(genreCounts)) {
    affinity[id] = {
      score: count,
      avgRating: genreRatings[id] / count,
    };
  }
  
  return affinity;
}

// ── Mood-based filtering ──────────────────────────────────────────────────────
const MOOD_GENRES = {
  action: [28, 12, 878],      // Action, Adventure, Sci-Fi
  comedy: [35, 10751],        // Comedy, Family
  drama: [18, 10749],         // Drama, Romance
  horror: [27, 53],           // Horror, Thriller
  mystery: [9648, 80],        // Mystery, Crime
  feelgood: [10751, 16, 35],  // Family, Animation, Comedy
  dark: [80, 53, 27],         // Crime, Thriller, Horror
  scifi: [878, 12, 14],       // Sci-Fi, Adventure, Fantasy
};

export function getMoodRecommendations(mood, limit = 10) {
  const genreIds = MOOD_GENRES[mood] || [];
  if (genreIds.length === 0) return [];
  
  // This would query TMDB for popular movies/shows in these genres
  // For now, return the genre IDs to filter by
  return { mood, genreIds, limit };
}

// ── "Because you watched X" ───────────────────────────────────────────────────
export function getSimilarRecommendations(title, type = "movie", limit = 10) {
  // In a full implementation, this would:
  // 1. Find the TMDB ID of the title
  // 2. Fetch similar titles from TMDB
  // 3. Filter out already-watched items
  // 4. Sort by relevance score
  
  return { title, type, limit, note: "Requires TMDB API call" };
}

// ── Watch history analysis ────────────────────────────────────────────────────
export function analyzeWatchHistory(history) {
  if (!history || history.length === 0) {
    return {
      totalWatched: 0,
      favoriteGenres: [],
      averageRating: 0,
      watchStreak: 0,
      mostActiveDay: null,
    };
  }
  
  const genreCounts = {};
  let totalRating = 0;
  let ratingCount = 0;
  const dayCounts = {};
  
  for (const item of history) {
    // Genre analysis
    for (const genre of item.genres || []) {
      const id = genre.id || genre;
      genreCounts[id] = (genreCounts[id] || 0) + 1;
    }
    
    // Rating analysis
    if (item.vote_average) {
      totalRating += item.vote_average;
      ratingCount++;
    }
    
    // Day of week analysis
    if (item.watchedAt) {
      const day = new Date(item.watchedAt).toLocaleDateString("en-US", { weekday: "long" });
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }
  }
  
  // Sort genres by frequency
  const favoriteGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ id: Number(id), count }));
  
  // Find most active day
  const mostActiveDay = Object.entries(dayCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  
  // Calculate watch streak (consecutive days with at least one watch)
  const watchStreak = calculateWatchStreak(history);
  
  return {
    totalWatched: history.length,
    favoriteGenres,
    averageRating: ratingCount > 0 ? totalRating / ratingCount : 0,
    watchStreak,
    mostActiveDay,
  };
}

function calculateWatchStreak(history) {
  if (!history || history.length === 0) return 0;
  
  // Get unique dates
  const dates = new Set(
    history.map((h) => new Date(h.watchedAt).toISOString().slice(0, 10))
  );
  
  // Sort dates descending
  const sortedDates = Array.from(dates).sort().reverse();
  
  let streak = 0;
  let currentDate = new Date();
  
  for (const dateStr of sortedDates) {
    const date = new Date(dateStr);
    const diffDays = Math.floor((currentDate - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays <= 1) {
      streak++;
      currentDate = date;
    } else {
      break;
    }
  }
  
  return streak;
}

// ── Personalized recommendations from TMDB ────────────────────────────────────
export async function getPersonalizedRecommendations(apiKey, history, limit = 10) {
  if (!apiKey || !history || history.length === 0) {
    return [];
  }
  
  const analysis = analyzeWatchHistory(history);
  const topGenres = analysis.favoriteGenres.slice(0, 3).map((g) => g.id);
  
  if (topGenres.length === 0) {
    // Fallback to popular
    const popular = await tmdbFetch(`/movie/popular?page=1`, apiKey);
    return (popular.results || []).slice(0, limit);
  }
  
  // Fetch recommendations based on top genres
  const genreParam = topGenres.join(",");
  const recommendations = await tmdbFetch(
    `/discover/movie?with_genres=${genreParam}&sort_by=popularity.desc&page=1`,
    apiKey
  );
  
  // Filter out already-watched
  const watchedIds = new Set(history.map((h) => h.id));
  const filtered = (recommendations.results || []).filter(
    (r) => !watchedIds.has(r.id)
  );
  
  return filtered.slice(0, limit);
}

// ── "Because you watched" section ────────────────────────────────────────────
export function getBecauseYouWatched(history, limit = 5) {
  if (!history || history.length === 0) return [];
  
  // Get the most recent watched item
  const recent = history.sort(
    (a, b) => new Date(b.watchedAt) - new Date(a.watchedAt)
  )[0];
  
  if (!recent) return [];
  
  return {
    basedOn: recent,
    note: `Because you watched "${recent.title || recent.name}"`,
    limit,
  };
}
