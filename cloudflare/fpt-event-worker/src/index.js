// cnktvpc source cutover: delivery remains schedule-free; five-minute watchdog owns Cron.
// Deployment cutover: source/status URLs now come from cnktvpc-owned GitHub repository.
const GENERATED_PLAYLIST_URL =
  "https://raw.githubusercontent.com/cnktvpc/Iptv-phuongnm7/main/generated/fpt-event-live.m3u";
const GENERATED_STATUS_URL =
  "https://raw.githubusercontent.com/cnktvpc/Iptv-phuongnm7/main/generated/fpt-event-live.status.json";

const WORKER_VERSION = "fpt-event-delivery-v17";

function isTestEntryName(name) {
  return /\\btest\\b/i.test(String(name || ""));
}

function filterTestEntriesFromPlaylist(playlist) {
  const lines = playlist.split(/\\r?\\n/);
  const output = [];
  let entry = [];

  function flushEntry() {
    if (!entry.length) return;
    const extinf = entry.find((line) => line.startsWith("#EXTINF:"));
    const title = extinf ? extinf.split(",").slice(1).join(",").trim() : "";
    if (!isTestEntryName(title)) output.push(...entry);
    entry = [];
  }

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      flushEntry();
      entry.push(line);
    } else if (entry.length) {
      entry.push(line);
      if (/^https?:\\/\\//i.test(line.trim())) flushEntry();
    } else {
      output.push(line);
    }
  }
  flushEntry();
  return output.join("\\n").replace(/\\n*$/, "\\n");
}

function filterTestEntriesFromStatus(status) {
  const allChannels = Array.isArray(status.liveChannels) ? status.liveChannels : [];
  const liveChannels = allChannels.filter((channel) => !isTestEntryName(channel.name));
  const removed = allChannels.length - liveChannels.length;
  return {
    ...status,
    liveDetectedEntries: Number.isFinite(status.liveDetectedEntries)
      ? status.liveDetectedEntries
      : allChannels.length,
    liveEntries: liveChannels.length,
    filteredOutEntries: Math.max(Number(status.filteredOutEntries) || 0, removed),
    filterPolicy: status.filterPolicy || "delivery guard: exclude entries explicitly marked TEST",
    liveChannels,
  };
}

async function fetchGitHub(url) {
  return fetch(`${url}?_=${Date.now()}`, {
    method: "GET",
    headers: {
      "User-Agent": "NM7-FPT-Event-Delivery/15",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
      Accept: "application/json,application/x-mpegURL,text/plain,*/*",
    },
    cache: "no-store",
  });
}

function playlistHeaders(extra = {}) {
  return {
    "Content-Type": "application/x-mpegURL; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    "Access-Control-Allow-Origin": "*",
    "X-NM7-FPT-Version": WORKER_VERSION,
    ...extra,
  };
}

async function getPlaylist() {
  const response = await fetchGitHub(GENERATED_PLAYLIST_URL);
  if (!response.ok) {
    throw new Error(`generated-playlist-http-${response.status}`);
  }

  const rawText = await response.text();
  if (!/^#EXTM3U/m.test(rawText)) {
    throw new Error("generated-playlist-is-not-m3u");
  }

  return filterTestEntriesFromPlaylist(rawText);
}

async function getStatus() {
  const response = await fetchGitHub(GENERATED_STATUS_URL);
  if (!response.ok) {
    throw new Error(`generated-status-http-${response.status}`);
  }
  return filterTestEntriesFromStatus(await response.json());
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/fpt-event-live.m3u") {
      try {
        const playlist = await getPlaylist();
        return new Response(playlist, {
          headers: playlistHeaders({
            "X-NM7-FPT-Source": "github-generated",
          }),
        });
      } catch (error) {
        return new Response(
          "#EXTM3U\n# NM7 FPT delivery error: " +
            (error instanceof Error ? error.message : String(error)) +
            "\n",
          {
            status: 502,
            headers: playlistHeaders(),
          }
        );
      }
    }

    if (url.pathname === "/status") {
      try {
        const scanner = await getStatus();
        return Response.json({
          service: "NM7 FPT Event Live",
          workerVersion: WORKER_VERSION,
          scannerOwner: "GitHub Actions",
          deliveryOwner: "Cloudflare Worker",
          schedule: "*/5 * * * *",
          sourceOnly: true,
          generatedPlaylistUrl: GENERATED_PLAYLIST_URL,
          ...scanner,
        });
      } catch (error) {
        return Response.json(
          {
            service: "NM7 FPT Event Live",
            workerVersion: WORKER_VERSION,
            scannerOwner: "GitHub Actions",
            deliveryOwner: "Cloudflare Worker",
            schedule: "*/5 * * * *",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 }
        );
      }
    }

    if (url.pathname === "/scan") {
      return Response.json({
        service: "NM7 FPT Event Live",
        workerVersion: WORKER_VERSION,
        scannerOwner: "GitHub Actions",
        deliveryOwner: "Cloudflare Worker",
        schedule: "*/5 * * * *",
        message:
          "FPT scanning is performed only by GitHub Actions. This Worker does not probe FPT origins.",
      });
    }

    return new Response(
      "NM7 FPT Event Live\n\n/fpt-event-live.m3u\n/status\n/scan\n",
      {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  },
};
