#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const {
  buildTransfersUrl,
  extractTransfers,
  fetchPayload,
  normalizeJourney,
  resolveLoginEmail,
  resolveLoginPhone,
  resolveSessionInputFile,
  resolveStorageStateFile
} = require("./gettransfer");
const {
  buildAuthStatus,
  ensureAuthFiles,
  handleAuthRoute,
  requireAuth
} = require("./dashboard-auth");
const {
  processIncomingOtp,
  readBody,
  readLatestOtp,
  sendJson
} = require("./otp-receiver");

const HOST = process.env.DASHBOARD_LISTEN_HOST || process.env.OTP_LISTEN_HOST || "0.0.0.0";
const PORT = Number(process.env.DASHBOARD_PORT || process.env.OTP_LISTEN_PORT || "8765");
const OTP_FILE = path.resolve(process.env.OTP_OUTPUT_FILE || ".latest-otp.json");
const CONFIG_FILE = path.resolve(process.env.DASHBOARD_CONFIG_FILE || ".dashboard-config.json");
const STATE_FILE = path.resolve(process.env.DASHBOARD_STATE_FILE || ".dashboard-state.json");
const JOBS_FILE = path.resolve(process.env.DASHBOARD_JOBS_FILE || ".latest-jobs.json");
const PAYLOAD_FILE = path.resolve(
  process.env.DASHBOARD_PAYLOAD_FILE || ".latest-provider-payload.json"
);
const AUDIT_FILE = path.resolve(process.env.DASHBOARD_AUDIT_FILE || ".dashboard-audit.jsonl");
const STATUS_POLL_MS = Number(process.env.DASHBOARD_SCHEDULE_POLL_MS || "30000");
const AUDIT_MAX_EVENTS = Number(process.env.DASHBOARD_AUDIT_MAX_EVENTS || "500");
const LOGIN_TIMEOUT_SECONDS = Number(process.env.GETTRANSFER_LOGIN_TIMEOUT || "180");
const GOTIFY_URL = process.env.GOTIFY_URL || "";
const GOTIFY_KEY = process.env.GOTIFY_KEY || process.env.GOTIFY_TOKEN || "";
const REFERENCE_POSTCODE = process.env.DASHBOARD_REFERENCE_POSTCODE || "EH4 4DN";
const REFERENCE_RADIUS_MILES = Number(process.env.DASHBOARD_REFERENCE_RADIUS_MILES || "15");
const STARTUP_REFRESH_ENABLED =
  String(process.env.DASHBOARD_STARTUP_REFRESH || "true").toLowerCase() !== "false";
const STARTUP_REFRESH_DELAY_MS = Number(
  process.env.DASHBOARD_STARTUP_REFRESH_DELAY_MS || "1500"
);
const HTML_FILE = path.resolve(__dirname, "dashboard.html");
const KEYS_HTML_FILE = path.resolve(__dirname, "keys.html");
const CSS_FILE = path.resolve(__dirname, "dashboard.css");
const CLIENT_FILE = path.resolve(__dirname, "dashboard-client.js");
const KEYS_CLIENT_FILE = path.resolve(__dirname, "keys-client.js");
const AUDIT_HTML_FILE = path.resolve(__dirname, "audit.html");
const AUDIT_CLIENT_FILE = path.resolve(__dirname, "audit-client.js");

const DEFAULT_CONFIG = {
  schedule: {
    mode: "disabled",
    time: "09:00",
    days: [1],
    auto_login_on_failure: true
  }
};

let currentOperation = null;
let referenceLocationCache = null;

