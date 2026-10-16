// Deployment cutover: source/status URLs now come from Dungntk9-owned GitHub repository.
const GENERATED_PLAYLIST_URL =
  "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/generated/fpt-event-live.m3u";
const GENERATED_STATUS_URL =
  "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/generated/fpt-event-live.status.json";

const WORKER_VERSION = "fpt-event-delivery-v15";

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

  const text = await response.text();
  if (!/^#EXTM3U/m.test(text)) {
    throw new Error("generated-playlist-is-not-m3u");
  }

  return text;
}

async function getStatus() {
  const response = await fetchGitHub(GENERATED_STATUS_URL);
  if (!response.ok) {
    throw new Error(`generated-status-http-${response.status}`);
  }
  return response.json();
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
