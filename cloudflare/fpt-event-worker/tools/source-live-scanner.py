#!/usr/bin/env python3
# ops(fpt): run source scanner
# verified syntax trigger
# spread proxy trigger
# dedicated FPT scanner activation trigger
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SOURCE_URL = "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/sources/fpt-events-source.m3u"
EVENT7_URL = "https://vips-livecdn.fptplay.net/live/media/event-07/hls_avc_v6/index.m3u8"
VIETNAM_PROXY_LIST_URL = "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/by-country/VN.txt"
OUTPUT_M3U = os.environ.get("OUTPUT_M3U", "generated/fpt-event-live.m3u")
OUTPUT_STATUS = os.environ.get("OUTPUT_STATUS", "generated/fpt-event-live.status.json")
MAX_PROXY_TRIES = int(os.environ.get("MAX_PROXY_TRIES", "32"))
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "6"))

HEADERS = [
    ("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"),
    ("Referer", "https://fptplay.vn/"),
    ("Origin", "https://fptplay.vn"),
    ("Accept", "application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,text/plain,*/*"),
    ("Cache-Control", "no-cache, no-store"),
    ("Pragma", "no-cache"),
]

HEADER_PROFILES = [
    HEADERS,
    HEADERS + [
        ("Sec-Fetch-Site", "same-site"),
        ("Sec-Fetch-Mode", "cors"),
        ("Sec-Fetch-Dest", "empty"),
        ("Accept-Language", "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"),
    ],
    HEADERS + [
        ("Sec-Fetch-Site", "cross-site"),
        ("Sec-Fetch-Mode", "cors"),
        ("Sec-Fetch-Dest", "empty"),
        ("Accept-Language", "vi,en-US;q=0.9,en;q=0.8"),
    ],
]

def get_text(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": HEADERS[0][1],
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

def parse_source(text):
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        line = line.strip()
        if not line.startswith("#EXTINF"):
            continue
        name = line.split(",", 1)[1].strip() if "," in line else "Sự kiện FPT"
        url = ""
        for j in range(i + 1, min(i + 8, len(lines))):
            candidate = lines[j].strip()
            if not candidate or candidate.startswith("#"):
                continue
            if candidate.startswith(("http://", "https://")):
                url = candidate
                break
        if url:
            out.append({"name": name, "url": url})
    seen = set()
    unique = []
    for item in out:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        unique.append(item)
    return unique

def is_live_hls(body):
    upper = body.upper()
    if "#EXTM3U" not in upper:
        return False
    if "#EXT-X-ENDLIST" in upper:
        return False
    if "#EXT-X-PLAYLIST-TYPE:VOD" in upper:
        return False
    return (
        "#EXTINF:" in upper
        or "#EXT-X-STREAM-INF:" in upper
        or "#EXT-X-MEDIA-SEQUENCE:" in upper
    )

def is_live_dash(body):
    upper = body.upper()
    if "<MPD" not in upper:
        return False
    if 'TYPE="STATIC"' in upper or "TYPE='STATIC'" in upper:
        return False
    live_signal = any(
        token in upper
        for token in (
            'TYPE="DYNAMIC"',
            "TYPE='DYNAMIC'",
            "MINIMUMUPDATEPERIOD=",
            "TIMESHIFTBUFFERDEPTH=",
            "AVAILABILITYSTARTTIME=",
            "SUGGESTEDPRESENTATIONDELAY=",
        )
    )
    media_signal = any(
        token in upper
        for token in (
            "<ADAPTATIONSET",
            "<REPRESENTATION",
            "<SEGMENTTEMPLATE",
            "<SEGMENTTIMELINE",
        )
    )
    return live_signal and media_signal

def curl_probe(url, proxy=None, headers=None):
    cmd = [
        "curl", "-sS", "-L", "--http1.1", "--max-time", str(PROBE_TIMEOUT),
        "-o", "-", "-D", "-", "-w", "\n__NM7_STATUS__:%{http_code}|%{content_type}|%{size_download}\n",
    ]
    if proxy:
        cmd += ["-x", f"http://{proxy}"]
    for key, value in (headers or HEADERS):
        cmd += ["-H", f"{key}: {value}"]
    cmd += [url]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=PROBE_TIMEOUT + 5)
    except Exception as exc:
        return {"url": url, "status": 0, "content_type": "", "body": "", "error": str(exc)}
    raw = p.stdout
    marker = "\n__NM7_STATUS__:"
    idx = raw.rfind(marker)
    body_and_headers = raw[:idx] if idx >= 0 else raw
    status_line = raw[idx + len(marker):].strip() if idx >= 0 else "0||0"
    parts = status_line.split("|", 2)
    status = int(parts[0]) if parts and parts[0].isdigit() else 0
    content_type = parts[1] if len(parts) > 1 else ""
    # Split response headers from body. curl's -D - can include multiple blocks.
    body = body_and_headers.split("\r\n\r\n")[-1].split("\n\n")[-1]
    return {
        "url": url,
        "status": status,
        "content_type": content_type,
        "body": body,
        "error": p.stderr.strip() if p.returncode and p.stderr.strip() else None,
    }

