const state = {
  auth: null,
  keys: [],
  total: 0,
  canDeleteAny: false
};

window.addEventListener("DOMContentLoaded", () => {
  bindControls();
  bootstrap().catch(showError);
});

function bindControls() {
  document.getElementById("keysAddBtn").addEventListener("click", () => registerKey());
  document.getElementById("keysLogoutBtn").addEventListener("click", logout);
}

async function bootstrap() {
  await refreshAuthStatus();
  if (!state.auth?.authenticated) {
    return;
  }
  await refreshKeys();
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

async function refreshKeys() {
  try {
    const payload = await fetchJson("/api/auth/keys");
    state.keys = payload.keys || [];
    state.total = Number(payload.total || state.keys.length || 0);
    state.canDeleteAny = payload.can_delete_any === true;
    renderKeys();
  } catch (error) {
    if (error.statusCode === 401) {
      state.auth = error.payload?.auth || null;
      renderAuth();
      return;
    }
    throw error;
  }
}

async function deleteKey(id) {
  const key = state.keys.find((item) => item.id === id);
  if (!key) {
    return;
  }

  const label = key.name || key.id_preview || "this key";
  if (!window.confirm(`Delete ${label}? The last remaining key cannot be removed.`)) {
    return;
  }

  setButtonsDisabled(true);
  try {
    const payload = await fetchJson("/api/auth/keys/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ id })
    });

    if (payload.logged_out) {
      window.location.href = "/";
      return;
    }

    await refreshKeys();
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

async function registerKey() {
  const keyName = document.getElementById("keysKeyName").value.trim();
  if (!keyName) {
    showError(new Error("Enter a name for the new access key first"));
    document.getElementById("keysKeyName").focus();
    return;
  }

  setButtonsDisabled(true);
  try {
    const optionsPayload = await fetchJson("/auth/register-options", {
      method: "POST"
    });
    const options = preparePublicKeyOptions(optionsPayload.options);
    const credential = await navigator.credentials.create({ publicKey: options });
    await fetchJson("/auth/register-verify", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...serializeCredential(credential),
        keyName
      })
    });
    document.getElementById("keysKeyName").value = "";
    await refreshAuthStatus();
    await refreshKeys();
    showError("");
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
    window.location.href = "/";
  } catch (error) {
    showError(error);
  } finally {
    setButtonsDisabled(false);
  }
}

function renderAuth() {
  const authShell = document.getElementById("keysAuthShell");
  const appShell = document.getElementById("keysAppShell");
  const status = document.getElementById("keysAuthStatus");

  const authenticated = Boolean(state.auth?.authenticated);
  authShell.classList.toggle("hidden", authenticated);
  appShell.classList.toggle("hidden", !authenticated);

  if (!authenticated) {
    status.textContent = state.auth?.has_credentials
      ? "Log in on the dashboard to manage access keys."
      : "Register the first key on the dashboard before managing keys here.";
    return;
  }

  document.getElementById("keysUserBadge").textContent =
    state.auth?.user?.name || "Signed in";
}

function renderKeys() {
  const container = document.getElementById("keysList");
  const meta = document.getElementById("keysMeta");

  meta.textContent = `${state.total} registered key${state.total === 1 ? "" : "s"}.`;

  if (!Array.isArray(state.keys) || state.keys.length === 0) {
    container.innerHTML = `<div class="detail-empty">No access keys found.</div>`;
    return;
  }

  container.innerHTML = state.keys
    .map((key) => {
      const isCurrent = key.id === state.auth?.user?.id;
      const canDelete = state.canDeleteAny;
      return `
        <article class="key-card">
          <div class="key-card-head">
            <div class="key-card-title">${escapeHtml(key.name || "Security key")}</div>
            <div class="key-card-actions">
              ${isCurrent ? `<span class="pill">Current</span>` : ""}
              <button class="btn" data-delete-id="${escapeAttribute(key.id)}" ${
                canDelete ? "" : "disabled"
              }>Delete</button>
            </div>
          </div>
          <div class="key-card-meta">
            ID: ${escapeHtml(key.id_preview || "")}<br />
            Created: ${escapeHtml(formatDateTime(key.created_at) || "Unknown")}<br />
            Last Used: ${escapeHtml(formatDateTime(key.last_used_at) || "Never")}<br />
            Transports: ${escapeHtml((key.transports || []).join(", ") || "Unknown")}
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of container.querySelectorAll("button[data-delete-id]")) {
    button.addEventListener("click", () => deleteKey(button.dataset.deleteId));
  }
}

function setButtonsDisabled(disabled) {
  for (const element of document.querySelectorAll("button")) {
    element.disabled = disabled || element.hasAttribute("data-force-disabled");
  }
}

function showError(error) {
  const message = String(error?.message || error || "");
  const status = document.getElementById("keysAuthStatus");
  status.textContent = message;
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
