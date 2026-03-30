const state = {
  auth: null,
  reference: null,
  status: null,
  jobs: [],
  selectedId: null,
  statusTimer: null,
  filterDefaultsApplied: false
};

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

window.addEventListener("DOMContentLoaded", () => {
  bindControls();
  bootstrap().catch(showError);
});

function bindControls() {
  document.getElementById("registerBtn").addEventListener("click", () => registerWebAuthn());
  document.getElementById("loginBtn").addEventListener("click", () => loginWebAuthn());
  document.getElementById("addKeyBtn").addEventListener("click", () => {
    window.location.href = "/keys";
  });
  document.getElementById("gotifyTestBtn").addEventListener("click", runGotifyTest);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("refreshBtn").addEventListener("click", () => runRefresh(false));
  document.getElementById("loginRefreshBtn").addEventListener("click", () => runRefresh(true));
  document.getElementById("saveScheduleBtn").addEventListener("click", saveSchedule);

  for (const id of ["filterSearch", "filterType", "filterTransport", "filterWaiting"]) {
    document.getElementById(id).addEventListener("input", renderJobs);
    document.getElementById(id).addEventListener("change", renderJobs);
  }
  document.getElementById("filterNearby").addEventListener("change", renderJobs);

  document.getElementById("scheduleMode").addEventListener("change", updateScheduleVisibility);
}

async function bootstrap() {
  await refreshAuthStatus();
  if (state.auth?.authenticated) {
    await refreshAll();
    startStatusPolling();
  }
}

async function refreshAuthStatus() {
  const response = await fetch("/api/auth/status", {
    credentials: "same-origin"
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Failed to load auth status");
  }

  state.auth = payload;
  renderAuth();
}

function renderAuth() {
  const authShell = document.getElementById("authShell");
  const appShell = document.getElementById("appShell");
  const authTitle = document.getElementById("authTitle");
  const authDescription = document.getElementById("authDescription");
  const authNameRow = document.getElementById("authNameRow");
  const registerBtn = document.getElementById("registerBtn");
  const loginBtn = document.getElementById("loginBtn");
  const addKeyBtn = document.getElementById("addKeyBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const hasCredentials = Boolean(state.auth?.has_credentials);
  const authenticated = Boolean(state.auth?.authenticated);

  authShell.classList.toggle("hidden", authenticated);
  appShell.classList.toggle("hidden", !authenticated);
  authNameRow.classList.toggle("hidden", hasCredentials);

  if (!hasCredentials) {
    authTitle.textContent = "Create the first passkey";
    authDescription.textContent =
      "Register a YubiKey, platform passkey, or phone passkey to secure the dashboard.";
    registerBtn.classList.remove("hidden");
    loginBtn.classList.add("hidden");
  } else {
    authTitle.textContent = "GetTransfer Dashboard";
    authDescription.textContent =
      "Log in with your YubiKey, passkey, or your phone before using the dashboard.";
    registerBtn.classList.add("hidden");
    loginBtn.classList.remove("hidden");
  }

  addKeyBtn.classList.toggle("hidden", !authenticated);
  logoutBtn.classList.toggle("hidden", !authenticated);
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshJobs()]);
}

async function refreshStatus() {
  const payload = await fetchJson("/api/status");
  state.status = payload;
  renderStatus();
}

async function refreshJobs() {
  const payload = await fetchJson("/api/jobs");
  state.reference = payload.reference || null;
  state.jobs = payload.jobs || [];
  buildFilterOptions();

  if (state.selectedId === null && state.jobs.length > 0) {
    state.selectedId = state.jobs[0].id;
  }

  if (!state.jobs.some((job) => job.id === state.selectedId)) {
    state.selectedId = state.jobs[0]?.id ?? null;
  }

  renderJobs();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });
  const payload = await response.json();

  if (response.status === 401) {
    stopStatusPolling();
    state.status = null;
    state.jobs = [];
    state.selectedId = null;
    await refreshAuthStatus();
    throw new Error(payload.error || "Session expired");
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

async function runRefresh(forceLogin) {
  setButtonsDisabled(true);
  try {
    await fetchJson(forceLogin ? "/api/login-refresh" : "/api/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        force_login: forceLogin
      })
    });
    await refreshAll();
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

