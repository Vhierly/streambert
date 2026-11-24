import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  normalizeAddonUrl,
  validateStremioManifest,
  buildStremioStreamUrl,
  normalizeAddonStreams,
  FEATURED_COMMUNITY_ADDONS,
} from "../stremio.js";
import {
  parseYtsResponse,
  parseEztvResponse,
  parseAnimeToshoResponse,
} from "../torrentSearch.js";
import { parseSubtitleCues } from "../srtToVtt.js";

const require = createRequire(import.meta.url);

test("normalizeAddonUrl converts stremio:// and bare origins to manifest/base URLs", () => {
  const fromProto = normalizeAddonUrl("stremio://torrentio.strem.fun/manifest.json");
  assert.deepEqual(fromProto, {
    manifestUrl: "https://torrentio.strem.fun/manifest.json",
    baseUrl: "https://torrentio.strem.fun",
  });

  const fromSubpath = normalizeAddonUrl("https://addon.example.com/custom-cfg/");
  assert.deepEqual(fromSubpath, {
    manifestUrl: "https://addon.example.com/custom-cfg/manifest.json",
    baseUrl: "https://addon.example.com/custom-cfg",
  });

  assert.equal(normalizeAddonUrl(""), null);
});

test("validateStremioManifest detects stream capability accurately", () => {
  const ok = validateStremioManifest({
    id: "org.example.streams",
    name: "Example Streams",
    version: "2.1.0",
    resources: ["catalog", { name: "stream", types: ["movie", "series"] }],
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.supportsStream, true);
  assert.equal(ok.name, "Example Streams");

  const catalogOnly = validateStremioManifest({
    id: "org.example.cat",
    name: "Catalog Only",
    resources: ["catalog"],
  });
  assert.equal(catalogOnly.valid, true);
  assert.equal(catalogOnly.supportsStream, false);
});

test("buildStremioStreamUrl builds movie and series endpoints with encoded colons", () => {
  assert.equal(
    buildStremioStreamUrl("https://addon.example.com", "movie", "tt0816692"),
    "https://addon.example.com/stream/movie/tt0816692.json",
  );
  assert.equal(
    buildStremioStreamUrl("https://addon.example.com/", "tv", "tt0903747", 5, 14),
    "https://addon.example.com/stream/series/tt0903747%3A5%3A14.json",
  );
  assert.equal(buildStremioStreamUrl("https://addon.example.com", "movie", "12345"), null);
});

test("normalizeAddonStreams prioritizes direct HTTP streams over magnets and tags quality", () => {
  const streams = normalizeAddonStreams(
    [
      {
        name: "P2P",
        title: "Movie.2024.2160p.WEB-DL",
        infoHash: "0123456789abcdef0123456789abcdef01234567",
        fileIdx: 2,
        sources: ["tracker:udp://tracker.opentrackr.org:1337/announce"],
      },
      {
        name: "Debrid+",
        title: "Movie.2024.1080p.BluRay.mp4",
        url: "https://cdn.example.com/video.mp4",
        behaviorHints: {
          proxyHeaders: { request: { Referer: "https://cdn.example.com/" } },
        },
      },
    ],
    "DemoAddon",
    "Movie 2024",
  );

  assert.equal(streams.length, 2);
  assert.equal(streams[0].quality, "4K");
  assert.equal(streams[0].isDirect, false);
  assert.equal(streams[0].fileIdx, 2);
  assert.match(streams[0].magnetUrl, /^magnet:\?xt=urn:btih:0123456789abcdef/);

  assert.equal(streams[1].quality, "1080p");
  assert.equal(streams[1].isDirect, true);
  assert.equal(streams[1].streamHeaders.referer, "https://cdn.example.com/");
});

test("parseYtsResponse, parseEztvResponse, and parseAnimeToshoResponse extract exact auto-search magnets", () => {
  const yts = parseYtsResponse(
    {
      data: {
        movies: [
          {
            title_long: "Interstellar (2014)",
            torrents: [
              {
                hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
                quality: "2160p",
                type: "bluray",
                video_codec: "x265",
                size: "5.4 GB",
                seeds: 412,
              },
            ],
          },
        ],
      },
    },
    "Interstellar",
  );
  assert.equal(yts.length, 1);
  assert.equal(yts[0].quality, "4K");
  assert.equal(yts[0].seeds, 412);
  assert.match(yts[0].magnetUrl, /^magnet:\?xt=urn:btih:ABCDEF0123456789/i);

  const eztv = parseEztvResponse(
    {
      torrents: [
        {
          hash: "1111111111111111111111111111111111111111",
          title: "Shogun.2024.S01E03.1080p.WEB.H264",
          season: "1",
          episode: "3",
          seeds: 95,
          size_bytes: "1610612736",
        },
        {
          hash: "2222222222222222222222222222222222222222",
          title: "Shogun.2024.S01E04.1080p.WEB.H264",
          season: "1",
          episode: "4",
          seeds: 80,
          size_bytes: "1610612736",
        },
      ],
    },
    1,
    3,
  );
  assert.equal(eztv.length, 1);
  assert.equal(eztv[0].quality, "1080p");
  assert.match(eztv[0].details, /S01E03/);

  const tosho = parseAnimeToshoResponse([
    {
      title: "[SubsPlease] Frieren - 03 (1080p) [ABCD].mkv",
      info_hash: "3333333333333333333333333333333333333333",
      seeders: 150,
      total_size: 1450000000,
    },
  ]);
  assert.equal(tosho.length, 1);
  assert.equal(tosho[0].quality, "1080p");
  assert.equal(tosho[0].seeds, 150);
});

test("parseSubtitleCues parses SRT and ASS dialogue cues and strips formatting tags", () => {
  const srt = `1\n00:00:01,500 --> 00:00:04,000\n<i>Halo dunia!</i>\nBaris kedua\n\n2\n00:01:05.250 --> 00:01:08.750\n{\\an8}Tes kedua`;
  const cues = parseSubtitleCues(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 4);
  assert.equal(cues[0].text, "Halo dunia!\nBaris kedua");
  assert.equal(cues[1].text, "Tes kedua");

  const ass = `[Events]\nDialogue: 0,0:00:10.00,0:00:12.50,Default,,0,0,0,,{\\pos(192,260)}Sub Indo\\NBaris 2`;
  const assCues = parseSubtitleCues(ass);
  assert.equal(assCues.length, 1);
  assert.equal(assCues[0].start, 10);
  assert.equal(assCues[0].end, 12.5);
  assert.equal(assCues[0].text, "Sub Indo\nBaris 2");

  assert.ok(FEATURED_COMMUNITY_ADDONS.length >= 5);
  for (const addon of FEATURED_COMMUNITY_ADDONS) {
    assert.match(addon.manifestUrl, /^https:\/\/.+\/manifest\.json$/);
  }
});
