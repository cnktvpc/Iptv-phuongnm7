# NM7 FPT Event Live — Progress

## 2026-10-01 — v7 subrequest-safe fix

### Runtime evidence
- Production /status reported 46 candidates: 38 HLS + 8 DASH.
- liveEntries = 0 and playlistEntries = 0.
- probeErrors = 46.
- Every reported probe error was:
  "Too many subrequests by single Worker invocation."
- Therefore the failure was in the probe architecture, not evidence that all 46 FPT sources were offline.

### Root causes isolated
1. scan() used Promise.all(candidates.map(probe)) and launched all endpoint probes together.
2. probe() could retry the same endpoint across three User-Agent values on 401/403.
3. Each manifest fetch used redirect: "follow", so redirect chains could consume extra subrequests.
4. The source fetch plus 46 probes had almost no margin under the Workers Free 50 external-subrequest limit.
5. scheduled() caught and swallowed scan failures inside waitUntil(), so a real scan failure could be recorded as a successful Cron invocation.
6. README and the actual deployed source had drifted: README described an older 250-candidate batch architecture while the current Worker source had 46 direct candidates and a 5-minute Cron.

### v7 implemented
- Worker version: fpt-event-resilient-v7-subrequest-safe.
- Full 46-endpoint scan remains every 5 minutes.
- Maximum 5 endpoint probes run concurrently.
- One primary probe per endpoint.
- Maximum 2 fallback probes per invocation for 401/403 or redirect cases.
- Manifest fetches use redirect: "manual" to avoid hidden redirect subrequests.
- External subrequest safety budget is hard-capped at 49, leaving a margin below the Workers Free 50-request limit.
- Current source size above the safe full-scan capacity fails explicitly instead of silently skipping endpoints.
- Duplicate source URLs are removed before probing.
- 8-second per-probe timeout added.
- HTTP 200 with non-M3U/non-MPD content is treated as probe error, not as clean inactive.
- If all probes fail specifically because of a subrequest-limit condition, the previous good playlist is preserved.
- Individual endpoint errors do not preserve unrelated stale channels; only currently confirmed live results are published.
- /status now exposes probe budget, concurrency, fallback usage, scan health, scan duration, protocol statistics and DASH diagnostics.
- scheduled() now rethrows after recording failure so Cron Past Events can reflect a real failure.

### Validation performed locally
- Syntax check passed for the new Worker source.
- Mock full-scan test: 46 candidates, 5-way concurrency, 47 external requests when no fallback is needed; playlist/result counts matched.
- Quota-failure test: 46 probe errors were handled without exceeding 47 external requests; the last good playlist remained intact.
- Fallback budget test reached the hard ceiling of 49 external requests and did not exceed it.

### GitHub updates
- cloudflare/fpt-event-worker/src/index.js updated to v7.
- .github/workflows/deploy-fpt-event-worker.yml updated to verify v7 and enforce the declared subrequest budget.
- cloudflare/fpt-event-worker/README.md rewritten to match the real 46-endpoint architecture.
- This progress file updated with the diagnosis and validation.

### Deployment
The source changes are committed on main. The deploy workflow is configured to run on changes under cloudflare/fpt-event-worker and then call /scan for post-deploy verification.

### Next production verification
After the GitHub Actions deployment completes, /status should show:
- workerVersion = fpt-event-resilient-v7-subrequest-safe
- candidates = 46 (unless the source file changes)
- subrequestBudget.maxExternalSubrequests = 49
- subrequestBudget.used <= 49
- probeErrors reported per actual source condition
- protocolStats showing 38 HLS + 8 DASH
- liveEntries = currently confirmed live events
- /fpt-event-live.m3u containing only the entries accepted by the current scan

If the FPT CDN itself changes its response format or starts requiring additional authorization/signatures, that is a separate source-access issue and will be visible in the per-endpoint diagnostics rather than being masked as a quota failure.

### 2026-10-01 — Production verification after v7 deployment

- Production deployment version observed: e3d305bb-6404-416b-9d9f-c3fe08658179.
- Cron trigger is active at */5 * * * *.
- First full production verification after v7 succeeded cleanly:
  - candidates: 46
  - HLS: 38 candidates, 5 live, 33 inactive, 0 errors
  - DASH: 8 candidates, 0 live, 8 inactive, 0 errors
  - external subrequests used: 47/49 safety budget
  - live channels confirmed:
    1. Sự kiện FPT 01
    2. Sự kiện FPT 09
    3. Sự kiện FPT 10
    4. Sự kiện FPT Event 02
    5. Sự kiện FPT Event 07
