import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoverPath,
  resolveYearBounds,
  filterSearchResults,
  pickRandomItem,
  hasCustomExploreFilters,
} from "../discover.js";

test("resolveYearBounds resolves exact years, decades, and classic range", () => {
  assert.deepEqual(resolveYearBounds("2025"), {
    gte: "2025-01-01",
    lte: "2025-12-31",
  });
  assert.deepEqual(resolveYearBounds("2010s"), {
    gte: "2010-01-01",
    lte: "2019-12-31",
  });
  assert.deepEqual(resolveYearBounds("classic"), {
    gte: null,
    lte: "1989-12-31",
  });
});

test("buildDiscoverPath builds movie and anime_tv queries with proper guards", () => {
  const movie = buildDiscoverPath(
    {
      mode: "movie",
      genres: [28, 878],
      yearPreset: "2020s",
      minRating: 7.5,
      providerId: 8,
      sortBy: "vote_average.desc",
    },
    2,
    { watchRegion: "ID", todayStr: "2026-11-24" },
  );
  assert.equal(movie.mediaType, "movie");
  const u = new URL("https://api.themoviedb.org/3" + movie.path);
  assert.equal(u.pathname, "/3/discover/movie");
  assert.equal(u.searchParams.get("page"), "2");
  assert.equal(u.searchParams.get("with_genres"), "28,878");
  assert.equal(u.searchParams.get("vote_average.gte"), "7.5");
  assert.equal(u.searchParams.get("vote_count.gte"), "150");
  assert.equal(u.searchParams.get("primary_release_date.gte"), "2020-01-01");
  assert.equal(u.searchParams.get("primary_release_date.lte"), "2029-12-31");
  assert.equal(u.searchParams.get("with_watch_providers"), "8");
  assert.equal(u.searchParams.get("watch_region"), "ID");

  const anime = buildDiscoverPath(
    { mode: "anime_tv", sortBy: "release_date.desc" },
    1,
    { todayStr: "2026-11-24" },
  );
  assert.equal(anime.mediaType, "tv");
  const ua = new URL("https://api.themoviedb.org/3" + anime.path);
  assert.equal(ua.pathname, "/3/discover/tv");
  assert.equal(ua.searchParams.get("with_genres"), "16");
  assert.equal(ua.searchParams.get("with_origin_country"), "JP");
  assert.equal(ua.searchParams.get("sort_by"), "first_air_date.desc");
  assert.equal(ua.searchParams.get("first_air_date.lte"), "2026-11-24");
});

test("filterSearchResults filters movies, tv, anime, and person tabs", () => {
  const sample = [
    { id: 1, media_type: "movie", genre_ids: [28], original_language: "en" },
    { id: 2, media_type: "tv", genre_ids: [16], original_language: "ja" },
    { id: 3, media_type: "person", name: "Hayao Miyazaki" },
  ];
  assert.equal(filterSearchResults(sample, "all").length, 3);
  assert.deepEqual(
    filterSearchResults(sample, "movie").map((x) => x.id),
    [1],
  );
  assert.deepEqual(
    filterSearchResults(sample, "anime").map((x) => x.id),
    [2],
  );
  assert.deepEqual(
    filterSearchResults(sample, "person").map((x) => x.id),
    [3],
  );
});

test("pickRandomItem and hasCustomExploreFilters behave predictably", () => {
  assert.equal(pickRandomItem([]), null);
  assert.equal(pickRandomItem(["a", "b", "c"], () => 0.5), "b");
  assert.equal(hasCustomExploreFilters(null), false);
  assert.equal(hasCustomExploreFilters({ mode: "anime_tv" }), true);
});