async function runGotifyTest() {
  setButtonsDisabled(true);
  try {
    await fetchJson("/api/gotify-test", {
      method: "POST"
    });
    await refreshStatus();
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

async function saveSchedule() {
  const weekdayChecks = Array.from(
    document.querySelectorAll("#weekdayPicker input[type=checkbox]")
  );
  const schedule = {
    mode: document.getElementById("scheduleMode").value,
    time: document.getElementById("scheduleTime").value,
    days: weekdayChecks.filter((input) => input.checked).map((input) => Number(input.value)),
    auto_login_on_failure: document.getElementById("autoLoginOnFailure").checked
  };

  try {
    await fetchJson("/api/schedule", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ schedule })
    });
    await refreshStatus();
  } catch (error) {
    showError(error);
  }
}

async function registerWebAuthn(isAdditionalKey = false) {
  const keyName = document.getElementById("authKeyName").value.trim();
  if (!isAdditionalKey && !state.auth?.has_credentials && !keyName) {
    setAuthMessage("Enter a name for the first key before registering.");
    document.getElementById("authKeyName").focus();
    return;
  }

  setButtonsDisabled(true);
  setAuthMessage("Requesting registration options...");

  try {
    const optionsPayload = await fetchJson("/auth/register-options", {
      method: "POST"
    });
    const options = preparePublicKeyOptions(optionsPayload.options);
    setAuthMessage("Use your passkey, YubiKey, or phone...");
    const credential = await navigator.credentials.create({ publicKey: options });
    setAuthMessage("Verifying credential...");
    await fetchJson("/auth/register-verify", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...serializeCredential(credential),
        keyName: keyName || "Security key"
      })
    });
    setAuthMessage("Passkey registered.");
    document.getElementById("authKeyName").value = "";
    await refreshAuthStatus();
    if (state.auth?.authenticated) {
      await refreshAll();
      startStatusPolling();
    }
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

