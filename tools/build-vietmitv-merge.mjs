import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TV_SOURCE_URL = "https://tinyurl.com/vmt47";
// Replace only the legacy FPT event group with the group supplied by the user's playlist.
const FPT_EVENT_SOURCE_URL = "https://tinyurl.com/tivinm7";
// Preserve the existing sports playlist URL exactly; only select the five configured groups.
const SPORTS_URL =
  "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/sports-auto.m3u?utm_source=chatgpt.com";
const MAIN_GROUPS = [
  "HTV",
  "HTVC",
  "Quốc Tế",
  "SCTV",
  "Sự kiện FPT",
  "Sự Kiện TV360",
  "Thể Thao",
  "VTV",
  "VTVcab",
  "Giải Trí",
];
const SPORTS_GROUPS = [
  "Giờ Vàng TV",
  "Gà Vàng 24h TV",
  "Gà Vàng 33 TV",
  "S8 TV",
  "Sao Kê TV",
];
const OUTPUT_PATH = path.resolve("generated/vietmitv-merge.m3u");
// Use the previous generated file only as a last-known-good sports fallback.
// Its TV channels are never carried forward.
const FALLBACK_PATH = OUTPUT_PATH;

function normalizeGroup(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLocaleLowerCase("vi")
    .replace(/[^a-z0-9]/g, "");
}

const MAIN_GROUP_KEYS = new Set(MAIN_GROUPS.map(normalizeGroup));
const LEGACY_FPT_GROUP_KEY = normalizeGroup("Sự Kiện FPT PLAY");
const FPT_EVENT_GROUP_KEY = normalizeGroup("Sự kiện FPT");
// Source selection still accepts the legacy group so it can be removed in-place.
// The final output whitelist contains only the replacement group name.
const SOURCE_MAIN_GROUP_KEYS = new Set([
  ...MAIN_GROUPS.filter((group) => normalizeGroup(group) !== FPT_EVENT_GROUP_KEY),
  "Sự Kiện FPT PLAY",
].map(normalizeGroup));
const SPORTS_GROUP_KEYS = new Set(SPORTS_GROUPS.map(normalizeGroup));

function validatePlaylist(input, label) {
  const value = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*#EXTM3U\b/im.test(value) || !/^\s*#EXTINF:/im.test(value)) {
    throw new Error(label + " không phải M3U hợp lệ");
  }
  return value.endsWith("\n") ? value : value + "\n";
}

