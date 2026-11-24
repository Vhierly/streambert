import test from "node:test";
import assert from "node:assert/strict";
import { srtToVtt, shiftVttTimestamps } from "../srtToVtt.js";
import { normalizeIntroDbResponse } from "../introSkip.js";
import {
  resolveItemWatchStatus,
  computeWatchStats,
  formatUpcomingSchedule,
} from "../library.js";
import {
  parseWatchedKey,
  parseWatchlistImport,
  derivePkceChallengeS256,
} from "../syncProviders.js";

test("srtToVtt converts SRT commas to WebVTT dots and shifts timestamps", () => {
  const srt = "1\r\n00:00:05,250 --> 00:00:08,500\r\nHello world!";
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.includes("00:00:05.250 --> 00:00:08.500"));

  const shifted = shiftVttTimestamps(vtt, 1.5);
  assert.ok(shifted.includes("00:00:06.750 --> 00:00:10.000"));
});

test("normalizeIntroDbResponse extracts valid intro and outro segments", () => {
  const res = normalizeIntroDbResponse({
    intro: { start_ms: 12000, end_ms: 85000 },
    outro: { start_sec: 1320, end_sec: 1410 },
  });
  assert.deepEqual(res, {
    intro: { startTime: 12, endTime: 85 },
    outro: { startTime: 1320, endTime: 1410 },
  });
  assert.equal(normalizeIntroDbResponse({ intro: { start_sec: 5, end_sec: 6 } }), null);
});

test("resolveItemWatchStatus and computeWatchStats calculate accurate library metrics", () => {
  const movie = { id: 550, media_type: "movie" };
  assert.equal(
    resolveItemWatchStatus(movie, { watched: { movie_550: true } }),
    "completed",
  );
  assert.equal(
    resolveItemWatchStatus(
      movie,
      { statusMap: { movie_550: "hold" }, watched: { movie_550: true } },
    ),
    "hold",
  );

  const now = Date.now();
  const stats = computeWatchStats({
    watched: { movie_550: true, tv_100_s1e1: true, tv_100_s1e2: true },
    history: [{ watchedAt: now }, { watchedAt: now - 86_400_000 }],
    saved: [movie],
  });
  assert.equal(stats.moviesCompleted, 1);
  assert.equal(stats.episodesCompleted, 2);
  assert.equal(stats.streakDays, 2);
  assert.equal(stats.estimatedHours, 3.1);
});

test("formatUpcomingSchedule orders upcoming releases and labels Today/Tomorrow", () => {
  const ref = new Date(2026, 10, 24);
  const sched = formatUpcomingSchedule(
    [
      { id: 2, airDate: "2026-11-25" },
      { id: 1, airDate: "2026-11-24" },
    ],
    ref,
  );
  assert.equal(sched[0].id, 1);
  assert.equal(sched[0].badge, "Today");
  assert.equal(sched[1].badge, "Tomorrow");
});

test("parseWatchlistImport handles IMDb CSV, Letterboxd CSV, and MAL XML", () => {
  const imdbCsv =
    'Position,Const,Title,Title Type,Year\n1,tt0133093,"The Matrix",movie,1999\n2,tt0903747,"Breaking Bad",tvSeries,2008';
  const parsedImdb = parseWatchlistImport(imdbCsv, "watchlist.csv");
  assert.equal(parsedImdb.length, 2);
  assert.equal(parsedImdb[0].imdbId, "tt0133093");
  assert.equal(parsedImdb[1].mediaHint, "tv");

  const malXml = `<myanimelist><anime><series_title><![CDATA[Cowboy Bebop]]></series_title><series_type>TV</series_type><my_status>Completed</my_status></anime></myanimelist>`;
  const parsedMal = parseWatchlistImport(malXml, "animelist.xml");
  assert.equal(parsedMal.length, 1);
  assert.equal(parsedMal[0].title, "Cowboy Bebop");
  assert.equal(parsedMal[0].status, "completed");

  assert.deepEqual(parseWatchedKey("tv_1399_s2e4"), {
    mediaType: "tv",
    tmdbId: 1399,
    season: 2,
    episode: 4,
  });
});

test("derivePkceChallengeS256 matches official RFC 7636 Appendix B vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(await derivePkceChallengeS256(verifier), expected);
});
