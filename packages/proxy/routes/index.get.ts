import { getDegradationRetryAfterSeconds } from "@m365-copilot/core";
import { buildModelsPayload } from "@m365-copilot/proxy-lib";
import { getActiveSessionsSnapshot, getDashboardSnapshot } from "../metrics";

function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 2,
  }).format(value);
}

function fmtSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 1000)} s`;
}

function fmtAgo(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function renderModelRows() {
  const snapshot = getDashboardSnapshot();
  const models = buildModelsPayload().data.map((m) => m.id);
  const metricMap = new Map(snapshot.byModel.map((row) => [row.model, row]));
  const healthMap = new Map(snapshot.modelHealth.map((row) => [row.model, row]));

  if (models.length === 0) {
    return '<tr><td colspan="11" class="muted">No model data available.</td></tr>';
  }

  return models
    .map((model) => {
      const row = metricMap.get(model);
      const health = healthMap.get(model);
      const reachable = health?.ok === true;
      const unreachable = health?.ok === false;
      const statusIcon = reachable
        ? '<span class="badge ok" title="Reachable">✅</span>'
        : unreachable
          ? '<span class="badge err" title="Unreachable">❌</span>'
          : '<span class="badge unknown" title="Not checked">•</span>';
      const statusText = reachable ? "Reachable" : unreachable ? "Not Reachable" : "Unknown";
      const metricOrDash = (value: string) => (unreachable ? "-" : value);

      return `<tr>
      <td>
        <div class="model-cell">${statusIcon}<span>${esc(model)}</span></div>
      </td>
      <td>${statusText}</td>
      <td>${metricOrDash(fmtNum(row?.requests ?? null))}</td>
      <td>${metricOrDash(fmtNum(row?.successRequests ?? null))}</td>
      <td>${metricOrDash(fmtNum(row?.errorRequests ?? null))}</td>
      <td>${metricOrDash(fmtNum(row?.promptTokens ?? null))}</td>
      <td>${metricOrDash(fmtNum(row?.completionTokens ?? null))}</td>
      <td>${metricOrDash(fmtNum(row?.totalTokens ?? null))}</td>
      <td>${metricOrDash(fmtSeconds(row?.avgLatencyMs ?? null))}</td>
      <td>${metricOrDash(fmtSeconds(unreachable ? null : (health?.latencyMs ?? row?.avgModelLatencyMs ?? null)))}</td>
      <td>${metricOrDash(fmtAgo(row?.lastSeenAt ?? null))}</td>
    </tr>`;
    })
    .join("\n");
}

function renderActiveRows() {
  const sessions = getActiveSessionsSnapshot();
  if (sessions.length === 0) {
    return '<tr><td colspan="11" class="muted">No active sessions in memory.</td></tr>';
  }

  return sessions
    .map((s) => {
      const convQuota =
        s.conversationMessages !== null && s.conversationMax !== null
          ? `${s.conversationMessages}/${s.conversationMax}`
          : "n/a";
      return `<tr>
      <td>${esc(s.model)}</td>
      <td>${esc(s.sessionId)}</td>
      <td>${esc(s.conversationId)}</td>
      <td>${fmtNum(s.turnCount)}</td>
      <td>${fmtNum(s.sentMessageCount)}</td>
      <td>${fmtNum(s.promptTokens)}</td>
      <td>${fmtNum(s.completionTokens)}</td>
      <td>${fmtNum(s.totalTokens)}</td>
      <td>${esc(convQuota)}</td>
      <td>${fmtSeconds(s.modelLatencyMs)}</td>
      <td>${fmtAgo(s.lastAccessedAt)}</td>
    </tr>`;
    })
    .join("\n");
}

function renderModelOptions() {
  const models = buildModelsPayload().data.map((m) => m.id);
  if (models.length === 0) {
    return '<option value="m365-copilot">m365-copilot</option>';
  }
  return models.map((model) => `<option value="${esc(model)}">${esc(model)}</option>`).join("\n");
}

export default defineEventHandler(() => {
  const snapshot = getDashboardSnapshot();
  const retryAfterSeconds = getDegradationRetryAfterSeconds();
  const accountThrottle = snapshot.accountThrottle;
  const accountStatus =
    accountThrottle.status === "throttled"
      ? "Throttled (last observed)"
      : accountThrottle.status === "recovered"
        ? "Recovery observed"
        : "Unknown";
  const healthyModels = snapshot.modelHealth.filter((m) => m.ok === true).length;
  const unhealthyModels = snapshot.modelHealth.filter((m) => m.ok === false).length;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M365 Proxy Dashboard</title>
  <style>
    :root {
      --bg: #f8f4eb;
      --panel: #fffdf8;
      --panel-2: #fff8ef;
      --ink: #152127;
      --muted: #5a6773;
      --line: #e6dac8;
      --accent: #005b64;
      --accent-2: #d8f1ed;
      --danger: #b4233d;
      --ok: #12713f;
      --shadow: 0 10px 28px rgba(14, 23, 34, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 8% -25%, #bbe7de 0, transparent 45%),
        radial-gradient(circle at 96% -8%, #ffd8b8 0, transparent 32%),
        linear-gradient(180deg, #fffdf8 0%, #f8f4eb 70%),
        var(--bg);
    }
    .wrap {
      max-width: 1260px;
      margin: 0 auto;
      padding: 1.2rem 1.2rem 2rem;
    }
    .hero {
      display: grid;
      gap: 0.8rem;
      margin-bottom: 1rem;
    }
    .title {
      margin: 0;
      font-family: "IBM Plex Serif", Georgia, serif;
      font-size: clamp(1.4rem, 2.2vw, 2.2rem);
      letter-spacing: 0.02em;
    }
    .sub {
      color: var(--muted);
      font-size: 0.95rem;
      margin: 0;
    }
    .health-strip {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      margin-top: 0.35rem;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.3rem 0.65rem;
      font-size: 0.82rem;
      background: var(--panel);
      color: var(--muted);
    }
    .pill.ok {
      color: var(--ok);
      border-color: #b9e0c8;
      background: #effaf3;
    }
    .pill.err {
      color: var(--danger);
      border-color: #f0c0ca;
      background: #fff1f4;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0.6rem;
      margin-bottom: 1rem;
    }
    .card {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0.8rem;
      box-shadow: var(--shadow);
    }
    .card .k {
      color: var(--muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .card .v {
      margin-top: 0.35rem;
      font-weight: 700;
      font-size: 1.2rem;
    }
    .panel {
      background: linear-gradient(180deg, var(--panel) 0%, #fffaf1 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0.9rem;
      margin-bottom: 0.9rem;
      box-shadow: var(--shadow);
    }
    .panel h2 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
      font-family: "IBM Plex Serif", Georgia, serif;
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 0.5rem;
      align-items: center;
    }
    select, button {
      font: inherit;
      border-radius: 10px;
      border: 1px solid var(--line);
      padding: 0.55rem 0.7rem;
      background: #fff;
      color: var(--ink);
    }
    button {
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease;
      background: var(--accent-2);
      border-color: #c8ddda;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .status {
      min-height: 1.2rem;
      margin-top: 0.65rem;
      font-size: 0.9rem;
      color: var(--muted);
    }
    .status.ok { color: var(--ok); }
    .status.err { color: var(--danger); }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    thead {
      background: #f3f8f6;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--line);
      padding: 0.55rem 0.55rem;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) {
      background: #fffcf7;
    }
    tbody tr:hover {
      background: #f5fbf8;
    }
    .model-cell {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 999px;
      font-size: 0.95rem;
      line-height: 1;
      border: 1px solid transparent;
      background: #fff;
    }
    .badge.ok {
      border-color: #b9e0c8;
      background: #effaf3;
    }
    .badge.err {
      border-color: #f0c0ca;
      background: #fff1f4;
    }
    .badge.unknown {
      border-color: #dde3df;
      color: #95a2a7;
      background: #f6f8f7;
      font-size: 1.15rem;
    }
    .muted { color: var(--muted); }
    .note {
      font-size: 0.84rem;
      color: var(--muted);
      margin-top: 0.6rem;
    }
    @media (max-width: 820px) {
      .controls {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1 class="title">M365 Proxy Runtime Dashboard</h1>
      <p class="sub">Auto-refreshes every 10s. Includes request latency, model latency, and token usage by model.</p>
      <div class="health-strip">
        <span class="pill ok">✅ Reachable: ${fmtNum(healthyModels)}</span>
        <span class="pill err">❌ Unreachable: ${fmtNum(unhealthyModels)}</span>
        <span class="pill${accountThrottle.status === "throttled" ? " err" : ""}" title="${esc(accountThrottle.message ?? "No account-throttle response recorded")}">
          M365: <strong>${accountStatus}</strong>
        </span>
        ${accountThrottle.since !== null
      ? `<span class="pill">
          First observed: <time data-throttle-observed-at="${accountThrottle.since}" datetime="${new Date(accountThrottle.since).toISOString()}" title="${new Date(accountThrottle.since).toISOString()}">${fmtAgo(accountThrottle.since)}</time>
        </span>`
      : ""
    }
        ${accountThrottle.lastObservedAt !== null
      ? `<span class="pill">
          Last throttle: <time data-throttle-observed-at="${accountThrottle.lastObservedAt}" datetime="${new Date(accountThrottle.lastObservedAt).toISOString()}" title="${new Date(accountThrottle.lastObservedAt).toISOString()}">${fmtAgo(accountThrottle.lastObservedAt)}</time>
        </span>`
      : ""
    }
        <span id="backoffStatus" class="pill${retryAfterSeconds > 0 ? " err" : ""}" title="Proxy-imposed wait recommendation">
          Local backoff: <strong id="backoffTime" data-retry-after="${retryAfterSeconds}">${retryAfterSeconds > 0 ? `${retryAfterSeconds}s` : "Inactive"}</strong>
        </span>
        <span class="pill">M365 reset: Unknown</span>
      </div>
    </section>

    <section class="cards">
      <article class="card"><div class="k">Active Sessions</div><div class="v">${fmtNum(snapshot.activeSessionCount)}</div></article>
      <article class="card"><div class="k">Requests</div><div class="v">${fmtNum(snapshot.totals.requests)}</div></article>
      <article class="card"><div class="k">Success / Error</div><div class="v">${fmtNum(snapshot.totals.successRequests)} / ${fmtNum(snapshot.totals.errorRequests)}</div></article>
      <article class="card"><div class="k">Prompt / Completion</div><div class="v">${fmtNum(snapshot.totals.promptTokens)} / ${fmtNum(snapshot.totals.completionTokens)}</div></article>
      <article class="card"><div class="k">Total Tokens</div><div class="v">${fmtNum(snapshot.totals.totalTokens)}</div></article>
      <article class="card"><div class="k">Avg Req / Model Latency</div><div class="v">${fmtSeconds(snapshot.totals.avgLatencyMs)} / ${fmtSeconds(snapshot.totals.avgModelLatencyMs)}</div></article>
    </section>

    <section class="panel">
      <h2>Actions</h2>
      <div class="controls">
        <label>
          <span class="muted">Model for Ping</span><br />
          <select id="modelSelect">${renderModelOptions()}</select>
        </label>
        <button id="pingBtn" type="button">Ping Selected Model</button>
        <button id="healthBtn" type="button">Check All Models Health</button>
      </div>
      <div id="status" class="status"></div>
    </section>

    <section class="panel">
      <h2>Per-Model Totals</h2>
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Status</th>
            <th>Requests</th>
            <th>Success</th>
            <th>Error</th>
            <th>Prompt</th>
            <th>Completion</th>
            <th>Total</th>
            <th>Avg Req Latency</th>
            <th>Avg Model Latency</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          ${renderModelRows()}
        </tbody>
      </table>
      </div>
    </section>

    <section class="panel">
      <h2>Active Session Tokens</h2>
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Session ID</th>
            <th>Conversation ID</th>
            <th>Turns</th>
            <th>Messages Sent</th>
            <th>Prompt</th>
            <th>Completion</th>
            <th>Total</th>
            <th>Conversation Quota</th>
            <th>Model Latency</th>
            <th>Last Access</th>
          </tr>
        </thead>
        <tbody>
          ${renderActiveRows()}
        </tbody>
      </table>
      </div>
      <p class="note">Prompt/completion tokens are currently zero when upstream does not expose token counts; conversation quota fields come from M365 usage metadata.</p>
    </section>
  </main>

  <script>
    (() => {
      const statusEl = document.getElementById("status");
      const pingBtn = document.getElementById("pingBtn");
      const healthBtn = document.getElementById("healthBtn");
      const modelSelect = document.getElementById("modelSelect");
      const backoffStatus = document.getElementById("backoffStatus");
      const backoffTime = document.getElementById("backoffTime");
      const backoffUntil = performance.now() + Number(backoffTime.dataset.retryAfter) * 1000;

      const updateBackoff = () => {
        const remaining = Math.max(0, Math.ceil((backoffUntil - performance.now()) / 1000));
        backoffTime.textContent = remaining > 0 ? remaining + "s" : "Inactive";
        backoffStatus.classList.toggle("err", remaining > 0);
      };
      updateBackoff();
      setInterval(updateBackoff, 1000);

      const observationTimes = document.querySelectorAll("[data-throttle-observed-at]");
      const updateThrottleAges = () => {
        for (const element of observationTimes) {
          const elapsed = Math.max(0, Math.floor((Date.now() - Number(element.dataset.throttleObservedAt)) / 1000));
          const age = elapsed < 60 ? elapsed + "s"
            : elapsed < 3600 ? Math.floor(elapsed / 60) + "m"
            : elapsed < 86400 ? Math.floor(elapsed / 3600) + "h"
            : Math.floor(elapsed / 86400) + "d";
          element.textContent = age + " ago";
        }
      };
      updateThrottleAges();
      setInterval(updateThrottleAges, 1000);

      const setStatus = (message, kind) => {
        statusEl.textContent = message;
        statusEl.className = "status" + (kind ? " " + kind : "");
      };

      const ping = async () => {
        const model = modelSelect.value;
        if (!model) {
          setStatus("Select a model first.", "err");
          return;
        }
        pingBtn.disabled = true;
        setStatus("Pinging " + model + "...");
        try {
          const res = await fetch("/actions/ping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
          });
          const data = await res.json();
          if (!res.ok) {
            setStatus("Ping failed: " + (data.error?.message || "unknown error"), "err");
          } else {
            setStatus("Ping " + data.model + ": " + data.status + " (" + (data.latencyMs / 1000).toFixed(2) + " s)", "ok");
          }
        } catch (err) {
          setStatus("Ping failed: " + (err.message || String(err)), "err");
        } finally {
          pingBtn.disabled = false;
        }
      };

      const checkAll = async () => {
        healthBtn.disabled = true;
        setStatus("Checking all models...");
        try {
          const res = await fetch("/actions/check-models", { method: "POST" });
          const data = await res.json();
          if (!res.ok) {
            setStatus("Health check failed: " + (data.error?.message || "unknown error"), "err");
          } else {
            const ok = data.results.filter((r) => r.ok).length;
            setStatus("Model health: " + ok + "/" + data.results.length + " healthy", ok === data.results.length ? "ok" : "err");
          }
        } catch (err) {
          setStatus("Health check failed: " + (err.message || String(err)), "err");
        } finally {
          healthBtn.disabled = false;
        }
      };

      pingBtn.addEventListener("click", ping);
      healthBtn.addEventListener("click", checkAll);
      setInterval(() => location.reload(), 10_000);
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