async function fetchText(url, label, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/x-mpegURL, audio/x-mpegurl, text/plain, */*",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
        "User-Agent": "NM7-Filtered-TV-Playlist-Generator/1",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(label + " HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractEntries(m3u) {
  const entries = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const hasUrl = current.some((line) => {
      const value = line.trim();
      return value && !value.startsWith("#") &&
        /^(https?|rtsp|rtmp|udp):\/\//i.test(value.split("|")[0]);
    });
    if (hasUrl) entries.push(current);
  };

  for (const line of String(m3u || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*#EXTM3U\b/i.test(line)) continue;
    if (/^\s*#EXTINF:/i.test(line)) {
      finish();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  finish();
  return entries;
}

function entryGroup(entry) {
  const extinf = entry.find((line) => /^\s*#EXTINF:/i.test(line)) || "";
  const match = /\bgroup-title\s*=\s*["']([^"']*)["']/i.exec(extinf);
  if (match) return match[1].trim();
  const extgrp = entry.find((line) => /^\s*#EXTGRP:/i.test(line)) || "";
  return extgrp.replace(/^\s*#EXTGRP:/i, "").trim();
}

function setEntryGroup(entry, targetGroup) {
  return entry.map((line) => {
    if (/^\s*#EXTINF:/i.test(line)) {
      return line.replace(/\bgroup-title\s*=\s*(["'])[^"']*\1/i, (_match, quote) =>
        "group-title=" + quote + targetGroup + quote
      );
    }
    if (/^\s*#EXTGRP:/i.test(line)) return "#EXTGRP:" + targetGroup;
    return line;
  });
}

function isDrmEntry(entry) {
  const text = entry.join("\n");
  return (
    /inputstream\.adaptive\.license_(?:type|key|url|data)/i.test(text) ||
    /(?:^|[^a-z])license[_-]?(?:type|key|url|server|data)\s*["']?\s*[:=]/im.test(text) ||
    /(?:com\.widevine\.alpha|org\.w3\.clearkey|widevine|playready|clearkey|skd:\/\/)/i.test(text) ||
    /\bdrm\s*[:=]\s*(?:true|1|yes)\b/i.test(text) ||
    /#EXT-X-(?:KEY|SESSION-KEY):[^\r\n]*METHOD\s*=\s*SAMPLE-AES(?:-CTR)?/i.test(text)
  );
}

function filterEntries(entries, allowedGroups, removeDrm = true) {
  return entries.filter((entry) => {
    if (!allowedGroups.has(normalizeGroup(entryGroup(entry)))) return false;
    if (removeDrm && isDrmEntry(entry)) return false;
    return true;
  });
}

function uniqueGroups(entries) {
  return [...new Set(entries.map(entryGroup).filter(Boolean))];
}

// Known non-DRM HLS replacements for the three channels that failed playback.
// VTV URLs follow the current FPTPlay HLS index endpoints present in recent public playlists.
// ON Phim Viet uses the vAppTV playlist's plain HLS resolver URL, without KODIPROP/license metadata.
const PLAYBACK_OVERRIDES = [
  {
    key: "vtv1",
    url: "https://livevlisctcdnw.seenow.vn/livesnv2/VTV1_HD/manifest.mpd",
    manifestType: "mpd",
    ua: "",
  },
  {
    key: "vtv10",
    url: "https://vips-livecdn.fptplay.net/live/media/vtv10/live247-hls-avc/index.m3u8",
    ua: "",
  },
  {
    key: "onphimviet",
    url: "https://vmttv.dpdns.org/tv360/?id=vtvcab-2-phim-viet-hd",
    ua: "Dalvik/2.1.0",
  },
];

function entryDisplayName(entry) {
  const extinf = entry.find((line) => line.trimStart().toUpperCase().startsWith("#EXTINF:")) || "";
  const comma = extinf.lastIndexOf(",");
  return comma >= 0 ? extinf.slice(comma + 1).trim() : "";
}

function entryChannelId(entry) {
  const extinf = entry.find((line) => line.trimStart().toUpperCase().startsWith("#EXTINF:")) || "";
  const match = /tvg-id\s*=\s*["']([^"']*)["']/i.exec(extinf);
  return match ? match[1].trim() : "";
}

function applyPlaybackOverrides(entries) {
  const result = [];
  const found = new Set();

  for (const entry of entries) {
    const group = normalizeGroup(entryGroup(entry));
    const name = normalizeGroup(entryDisplayName(entry));
    const id = normalizeGroup(entryChannelId(entry));
    let override = null;

    if (group === normalizeGroup("VTV") && (name === "VTV1".toLocaleLowerCase("vi") || id === "vtv1hd" || id === "vtv1")) {
      override = PLAYBACK_OVERRIDES.find((x) => x.key === "vtv1");
    } else if (group === normalizeGroup("VTV") && (name === "vtv10" || id === "vtv10hd" || id === "vtv10")) {
      override = PLAYBACK_OVERRIDES.find((x) => x.key === "vtv10");
    } else if (
      group === normalizeGroup("VTVcab") &&
      (name.replace(/\s+/g, "").includes("onphimviet") || id.includes("onphimviet"))
    ) {
      override = PLAYBACK_OVERRIDES.find((x) => x.key === "onphimviet");
    }

    if (!override) {
      result.push(entry);
      continue;
    }

    const updated = entry.filter((line) => {
      const upper = line.trimStart().toUpperCase();
      return !upper.startsWith("#EXTVLCOPT:HTTP-USER-AGENT=") &&
        !upper.startsWith("#KODIPROP:INPUTSTREAM.ADAPTIVE.MANIFEST_TYPE=");
    });
    let replacedUrl = false;
    for (let i = 0; i < updated.length; i++) {
      const value = updated[i].trim();
      if (!value || value.startsWith("#")) continue;
      if (/^(https?|rtsp|rtmp|udp):\/\//i.test(value.split("|")[0])) {
        updated[i] = override.url;
        replacedUrl = true;
        break;
      }
    }
    if (!replacedUrl) {
      throw new Error("Không tìm thấy URL để thay thế cho kênh " + entryDisplayName(entry));
    }
    const extinfIndex = updated.findIndex((line) => line.trimStart().toUpperCase().startsWith("#EXTINF:"));
    if (extinfIndex < 0) throw new Error("Mục thiếu EXTINF cho kênh " + entryDisplayName(entry));
    const metadata = [];
    if (override.manifestType) {
      metadata.push("#KODIPROP:inputstream.adaptive.manifest_type=" + override.manifestType);
    }
    if (override.ua) {
      metadata.push("#EXTVLCOPT:http-user-agent=\"" + override.ua + "\"");
    }
    if (metadata.length) updated.splice(extinfIndex + 1, 0, ...metadata);
    found.add(override.key);
    result.push(updated);
  }

  const missing = PLAYBACK_OVERRIDES.map((x) => x.key).filter((key) => !found.has(key));
  if (missing.length) {
    throw new Error("Không tìm thấy đủ kênh cần sửa trong nguồn mới: " + missing.join(", "));
  }
  return { entries: result, applied: [...found] };
}

function composePlaylist(tvM3u, fptEventM3u, sportsM3u, fallbackM3u) {
  const header = tvM3u.split(/\r?\n/).find((line) => /^\s*#EXTM3U\b/i.test(line)) || "#EXTM3U";

  const rawTvEntries = extractEntries(tvM3u);
  const filteredSourceTvEntries = filterEntries(rawTvEntries, SOURCE_MAIN_GROUP_KEYS, true);
  if (!filteredSourceTvEntries.length) {
    throw new Error("Sau khi lọc, nguồn truyền hình không còn kênh hợp lệ thuộc các nhóm yêu cầu");
  }

  // Extract only the requested group from the separate TinyURL playlist.
  const replacementFptEntries = filterEntries(
    extractEntries(fptEventM3u),
    new Set([FPT_EVENT_GROUP_KEY]),
    true
  );
  if (!replacementFptEntries.length) {
    throw new Error("Nguồn tinyurl.com/tivinm7 không có kênh hợp lệ thuộc nhóm Sự kiện FPT");
  }

  // Remove every legacy "Sự Kiện FPT PLAY" entry, then insert the replacement group
  // at the old group's first position. All other TV entries keep their original order.
  const firstLegacyFptIndex = filteredSourceTvEntries.findIndex(
    (entry) => normalizeGroup(entryGroup(entry)) === LEGACY_FPT_GROUP_KEY
  );
  const baseTvEntries = filteredSourceTvEntries.filter(
    (entry) => normalizeGroup(entryGroup(entry)) !== LEGACY_FPT_GROUP_KEY
  );
  const fallbackInsertionIndex = baseTvEntries.findIndex(
    (entry) => normalizeGroup(entryGroup(entry)) === normalizeGroup("Sự Kiện TV360")
  );
  const insertionIndex = firstLegacyFptIndex >= 0
    ? filteredSourceTvEntries
        .slice(0, firstLegacyFptIndex)
        .filter((entry) => normalizeGroup(entryGroup(entry)) !== LEGACY_FPT_GROUP_KEY).length
    : fallbackInsertionIndex >= 0 ? fallbackInsertionIndex : baseTvEntries.length;
  const renamedFptEntries = replacementFptEntries.map(
    (entry) => setEntryGroup(entry, "Sự kiện FPT")
  );
  const tvEntriesBeforeOverrides = [
    ...baseTvEntries.slice(0, insertionIndex),
    ...renamedFptEntries,
    ...baseTvEntries.slice(insertionIndex),
  ];
  const playback = applyPlaybackOverrides(tvEntriesBeforeOverrides);
  const tvEntries = playback.entries;

  const liveSports = filterEntries(extractEntries(sportsM3u), SPORTS_GROUP_KEYS, true);
  const fallbackSports = filterEntries(extractEntries(fallbackM3u), SPORTS_GROUP_KEYS, true);
  const liveGroups = new Set(liveSports.map((entry) => normalizeGroup(entryGroup(entry))));
  const missingGroups = new Set([...SPORTS_GROUP_KEYS].filter((group) => !liveGroups.has(group)));
  const fallbackExtras = fallbackSports.filter((entry) => missingGroups.has(normalizeGroup(entryGroup(entry))));
  const sportsEntries = [...liveSports, ...fallbackExtras];

  const availableSportsGroups = new Set(sportsEntries.map((entry) => normalizeGroup(entryGroup(entry))));
  const missing = [...SPORTS_GROUP_KEYS].filter((group) => !availableSportsGroups.has(group));
  if (missing.length) {
    throw new Error("Thiếu nhóm thể thao cả ở nguồn trực tiếp lẫn bản dự phòng: " + missing.join(", "));
  }

  const allEntries = [...tvEntries, ...sportsEntries];
  const output = header + "\n" + allEntries.map((entry) => entry.join("\n").trim()).join("\n") + "\n";
  const validated = validatePlaylist(output, "Playlist đầu ra");
  const outputEntries = extractEntries(validated);
  const invalidGroups = uniqueGroups(outputEntries).filter((group) => {
    const key = normalizeGroup(group);
    return !MAIN_GROUP_KEYS.has(key) && !SPORTS_GROUP_KEYS.has(key);
  });
  if (invalidGroups.length) throw new Error("Có nhóm ngoài danh sách cho phép: " + invalidGroups.join(", "));
  if (outputEntries.some(isDrmEntry)) throw new Error("Playlist đầu ra còn kênh có metadata DRM");

  return {
    m3u: validated,
    rawTvEntries: rawTvEntries.length,
    tvEntries: tvEntries.length,
    playbackOverrides: playback.applied,
    drmExcludedTv: rawTvEntries.filter((entry) =>
      MAIN_GROUP_KEYS.has(normalizeGroup(entryGroup(entry))) && isDrmEntry(entry)
    ).length,
    tvGroups: uniqueGroups(tvEntries),
    fptEventEntries: renamedFptEntries.length,
    sportEntries: sportsEntries.length,
    sportGroups: uniqueGroups(sportsEntries),
    liveSportEntries: liveSports.length,
    fallbackSportEntries: fallbackExtras.length,
    totalEntries: outputEntries.length,
  };
}

async function main() {
  let previousOutput = "";
  try {
    previousOutput = await readFile(FALLBACK_PATH, "utf8");
  } catch {
    // No previous output is acceptable when the live sports source supplies all five groups.
  }

  const tvPromise = fetchText(TV_SOURCE_URL, "Nguồn M3U https://tinyurl.com/vmt47");
  const fptEventPromise = fetchText(FPT_EVENT_SOURCE_URL, "Nguồn nhóm Sự kiện FPT https://tinyurl.com/tivinm7");
  let sportsPromise = fetchText(SPORTS_URL, "Nguồn sports-auto.m3u").catch((error) => {
    console.warn("Nguồn thể thao trực tiếp lỗi; sẽ dùng các nhóm còn thiếu từ bản M3U trước:", error instanceof Error ? error.message : String(error));
    return previousOutput;
  });
  const [tvRaw, fptEventRaw, sportsRaw] = await Promise.all([tvPromise, fptEventPromise, sportsPromise]);
  const tvM3u = validatePlaylist(tvRaw, "Nguồn truyền hình tinyurl");
  const fptEventM3u = validatePlaylist(fptEventRaw, "Nguồn nhóm Sự kiện FPT");
  const sportsM3u = validatePlaylist(sportsRaw, "Nguồn thể thao / bản dự phòng");
  const fallbackM3u = previousOutput && /^\s*#EXTM3U\b/im.test(previousOutput) ? previousOutput : sportsM3u;

  const result = composePlaylist(tvM3u, fptEventM3u, sportsM3u, fallbackM3u);
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, result.m3u, "utf8");

  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    tvSource: TV_SOURCE_URL,
    fptEventSource: FPT_EVENT_SOURCE_URL,
    sportSource: SPORTS_URL,
    drmFilter: "enabled",
    selectedTvChannels: result.tvEntries,
    removedDrmTvChannels: result.drmExcludedTv,
    playbackOverrides: result.playbackOverrides,
    tvGroups: result.tvGroups,
    replacementFptEventChannels: result.fptEventEntries,
    sportsSourceMode: sportsRaw === previousOutput ? "live-unavailable-previous-playlist-fallback" : "live",
    liveSportChannels: result.liveSportEntries,
    fallbackSportChannels: result.fallbackSportEntries,
    sportGroups: result.sportGroups,
    totalChannels: result.totalEntries,
    bytes: Buffer.byteLength(result.m3u, "utf8"),
  }, null, 2));
}

main().catch((error) => {
  console.error("[NM7 filtered TV playlist] generation failed:", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