function main() {
  ensureDataFiles();
  ensureAuthFiles();
  reconcileStaleRefreshState();

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && requestUrl.pathname === "/") {
        return sendStatic(res, HTML_FILE, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/keys") {
        return sendStatic(res, KEYS_HTML_FILE, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/audit") {
        return sendStatic(res, AUDIT_HTML_FILE, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/dashboard.css") {
        return sendStatic(res, CSS_FILE, "text/css; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/dashboard-client.js") {
        return sendStatic(res, CLIENT_FILE, "text/javascript; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/keys-client.js") {
        return sendStatic(res, KEYS_CLIENT_FILE, "text/javascript; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/audit-client.js") {
        return sendStatic(res, AUDIT_CLIENT_FILE, "text/javascript; charset=utf-8");
      }

      if (req.method === "GET" && requestUrl.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          operation: currentOperation ? currentOperation.type : null,
          next_run_at: computeNextRunAt(loadConfig().schedule)?.toISOString() || null
        });
      }

      if (await handleAuthRoute(req, res, requestUrl.pathname)) {
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/otp") {
        if (!requireAuth(req, res)) {
          return;
        }
        const payload = readLatestOtp(OTP_FILE);
        if (!payload) {
          return sendJson(res, 404, { ok: false, error: "No OTP captured yet" });
        }
        return sendJson(res, 200, summarizeOtpPayload(payload));
      }

      if (req.method === "POST" && requestUrl.pathname === "/otp") {
        const raw = await readBody(req);
        const payload = processIncomingOtp({
          raw,
          remoteAddress: req.socket.remoteAddress || "",
          outputFile: OTP_FILE
        });
        mergeState({
          last_otp_received_at: payload.received_at,
          last_otp_source: summarizeOtpPayload(payload)
        });
        appendAuditEvent({
          level: "info",
          category: "otp",
          action: "received",
          title: "OTP received",
          summary: buildOtpAuditSummary(payload),
          narrative:
            "The system received a fresh OTP notification and saved it for the next login attempt.",
          details: [
            `Source: ${payload.source || "unknown"}`,
            `Sender: ${sanitizeText(
              payload.raw?.notification_title ||
                payload.raw?.title ||
                payload.raw?.sender ||
                payload.raw?.from ||
                "unknown"
            )}`,
            `Received: ${payload.received_at || "unknown"}`
          ]
        });
        return sendJson(res, 200, payload);
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/status") {
        if (!requireAuth(req, res)) {
          return;
        }
        return sendJson(res, 200, buildStatusPayload(req));
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
        if (!requireAuth(req, res)) {
          return;
        }
        return sendJson(res, 200, buildJobsPayload());
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/audit") {
        if (!requireAuth(req, res)) {
          return;
        }
        return sendJson(res, 200, buildAuditPayload(req));
      }

      if (
        req.method === "POST" &&
        (requestUrl.pathname === "/api/refresh" || requestUrl.pathname === "/api/login-refresh")
      ) {
        if (!requireAuth(req, res)) {
          return;
        }
        const raw = await readBody(req);
        const body = raw.trim() ? JSON.parse(raw) : {};
        const forceLogin =
          requestUrl.pathname === "/api/login-refresh" || body.force_login === true;
        const result = await runExclusive(forceLogin ? "login_refresh" : "refresh", () =>
          runRefresh({
            forceLogin,
            reason: body.reason || "manual"
          })
        );
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/gotify-test") {
        if (!requireAuth(req, res)) {
          return;
        }
        const result = await runGotifyTest();
        return sendJson(res, result.ok ? 200 : 502, result);
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/schedule") {
        if (!requireAuth(req, res)) {
          return;
        }
        return sendJson(res, 200, { ok: true, schedule: loadConfig().schedule });
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/schedule") {
        if (!requireAuth(req, res)) {
          return;
        }
        const raw = await readBody(req);
        const input = raw.trim() ? JSON.parse(raw) : {};
        const schedule = normalizeSchedule(input.schedule || input);
        const nextConfig = { ...loadConfig(), schedule };
        writeJson(CONFIG_FILE, nextConfig);
        appendAuditEvent({
          level: "info",
          category: "schedule",
          action: "updated",
          title: "Schedule updated",
          summary: describeSchedule(schedule),
          narrative:
            "The automatic pull schedule changed. The system will continue to prefer the existing session and only ask GetTransfer for new login codes when a fetch fails or you force a login.",
          details: [
            `Mode: ${schedule.mode}`,
            `Time: ${schedule.time}`,
            `Days: ${schedule.days.map((day) => weekdayName(day)).join(", ") || "n/a"}`,
            `Auto login on auth failure: ${schedule.auto_login_on_failure !== false ? "yes" : "no"}`
          ]
        });
        return sendJson(res, 200, {
          ok: true,
          schedule,
          next_run_at: computeNextRunAt(schedule)?.toISOString() || null
        });
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      if (res.headersSent) {
        process.stderr.write(`Request error after response sent: ${error.stack || error.message}\n`);
        return;
      }
      sendJson(res, statusCode, { ok: false, error: error.message });
    }
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Dashboard listening on http://${HOST}:${PORT}\n`);

    if (STARTUP_REFRESH_ENABLED) {
      appendAuditEvent({
        level: "info",
        category: "system",
        action: "startup_refresh_scheduled",
        title: "Startup refresh scheduled",
        summary: `A low-impact startup refresh will run in ${Math.round(
          STARTUP_REFRESH_DELAY_MS / 1000
        )} seconds.`,
        narrative:
          "On start, the dashboard tries a normal fetch first so development restarts do not trigger fresh login codes unless the saved session is no longer valid."
      });
      setTimeout(() => {
        runExclusive("startup_refresh", () =>
          runRefresh({
            forceLogin: false,
            reason: "startup"
          })
        ).catch((error) => {
          process.stderr.write(`Startup refresh failed: ${error.message}\n`);
        });
      }, STARTUP_REFRESH_DELAY_MS);
    }
  });

  setInterval(() => {
    runScheduledRefresh().catch((error) => {
      process.stderr.write(`Scheduled refresh failed: ${error.message}\n`);
    });
  }, STATUS_POLL_MS);
}

function ensureDataFiles() {
  if (!fs.existsSync(CONFIG_FILE)) {
    writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  }

  if (!fs.existsSync(STATE_FILE)) {
    writeJson(STATE_FILE, {
      created_at: new Date().toISOString()
    });
  }

  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, "", "utf8");
  }
}

function reconcileStaleRefreshState() {
  const state = loadState();
  if (state.last_refresh_status !== "running") {
    return;
  }

  mergeState({
    last_refresh_status: "aborted",
    last_refresh_error: "Dashboard restarted while a refresh was still marked running",
    last_refresh_finished_at: new Date().toISOString()
  });
  appendAuditEvent({
    level: "warn",
    category: "refresh",
    action: "reconciled_after_restart",
    title: "A previous refresh was interrupted",
    summary: "The dashboard restarted while a refresh was still marked as running.",
    narrative:
      "This does not mean GetTransfer was hit again. The dashboard is only correcting its local state so the next refresh can run cleanly."
  });
}

function loadConfig() {
  const loaded = readJson(CONFIG_FILE) || {};
  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    schedule: normalizeSchedule(loaded.schedule || DEFAULT_CONFIG.schedule)
  };
}

function loadState() {
  return readJson(STATE_FILE) || {};
}