async function loginWebAuthn() {
  setButtonsDisabled(true);
  setAuthMessage("Requesting login challenge...");

  try {
    const optionsPayload = await fetchJson("/auth/login-options", {
      method: "POST"
    });
    const options = preparePublicKeyOptions(optionsPayload.options);
    setAuthMessage("Use your passkey, YubiKey, or phone...");
    const credential = await navigator.credentials.get({ publicKey: options });
    setAuthMessage("Verifying credential...");
    await fetchJson("/auth/login-verify", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(serializeCredential(credential))
    });
    await refreshAuthStatus();
    await refreshAll();
    startStatusPolling();
    setAuthMessage("");
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

async function logout() {
  setButtonsDisabled(true);
  try {
    await fetchJson("/auth/logout", {
      method: "POST"
    });
    stopStatusPolling();
    state.status = null;
    state.jobs = [];
    state.selectedId = null;
    await refreshAuthStatus();
    renderJobs();
    renderDetail(null);
    setAuthMessage("");
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  state.statusTimer = window.setInterval(() => {
    refreshStatus().catch(() => {});
  }, 15000);
}

function stopStatusPolling() {
  if (state.statusTimer) {
    window.clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

function renderStatus() {
  if (!state.status) {
    return;
  }

  const cards = [
    {
      title: "Last Scrape",
      metric: state.status.state.last_refresh_status || "idle",
      sub: [
        formatDateTime(state.status.state.last_refresh_finished_at),
        state.status.state.last_refresh_error || ""
      ].filter(Boolean)
    },
    {
      title: "Jobs",
      metric: String(state.status.jobs_summary.total || 0),
      sub: Object.entries(state.status.jobs_summary.by_type || {}).map(
        ([name, count]) => `${name}: ${count}`
      )
    },
    {
      title: "Session",
      metric: state.status.session.exists ? ageLabel(state.status.session.age_seconds) : "missing",
      sub: [
        state.status.session.login_hint ? `login: ${state.status.session.login_hint}` : "",
        state.status.session.saved_at ? `saved ${formatDateTime(state.status.session.saved_at)}` : ""
      ].filter(Boolean)
    },
    {
      title: "Session Continuity",
      metric: state.status.audit?.session_continuity?.age_seconds == null
        ? "unknown"
        : ageLabel(state.status.audit.session_continuity.age_seconds),
      sub: [
        state.status.audit?.session_continuity?.success_count != null
          ? `${state.status.audit.session_continuity.success_count} successful scrape${
              state.status.audit.session_continuity.success_count === 1 ? "" : "s"
            }`
          : "",
        state.status.audit?.session_continuity?.rotation_count != null
          ? `${state.status.audit.session_continuity.rotation_count} rotation${
              state.status.audit.session_continuity.rotation_count === 1 ? "" : "s"
            }`
          : ""
      ].filter(Boolean)
    },
    {
      title: "Cookies",
      metric:
        state.status.cookies.cf_clearance_expires_in_seconds === null
          ? "n/a"
          : ageUntilLabel(state.status.cookies.cf_clearance_expires_in_seconds),
      sub: [
        state.status.cookies.cf_clearance_expires_at
          ? `cf_clearance until ${formatDateTime(state.status.cookies.cf_clearance_expires_at)}`
          : "no cf_clearance expiry",
        state.status.cookies.rack_session_expires_at
          ? `rack.session until ${formatDateTime(state.status.cookies.rack_session_expires_at)}`
          : ""
      ].filter(Boolean)
    },
    {
      title: "2FA",
      metric: state.status.state.last_login_method || state.status.session.login_hint || "unknown",
      sub: [
        state.status.state.last_2fa_source?.source || state.status.latest_otp?.source || "",
        state.status.state.last_2fa_source?.title || state.status.latest_otp?.title || ""
      ].filter(Boolean)
    },
    {
      title: "Access",
      metric: state.auth?.user?.name || "authenticated",
      sub: [
        state.auth?.webauthn?.rp_id ? `rp: ${state.auth.webauthn.rp_id}` : "",
        state.auth?.user?.last_used_at
          ? `last used ${formatDateTime(state.auth.user.last_used_at)}`
          : ""
      ].filter(Boolean)
    },
    {
      title: "Gotify",
      metric: state.status.gotify?.configured
        ? state.status.gotify.last_status || "configured"
        : "not configured",
      sub: [
        state.status.gotify?.last_sent_at
          ? `sent ${formatDateTime(state.status.gotify.last_sent_at)}`
          : "",
        state.status.gotify?.last_error || ""
      ].filter(Boolean)
    },
    {
      title: "Next Run",
      metric: state.status.next_run_at ? formatDateTime(state.status.next_run_at) : "disabled",
      sub: [
        state.status.config.schedule.mode,
        scheduleDaysLabel(state.status.config.schedule)
      ].filter(Boolean)
    }
  ];

  const cardsContainer = document.getElementById("statusCards");
  cardsContainer.innerHTML = cards
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

  const badge = document.getElementById("operationBadge");
  badge.textContent = state.status.operation ? state.status.operation.type : "Idle";

  const schedule = state.status.config.schedule;
  document.getElementById("scheduleMode").value = schedule.mode;
  document.getElementById("scheduleTime").value = schedule.time;
  document.getElementById("autoLoginOnFailure").checked = schedule.auto_login_on_failure !== false;
  for (const input of document.querySelectorAll("#weekdayPicker input[type=checkbox]")) {
    input.checked = Array.isArray(schedule.days) && schedule.days.includes(Number(input.value));
  }
  updateScheduleVisibility();
}

function buildFilterOptions() {
  const typeOptions = uniqueValues(state.jobs.map((job) => job.type));
  const transportOptions = uniqueValues(
    state.jobs.flatMap((job) => String(job.transport_types || "").split("|"))
  );
  const waitingOptions = uniqueValues(state.jobs.map((job) => job.waiting_time_to));

  populateSelect("filterType", typeOptions);
  populateSelect("filterTransport", transportOptions);
  populateSelect("filterWaiting", waitingOptions);

  if (!state.filterDefaultsApplied) {
    document.getElementById("filterType").value = typeOptions.includes("one_way")
      ? "one_way"
      : "";
    document.getElementById("filterTransport").value = "__economy_or_any";
    document.getElementById("filterNearby").checked = true;
    state.filterDefaultsApplied = true;
  }
}

function populateSelect(id, values) {
  const select = document.getElementById(id);
  const current = select.value;
  const extraOptions =
    id === "filterTransport"
      ? `<option value="__economy_or_any">Economy Or Any</option>`
      : "";
  select.innerHTML = `<option value="">All</option>${extraOptions}${values
    .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;

  if (id === "filterTransport" && current === "__economy_or_any") {
    select.value = "__economy_or_any";
    return;
  }

  select.value = values.includes(current) ? current : "";
}

function renderJobs() {
  const tbody = document.getElementById("jobsTableBody");
  const meta = document.getElementById("jobsMeta");

  if (!state.auth?.authenticated) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Sign in to load jobs.</td></tr>`;
    meta.textContent = "Authentication required.";
    renderDetail(null);
    return;
  }

  const rows = applyFilters(state.jobs);
  meta.textContent = `${rows.length} shown of ${state.jobs.length} jobs${
    state.reference?.postcode ? ` near ${state.reference.postcode}` : ""
  }`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No jobs match the current filters.</td></tr>`;
    renderDetail(null);
    return;
  }

  tbody.innerHTML = rows
    .map(
      (job) => `
        <tr data-id="${job.id}" class="${job.id === state.selectedId ? "selected" : ""}">
          <td>${escapeHtml(String(job.id ?? ""))}</td>
          <td>${escapeHtml(formatDateTime(job.pickup_at))}</td>
          <td><span class="pill">${escapeHtml(job.type || "unknown")}</span></td>
          <td>${escapeHtml(String(job.passengers ?? ""))}</td>
          <td>${escapeHtml(job.distance_km == null ? "" : `${job.distance_km} km`)}</td>
          <td>${escapeHtml(job.from_name || "")}</td>
          <td>${escapeHtml(job.to_name || "")}</td>
          <td>${escapeHtml(job.transport_types || "")}</td>
        </tr>
      `
    )
    .join("");

  for (const row of tbody.querySelectorAll("tr[data-id]")) {
    row.addEventListener("click", () => {
      state.selectedId = Number(row.dataset.id);
      renderJobs();
    });
  }

  const selectedJob = rows.find((job) => job.id === state.selectedId) || rows[0];
  state.selectedId = selectedJob.id;
  renderDetail(selectedJob);
}

function renderDetail(job) {
  const container = document.getElementById("jobDetail");
  if (!job) {
    container.className = "detail-empty";
    container.textContent = "No job selected.";
    return;
  }

  container.className = "detail-grid";
  const fields = [
    ["Pickup", formatDateTime(job.pickup_at)],
    ["Return", formatDateTime(job.return_at)],
    ["Passengers", job.passengers],
    ["Distance", job.distance_km == null ? "" : `${job.distance_km} km`],
    ["Time", job.time_minutes == null ? "" : `${job.time_minutes} min`],
    ["From", job.from_name],
    ["To", job.to_name],
    ["Transport", job.transport_types],
    [
      `From Distance To ${state.reference?.postcode || "Reference"}`,
      job.from_distance_to_reference_miles == null
        ? ""
        : `${job.from_distance_to_reference_miles} miles`
    ],
    [
      `To Distance To ${state.reference?.postcode || "Reference"}`,
      job.to_distance_to_reference_miles == null
        ? ""
        : `${job.to_distance_to_reference_miles} miles`
    ],
    ["Waiting To", job.waiting_time_to],
    ["Waiting Return", job.waiting_time_return],
    ["Child Seats", job.child_seats_total],
    ["Name Sign", boolLabel(job.name_sign_present)],
    ["Chosen On Map From", boolLabel(job.from_chosen_on_map)],
    ["Chosen On Map To", boolLabel(job.to_chosen_on_map)],
    ["Water Taxi", boolLabel(job.watertaxi)],
    ["Air Conditioning", boolLabel(job.air_conditioner_option_available)]
  ];

  container.innerHTML = fields
    .map(
      ([label, value]) => `
        <div class="detail-item">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(String(value ?? ""))}</span>
        </div>
      `
    )
    .join("");
}

function applyFilters(jobs) {
  const search = document.getElementById("filterSearch").value.trim().toLowerCase();
  const type = document.getElementById("filterType").value;
  const transport = document.getElementById("filterTransport").value;
  const waiting = document.getElementById("filterWaiting").value;
  const nearbyOnly = document.getElementById("filterNearby").checked;

  return jobs.filter((job) => {
    if (type && job.type !== type) {
      return false;
    }
    if (transport) {
      const transportValues = String(job.transport_types || "")
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean);

      if (transport === "__economy_or_any") {
        if (transportValues.length > 0 && !transportValues.includes("economy")) {
          return false;
        }
      } else if (!transportValues.includes(transport)) {
        return false;
      }
    }
    if (waiting && job.waiting_time_to !== waiting) {
      return false;
    }
    if (nearbyOnly) {
      const hasKnownDistance =
        typeof job.from_distance_to_reference_miles === "number" ||
        typeof job.to_distance_to_reference_miles === "number";
      if (hasKnownDistance && !job.within_reference_radius) {
        return false;
      }
    }
    if (!search) {
      return true;
    }

    const haystack = [
      job.id,
      job.type,
      job.from_name,
      job.to_name,
      job.transport_types,
      job.waiting_time_to
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });
}

function updateScheduleVisibility() {
  const weekly = document.getElementById("scheduleMode").value === "weekly";
  document.getElementById("weekdayPicker").style.display = weekly ? "flex" : "none";
}

function setButtonsDisabled(disabled) {
  for (const id of [
    "registerBtn",
    "loginBtn",
    "addKeyBtn",
    "gotifyTestBtn",
    "logoutBtn",
    "refreshBtn",
    "loginRefreshBtn",
    "saveScheduleBtn"
  ]) {
    const element = document.getElementById(id);
    if (element) {
      element.disabled = disabled;
    }
  }
}

function setAuthMessage(message) {
  document.getElementById("authStatus").textContent = message || "";
}

function showError(error) {
  const message = String(error.message || error);
  if (!state.auth?.authenticated) {
    setAuthMessage(message);
  }
  const badge = document.getElementById("operationBadge");
  badge.textContent = message;
}

function preparePublicKeyOptions(options) {
  const next = { ...options };
  next.challenge = base64urlToBuffer(next.challenge);

  if (next.user?.id) {
    next.user = { ...next.user, id: base64urlToBuffer(next.user.id) };
  }

  if (Array.isArray(next.allowCredentials)) {
    next.allowCredentials = next.allowCredentials.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id)
    }));
  }

  if (Array.isArray(next.excludeCredentials)) {
    next.excludeCredentials = next.excludeCredentials.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id)
    }));
  }

  return next;
}

function serializeCredential(credential) {
  if (!credential) {
    throw new Error("No WebAuthn credential returned");
  }

  const response = {
    clientDataJSON: bufferToBase64url(credential.response.clientDataJSON)
  };

  if (credential.response.attestationObject) {
    response.attestationObject = bufferToBase64url(credential.response.attestationObject);
  }

  if (credential.response.authenticatorData) {
    response.authenticatorData = bufferToBase64url(credential.response.authenticatorData);
  }

  if (credential.response.signature) {
    response.signature = bufferToBase64url(credential.response.signature);
  }

  if (credential.response.userHandle) {
    response.userHandle = bufferToBase64url(credential.response.userHandle);
  }

  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    response,
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment
  };
}

function base64urlToBuffer(value) {
  let next = String(value);
  const pad = next.length % 4;
  if (pad) {
    next += "=".repeat(4 - pad);
  }
  const binary = atob(next.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

function bufferToBase64url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function uniqueValues(values) {
  return Array.from(
    new Set(
      values
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  ).sort();
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

function ageLabel(seconds) {
  if (seconds == null) {
    return "n/a";
  }
  if (seconds < 60) {
    return `${seconds}s old`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m old`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h old`;
  }
  return `${Math.floor(seconds / 86400)}d old`;
}

function ageUntilLabel(seconds) {
  if (seconds == null) {
    return "n/a";
  }
  if (seconds <= 0) {
    return "expired";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m left`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h left`;
  }
  return `${Math.floor(seconds / 86400)}d left`;
}

function scheduleDaysLabel(schedule) {
  if (schedule.mode !== "weekly" || !Array.isArray(schedule.days)) {
    return "";
  }
  return schedule.days.map((day) => weekdayNames[day]).join(", ");
}

function boolLabel(value) {
  return value ? "Yes" : "No";
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
