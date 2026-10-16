// Migration: public GitHub read APIs only; no legacy GitHub token or dispatch.
const REPO = "dungntk9/Iptv-phuongnm7";
const WORKFLOW = "fpt-event-scan.yml";
const BRANCH = "main";
const STATUS_URL = "https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/generated/fpt-event-live.status.json";
const STALE_AFTER_MS = 8 * 60 * 1000;
const API_VERSION = "2026-03-10";
const ACTIVE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "NM7-FPT-Event-Watchdog/3.0",
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body?.message || body?.raw || "error"}`);
  return body;
}

async function latestRun() {
  const url = new URL(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`);
  url.searchParams.set("branch", BRANCH);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("exclude_pull_requests", "true");
  const data = await githubJson(url.toString());
  return Array.isArray(data?.workflow_runs) ? (data.workflow_runs[0] || null) : null;
}

async function latestScanStatus() {
  const response = await fetch(`${STATUS_URL}?_=${Date.now()}`, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
      Accept: "application/json",
      "User-Agent": "NM7-FPT-Event-Watchdog/3.0",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`scanner-status-http-${response.status}`);
  return response.json();
}

function ageMinutes(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 60000));
}

async function check() {
  const [runResult, scanResult] = await Promise.allSettled([latestRun(), latestScanStatus()]);
  if (runResult.status === "rejected") throw runResult.reason;

  const run = runResult.value;
  const scan = scanResult.status === "fulfilled" ? scanResult.value : null;
  const scanStatusError = scanResult.status === "rejected"
    ? (scanResult.reason instanceof Error ? scanResult.reason.message : String(scanResult.reason))
    : null;

  const runAgeMs = run?.created_at ? Date.now() - Date.parse(run.created_at) : Infinity;
  const runAgeMinutes = Number.isFinite(runAgeMs) ? Math.max(0, Math.round(runAgeMs / 60000)) : null;
  const scanAgeMinutes = ageMinutes(scan?.generatedAt);
  const scanFresh = scanAgeMinutes !== null && scanAgeMinutes < 8;
  const validCandidateCount = Number(scan?.candidates) > 0;
  const sourceOnly = scan?.sourceOnly === true;
  const validPublishedScan = Boolean(sourceOnly &&
    (scan?.scanHealthy === true || (scan?.partialScan === true && Number(scan?.liveEntries) > 0)));
  const activeRun = Boolean(run && ACTIVE.has(run.status));

  let reason = "github_schedule_is_authoritative";
  if (activeRun) reason = "scanner_workflow_running";
  else if (scanStatusError) reason = "scanner_status_unavailable";
  else if (!scanFresh) reason = "scanner_status_stale";
  else if (!validCandidateCount || !validPublishedScan) reason = "scanner_output_invalid";
  else if (run && runAgeMs >= STALE_AFTER_MS) reason = "scanner_run_is_old_monitor_only";

  return {
    action: "monitor",
    reason,
    githubTokenRequired: false,
    latest_run_id: run?.id ?? null,
    latest_run_status: run?.status ?? null,
    latest_run_conclusion: run?.conclusion ?? null,
    latest_run_age_minutes: runAgeMinutes,
    scan_generated_at: scan?.generatedAt ?? null,
    scan_age_minutes: scanAgeMinutes,
    scan_healthy: scan?.scanHealthy ?? null,
    partial_scan: scan?.partialScan ?? null,
    candidates: Number(scan?.candidates ?? 0),
    live_entries: Number(scan?.liveEntries ?? 0),
    probe_errors: Number(scan?.probeErrors ?? 0),
    source_only: scan?.sourceOnly ?? null,
    scan_status_error: scanStatusError,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export default {
  async scheduled(controller) {
    const baseLog = {
      service: "nm7-fpt-event-watchdog",
      cron: controller.cron,
      scheduled_at: new Date(controller.scheduledTime).toISOString(),
      github_token_required: false,
    };
    try {
      console.log(JSON.stringify({ ...baseLog, ...(await check()) }));
    } catch (error) {
      console.error(JSON.stringify({ ...baseLog, action: "error", error: errorMessage(error) }));
    }
  },

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "nm7-fpt-event-watchdog",
        schedule: "*/5 * * * *",
        targetWorkflow: WORKFLOW,
        staleAfterMinutes: 8,
        githubTokenRequired: false,
      });
    }
    if (url.pathname === "/run") {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      try {
        return Response.json({ ok: true, service: "nm7-fpt-event-watchdog", ...(await check()) });
      } catch (error) {
        return Response.json({ ok: false, service: "nm7-fpt-event-watchdog", error: errorMessage(error) }, { status: 502 });
      }
    }
    return new Response("NM7 FPT Event Watchdog\n\n/health\nPOST /run\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
