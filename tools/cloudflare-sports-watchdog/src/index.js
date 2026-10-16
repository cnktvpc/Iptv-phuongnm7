const REPO = "dungntk9/Iptv-phuongnm7";
const WORKFLOW = "update-sports-auto.yml";
const BRANCH = "main";
const STALE_AFTER_MS = 8 * 60 * 1000;
const API_VERSION = "2026-03-10";
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "NM7-Sports-Watchdog/2.0",
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body?.message || body?.raw || "error"}`);
  return body;
}

async function runWatchdog() {
  const url = new URL(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`);
  url.searchParams.set("branch", BRANCH);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("exclude_pull_requests", "true");
  const data = await githubJson(url.toString());
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  const latest = runs[0] || null;
  if (!latest) return { action: "monitor", reason: "no_previous_run", githubTokenRequired: false };

  const createdAt = Date.parse(latest.created_at);
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : Infinity;
  const status = String(latest.status || "unknown");
  let reason = "github_schedule_is_authoritative";
  if (ACTIVE_STATUSES.has(status)) reason = "workflow_still_active";
  else if (ageMs < STALE_AFTER_MS) reason = "recent_run";
  else reason = "latest_run_older_than_8_minutes_monitor_only";

  return {
    action: "monitor",
    reason,
    githubTokenRequired: false,
    run_id: latest.id,
    status,
    conclusion: latest.conclusion ?? null,
    age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
  };
}

export default {
  async scheduled(controller) {
    try {
      const result = await runWatchdog();
      console.log(JSON.stringify({
        service: "nm7-sports-watchdog",
        cron: controller.cron,
        scheduled_at: new Date(controller.scheduledTime).toISOString(),
        ...result,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        service: "nm7-sports-watchdog",
        cron: controller.cron,
        scheduled_at: new Date(controller.scheduledTime).toISOString(),
        action: "error",
        error: error instanceof Error ? error.message : String(error),
        githubTokenRequired: false,
      }));
    }
  },
  async fetch() {
    return Response.json({
      ok: true,
      service: "nm7-sports-watchdog",
      schedule: "*/5 * * * *",
      stale_after_minutes: 8,
      githubTokenRequired: false,
    });
  },
};