def classify(item, result):
    url = item["url"]
    status = result["status"]
    body = result["body"]
    dash = url.lower().split("?", 1)[0].endswith(".mpd")
    if status == 200:
        live = is_live_dash(body) if dash else is_live_hls(body)
        return {
            "name": item["name"], "url": url, "live": live,
            "status": status, "content_type": result["content_type"],
            "error": None,
            "inactive_reason": None if live else ("DASH MPD is not live" if dash else "HLS playlist is not live"),
        }
    if status in (404, 410):
        return {
            "name": item["name"], "url": url, "live": False,
            "status": status, "content_type": result["content_type"],
            "error": None, "inactive_reason": f"HTTP {status}",
        }
    return {
        "name": item["name"], "url": url, "live": False,
        "status": status, "content_type": result["content_type"],
        "error": result["error"] or f"HTTP {status}",
        "inactive_reason": None,
    }

def load_proxies():
    text = get_text(VIETNAM_PROXY_LIST_URL)
    proxies = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            host, port = line.rsplit(":", 1)
            if host and port.isdigit():
                proxies.append(line)
    # De-duplicate while preserving the current public ordering.
    return list(dict.fromkeys(proxies))

def probe_via_rotating_proxies(item, proxies, max_proxy_tries=8):
    # Direct first: some FPT POPs may allow requests without a proxy.
    direct = curl_probe(item["url"], headers=HEADER_PROFILES[0])
    if direct["status"] == 200:
        return classify(item, direct), "direct"
    if direct["status"] in (404, 410):
        return classify(item, direct), "direct"

    # A 403 is an access-control result, not proof that the event is offline.
    # Re-test unresolved 403s with alternate browser request profiles before
    # leaving them as probe errors.
    if direct["status"] == 403:
        for profile in HEADER_PROFILES[1:]:
            alt = curl_probe(item["url"], headers=profile)
            if alt["status"] in (200, 404, 410):
                return classify(item, alt), "direct-profile"

    # Free proxies are volatile. Try a bounded set in parallel for THIS URL,
    # then take the first definitive response. This avoids serially waiting on
    # dead proxies and prevents one proxy from being reused across 46 URLs.
    # Spread attempts across the full fresh Vietnam proxy list instead of
    # trusting only the first few entries, which are often dead/overloaded.
    candidates = []
    usable = [p for p in proxies if p]
    if len(usable) <= max_proxy_tries:
        candidates = usable
    elif usable:
        step = (len(usable) - 1) / float(max_proxy_tries - 1)
        seen = set()
        for i in range(max_proxy_tries):
            idx = int(round(i * step))
            proxy = usable[idx]
            if proxy not in seen:
                candidates.append(proxy)
                seen.add(proxy)
    if not candidates:
        return {
            "name": item["name"], "url": item["url"], "live": False,
            "status": direct["status"], "content_type": direct["content_type"],
            "error": direct["error"] or f"HTTP {direct['status']}",
            "inactive_reason": None,
        }, None

    def test(proxy):
        result = curl_probe(item["url"], proxy, headers=HEADER_PROFILES[0])
        if result["status"] == 200:
            return proxy, classify(item, result)
        if result["status"] in (404, 410):
            return proxy, classify(item, result)
        return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, len(candidates))) as pool:
        futures = [pool.submit(test, proxy) for proxy in candidates]
        definitive = []
        for future in concurrent.futures.as_completed(futures):
            try:
                found = future.result()
                if not found:
                    continue
                proxy, classified = found
                if classified["live"]:
                    for other in futures:
                        if not other.done():
                            other.cancel()
                    return classified, proxy
                definitive.append((proxy, classified))
            except Exception:
                pass

    if definitive:
        # Prefer a non-error definitive response if every tested proxy missed live.
        definitive.sort(key=lambda pair: (
            pair[1]["error"] is not None,
            pair[1]["status"] == 0,
        ))
        return definitive[0][1], definitive[0][0]

    return {
        "name": item["name"],
        "url": item["url"],
        "live": False,
        "status": direct["status"],
        "content_type": direct["content_type"],
        "error": direct["error"] or f"HTTP {direct['status']}",
        "inactive_reason": None,
    }, None