function loadJobs() {
  return readJson(JOBS_FILE) || { jobs: [], summary: {}, fetched_at: null };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function mergeState(patch) {
  const nextState = {
    ...loadState(),
    ...patch,
    updated_at: new Date().toISOString()
  };
  writeJson(STATE_FILE, nextState);
  return nextState;
}

function buildStatusPayload(req) {
  const config = loadConfig();
  const state = loadState();
  const jobs = loadJobs();

  return {
    ok: true,
    config,
    state,
    operation: currentOperation,
    auth: buildAuthStatus(req),
    next_run_at: computeNextRunAt(config.schedule)?.toISOString() || null,
    session: readSessionSummary(),
    cookies: readStorageSummary(),
    latest_otp: summarizeOtpPayload(readLatestOtp(OTP_FILE)),
    gotify: buildGotifyStatus(state),
    audit: buildAuditSummary(),
    jobs_summary: jobs.summary || summarizeJobs(jobs.jobs || [])
  };
}

function buildAuditPayload(req) {
  return {
    ok: true,
    auth: buildAuthStatus(req),
    summary: buildAuditSummary(),
    events: readAuditEvents()
  };
}

function buildJobsPayload() {
  const payload = loadJobs();
  return {
    ok: true,
    fetched_at: payload.fetched_at || null,
    source_url: payload.source_url || null,
    reference: payload.reference || null,
    total: Array.isArray(payload.jobs) ? payload.jobs.length : 0,
    summary: payload.summary || summarizeJobs(payload.jobs || []),
    jobs: Array.isArray(payload.jobs) ? payload.jobs : []
  };
}

async function runExclusive(type, fn) {
  if (currentOperation) {
    const error = new Error(`Another operation is already running: ${currentOperation.type}`);
    error.statusCode = 409;
    throw error;
  }

  currentOperation = {
    type,
    started_at: new Date().toISOString()
  };

  appendAuditEvent({
    level: "info",
    category: "operation",
    action: "started",
    title: `${humanizeOperationType(type)} started`,
    summary: `Operation ${type} has the lock.`,
    narrative:
      "Only one refresh or login flow runs at a time so the system does not pile up repeated requests against GetTransfer."
  });

  try {
    return await fn();
  } finally {
    appendAuditEvent({
      level: "info",
      category: "operation",
      action: "finished",
      title: `${humanizeOperationType(type)} finished`,
      summary: `Operation ${type} released the lock.`,
      narrative:
        "The dashboard is idle again and ready for the next scheduled or manual action."
    });
    currentOperation = null;
  }
}

async function runRefresh({ forceLogin = false, reason = "manual", allowLoginOnFailure = true } = {}) {
  const startedAt = new Date().toISOString();
  mergeState({
    last_refresh_started_at: startedAt,
    last_refresh_reason: reason,
    last_refresh_status: "running",
    last_refresh_error: null
  });
  appendAuditEvent({
    level: "info",
    category: "refresh",
    action: "started",
    title: "Refresh started",
    summary: forceLogin
      ? `A ${reason} refresh was asked to log in first.`
      : `A ${reason} refresh started with session reuse first.`,
    narrative: forceLogin
      ? "Because this was a forced login refresh, the dashboard will obtain fresh authentication before fetching jobs."
      : "To keep traffic light and human-like, the dashboard first tries the saved session. It only asks GetTransfer for a new code if that fetch fails with an auth-style error.",
    details: [
      `Reason: ${reason}`,
      `Force login first: ${forceLogin ? "yes" : "no"}`,
      `Auto login on failure: ${allowLoginOnFailure ? "yes" : "no"}`
    ]
  });

  const fetchArgs = createFetchArgs();
  let loginResult = null;
  let payload;

  try {
    if (forceLogin) {
      appendAuditEvent({
        level: "info",
        category: "login",
        action: "requested_before_fetch",
        title: "Login requested before fetch",
        summary: "This refresh was told to log in before touching the jobs endpoint.",
        narrative:
          "A forced login is more expensive than a normal fetch, so it only runs when you ask for it explicitly."
      });
      loginResult = await runLoginCli();
    }

    try {
      appendAuditEvent({
        level: "info",
        category: "fetch",
        action: "attempted",
        title: "Trying the saved session",
        summary: "The dashboard is attempting a normal jobs fetch with the current session.",
        narrative:
          "This is the preferred path because it looks closest to your own regular use and avoids unnecessary login codes."
      });
      payload = await fetchPayload(fetchArgs);
    } catch (error) {
      if (!shouldAttemptRelogin(error, forceLogin, allowLoginOnFailure)) {
        appendAuditEvent({
          level: "error",
          category: "fetch",
          action: "failed_without_relogin",
          title: "Fetch failed and the dashboard did not re-login",
          summary: sanitizeText(error.message),
          narrative:
            "The dashboard only falls back to login when the failure looks authentication-related and fallback login is allowed. In this case it stopped after the fetch failure.",
          details: buildErrorDetails(error)
        });
        throw error;
      }
      appendAuditEvent({
        level: "warn",
        category: "fetch",
        action: "failed_relogin_decision",
        title: "Saved session was not enough",
        summary: sanitizeText(error.message),
        narrative:
          "The fetch failed in a way that looked like an auth problem, so the dashboard chose a careful re-login rather than retrying the same request repeatedly.",
        details: buildErrorDetails(error)
      });
      loginResult = await runLoginCli();
      appendAuditEvent({
        level: "info",
        category: "fetch",
        action: "retry_after_login",
        title: "Retrying fetch after login",
        summary: `A fresh ${loginResult.login_method || "unknown"} login completed, so the dashboard is retrying the jobs fetch once.`,
        narrative:
          "The dashboard retries only once after login. This avoids noisy repeated scraping if GetTransfer is unhappy or still unauthenticated."
      });
      payload = await fetchPayload(fetchArgs);
    }

    const transfers = extractTransfers(payload);
    const referenceLocation = await resolveReferenceLocation();
    const jobs = transfers
      .map(normalizeJourney)
      .map((job) => enrichJobWithReference(job, referenceLocation));
    const summary = summarizeJobs(jobs);
    const fetchedAt = new Date().toISOString();
    const sourceUrl = buildTransfersUrl(fetchArgs);
    const sessionSummary = readSessionSummary();
    const continuity = updateSessionContinuity(sessionSummary, {
      fetchedAt,
      loginResult
    });

    writeJson(JOBS_FILE, {
      fetched_at: fetchedAt,
      source_url: sourceUrl,
      reference: referenceLocation
        ? {
            postcode: referenceLocation.postcode,
            latitude: referenceLocation.latitude,
            longitude: referenceLocation.longitude,
            radius_miles: REFERENCE_RADIUS_MILES
          }
        : {
            postcode: REFERENCE_POSTCODE,
            latitude: null,
            longitude: null,
            radius_miles: REFERENCE_RADIUS_MILES
          },
      jobs,
      summary
    });
    writeJson(PAYLOAD_FILE, {
      fetched_at: fetchedAt,
      source_url: sourceUrl,
      payload
    });

    const nextState = mergeState({
      last_refresh_finished_at: fetchedAt,
      last_refresh_status: "success",
      last_refresh_error: null,
      last_jobs_count: jobs.length,
      last_provider_url: sourceUrl,
      last_login_result: loginResult,
      last_login_at: loginResult?.saved_at || loadState().last_login_at || null,
      last_login_method:
        loginResult?.login_method ||
        loadState().last_login_method ||
        inferMethodFromSession(),
      last_2fa_source:
        loginResult?.latest_otp_source ||
        loadState().last_2fa_source ||
        summarizeOtpPayload(readLatestOtp(OTP_FILE))
    });
    if (continuity.patch) {
      mergeState(continuity.patch);
    }

    const notificationResult = await notifyMatchingJobs(jobs);
    if (notificationResult) {
      mergeState(notificationResult);
    }

    appendAuditEvent({
      level: "info",
      category: "refresh",
      action: "succeeded",
      title: "Refresh completed",
      summary: `${jobs.length} jobs fetched successfully.`,
      narrative: loginResult
        ? "This refresh needed a new login first, then fetched jobs successfully."
        : "This refresh succeeded on the existing session, which is exactly the low-friction path we want for daily operation.",
      details: [
        `Reason: ${reason}`,
        `Login used: ${loginResult ? loginResult.login_method || "unknown" : "no"}`,
        `Jobs fetched: ${jobs.length}`,
        `Session continuity: ${continuity.summary}`,
        notificationResult?.last_gotify_status
          ? `Gotify: ${notificationResult.last_gotify_status}`
          : ""
      ].filter(Boolean)
    });

    return {
      ok: true,
      jobs_count: jobs.length,
      summary,
      notifications: notificationResult,
      login: loginResult,
      state: nextState
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const nextState = mergeState({
      last_refresh_finished_at: failedAt,
      last_refresh_status: "error",
      last_refresh_error: error.message
    });
    appendAuditEvent({
      level: "error",
      category: "refresh",
      action: "failed",
      title: "Refresh failed",
      summary: sanitizeText(error.message),
      narrative:
        "The dashboard stopped this run rather than looping aggressively. The detail below captures what failed so you can see whether the issue was auth, OTP delivery, Cloudflare, or something else.",
      details: buildErrorDetails(error)
    });
    return {
      ok: false,
      error: error.message,
      login: loginResult,
      state: nextState
    };
  }
}

function shouldAttemptRelogin(error, forceLogin, allowLoginOnFailure) {
  if (forceLogin || !allowLoginOnFailure) {
    return false;
  }

  return /unauthorized|forbidden|not logged in|403/i.test(String(error.message || ""));
}

function runLoginCli() {
  return new Promise((resolve, reject) => {
    const command = process.execPath;
    const args = [path.resolve(__dirname, "gettransfer.js"), "login", "--timeout", String(LOGIN_TIMEOUT_SECONDS)];
    appendAuditEvent({
      level: "info",
      category: "login",
      action: "started",
      title: "Login flow started",
      summary: "The dashboard is asking the CLI to obtain a fresh session.",
      narrative:
        "The login CLI tries phone first when configured, then email fallback. It waits for a real OTP instead of hammering the provider.",
      details: [
        `Timeout: ${LOGIN_TIMEOUT_SECONDS}s`,
        `Targets: ${resolveLoginTargetsSafe().join(", ") || "none configured"}`
      ]
    });
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const failure = new Error(
          stderr.trim() || stdout.trim() || `Login exited with code ${code}`
        );
        appendAuditEvent({
          level: "error",
          category: "login",
          action: "failed",
          title: "Login flow failed",
          summary: sanitizeText(failure.message),
          narrative:
            "No further fetch retry is attempted after a login failure. This avoids repeated OTP requests and keeps the automation polite.",
          details: [
            `Exit code: ${code}`,
            stderr.trim() ? `stderr: ${sanitizeText(stderr.trim())}` : "",
            stdout.trim() ? `stdout: ${sanitizeText(stdout.trim())}` : ""
          ].filter(Boolean)
        });
        return reject(failure);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Login returned invalid JSON: ${stdout.slice(0, 500)}`));
      }

      const latestOtp = summarizeOtpPayload(readLatestOtp(OTP_FILE));
      const enriched = {
        ...parsed,
        saved_at: new Date().toISOString(),
        latest_otp_source: latestOtp
      };
      mergeState({
        last_login_at: enriched.saved_at,
        last_login_method: enriched.login_method || inferMethodFromSession(),
        last_2fa_source: latestOtp
      });
      appendAuditEvent({
        level: "info",
        category: "login",
        action: "succeeded",
        title: "Login flow succeeded",
        summary: `A fresh ${enriched.login_method || "unknown"} session was saved.`,
        narrative:
          enriched.fallback_used
            ? "The preferred login method failed, so the CLI fell back and still obtained a usable session."
            : "The first available login method worked and the new session was saved for future low-impact fetches.",
        details: [
          `Method: ${enriched.login_method || "unknown"}`,
          Array.isArray(enriched.attempted_methods)
            ? `Attempted: ${enriched.attempted_methods.join(", ")}`
            : "",
          latestOtp?.source ? `OTP source: ${latestOtp.source}` : "",
          latestOtp?.title ? `OTP title: ${sanitizeText(latestOtp.title)}` : ""
        ].filter(Boolean)
      });
      resolve(enriched);
    });
  });
}

function createFetchArgs() {
  return {
    command: "fetch",
    headers: [],
    format: "json"
  };
}

async function runScheduledRefresh() {
  const config = loadConfig();
  const schedule = config.schedule;
  if (schedule.mode === "disabled" || currentOperation) {
    return;
  }

  const now = new Date();
  const dueSlot = computeLatestDueSlot(schedule, now);
  if (!dueSlot) {
    return;
  }

  const state = loadState();
  if (state.last_scheduled_slot === dueSlot) {
    return;
  }

  mergeState({
    last_scheduled_slot: dueSlot,
    last_scheduled_attempt_at: now.toISOString()
  });
  appendAuditEvent({
    level: "info",
    category: "schedule",
    action: "triggered",
    title: "Scheduled refresh is due",
    summary: `${schedule.mode} schedule reached ${schedule.time}.`,
    narrative:
      "The scheduler only runs once for each due slot. It will still try the existing session first before asking for a fresh login.",
    details: [`Due slot: ${dueSlot}`]
  });

  await runExclusive("scheduled_refresh", () =>
    runRefresh({
      forceLogin: false,
      reason: "scheduled",
      allowLoginOnFailure: schedule.auto_login_on_failure !== false
    })
  );
}

function normalizeSchedule(input) {
  const mode = ["disabled", "daily", "weekly"].includes(input.mode)
    ? input.mode
    : DEFAULT_CONFIG.schedule.mode;
  const time = normalizeTime(input.time || DEFAULT_CONFIG.schedule.time);
  const days = Array.isArray(input.days)
    ? input.days
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
        .sort((left, right) => left - right)
    : DEFAULT_CONFIG.schedule.days;

  return {
    mode,
    time,
    days: days.length > 0 ? Array.from(new Set(days)) : DEFAULT_CONFIG.schedule.days,
    auto_login_on_failure: input.auto_login_on_failure !== false
  };
}

function normalizeTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return DEFAULT_CONFIG.schedule.time;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_CONFIG.schedule.time;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function computeLatestDueSlot(schedule, now) {
  const [hours, minutes] = schedule.time.split(":").map(Number);

  if (schedule.mode === "daily") {
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate > now) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate.toISOString();
  }

  if (schedule.mode === "weekly") {
    for (let offset = 0; offset < 7; offset += 1) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() - offset);
      if (!schedule.days.includes(candidate.getDay())) {
        continue;
      }
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate <= now) {
        return candidate.toISOString();
      }
    }
  }

  return null;
}

function computeNextRunAt(schedule, now = new Date()) {
  if (schedule.mode === "disabled") {
    return null;
  }

  const [hours, minutes] = schedule.time.split(":").map(Number);

  if (schedule.mode === "daily") {
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (schedule.mode === "weekly") {
    for (let offset = 0; offset < 14; offset += 1) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      if (!schedule.days.includes(candidate.getDay())) {
        continue;
      }
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate > now) {
        return candidate;
      }
    }
  }

  return null;
}

function summarizeJobs(jobs) {
  const items = Array.isArray(jobs) ? jobs : [];
  const byType = {};
  const byTransport = {};

  for (const job of items) {
    const type = job.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;

    for (const transport of String(job.transport_types || "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean)) {
      byTransport[transport] = (byTransport[transport] || 0) + 1;
    }
  }

  return {
    total: items.length,
    by_type: byType,
    by_transport: byTransport
  };
}

function buildGotifyStatus(state) {
  return {
    configured: Boolean(GOTIFY_URL && GOTIFY_KEY),
    url: GOTIFY_URL || null,
    last_status: state.last_gotify_status || null,
    last_error: state.last_gotify_error || null,
    last_sent_at: state.last_gotify_sent_at || null,
    last_test_at: state.last_gotify_test_at || null,
    last_test_status: state.last_gotify_test_status || null,
    notified_job_ids: Array.isArray(state.notified_matching_job_ids)
      ? state.notified_matching_job_ids.length
      : 0
  };
}

async function runGotifyTest() {
  if (!GOTIFY_URL || !GOTIFY_KEY) {
    const result = {
      ok: false,
      error: "Gotify is not configured"
    };
    mergeState({
      last_gotify_test_at: new Date().toISOString(),
      last_gotify_test_status: "error",
      last_gotify_error: result.error
    });
    appendAuditEvent({
      level: "warn",
      category: "notification",
      action: "test_failed_unconfigured",
      title: "Gotify test skipped",
      summary: result.error,
      narrative:
        "The dashboard did not try to send a test notification because Gotify is not configured."
    });
    return result;
  }

  try {
    await sendGotifyMessage({
      title: "GetTransfer Test",
      message: `Manual test from GetTransfer dashboard at ${new Date().toISOString()}`,
      priority: 5
    });
    const sentAt = new Date().toISOString();
    mergeState({
      last_gotify_test_at: sentAt,
      last_gotify_test_status: "success",
      last_gotify_status: "success",
      last_gotify_error: null,
      last_gotify_sent_at: sentAt
    });
    appendAuditEvent({
      level: "info",
      category: "notification",
      action: "test_sent",
      title: "Gotify test sent",
      summary: "The dashboard sent a manual test notification successfully.",
      narrative:
        "This confirms the notification path is live without needing to wait for a real job."
    });
    return { ok: true, sent_at: sentAt };
  } catch (error) {
    const failedAt = new Date().toISOString();
    mergeState({
      last_gotify_test_at: failedAt,
      last_gotify_test_status: "error",
      last_gotify_status: "error",
      last_gotify_error: error.message
    });
    appendAuditEvent({
      level: "error",
      category: "notification",
      action: "test_failed",
      title: "Gotify test failed",
      summary: sanitizeText(error.message),
      narrative:
        "The notification backend rejected the test message or could not be reached.",
      details: buildErrorDetails(error)
    });
    return { ok: false, error: error.message, sent_at: failedAt };
  }
}

async function notifyMatchingJobs(jobs) {
  const state = loadState();
  const notifiedIds = Array.isArray(state.notified_matching_job_ids)
    ? state.notified_matching_job_ids.map((value) => String(value))
    : [];
  const matches = jobs.filter(matchesDefaultNotificationCriteria);
  const freshMatches = matches.filter((job) => !notifiedIds.includes(String(job.id)));

  if (!GOTIFY_URL || !GOTIFY_KEY) {
    appendAuditEvent({
      level: "warn",
      category: "notification",
      action: "skipped_unconfigured",
      title: "Matching jobs were not notified",
      summary: "Gotify is not configured.",
      narrative:
        "The dashboard found jobs worth notifying, but the notification backend is disabled."
    });
    return {
      last_gotify_status: "disabled",
      last_gotify_error: "Gotify is not configured",
      notified_matching_job_ids: notifiedIds
    };
  }

  if (freshMatches.length === 0) {
    appendAuditEvent({
      level: "info",
      category: "notification",
      action: "no_new_matches",
      title: "No new alert-worthy jobs",
      summary: "Either nothing matched the default criteria or all matching jobs were already notified.",
      narrative:
        "This is normal. The dashboard only sends alerts for newly seen jobs that match your default business filters."
    });
    return {
      last_gotify_status: "idle",
      last_gotify_error: null,
      notified_matching_job_ids: notifiedIds
    };
  }

  try {
    for (const job of freshMatches) {
      await sendGotifyMessage({
        title: `GetTransfer Job ${job.id}`,
        message: buildGotifyJobMessage(job),
        priority: 5
      });
    }

    const sentAt = new Date().toISOString();
    appendAuditEvent({
      level: "info",
      category: "notification",
      action: "sent_matching_jobs",
      title: "Gotify alerts sent",
      summary: `${freshMatches.length} new matching job notification${
        freshMatches.length === 1 ? "" : "s"
      } sent.`,
      narrative:
        "Only newly seen jobs that match the default filter policy were notified. Already-seen matching jobs were left alone to avoid repeat noise.",
      details: freshMatches
        .slice(0, 10)
        .map((job) => `Job ${job.id}: ${sanitizeText(job.from_name)} -> ${sanitizeText(job.to_name)}`)
    });
    return {
      last_gotify_status: "success",
      last_gotify_error: null,
      last_gotify_sent_at: sentAt,
      notified_matching_job_ids: uniqueRecentIds(
        notifiedIds.concat(freshMatches.map((job) => String(job.id)))
      )
    };
  } catch (error) {
    appendAuditEvent({
      level: "error",
      category: "notification",
      action: "send_failed",
      title: "Gotify alert failed",
      summary: sanitizeText(error.message),
      narrative:
        "A matching job was found, but the dashboard could not deliver the alert. Matching job ids were not marked as notified so a later retry can still send them.",
      details: buildErrorDetails(error)
    });
    return {
      last_gotify_status: "error",
      last_gotify_error: error.message,
      notified_matching_job_ids: notifiedIds
    };
  }
}

function matchesDefaultNotificationCriteria(job) {
  const transportValues = String(job.transport_types || "")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  const economyOrAny =
    transportValues.length === 0 || transportValues.includes("economy");
  const oneWay = job.type === "one_way";
  const hasKnownDistance =
    typeof job.from_distance_to_reference_miles === "number" ||
    typeof job.to_distance_to_reference_miles === "number";
  const nearby = !hasKnownDistance || job.within_reference_radius === true;

  return oneWay && economyOrAny && nearby;
}

function buildGotifyJobMessage(job) {
  const details = [
    `${job.from_name || "Unknown"} -> ${job.to_name || "Unknown"}`,
    `Pickup: ${job.pickup_at || "Unknown"}`,
    `Passengers: ${job.passengers ?? "Unknown"}`,
    `Transport: ${job.transport_types || "Any"}`,
    `From ${REFERENCE_POSTCODE}: ${
      job.from_distance_to_reference_miles == null
        ? "Unknown"
        : `${job.from_distance_to_reference_miles} miles`
    }`,
    `To ${REFERENCE_POSTCODE}: ${
      job.to_distance_to_reference_miles == null
        ? "Unknown"
        : `${job.to_distance_to_reference_miles} miles`
    }`
  ];
  return details.join("\n");
}

async function sendGotifyMessage({ title, message, priority = 5 }) {
  const target = new URL(GOTIFY_URL);
  target.searchParams.set("token", GOTIFY_KEY);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      title,
      message,
      priority
    })
  });
  if (!response.ok) {
    throw new Error(`Gotify send failed with ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

function uniqueRecentIds(ids, limit = 500) {
  return Array.from(new Set(ids)).slice(-limit);
}

async function resolveReferenceLocation() {
  if (
    referenceLocationCache &&
    referenceLocationCache.postcode === REFERENCE_POSTCODE
  ) {
    return referenceLocationCache;
  }

  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(REFERENCE_POSTCODE)}`
    );
    if (!response.ok) {
      throw new Error(`Postcode lookup failed with ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || payload.status !== 200 || !payload.result) {
      throw new Error("Postcode lookup returned no result");
    }

    referenceLocationCache = {
      postcode: REFERENCE_POSTCODE,
      latitude: Number(payload.result.latitude),
      longitude: Number(payload.result.longitude)
    };
    return referenceLocationCache;
  } catch (error) {
    process.stderr.write(`Reference postcode lookup failed: ${error.message}\n`);
    return null;
  }
}

function enrichJobWithReference(job, referenceLocation) {
  const fromCoordinates = parsePoint(job.from_point);
  const toCoordinates = parsePoint(job.to_point);

  const fromDistanceMiles =
    referenceLocation && fromCoordinates
      ? haversineMiles(
          referenceLocation.latitude,
          referenceLocation.longitude,
          fromCoordinates.latitude,
          fromCoordinates.longitude
        )
      : null;
  const toDistanceMiles =
    referenceLocation && toCoordinates
      ? haversineMiles(
          referenceLocation.latitude,
          referenceLocation.longitude,
          toCoordinates.latitude,
          toCoordinates.longitude
        )
      : null;

  return {
    ...job,
    from_distance_to_reference_miles: roundMiles(fromDistanceMiles),
    to_distance_to_reference_miles: roundMiles(toDistanceMiles),
    within_reference_radius:
      (typeof fromDistanceMiles === "number" && fromDistanceMiles <= REFERENCE_RADIUS_MILES) ||
      (typeof toDistanceMiles === "number" && toDistanceMiles <= REFERENCE_RADIUS_MILES)
  };
}

function parsePoint(value) {
  const match = String(value || "").match(
    /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/
  );
  if (!match) {
    return null;
  }

  return {
    latitude: Number(match[1]),
    longitude: Number(match[2])
  };
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const earthRadiusMiles = 3958.7613;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function roundMiles(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

function readSessionSummary() {
  const sessionPath = resolveSessionInputFile({ headers: [] });
  const absolutePath = path.resolve(sessionPath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return {
      exists: false
    };
  }

  const session = readJson(absolutePath) || {};
  const savedAt = session.saved_at || null;
  return {
    exists: true,
    saved_at: savedAt,
    age_seconds: savedAt ? secondsSince(savedAt) : null,
    has_cookie: Boolean(session.cookie),
    cookie_count: countCookiePairs(session.cookie),
    fingerprint: session.cookie ? stableFingerprint(session.cookie) : null,
    login_hint: session.phone ? "phone" : session.email ? "email" : null,
    last_url: session.last_url || null
  };
}

function readStorageSummary() {
  const storageStatePath = resolveStorageStateFile({ headers: [] });
  const absolutePath = path.resolve(storageStatePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      exists: false
    };
  }

  const storageState = readJson(absolutePath) || {};
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
  const sessionCookie = cookies.find((item) => item.name === "rack.session");
  const clearanceCookie = cookies.find((item) => item.name === "cf_clearance");
  const stats = fs.statSync(absolutePath);

  return {
    exists: true,
    saved_at: new Date(stats.mtimeMs).toISOString(),
    age_seconds: Math.max(0, Math.floor((Date.now() - stats.mtimeMs) / 1000)),
    rack_session_expires_at: cookieExpiry(sessionCookie),
    rack_session_expires_in_seconds: secondsUntil(cookieExpiry(sessionCookie)),
    cf_clearance_expires_at: cookieExpiry(clearanceCookie),
    cf_clearance_expires_in_seconds: secondsUntil(cookieExpiry(clearanceCookie))
  };
}

function cookieExpiry(cookie) {
  if (!cookie || typeof cookie.expires !== "number" || cookie.expires <= 0) {
    return null;
  }

  return new Date(cookie.expires * 1000).toISOString();
}

function secondsSince(iso) {
  const value = Date.parse(iso || "");
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - value) / 1000));
}