- All eight current DASH event URLs in the source returned clean HTTP 404 during that healthy scan; they are treated as inactive, not as probe errors.
- A second full scan only about 30 seconds later received HTTP 403 from all 46 endpoints. This was traced to repeated manual scans during consecutive CI deployments, not to the original subrequest-limit defect.
- The Worker therefore now:
  - does not force a full /scan during every CI deployment;
  - runs the real scan through Cloudflare Cron every 5 minutes;
  - preserves the last healthy playlist for up to 15 minutes during a degraded scan;
  - does not overwrite a healthy playlist with an empty playlist just because FPT temporarily returns 403/timeouts;
  - expires degraded snapshots after the grace period instead of keeping stale events indefinitely.
- CI deployment verification now checks /status and the playlist endpoint without triggering another full scan.
- Manual FPT CDN diagnostics were separated into .github/workflows/diagnose-fpt-event-cdn.yml.

### Final runtime/CI state — 2026-10-01

- Final runtime fix commit: ff6e07e9a9a23318945d39f6b91ff4fba29fe3a1.
- Final production deployment verified by GitHub Actions: run 36837503122, conclusion success.
- Cloudflare production Version ID: a011faa9-baa1-4110-b3fa-7e1445e43281.
- Production trigger confirmed: */5 * * * *.
- Final runtime probe pool is limited to 3 concurrent endpoint checks and does not perform immediate retries on HTTP 403.
- The deployment workflow no longer forces /scan after every deploy. It verifies /status and the playlist endpoint only, avoiding back-to-back full scans that can trigger source-side blocking.
- Manual FPT CDN diagnostics are isolated in .github/workflows/diagnose-fpt-event-cdn.yml.
- Latest healthy full scan before the source-side block confirmed 5 live HLS entries:
  Sự kiện FPT 01, Sự kiện FPT 09, Sự kiện FPT 10, Sự kiện FPT Event 02, Sự kiện FPT Event 07.
- The same healthy scan confirmed all 8 DASH candidates as clean HTTP 404 and all remaining 33 HLS candidates as inactive.
- At the 08:35:47 UTC Cron run, FPT returned HTTP 403 for all 46 candidates. The Worker marked the scan degraded and preserved the 5-entry last healthy playlist instead of replacing it with an empty playlist.
- Current safety behavior: the last healthy playlist is preserved for a maximum of 15 minutes during degraded scans; after that it expires rather than remaining stale indefinitely.
- Root cause of the original empty playlist was Cloudflare's per-invocation subrequest limit combined with Promise.all + multi-UA retries + redirect:follow. That architecture has now been removed.

### Final recovery fix — 2026-10-01

- Root cause of the second disappearance confirmed at 08:53:24 UTC:
  - last healthy snapshot was from 08:33:26 UTC;
  - subsequent Cron scans received 403 for all 46 candidates;
  - the previous 15-minute degraded grace period expired;
  - KV contained a header-only M3U, so playlistEntries became 0.
- Adaptive recovery was added:
  - when the previous scan is globally blocked by 403, the Worker stops full-scanning 46 endpoints;
  - it probes at most 2 previously healthy channels, rotating through the known-good set;
  - while the source remains blocked, the last healthy playlist is preserved;
  - a header-only/empty KV playlist is replaced by the last-known-good 5-entry snapshot;
  - the public /fpt-event-live.m3u endpoint itself guarantees the same fallback instead of exposing an empty playlist;
  - when any recovery probe proves the source reachable/live again, the normal full 46-endpoint scan resumes on the next 5-minute Cron.
- Final runtime commit: f419458454bd1280b33af26fe64105e9966aaadd.
- Final CI commit: e29fb69cd2c5261ea33a332f8d36dc1585ae983f.
- Final deployment run 36839685317 completed successfully.
- Production Version ID from the final successful deployment: recorded in the successful Wrangler deployment immediately preceding the warm recovery check.
- Final warm-recovery verification at 08:58:53 UTC reported:
  - recoveryMode = true
  - recoveryProbeSucceeded = true
  - sourceBlocked = false
  - public playlist entry count = 5
- This means the public playlist is non-empty again and FPT access has shown a live response through the recovery path.


## 2026-10-01 — Persistent fail-safe hardening

