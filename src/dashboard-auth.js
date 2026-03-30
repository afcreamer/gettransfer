const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} = require("@simplewebauthn/server");

const CREDENTIALS_FILE = path.resolve(
  process.env.WEBAUTHN_CREDENTIALS_FILE || ".webauthn-credentials.json"
);
const CHALLENGES_FILE = path.resolve(
  process.env.WEBAUTHN_CHALLENGES_FILE || ".webauthn-challenges.json"
);
const SESSIONS_FILE = path.resolve(
  process.env.WEBAUTHN_SESSIONS_FILE || ".webauthn-sessions.json"
);
const SESSION_COOKIE_NAME = process.env.WEBAUTHN_SESSION_COOKIE_NAME || "dashboard_session";
const SESSION_MAX_AGE_SECONDS = Number(process.env.WEBAUTHN_SESSION_MAX_AGE_SECONDS || "604800");
const CHALLENGE_MAX_AGE_MS = Number(process.env.WEBAUTHN_CHALLENGE_MAX_AGE_MS || "300000");
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "GetTransfer Dashboard";

function ensureAuthFiles() {
  ensureJsonFile(CREDENTIALS_FILE, []);
  ensureJsonFile(CHALLENGES_FILE, []);
  ensureJsonFile(SESSIONS_FILE, []);
  cleanupExpiredState();
}

function handleAuthRoute(req, res, pathname) {
  if (pathname === "/api/auth/status" && req.method === "GET") {
    return sendJson(res, 200, buildAuthStatus(req));
  }

  if (pathname === "/api/auth/keys" && req.method === "GET") {
    const current = requireAuth(req, res);
    if (!current) {
      return true;
    }
    return sendJson(res, 200, {
      ok: true,
      current_credential_id: current.id,
      total: getCredentials().length,
      can_delete_any: getCredentials().length > 1,
      keys: listCredentialSummaries()
    });
  }

  if (pathname === "/api/auth/keys/delete" && req.method === "POST") {
    return handleDeleteKey(req, res);
  }

  if (pathname === "/auth/logout" && req.method === "POST") {
    destroySession(getSessionToken(req));
    return sendJson(
      res,
      200,
      { ok: true },
      { "set-cookie": buildSessionCookie("", req, { maxAge: 0 }) }
    );
  }

  if (pathname === "/auth/register-options" && req.method === "POST") {
    return handleRegisterOptions(req, res);
  }

  if (pathname === "/auth/register-verify" && req.method === "POST") {
    return handleRegisterVerify(req, res);
  }

  if (pathname === "/auth/login-options" && req.method === "POST") {
    return handleLoginOptions(req, res);
  }

  if (pathname === "/auth/login-verify" && req.method === "POST") {
    return handleLoginVerify(req, res);
  }

  return false;
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (session) {
    return session;
  }

  sendJson(res, 401, {
    ok: false,
    error: "Authentication required",
    auth: buildAuthStatus(req)
  });
  return null;
}

function buildAuthStatus(req) {
  const current = getSession(req);
  return {
    ok: true,
    has_credentials: hasRegisteredCredentials(),
    authenticated: Boolean(current),
    user: current
      ? {
          id: current.id,
          name: current.name || "Security key",
          created_at: current.created_at || null,
          last_used_at: current.last_used_at || null
        }
      : null,
    webauthn: {
      rp_name: RP_NAME,
      rp_id: getRpId(req)
    }
  };
}