function secondsUntil(iso) {
  const value = Date.parse(iso || "");
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.floor((value - Date.now()) / 1000);
}

function countCookiePairs(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.includes("=")).length;
}

function inferMethodFromSession() {
  const sessionPath = resolveSessionInputFile({ headers: [] });
  const absolutePath = path.resolve(sessionPath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const session = readJson(absolutePath) || {};
  if (session.phone) {
    return "phone";
  }
  if (session.email) {
    return "email";
  }
  return null;
}

function summarizeOtpPayload(payload) {
  if (!payload) {
    return null;
  }

  const raw = payload.raw || {};
  return {
    source: payload.source || null,
    received_at: payload.received_at || null,
    title:
      raw.notification_title ||
      raw.title ||
      raw.sender ||
      raw.from ||
      null
  };
}

function buildAuditSummary() {
  const state = loadState();
  const session = readSessionSummary();
  const cookies = readStorageSummary();
  const events = readAuditEvents(80);
  const lastSuccess = events.find((event) => event.category === "refresh" && event.action === "succeeded");
  const lastFailure = events.find((event) => event.level === "error");

  return {
    total_events: events.length,
    last_success_at: lastSuccess?.at || state.last_refresh_finished_at || null,
    last_failure_at: lastFailure?.at || null,
    current_auth_state: inferCurrentAuthState({ state, session, cookies }),
    session_continuity: {
      fingerprint: state.current_session_fingerprint || session.fingerprint || null,
      since: state.current_session_since || session.saved_at || null,
      age_seconds: secondsSince(state.current_session_since || session.saved_at || null),
      success_count: Number(state.current_session_success_count || 0),
      rotation_count: Number(state.session_rotation_count || 0)
    },
    strategy: {
      headline: "Reuse the existing session first, then login only when it looks necessary.",
      summary:
        "Each refresh tries the saved session once before any OTP flow. The dashboard only re-logins on a forced refresh or a failure that looks auth-related.",
      cadence: describeSchedule(loadConfig().schedule)
    }
  };
}

function readAuditEvents(limit = AUDIT_MAX_EVENTS) {
  if (!fs.existsSync(AUDIT_FILE)) {
    return [];
  }

  const lines = fs
    .readFileSync(AUDIT_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function appendAuditEvent({
  level = "info",
  category = "system",
  action = "note",
  title,
  summary,
  narrative,
  details = []
}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    at: new Date().toISOString(),
    level,
    category,
    action,
    title: sanitizeText(title || "Audit event"),
    summary: sanitizeText(summary || ""),
    narrative: sanitizeText(narrative || ""),
    details: Array.isArray(details)
      ? details.map((detail) => sanitizeText(detail)).filter(Boolean)
      : [],
    auth: buildAuditAuthSnapshot(),
    operation: currentOperation ? { ...currentOperation } : null
  };

  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(event)}\n`, "utf8");
  trimAuditFileIfNeeded();
  return event;
}

function trimAuditFileIfNeeded() {
  if (!fs.existsSync(AUDIT_FILE)) {
    return;
  }

  const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
  if (lines.length <= AUDIT_MAX_EVENTS * 2) {
    return;
  }

  fs.writeFileSync(AUDIT_FILE, `${lines.slice(-AUDIT_MAX_EVENTS).join("\n")}\n`, "utf8");
}

function buildAuditAuthSnapshot() {
  const state = loadState();
  const session = readSessionSummary();
  const cookies = readStorageSummary();

  return {
    current_auth_state: inferCurrentAuthState({ state, session, cookies }),
    session_exists: Boolean(session.exists),
    session_age_seconds: session.age_seconds ?? null,
    session_fingerprint: session.fingerprint || null,
    storage_exists: Boolean(cookies.exists),
    cf_clearance_expires_in_seconds: cookies.cf_clearance_expires_in_seconds ?? null,
    last_refresh_status: state.last_refresh_status || null,
    last_login_method: state.last_login_method || null
  };
}

function inferCurrentAuthState({ state, session, cookies }) {
  if (state.last_refresh_status === "success") {
    return "working";
  }
  if (!session.exists) {
    return "missing_session";
  }
  if (cookies.exists && typeof cookies.cf_clearance_expires_in_seconds === "number") {
    if (cookies.cf_clearance_expires_in_seconds <= 0) {
      return "cookie_expired";
    }
    return "session_present";
  }
  return "unknown";
}

function buildOtpAuditSummary(payload) {
  const sender =
    payload.raw?.notification_title ||
    payload.raw?.title ||
    payload.raw?.sender ||
    payload.raw?.from ||
    "unknown sender";
  return `${payload.source || "OTP source"} delivered a code from ${sanitizeText(sender)}.`;
}

function buildErrorDetails(error) {
  const pieces = [sanitizeText(error.message || "Unknown error")];
  if (error.stack) {
    pieces.push(
      ...String(error.stack)
        .split("\n")
        .slice(1, 4)
        .map((line) => sanitizeText(line.trim()))
    );
  }
  return pieces.filter(Boolean);
}

function resolveLoginTargetsSafe() {
  const targets = [];
  if (resolveLoginPhone({})) {
    targets.push("phone");
  }
  if (resolveLoginEmail({})) {
    targets.push("email");
  }
  return targets;
}

function stableFingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function updateSessionContinuity(sessionSummary, { fetchedAt, loginResult }) {
  if (!sessionSummary.exists || !sessionSummary.fingerprint) {
    return {
      summary: "no saved session fingerprint was available",
      patch: null
    };
  }

  const state = loadState();
  const previousFingerprint = state.current_session_fingerprint || null;
  const sameSession = previousFingerprint && previousFingerprint === sessionSummary.fingerprint;
  const currentSince = sameSession
    ? state.current_session_since || sessionSummary.saved_at || fetchedAt
    : sessionSummary.saved_at || fetchedAt;
  const currentSuccessCount = sameSession
    ? Number(state.current_session_success_count || 0) + 1
    : 1;
  const rotationCount =
    previousFingerprint && previousFingerprint !== sessionSummary.fingerprint
      ? Number(state.session_rotation_count || 0) + 1
      : Number(state.session_rotation_count || 0);

  return {
    summary: sameSession
      ? `same session still working for ${humanDuration(secondsSince(currentSince))}`
      : loginResult
        ? "session rotated after a fresh login"
        : "session fingerprint changed since the previous successful run",
    patch: {
      current_session_fingerprint: sessionSummary.fingerprint,
      current_session_since: currentSince,
      current_session_success_count: currentSuccessCount,
      current_session_last_seen_at: fetchedAt,
      session_rotation_count: rotationCount
    }
  };
}

function describeSchedule(schedule) {
  if (!schedule || schedule.mode === "disabled") {
    return "Automatic refreshes are disabled.";
  }
  if (schedule.mode === "daily") {
    return `Automatic refresh runs daily at ${schedule.time}.`;
  }
  return `Automatic refresh runs weekly on ${schedule.days
    .map((day) => weekdayName(day))
    .join(", ")} at ${schedule.time}.`;
}

function weekdayName(day) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(day)] || "?";
}

function humanizeOperationType(type) {
  return String(type || "operation")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds == null) {
    return "unknown time";
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

function sanitizeText(value) {
  return String(value || "")
    .replace(/("password"\s*:\s*")([^"]+)"/gi, '$1[redacted]"')
    .replace(/(Your login code:\s*)(\d{4,8})/gi, "$1[redacted]")
    .replace(/(Your code\s+)(\d{4,8})/gi, "$1[redacted]")
    .replace(/(\bpassword=)([^&\s]+)/gi, "$1[redacted]");
}

function sendStatic(res, filePath, contentType) {
  const body = fs.readFileSync(filePath, "utf8");
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  res.end(body);
}

main();