def scan_all(candidates, proxies):
    results = []
    details = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = {
            pool.submit(probe_via_rotating_proxies, item, proxies, MAX_PROXY_TRIES): item
            for item in candidates
        }
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                classified, transport = future.result()
                results.append(classified)
                details[item["url"]] = transport
            except Exception as exc:
                results.append({
                    "name": item["name"], "url": item["url"], "live": False,
                    "status": 0, "content_type": "", "error": str(exc),
                    "inactive_reason": None,
                })
                details[item["url"]] = None

    order = {item["url"]: i for i, item in enumerate(candidates)}
    results.sort(key=lambda x: order.get(x["url"], 999999))
    return results, details

def build_m3u(results):
    lines = ["#EXTM3U", "#NM7-SCAN-VERIFIED: true", "#NM7-SCAN-MODE: vietnam-transport-source-only"]
    for row in results:
        if not row["live"]:
            continue
        lines.append(f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{row["name"]}')
        lines.append(row["url"])
    return "\n".join(lines) + "\n"

def main():
    source = get_text(SOURCE_URL)
    candidates = parse_source(source)
    if not candidates:
        raise RuntimeError("Source M3U contains no valid HTTP(S) endpoints")

    try:
        proxies = load_proxies()
    except Exception as exc:
        # Direct probes remain useful even if the public Vietnam proxy list
        # is temporarily unavailable. The scan will still report real errors.
        print(f"PROXY_LIST_WARNING {type(exc).__name__}: {exc}")
        proxies = []

    # Every exact source URL gets its own direct+rotating-proxy decision.
    # This avoids reusing one unstable free proxy across the whole 46-entry scan.
    results, transports = scan_all(candidates, proxies)

    # Retry only failed endpoints with the reverse proxy order. This gives
    # transient/dead-proxy failures an independent second chance without
    # doubling the scan cost for healthy endpoints.
    first_errors = [x for x in results if x["error"]]
    if first_errors and proxies:
        retry_candidates = [
            {"name": x["name"], "url": x["url"]}
            for x in first_errors
        ]
        retry_results, retry_transports = scan_all(
            retry_candidates,
            list(reversed(proxies)),
        )
        retry_by_url = {x["url"]: x for x in retry_results}
        for idx, row in enumerate(results):
            replacement = retry_by_url.get(row["url"])
            if replacement and not replacement["error"]:
                results[idx] = replacement
                transports[row["url"]] = retry_transports.get(row["url"])

    live = [x for x in results if x["live"]]
    errors = [x for x in results if x["error"]]
    all_403 = len(results) > 0 and all(x["status"] == 403 for x in results)

    status = {
        "service": "NM7 FPT Event Live Scanner",
        "scannerVersion": "source-probe-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": SOURCE_URL,
        "sourceOnly": True,
        "candidates": len(candidates),
        "liveEntries": len(live),
        "inactiveEntries": len([x for x in results if not x["live"] and not x["error"]]),
        "probeErrors": len(errors),
        "allProbeErrorsAre403": all_403,
        "scanHealthy": len(errors) == 0,
        "partialScan": len(errors) > 0 and len(live) > 0,
        "transport": "per-url-rotating-vietnam-proxy",
        "transportCount": sum(1 for v in transports.values() if v),
        "event07Transport": transports.get(EVENT7_URL),
        "liveChannels": [{"name": x["name"], "url": x["url"]} for x in live],
        "errors": results if len(results) <= 60 else results[:60],
    }

    os.makedirs(os.path.dirname(OUTPUT_M3U), exist_ok=True)
    os.makedirs(os.path.dirname(OUTPUT_STATUS), exist_ok=True)

    # Publish positively verified live URLs even when a small number of
    # endpoints remain unreachable after two probe passes. Unverified URLs are
    # never added to the output, so the public playlist remains live-only.
    can_publish = (len(errors) == 0) or (len(live) > 0)
    if can_publish:
        with open(OUTPUT_M3U, "w", encoding="utf-8") as f:
            f.write(build_m3u(results))
    elif not os.path.exists(OUTPUT_M3U):
        raise RuntimeError(
            "No publishable live result: FPT/transport returned errors and no previous playlist exists"
        )

    with open(OUTPUT_STATUS, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "candidates": len(candidates),
        "liveEntries": len(live),
        "probeErrors": len(errors),
        "scanHealthy": status["scanHealthy"],
        "partialScan": status["partialScan"],
        "transport": "per-url-rotating-vietnam-proxy",
        "proxyUsed": any(v for v in transports.values()),
        "liveChannels": status["liveChannels"],
        "allProbeErrorsAre403": all_403,
        "publishedCurrentScan": can_publish,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