function ensureJsonFile(filePath, fallbackValue) {
  if (fs.existsSync(filePath)) {
    return;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(fallbackValue, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function readJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function cleanupExpiredState() {
  const now = Date.now();
  const challenges = readJson(CHALLENGES_FILE, []).filter(
    (entry) => now - Date.parse(entry.created_at || 0) <= CHALLENGE_MAX_AGE_MS
  );
  writeJson(CHALLENGES_FILE, challenges);

  const sessions = readJson(SESSIONS_FILE, []).filter(
    (entry) => now - Date.parse(entry.created_at || 0) <= SESSION_MAX_AGE_SECONDS * 1000
  );
  writeJson(SESSIONS_FILE, sessions);
}

function hasRegisteredCredentials() {
  return readJson(CREDENTIALS_FILE, []).length > 0;
}

function getCredentials() {
  return readJson(CREDENTIALS_FILE, []);
}

function listCredentialSummaries() {
  return getCredentials().map((entry) => ({
    id: entry.id,
    id_preview: maskCredentialId(entry.id),
    name: entry.name || "Security key",
    created_at: entry.created_at || null,
    last_used_at: entry.last_used_at || null,
    transports: Array.isArray(entry.transports) ? entry.transports : []
  }));
}

function getCredentialById(id) {
  return getCredentials().find((entry) => entry.id === id) || null;
}

function saveCredential(credential) {
  const items = getCredentials();
  const existingIndex = items.findIndex((item) => item.id === credential.id);
  const next = {
    created_at: new Date().toISOString(),
    ...credential
  };

  if (existingIndex >= 0) {
    items[existingIndex] = { ...items[existingIndex], ...next };
  } else {
    items.push(next);
  }

  writeJson(CREDENTIALS_FILE, items);
  return next;
}

function deleteCredential(id) {
  const items = getCredentials();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    return null;
  }

  const [removed] = items.splice(index, 1);
  writeJson(CREDENTIALS_FILE, items);
  return removed;
}

function touchCredential(id, patch = {}) {
  const items = getCredentials();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    return null;
  }
  items[index] = { ...items[index], ...patch };
  writeJson(CREDENTIALS_FILE, items);
  return items[index];
}

function maskCredentialId(id) {
  const value = String(id || "");
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getSessionToken(req) {
  const cookies = String(req.headers.cookie || "");
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([a-f0-9]+)`));
  return match ? match[1] : "";
}

function getSession(req) {
  cleanupExpiredState();
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }

  const sessions = readJson(SESSIONS_FILE, []);
  const row = sessions.find((entry) => entry.token === token);
  if (!row) {
    return null;
  }

  const credential = getCredentialById(row.credential_id);
  if (!credential) {
    destroySession(token);
    return null;
  }

  return credential;
}

function destroySession(token) {
  if (!token) {
    return;
  }
  const sessions = readJson(SESSIONS_FILE, []).filter((entry) => entry.token !== token);
  writeJson(SESSIONS_FILE, sessions);
}

function destroySessionsForCredential(credentialId) {
  const sessions = readJson(SESSIONS_FILE, []).filter(
    (entry) => entry.credential_id !== credentialId
  );
  writeJson(SESSIONS_FILE, sessions);
}

function createSession(credentialId) {
  cleanupExpiredState();
  const sessions = readJson(SESSIONS_FILE, []);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.push({
    token,
    credential_id: credentialId,
    created_at: new Date().toISOString()
  });
  writeJson(SESSIONS_FILE, sessions);
  return token;
}

function buildSessionCookie(value, req, { maxAge = SESSION_MAX_AGE_SECONDS } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ];

  if (shouldUseSecureCookie(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function shouldUseSecureCookie(req) {
  const explicit = process.env.WEBAUTHN_COOKIE_SECURE;
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return getProtocol(req) === "https";
}

function getProtocol(req) {
  return String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase() || (req.socket.encrypted ? "https" : "http");
}

function getHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "localhost")
    .split(",")[0]
    .trim();
}

function getRpId(req) {
  return process.env.WEBAUTHN_RP_ID || getHost(req).replace(/:\d+$/, "");
}

function getExpectedOrigin(req) {
  return process.env.WEBAUTHN_ORIGIN || `${getProtocol(req)}://${getHost(req)}`;
}

function storeChallenge(challenge, type) {
  cleanupExpiredState();
  const items = readJson(CHALLENGES_FILE, []);
  items.push({
    challenge,
    type,
    created_at: new Date().toISOString()
  });
  writeJson(CHALLENGES_FILE, items);
}

function consumeChallenge(challenge, type) {
  const items = readJson(CHALLENGES_FILE, []);
  let matched = false;
  const now = Date.now();
  const next = items.filter((entry) => {
    const fresh = now - Date.parse(entry.created_at || 0) <= CHALLENGE_MAX_AGE_MS;
    if (!fresh) {
      return false;
    }
    if (!matched && entry.challenge === challenge && entry.type === type) {
      matched = true;
      return false;
    }
    return true;
  });
  writeJson(CHALLENGES_FILE, next);
  return matched;
}

async function handleRegisterOptions(req, res) {
  if (hasRegisteredCredentials() && !getSession(req)) {
    sendJson(res, 403, { ok: false, error: "Authentication required to register another key" });
    return true;
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: getRpId(req),
    userName: "dashboard-user",
    userDisplayName: "Dashboard User",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred"
    }
  });

  storeChallenge(options.challenge, "register");
  sendJson(res, 200, { ok: true, options });
  return true;
}

