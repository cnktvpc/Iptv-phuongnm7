const PLAYLIST_URL =
  "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/generated/vietmitv-merge.m3u";
const WORKER_VERSION = "nm7-vietmitv-merge-v1";

function baseHeaders(extra = {}) {
  return {
    "Content-Type": "application/x-mpegURL; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "X-NM7-Playlist-Worker": WORKER_VERSION,
    ...extra,
  };
}

async function loadPlaylist() {
  const response = await fetch(PLAYLIST_URL + "?_=" + Date.now(), {
    method: "GET",
    headers: {
      "Accept": "application/x-mpegURL, audio/x-mpegurl, text/plain, */*",
      "Cache-Control": "no-cache, no-store",
      "Pragma": "no-cache",
      "User-Agent": "NM7-VietMiTV-Playlist-Worker/1",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("github-playlist-http-" + response.status);
  const text = (await response.text()).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*#EXTM3U\b/im.test(text) || !/^\s*#EXTINF:/im.test(text)) {
    throw new Error("github-playlist-is-not-valid-m3u");
  }
  return text.endsWith("\n") ? text : text + "\n";
}

function countEntries(text) {
  return (text.match(/^\s*#EXTINF:/gim) || []).length;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders() });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: baseHeaders({ Allow: "GET, HEAD, OPTIONS", "Content-Type": "text/plain; charset=utf-8" }),
      });
    }

    if (url.pathname === "/") {
      return Response.json({
        service: "NM7 VietMiTV merged playlist",
        workerVersion: WORKER_VERSION,
        delivery: "Cloudflare Worker",
        generator: "GitHub Actions",
        schedule: "*/5 * * * *",
        playlistPath: "/vietmitv-merge.m3u",
        statusPath: "/status",
      }, { headers: baseHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
    }

    if (url.pathname === "/status") {
      try {
        const playlist = await loadPlaylist();
        const groups = new Set();
        for (const line of playlist.split("\n")) {
          if (!/^\s*#EXTINF:/i.test(line)) continue;
          const match = /\bgroup-title\s*=\s*["']([^"']*)["']/i.exec(line);
          if (match && match[1].trim()) groups.add(match[1].trim());
        }
        return Response.json({
          ok: true,
          service: "NM7 VietMiTV merged playlist",
          workerVersion: WORKER_VERSION,
          delivery: "Cloudflare Worker",
          generator: "GitHub Actions",
          schedule: "*/5 * * * *",
          channels: countEntries(playlist),
          groups: [...groups],
          playlistUrl: new URL("/vietmitv-merge.m3u", url.origin).toString(),
        }, { headers: baseHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
      } catch (error) {
        return Response.json({
          ok: false,
          workerVersion: WORKER_VERSION,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 502, headers: baseHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
      }
    }

    if (url.pathname === "/vietmitv-merge.m3u" || url.pathname === "/api/vietmitv-merge") {
      try {
        const playlist = await loadPlaylist();
        return new Response(request.method === "HEAD" ? null : playlist, {
          status: 200,
          headers: baseHeaders({
            "Content-Length": String(new TextEncoder().encode(playlist).byteLength),
            "X-NM7-Playlist-Source": "github-generated",
            "X-NM7-Channel-Count": String(countEntries(playlist)),
          }),
        });
      } catch (error) {
        return new Response(
          "#EXTM3U\n# NM7 VietMiTV Worker error: " +
            (error instanceof Error ? error.message : String(error)) + "\n",
          { status: 502, headers: baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }) },
        );
      }
    }

    return new Response("Not found. Use /vietmitv-merge.m3u or /status\n", {
      status: 404,
      headers: baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
