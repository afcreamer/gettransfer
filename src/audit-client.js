const state = {
  auth: null,
  audit: null
};

window.addEventListener("DOMContentLoaded", () => {
  bindControls();
  bootstrap().catch(showError);
});

function bindControls() {
  document.getElementById("auditRefreshBtn").addEventListener("click", refreshAudit);
  document.getElementById("auditLogoutBtn").addEventListener("click", logout);
}

async function bootstrap() {
  await refreshAuthStatus();
  if (!state.auth?.authenticated) {
    return;
  }
  await refreshAudit();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || "Request failed");
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function refreshAuthStatus() {
  const payload = await fetchJson("/api/auth/status");
  state.auth = payload;
  renderAuth();
}

async function refreshAudit() {
  try {
    const payload = await fetchJson("/api/audit");
    state.audit = payload;
    renderAudit();
    showError("");
  } catch (error) {
    if (error.statusCode === 401) {
      state.auth = error.payload?.auth || null;
      renderAuth();
      return;
    }
    throw error;
  }
}

async function logout() {
  try {
    await fetchJson("/auth/logout", { method: "POST" });
    window.location.href = "/";
  } catch (error) {
    showError(error);
  }
}

function renderAuth() {
  const authenticated = Boolean(state.auth?.authenticated);
  document.getElementById("auditAuthShell").classList.toggle("hidden", authenticated);
  document.getElementById("auditAppShell").classList.toggle("hidden", !authenticated);

  if (!authenticated) {
    document.getElementById("auditAuthStatus").textContent = state.auth?.has_credentials
      ? "Log in on the dashboard first, then come back to the audit trail."
      : "Register the first access key on the dashboard before using the audit trail.";
    return;
  }

  document.getElementById("auditUserBadge").textContent =
    state.auth?.user?.name || "Signed in";
}

function renderAudit() {
  if (!state.audit) {
    return;
  }

  renderSummaryCards();
  renderStrategy();
  renderTimeline();
}

function renderSummaryCards() {
  const summary = state.audit.summary || {};
  const continuity = summary.session_continuity || {};
  const cards = [
    {
      title: "Auth State",
      metric: humanLabel(summary.current_auth_state || "unknown"),
      sub: [
        summary.last_success_at ? `last success ${formatDateTime(summary.last_success_at)}` : "",
        summary.last_failure_at ? `last failure ${formatDateTime(summary.last_failure_at)}` : ""
      ].filter(Boolean)
    },
    {
      title: "Current Session",
      metric: continuity.age_seconds == null ? "unknown" : ageLabel(continuity.age_seconds),
      sub: [
        continuity.since ? `tracking since ${formatDateTime(continuity.since)}` : "",
        continuity.fingerprint ? `fingerprint ${continuity.fingerprint}` : ""
      ].filter(Boolean)
    },
    {
      title: "Session Reuse",
      metric: String(continuity.success_count || 0),
      sub: [
        `${continuity.rotation_count || 0} rotation${continuity.rotation_count === 1 ? "" : "s"}`,
        "successful scrapes on this session"
      ]
    },
    {
      title: "Events Stored",
      metric: String(summary.total_events || 0),
      sub: [summary.strategy?.cadence || ""].filter(Boolean)
    }
  ];

  document.getElementById("auditSummaryCards").innerHTML = cards
    .map(
      (card) => `
        <article class="card">
          <h3>${escapeHtml(card.title)}</h3>
          <div class="metric">${escapeHtml(card.metric)}</div>
          <div class="metric-sub">${card.sub.map(escapeHtml).join("<br />")}</div>
        </article>
      `
    )
    .join("");
}

function renderStrategy() {
  const strategy = state.audit.summary?.strategy || {};
  document.getElementById("auditStrategyMeta").textContent =
    strategy.cadence || "No schedule summary available.";

  document.getElementById("auditStrategy").innerHTML = `
    <article class="audit-event">
      <div class="audit-event-head">
        <div>
          <div class="audit-event-title">${escapeHtml(strategy.headline || "Current strategy")}</div>
          <div class="audit-event-meta">The dashboard uses this policy to stay low-impact.</div>
        </div>
      </div>
      <p class="audit-event-narrative">${escapeHtml(
        strategy.summary ||
          "The dashboard tries the saved session first, then only logs in when necessary."
      )}</p>
    </article>
  `;
}

function renderTimeline() {
  const events = Array.isArray(state.audit.events) ? state.audit.events : [];
  document.getElementById("auditEventsMeta").textContent = `${events.length} recent event${
    events.length === 1 ? "" : "s"
  }.`;

  const container = document.getElementById("auditTimeline");
  if (events.length === 0) {
    container.innerHTML = `<div class="detail-empty">No audit events recorded yet.</div>`;
    return;
  }

  container.innerHTML = events
    .map((event) => {
      const details = Array.isArray(event.details) ? event.details : [];
      return `
        <article class="audit-event audit-${escapeAttribute(event.level || "info")}">
          <div class="audit-event-head">
            <div>
              <div class="audit-event-title">${escapeHtml(event.title || "Event")}</div>
              <div class="audit-event-meta">
                ${escapeHtml(formatDateTime(event.at))} ·
                ${escapeHtml(event.category || "system")} ·
                auth ${escapeHtml(humanLabel(event.auth?.current_auth_state || "unknown"))}
              </div>
            </div>
            <span class="pill">${escapeHtml(event.level || "info")}</span>
          </div>
          <p class="audit-event-summary">${escapeHtml(event.summary || "")}</p>
          <p class="audit-event-narrative">${escapeHtml(event.narrative || "")}</p>
          ${
            details.length > 0
              ? `<ul class="audit-event-details">${details
                  .map((detail) => `<li>${escapeHtml(detail)}</li>`)
                  .join("")}</ul>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function showError(error) {
  const message = String(error?.message || error || "");
  const status = document.getElementById("auditAuthStatus");
  if (status) {
    status.textContent = message;
  }
}

function humanLabel(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

function ageLabel(seconds) {
  if (seconds == null) {
    return "unknown";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