async function handleRegisterVerify(req, res) {
  if (hasRegisteredCredentials() && !getSession(req)) {
    sendJson(res, 403, { ok: false, error: "Authentication required to register another key" });
    return true;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: (challenge) => consumeChallenge(challenge, "register"),
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
      requireUserVerification: false
    });

    if (!verification.verified || !verification.registrationInfo) {
      sendJson(res, 400, { ok: false, verified: false, error: "Verification failed" });
      return true;
    }

    const { credential } = verification.registrationInfo;
    const credentialId =
      typeof credential.id === "string"
        ? credential.id
        : Buffer.from(credential.id).toString("base64url");
    const publicKey =
      typeof credential.publicKey === "string"
        ? credential.publicKey
        : Buffer.from(credential.publicKey).toString("base64url");
    const saved = saveCredential({
      id: credentialId,
      public_key: publicKey,
      counter: credential.counter,
      transports: credential.transports || [],
      name: String(body.keyName || "").trim().slice(0, 50) || "Security key",
      last_used_at: new Date().toISOString()
    });

    const token = createSession(saved.id);
    sendJson(
      res,
      200,
      {
        ok: true,
        verified: true,
        credential: {
          id: saved.id,
          name: saved.name,
          created_at: saved.created_at
        }
      },
      { "set-cookie": buildSessionCookie(token, req) }
    );
  } catch (error) {
    sendJson(res, 400, { ok: false, verified: false, error: error.message });
  }

  return true;
}

async function handleLoginOptions(req, res) {
  const credentials = getCredentials();
  if (credentials.length === 0) {
    sendJson(res, 400, { ok: false, error: "No credentials registered yet" });
    return true;
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    allowCredentials: credentials.map((entry) => ({
      id: entry.id,
      transports: Array.isArray(entry.transports) ? entry.transports : []
    })),
    userVerification: "preferred"
  });

  storeChallenge(options.challenge, "login");
  sendJson(res, 200, { ok: true, options });
  return true;
}

async function handleLoginVerify(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  const credential = getCredentialById(body.id);
  if (!credential) {
    sendJson(res, 400, { ok: false, verified: false, error: "Unknown credential" });
    return true;
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: (challenge) => consumeChallenge(challenge, "login"),
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
      requireUserVerification: false,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.public_key, "base64url"),
        counter: credential.counter,
        transports: Array.isArray(credential.transports) ? credential.transports : []
      }
    });

    if (!verification.verified) {
      sendJson(res, 400, { ok: false, verified: false, error: "Verification failed" });
      return true;
    }

    const updated = touchCredential(credential.id, {
      counter: verification.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString()
    });
    const token = createSession(credential.id);
    sendJson(
      res,
      200,
      {
        ok: true,
        verified: true,
        credential: {
          id: updated.id,
          name: updated.name,
          last_used_at: updated.last_used_at
        }
      },
      { "set-cookie": buildSessionCookie(token, req) }
    );
  } catch (error) {
    sendJson(res, 400, { ok: false, verified: false, error: error.message });
  }

  return true;
}

async function handleDeleteKey(req, res) {
  const current = requireAuth(req, res);
  if (!current) {
    return true;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  const credentialId = String(body.id || "");
  if (!credentialId) {
    sendJson(res, 400, { ok: false, error: "Missing credential id" });
    return true;
  }

  const credentials = getCredentials();
  if (credentials.length <= 1) {
    sendJson(res, 409, { ok: false, error: "Cannot delete the last remaining access key" });
    return true;
  }

  const removed = deleteCredential(credentialId);
  if (!removed) {
    sendJson(res, 404, { ok: false, error: "Access key not found" });
    return true;
  }

  destroySessionsForCredential(credentialId);
  const extraHeaders = {};
  if (credentialId === current.id) {
    extraHeaders["set-cookie"] = buildSessionCookie("", req, { maxAge: 0 });
  }

  sendJson(
    res,
    200,
    {
      ok: true,
      deleted: {
        id: removed.id,
        name: removed.name || "Security key"
      },
      logged_out: credentialId === current.id
    },
    extraHeaders
  );
  return true;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        const error = new Error(`Request body too large: limit is ${maxBytes} bytes`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

module.exports = {
  buildAuthStatus,
  ensureAuthFiles,
  getSession,
  handleAuthRoute,
  hasRegisteredCredentials,
  requireAuth
};