- Fixed a latent failure in `recordFailure()`: it referenced scan-local variables that do not exist in the failure handler.
- Removed the 1-hour KV expiry from the published playlist, publication timestamp and recovery channel pool. These states are now persistent.
- Any degraded scan (403, timeout, network failure, invalid manifest, etc.) preserves the last usable playlist indefinitely until a clean scan confirms a new state.
- The public `/fpt-event-live.m3u` endpoint now falls back to the last-known-good event set whenever the stored playlist is empty and the latest scan is not clean.
- Manual `/scan` calls now have a 4-minute protection window so repeated CI/manual calls cannot hammer the FPT origin.
- Deployment no longer calls `/scan`; deployment validation checks the Worker and playlist endpoint only. Normal source probing remains on the Cloudflare 5-minute Cron/recovery loop.
- Clean scans persist the newest non-empty recovery pool for future recovery.
- Commit: `9c2bad3b89e6bdcbb0749cfa2a76519e8152fc01` plus diagnostic commit `3a2b053fd25a369c8c3d56c702a58c43b1bc9dca`.
- Production deploy workflow for the hardening commit completed successfully.
- Post-deploy production verification showed the public playlist endpoint returning **5 entries** with the v7 worker.
- At the verification time, FPT upstream was still returning HTTP 403 for all 46 candidates, so the Worker was in adaptive recovery and deliberately preserved the 5-entry last-known-good playlist instead of publishing an empty list.
- This hardening makes playlist availability resilient to prolonged upstream blocking. It cannot guarantee that an upstream FPT URL remains playable while FPT itself returns 403; a clean recovery scan is still required to refresh the live set.


## 2026-10-01 — v8 strict live filtering fix (authoritative current state)

The filtering bug was confirmed to be caused by mixing the persistent last-known-good recovery playlist with the public live playlist. When FPT returned HTTP 403 for all 46 endpoints, the old Worker preserved the 5 previously healthy channels and exposed them through the same /fpt-event-live.m3u URL even though their current live state could not be verified.

### v8 changes

- Worker version: fpt-event-strict-live-v8.
- /fpt-event-live.m3u is now strict: it exposes entries only after a clean 46-endpoint scan with zero probe errors.
- During 403/timeout/network-degraded recovery, the strict endpoint returns a header-only M3U and sets X-NM7-FPT-Verified: false and X-NM7-FPT-Filter: upstream-unverified.
- A separate /fpt-event-fallback.m3u endpoint is available for temporary recovery playback and is limited to 30 minutes of fallback age.
- The persistent last-known-good pool is no longer allowed to masquerade as the current live set.
- v7 KV state is migrated into the new fallback key when v8 recovery starts, so the old recovery pool is not lost.
- lastCleanLiveChannels, verifiedPlaylistEntries and fallback timestamps are retained in status for clearer diagnostics.
- GitHub Actions now runs node --check src/index.js before Wrangler deployment and verifies the v8 headers/endpoints without forcing a new FPT origin scan.

### Verification

- Main v8 code commit: 0ba070839e65489bb1415f0d23d4c947d82286b6.
- Compatibility/fallback hardening commit: 5d026ddee430c997a274128c758ed908372813bb.
- Production deployment version from Wrangler: b13102f4-a89b-4380-a98c-e59ac6300ed1.
- GitHub Actions deploy run: 36889765021, conclusion: success.
- JavaScript validation: success.
- Wrangler deployment: success.
- Production /status: Worker version v8, Cron */5 * * * *.
- Production strict playlist during the verification window: 0 entries with X-NM7-FPT-Verified: false, because FPT returned HTTP 403 on the current recovery probes.
- Separate FPT CDN diagnostic run confirmed all tested official and alternate representative endpoints returned HTTP 403 from the GitHub runner.
- This means the Worker is running and the filtering logic now avoids publishing stale channels as currently live when the upstream cannot be verified.

### Operational rule going forward

A new clean scan is required before /fpt-event-live.m3u shows channels again. When FPT becomes reachable, the next 5-minute Cron resumes the full 46-endpoint scan; only channels whose current manifests pass the live checks are published.

## 2026-10-01 — v10 metadata-assisted current-event recovery

### Research result
- Server-side probes to the 46 official FPT event endpoints and the previously tested alternate FPT CDN paths continue to return HTTP 403 from datacenter/GitHub execution.
- A useful independent signal was identified in two public playlist generators:
  - `vhd0/Stuff` regenerates `m3u/listtivi.m3u` hourly and currently carries the FPT event subset.
  - `vuminhthanh12/vuminhthanh12` regenerates `vmttv` whenever its source state changes and its FPT event section tracks additions/removals.
- On 2026-10-01, the current `vhd0/Stuff` snapshot was committed at 15:35:49 UTC and contained the FPT event set; the latest `vmttv` change was 13:57:50 UTC.

### v10 implementation
- Worker version: `fpt-event-strict-live-v10`.
- When the primary FPT source is globally blocked by 403, the Worker first fetches a fresh current-event metadata source and checks its latest Git commit timestamp.
- Metadata snapshots older than 3 hours are rejected.
- Only FPT event URLs with current event artwork metadata are included.
- The strict endpoint can now publish these current-event candidates with:
  - `X-NM7-FPT-Verified: false`
  - `X-NM7-FPT-Filter: metadata-assisted-current-events`
- `verifiedPlaylistEntries` remains 0 because direct CDN probing is still blocked.
- The old last-known-good five-channel pool is not used to populate the current strict playlist.
- A clean direct scan automatically supersedes the metadata-assisted state when FPT server-side access recovers.

