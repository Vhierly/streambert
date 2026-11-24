import test from "node:test";
import assert from "node:assert/strict";
import {
  getSourceUrl,
  getAnimeSourceUrl,
  isAnimeContent,
  cleanAnilistDescription,
  buildAnilistSeasons,
} from "../api.js";

test("getSourceUrl builds movie and series URLs with accent and subtitle params", () => {
  const movieUrl = getSourceUrl(
    "vidfast",
    "movie",
    550,
    null,
    null,
    {},
    "#e50914",
    "en",
  );
  assert.ok(movieUrl);
  const parsed = new URL(movieUrl);
  assert.equal(parsed.origin, "https://vidfast.vc");
  assert.equal(parsed.pathname, "/movie/550");
  assert.equal(parsed.searchParams.get("theme"), "e50914");
  assert.equal(parsed.searchParams.get("sub"), "en");

  const tvUrl = getSourceUrl("vidsrc", "tv", 1399, 2, 5, {}, "#ff0000", "id");
  const parsedTv = new URL(tvUrl);
  assert.equal(parsedTv.pathname, "/embed/tv/1399/2/5");
  assert.equal(parsedTv.searchParams.get("ds_lang"), "id");
});

test("getSourceUrl returns null for movieOnly sources on TV shows or missing ID", () => {
  assert.equal(getSourceUrl("kinohub", "tv", "12345", 1, 1), null);
  assert.equal(getSourceUrl("vidsrc", "movie", null), null);
});

test("getAnimeSourceUrl builds sub and dub URLs for anime-capable sources", () => {
  const subUrl = getAnimeSourceUrl("vidnest", 21, 12, "sub");
  assert.equal(subUrl, "https://vidnest.fun/anime/21/12/sub");
  const dubUrl = getAnimeSourceUrl("vidnest", 21, 12, "dub");
  assert.equal(dubUrl, "https://vidnest.fun/anime/21/12/dub");
  assert.equal(getAnimeSourceUrl("vidsrc", 21, 1, "sub"), null);
});

test("isAnimeContent detects Japanese animation accurately", () => {
  assert.equal(
    isAnimeContent({ genre_ids: [16, 28], original_language: "ja" }),
    true,
  );
  assert.equal(
    isAnimeContent({ genres: [{ id: 16 }], origin_country: ["JP"] }),
    true,
  );
  assert.equal(
    isAnimeContent({ genre_ids: [16], original_language: "en" }),
    false,
  );
});

test("cleanAnilistDescription strips HTML tags, Source, and Note lines", () => {
  const raw =
    "A young boy <i>fights</i> curses.<br><br>(Source: Viz Media)\nNote: Premiered early.";
  assert.equal(cleanAnilistDescription(raw), "A young boy fights curses.");
});

test("buildAnilistSeasons orders main entry and TV sequels chronologically", () => {
  const seasons = buildAnilistSeasons({
    id: 100,
    title: { english: "Show S1" },
    episodes: 12,
    startDate: { year: 2021, month: 4 },
    relations: {
      edges: [
        {
          relationType: "SEQUEL",
          node: {
            id: 200,
            type: "ANIME",
            format: "TV",
            title: { english: "Show S2" },
            episodes: 24,
            startDate: { year: 2023, month: 1 },
          },
        },
      ],
    },
  });
  assert.equal(seasons.length, 2);
  assert.equal(seasons[0].seasonNum, 1);
  assert.equal(seasons[0].id, 100);
  assert.equal(seasons[1].seasonNum, 2);
  assert.equal(seasons[1].id, 200);
});