### Important limitation
The metadata source tells us which FPT event streams are currently advertised by an independently refreshed playlist. It does not prove that the FPT CDN will accept a request from every client/network. The Worker therefore exposes the distinction explicitly instead of mislabelling metadata-assisted entries as directly verified live streams.

### Deployment target
- GitHub Actions must validate `fpt-event-strict-live-v10`.
- Cron remains `*/5 * * * *`.
- No CI step should force a new 46-endpoint FPT scan.


## 2026-10-01 — v12 fix: newly-live event was being skipped

### Root cause

The v11 Worker entered a low-frequency recovery path whenever the previous scan looked globally blocked by HTTP 403. That recovery path probed only a small rotating set of previously healthy channels.

This created a real filtering blind spot: when FPT had a **new event live** whose URL was present in the official source M3U but was not in the historical last-known-good pool, the Worker never probed that URL during recovery. Therefore the event could be playable now while the strict playlist still showed no current event.

### v12 behavior

- Worker version: `fpt-event-source-proven-live-v12`.
- Recovery shortcut based on `priorLooksBlocked` was removed.
- Every 5-minute scan always loads the exact source M3U and probes all 46 source URLs.
- The source URL is never replaced or supplemented by another playlist/metadata source.
- A URL is added to the public playlist only when that exact URL returns a valid live HLS/DASH manifest in the current scan.
- Partial scans are supported:
  - some URLs may be 403/unreachable;
  - any positively verified live URLs are still published;
  - unverified URLs remain absent;
  - `scanHealthy=false` and `partialScan=true` make the incomplete verification explicit.
- If no URL is positively verified live, the strict playlist is empty. Historical channels are never copied into the strict result.
- `recordFailure()` now explicitly clears `publishedFromCurrentScan` and the current-live counters so a failed source fetch cannot accidentally expose a previous playlist as current live.
- Legacy v10 metadata-assisted status fields are sanitized without republishing those entries.

### Current-source scan after deploy

The deployment workflow now performs one best-effort `/scan` after a successful v12 deploy and prints the resulting strict playlist. Normal Cron remains `*/5 * * * *`.

### Validation rule

The CI source-only integrity test still requires every public playlist URL to be an exact URL from:

`https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/sources/fpt-events-source.m3u`

and rejects old metadata/alternate-source markers.


## 2026-10-02 — Independent GitHub Actions watchdog

### Mô hình mới
- Giữ nguyên GitHub Actions `.github/workflows/fpt-event-scan.yml` là scanner chính.
- Giữ nguyên `nm7-fpt-event-live` là delivery Worker v15.
- Bổ sung Cloudflare Worker riêng: `nm7-fpt-event-watchdog`.
- Watchdog Cron: `*/5 * * * *`.
- Watchdog kiểm tra run gần nhất của `fpt-event-scan.yml`.
- Nếu run mới hơn 8 phút: không làm gì.
- Nếu run vẫn queued/in_progress/requested/waiting/pending: không dispatch trùng.
- Nếu không có run hoặc run mới nhất quá 8 phút: gọi GitHub `workflow_dispatch` trên `main` để khởi động scanner.

### Files
- `tools/cloudflare-fpt-watchdog/src/index.js`
- `tools/cloudflare-fpt-watchdog/wrangler.toml`
- `tools/cloudflare-fpt-watchdog/README.md`
- `.github/workflows/deploy-fpt-event-watchdog.yml`

### GitHub
- Scanner cron đã được chuẩn hóa về `*/5 * * * *`.
- Scanner concurrency đã chuyển sang `cancel-in-progress: false` để run mới không hủy run đang xử lý.
- Watchdog deploy workflow dùng lại `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID` hiện có.

### Secret cần có trên Cloudflare watchdog
- Watchdog không còn yêu cầu `GITHUB_TOKEN`; nó chỉ đọc trạng thái công khai. GitHub Actions scanner chạy theo lịch 5 phút và là bộ cập nhật chính.

### Commit
- Scanner schedule/concurrency fix: `c92f5a96f5e7bade0ef63083c1f70eba18e34025`.
- Watchdog source: `926580abfaa339b0d13a31ce36952d7fa69071fa`.
- Watchdog config: `720623c22a2932adac7e0845203f516b99be5358`.
- Watchdog README: `acc85298dc5c3a708aef912cb29f8915febd9ef8`.
- Watchdog deploy workflow: `b26afab25c720e6f9af544db4de03acc82d64d2d`.

### Lưu ý triển khai
- Việc thêm code/deploy workflow đã hoàn tất trong repository.
- Để watchdog thực sự dispatch được GitHub Actions, Cloudflare Worker phải được deploy và Secret `GITHUB_TOKEN` phải được cấu hình trên Worker.
