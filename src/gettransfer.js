#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CARRIER_PAGE_URL = "https://gettransfer.com/en/carrier/";
const CABINET_REQUESTS_URL =
  "https://gettransfer.com/en/carrier/#/cabinet/requests";
const LOGIN_REFERER =
  "https://gettransfer.com/en?auth=true&redirect_url=https%3A%2F%2Fgettransfer.com%2Fen%2Fcarrier%2F%23%2Fcabinet%2Frequests";
const DEFAULT_TRANSFERS_ENDPOINT = "https://gettransfer.com/api/transfers";
const CONFIGS_ENDPOINT = "https://gettransfer.com/api/configs?locale=en";
const COUNTRIES_ENDPOINT = "https://gettransfer.com/api/configs/countries";
const REQUEST_CODE_ENDPOINT = "https://gettransfer.com/api/account";
const LOGIN_ENDPOINT = "https://gettransfer.com/api/account/login";
const DEFAULT_SESSION_FILES = [
  ".gettransfer-session.json",
  "capture/session.json"
];
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "en-GB,en;q=0.9";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium"
].filter(Boolean);
const DEFAULT_QUERY = {
  page: "1",
  role: "carrier",
  "filtering[date_since]": "",
  "filtering[date_till]": "",
  "filtering[offers]": "except_my",
  "filtering[pax_max]": "4",
  "filtering[pax_min]": "0",
  "filtering[asap]": "false",
  "filtering[hidden]": "false",
  "filtering[search]": "",
  "sorting[field]": "created_at",
  "sorting[order_by]": "desc"
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  let payload;

  if (args.command === "login") {
    const result = await loginWithCode(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (args.command === "fetch") {
    payload = await fetchPayload(args);
  } else if (args.command === "extract") {
    payload = await loadPayload(args);
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const transfers = extractTransfers(payload);
  const journeys = transfers.map(normalizeJourney);
  const output = renderJourneys(journeys, args.format || "pretty");

  if (args.rawOutput) {
    writeTextFile(args.rawOutput, JSON.stringify(payload, null, 2));
  }

  if (args.output) {
    writeTextFile(args.output, output);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
}

function parseArgs(argv) {
  const args = {
    command: argv[0],
    headers: []
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (key === "header") {
      if (!next) {
        throw new Error("--header requires a value");
      }
      args.headers.push(next);
      index += 1;
      continue;
    }

    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function buildTransfersUrl(args) {
  const url = new URL(DEFAULT_TRANSFERS_ENDPOINT);
  const params = new URLSearchParams(DEFAULT_QUERY);

  if (args.page) {
    params.set("page", String(args.page));
  }

  if (args.role) {
    params.set("role", String(args.role));
  }

  applyOptionalParam(args, params, "date-since", "filtering[date_since]");
  applyOptionalParam(args, params, "date-till", "filtering[date_till]");
  applyOptionalParam(args, params, "offers", "filtering[offers]");
  applyOptionalParam(args, params, "pax-max", "filtering[pax_max]");
  applyOptionalParam(args, params, "pax-min", "filtering[pax_min]");
  applyOptionalParam(args, params, "asap", "filtering[asap]");
  applyOptionalParam(args, params, "hidden", "filtering[hidden]");
  applyOptionalParam(args, params, "search", "filtering[search]");
  applyOptionalParam(args, params, "sort-field", "sorting[field]");
  applyOptionalParam(args, params, "sort-order", "sorting[order_by]");

  url.search = params.toString();
  return url.toString();
}

function applyOptionalParam(args, params, argKey, queryKey) {
  if (args[argKey] !== undefined) {
    params.set(queryKey, String(args[argKey]));
  }
}

async function fetchPayload(args) {
  const url = args.url || buildTransfersUrl(args);
  const session = loadSession(args);
  const headers = buildHeaders(args, session);
  const directResult = await fetchJsonText(url, {
    headers,
    method: "GET"
  });

  if (directResult.ok) {
    return directResult.json;
  }

  if (shouldUseBrowserFetchFallback(args, directResult)) {
    return await fetchPayloadInBrowser(args, url);
  }

  throw new Error(
    `Request failed with ${directResult.status} ${directResult.statusText}\n${directResult.body.slice(0, 500)}`
  );
}

async function loadPayload(args) {
  const text = args.input
    ? fs.readFileSync(path.resolve(args.input), "utf8")
    : await readStdin();

  if (!text.trim()) {
    throw new Error("No input payload provided");
  }

  return JSON.parse(text);
}

async function loginWithCode(args) {
  const targets = resolveLoginTargets(args);
  const errors = [];

  for (const target of targets) {
    try {
      const result = await loginWithSingleTarget(args, target);
      return {
        ...result,
        login_method: target.type,
        fallback_used: errors.length > 0,
        attempted_methods: targets.map((item) => item.type)
      };
    } catch (error) {
      errors.push(`${target.type}: ${error.message}`);
    }
  }

  throw new Error(
    `All login methods failed\n${errors.join("\n")}`
  );
}

async function loginWithSingleTarget(args, target) {
  if (shouldUseBrowserLogin(args, target)) {
    return await loginWithCodeInBrowser(args, target);
  }

  const session = loadSession(args);
  let cookie = resolveCookie(args) || session.cookie;

  cookie = await bootstrapLoginSession(args, session, cookie);

  const requestHeaders = buildHeaders(args, session, {
    cookie,
    referer: args.referer || LOGIN_REFERER
  });
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", "https://gettransfer.com");

  const requestStartedAt = Date.now();
  const requestCodeResponse = await fetch(REQUEST_CODE_ENDPOINT, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      account: { [target.type]: target.value },
      request_code: true
    })
  });

  cookie = applySetCookies(cookie, extractSetCookieHeaders(requestCodeResponse));
  const requestCodeText = await requestCodeResponse.text();
  let requestCodeJson = null;
  try {
    requestCodeJson = JSON.parse(requestCodeText);
  } catch {}

  if (
    !requestCodeResponse.ok &&
    requestCodeJson?.error?.type !== "account_exists"
  ) {
    throw new Error(
      `Code request failed with ${requestCodeResponse.status}: ${requestCodeText.slice(0, 500)}`
    );
  }

  const code =
    target.type === "phone"
      ? fetchOtpCodeFromFile({
          otpFile: resolveOtpFile(args),
          timeoutSeconds: Number(args.timeout || 180),
          sinceEpochMs: requestStartedAt
        })
      : fetchOtpCodeFromEmail({
          email: target.value,
          timeoutSeconds: Number(args.timeout || 180),
          sinceEpochMs: requestStartedAt
        });

  const loginHeaders = buildHeaders(args, session, {
    cookie,
    referer: args.referer || LOGIN_REFERER
  });
  loginHeaders.set("content-type", "application/json");
  loginHeaders.set("origin", "https://gettransfer.com");

  const loginResponse = await fetch(LOGIN_ENDPOINT, {
    method: "POST",
    headers: loginHeaders,
    body: JSON.stringify({
      [target.type]: target.value,
      password: code
    })
  });

  cookie = applySetCookies(cookie, extractSetCookieHeaders(loginResponse));
  const loginText = await loginResponse.text();
  let loginJson = null;
  try {
    loginJson = JSON.parse(loginText);
  } catch {}

  if (!loginResponse.ok || loginJson?.result === "error") {
    throw new Error(
      `Login failed with ${loginResponse.status}: ${loginText.slice(0, 500)}`
    );
  }

  const verifyHeaders = buildHeaders(args, session, { cookie });
  const verifyResponse = await fetch(REQUEST_CODE_ENDPOINT, {
    method: "GET",
    headers: verifyHeaders
  });
  const verifyText = await verifyResponse.text();
  let verifyJson = null;
  try {
    verifyJson = JSON.parse(verifyText);
  } catch {}

  if (!verifyResponse.ok || verifyJson?.result !== "success") {
    throw new Error(
      `Verification failed with ${verifyResponse.status}: ${verifyText.slice(0, 500)}`
    );
  }

  const sessionData = {
    cookie,
    headers: {
      Referer: args.referer || CARRIER_PAGE_URL,
      "User-Agent":
        args["user-agent"] ||
        session.headers?.["User-Agent"] ||
        session.headers?.["user-agent"] ||
        DEFAULT_USER_AGENT
    },
    [target.type]: target.value,
    last_url: buildTransfersUrl(args),
    saved_at: new Date().toISOString()
  };

  const sessionFile = path.resolve(resolveSessionOutputFile(args));
  writeTextFile(sessionFile, JSON.stringify(sessionData, null, 2));

  return {
    ok: true,
    [target.type]: target.value,
    session_file: sessionFile,
    account_id: verifyJson?.data?.account?.id ?? null
  };
}

async function loginWithCodeInBrowser(args, target) {
  const { browser, context, page } = await openBrowserContext(args, {
    preferStorageState: false
  });

  try {
    await page.goto(CABINET_REQUESTS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const requestStartedAt = Date.now();
    const requestCodeResult = await page.evaluate(
      async ({ requestCodeEndpoint, accountEndpoint, countriesEndpoint, target }) => {
        const commonHeaders = {
          accept: "application/json, text/plain, */*"
        };

        await fetch(accountEndpoint, {
          method: "GET",
          credentials: "include",
          headers: commonHeaders
        }).catch(() => null);

        await fetch(countriesEndpoint, {
          method: "GET",
          credentials: "include",
          headers: commonHeaders
        }).catch(() => null);

        const response = await fetch(requestCodeEndpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            ...commonHeaders,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            account: { [target.type]: target.value },
            request_code: true
          })
        });

        return {
          ok: response.ok,
          status: response.status,
          body: await response.text()
        };
      },
      {
        requestCodeEndpoint: REQUEST_CODE_ENDPOINT,
        accountEndpoint: REQUEST_CODE_ENDPOINT,
        countriesEndpoint: COUNTRIES_ENDPOINT,
        target
      }
    );

    const requestCodeJson = parsePossibleJson(requestCodeResult.body);
    if (
      !requestCodeResult.ok &&
      requestCodeJson?.error?.type !== "account_exists"
    ) {
      throw new Error(
        `Code request failed with ${requestCodeResult.status}: ${requestCodeResult.body.slice(0, 500)}`
      );
    }

    const code = fetchOtpCodeFromFile({
      otpFile: resolveOtpFile(args),
      timeoutSeconds: Number(args.timeout || 180),
      sinceEpochMs: requestStartedAt
    });

    const loginResult = await page.evaluate(
      async ({ loginEndpoint, target, code }) => {
        const response = await fetch(loginEndpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            [target.type]: target.value,
            password: code
          })
        });

        return {
          ok: response.ok,
          status: response.status,
          body: await response.text()
        };
      },
      {
        loginEndpoint: LOGIN_ENDPOINT,
        target,
        code
      }
    );

    const loginJson = parsePossibleJson(loginResult.body);
    if (!loginResult.ok || loginJson?.result === "error") {
      throw new Error(
        `Login failed with ${loginResult.status}: ${loginResult.body.slice(0, 500)}`
      );
    }

    await page.goto(CABINET_REQUESTS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const verifyResult = await page.evaluate(async (accountEndpoint) => {
      const response = await fetch(accountEndpoint, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      });

      return {
        ok: response.ok,
        status: response.status,
        body: await response.text()
      };
    }, REQUEST_CODE_ENDPOINT);

    const verifyJson = parsePossibleJson(verifyResult.body);
    if (!verifyResult.ok || verifyJson?.result !== "success") {
      throw new Error(
        `Verification failed with ${verifyResult.status}: ${verifyResult.body.slice(0, 500)}`
      );
    }

    const sessionFile = path.resolve(resolveSessionOutputFile(args));
    const storageStatePath = resolveStorageStateFile(args);
    const sessionData = await buildSessionDataFromContext({
      context,
      page,
      args,
      target,
      lastUrl: buildTransfersUrl(args)
    });

    writeTextFile(sessionFile, JSON.stringify(sessionData, null, 2));
    await context.storageState({ path: storageStatePath });

    return {
      ok: true,
      [target.type]: target.value,
      session_file: sessionFile,
      storage_state_file: storageStatePath,
      account_id: verifyJson?.data?.account?.id ?? null
    };
  } finally {
    await browser.close();
  }
}

function loadSession(args) {
  const sessionPath = resolveSessionInputFile(args);

  if (!sessionPath) {
    return { cookie: "", headers: {}, sessionFile: null };
  }

  const absolutePath = path.resolve(sessionPath);
  if (!fs.existsSync(absolutePath)) {
    return { cookie: "", headers: {}, sessionFile: absolutePath };
  }

  const session = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return {
    cookie: session.cookie || "",
    headers: session.headers || {},
    sessionFile: absolutePath
  };
}

function buildHeaders(args, session, overrides = {}) {
  const sessionHeaders = session.headers || {};
  const headers = new Headers({
    accept: "application/json, text/plain, */*",
    "accept-language": DEFAULT_ACCEPT_LANGUAGE,
    referer:
      overrides.referer ||
      args.referer ||
      sessionHeaders.Referer ||
      sessionHeaders.referer ||
      CARRIER_PAGE_URL,
    "user-agent":
      overrides.userAgent ||
      args["user-agent"] ||
      sessionHeaders["User-Agent"] ||
      sessionHeaders["user-agent"] ||
      DEFAULT_USER_AGENT
  });

  const cookie = overrides.cookie || "";
  if (cookie) {
    headers.set("cookie", cookie);
  }

  for (const [name, value] of Object.entries(sessionHeaders)) {
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "referer" || lower === "user-agent") {
      continue;
    }
    headers.set(name, value);
  }

  for (const header of args.headers) {
    const separator = header.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid --header value: ${header}`);
    }
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    headers.set(name, value);
  }

  return headers;
}

function resolveCookie(args) {
  if (args.cookie) {
    return String(args.cookie).trim();
  }

  if (args["cookie-file"]) {
    return fs.readFileSync(path.resolve(args["cookie-file"]), "utf8").trim();
  }

  return process.env.GETTRANSFER_COOKIE || "";
}

function resolveSessionInputFile(args) {
  if (args["session-file"]) {
    return args["session-file"];
  }

  const candidates = DEFAULT_SESSION_FILES
    .map((candidate) => {
      const absolutePath = path.resolve(candidate);
      if (!fs.existsSync(absolutePath)) {
        return null;
      }

      return {
        candidate,
        timestamp: readSessionTimestamp(absolutePath)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp);

  if (candidates.length > 0) {
    return candidates[0].candidate;
  }

  return DEFAULT_SESSION_FILES[0];
}

function resolveSessionOutputFile(args) {
  return args["session-file"] || DEFAULT_SESSION_FILES[0];
}

function readSessionTimestamp(absolutePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    const savedAt = Date.parse(payload.saved_at || "");
    if (Number.isFinite(savedAt)) {
      return savedAt;
    }
  } catch {}

  return fs.statSync(absolutePath).mtimeMs;
}

function resolveLoginTargets(args) {
  const targets = [];
  const explicitPhone = String(args.phone || "").trim();
  const explicitEmail = String(args.email || "").trim();
  const phone = explicitPhone || resolveLoginPhone(args);
  const email = explicitEmail || resolveLoginEmail(args);

  if (explicitPhone || explicitEmail) {
    if (explicitPhone) {
      targets.push({ type: "phone", value: explicitPhone });
    }

    if (explicitEmail) {
      targets.push({ type: "email", value: explicitEmail });
    }

    if (targets.length === 0) {
      throw new Error("Missing explicit login email or phone");
    }

    return targets;
  }

  if (phone) {
    targets.push({ type: "phone", value: phone });
  }

  if (email) {
    targets.push({ type: "email", value: email });
  }

  if (targets.length === 0) {
    throw new Error("Missing login email or phone");
  }

  return targets;
}

function resolveLoginEmail(args) {
  return (
    args.email ||
    process.env.GETTRANSFER_EMAIL ||
    process.env.GMAIL_USER ||
    ""
  ).trim();
}

function resolveLoginPhone(args) {
  return (
    args.phone ||
    process.env.GETTRANSFER_PHONE ||
    ""
  ).trim();
}

function resolveOtpFile(args) {
  return path.resolve(args["otp-file"] || ".latest-otp.json");
}

function resolveStorageStateFile(args) {
  return path.resolve(args["storage-state"] || "capture/storage-state.json");
}

function shouldUseBrowserLogin(args, target) {
  return target.type === "phone" && !args["no-browser-login"];
}

function fetchOtpCodeFromEmail({ email, timeoutSeconds, sinceEpochMs }) {
  if (!resolveLoginEmail({ email })) {
    throw new Error("Missing login email");
  }

  const helperPath = path.resolve(__dirname, "gettransfer_otp.py");
  const result = spawnSync(
    "python3",
    [
      helperPath,
      "--email",
      email,
      "--since-epoch-ms",
      String(sinceEpochMs),
      "--timeout",
      String(timeoutSeconds)
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env
    }
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "OTP helper failed"
    );
  }

  return result.stdout.trim();
}

function fetchOtpCodeFromFile({ otpFile, timeoutSeconds, sinceEpochMs }) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() <= deadline) {
    if (fs.existsSync(otpFile)) {
      const payload = JSON.parse(fs.readFileSync(otpFile, "utf8"));
      const receivedAt = payload.received_at
        ? Date.parse(payload.received_at)
        : 0;
      if (
        payload.ok === true &&
        payload.code &&
        Number.isFinite(receivedAt) &&
        receivedAt >= sinceEpochMs
      ) {
        return String(payload.code).trim();
      }
    }

    sleep(1000);
  }

  throw new Error(
    `No OTP received in ${otpFile} after ${new Date(sinceEpochMs).toISOString()}`
  );
}

async function bootstrapLoginSession(args, session, initialCookie) {
  let cookie = initialCookie || "";
  const documentHeaders = buildDocumentHeaders(args, session, {
    cookie,
    referer: args.referer || CARRIER_PAGE_URL
  });

  cookie = await requestCookieRefresh(CARRIER_PAGE_URL, {
    headers: documentHeaders,
    cookie
  });

  const configsHeaders = buildHeaders(args, session, {
    cookie,
    referer: args.referer || CARRIER_PAGE_URL
  });
  cookie = await requestCookieRefresh(CONFIGS_ENDPOINT, {
    headers: configsHeaders,
    cookie
  });

  const countriesHeaders = buildHeaders(args, session, {
    cookie,
    referer: args.referer || LOGIN_REFERER
  });
  cookie = await requestCookieRefresh(COUNTRIES_ENDPOINT, {
    headers: countriesHeaders,
    cookie
  });

  return cookie;
}

function parsePossibleJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchJsonText(url, options) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      body,
      json: null
    };
  }

  try {
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      body,
      json: JSON.parse(body)
    };
  } catch {
    throw new Error(
      `Response was not valid JSON. First 500 bytes:\n${body.slice(0, 500)}`
    );
  }
}

async function requestCookieRefresh(url, { headers, cookie }) {
  const response = await fetch(url, {
    method: "GET",
    headers
  });
  await response.arrayBuffer();
  return applySetCookies(cookie, extractSetCookieHeaders(response));
}

async function openBrowserContext(args, options = {}) {
  const { chromium } = require("playwright-core");
  const executablePath = CHROME_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate)
  );

  if (!executablePath) {
    throw new Error(
      "Browser support requires Chrome/Chromium. Set CHROME_PATH to a Chromium-based browser."
    );
  }

  const browser = await chromium.launch({
    executablePath,
    headless: options.headless ?? !args.headful,
    args: ["--disable-dev-shm-usage"]
  });

  const storageStatePath = resolveStorageStateFile(args);
  const contextOptions = {
    ignoreHTTPSErrors: true
  };

  if (options.preferStorageState && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }

  const userAgent = args["user-agent"];
  if (userAgent) {
    contextOptions.userAgent = userAgent;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page };
}

async function buildSessionDataFromContext({
  context,
  page,
  args,
  target,
  lastUrl
}) {
  const cookies = await context.cookies();
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  let userAgent =
    args["user-agent"] ||
    DEFAULT_USER_AGENT;

  try {
    userAgent = await page.evaluate(() => navigator.userAgent);
  } catch {}

  return {
    cookie,
    headers: {
      Referer: args.referer || CARRIER_PAGE_URL,
      "User-Agent": userAgent
    },
    [target.type]: target.value,
    last_url: lastUrl,
    saved_at: new Date().toISOString()
  };
}

function buildDocumentHeaders(args, session, overrides = {}) {
  const sessionHeaders = session.headers || {};
  const headers = new Headers({
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": DEFAULT_ACCEPT_LANGUAGE,
    referer:
      overrides.referer ||
      args.referer ||
      sessionHeaders.Referer ||
      sessionHeaders.referer ||
      CARRIER_PAGE_URL,
    "user-agent":
      overrides.userAgent ||
      args["user-agent"] ||
      sessionHeaders["User-Agent"] ||
      sessionHeaders["user-agent"] ||
      DEFAULT_USER_AGENT
  });

  const cookie = overrides.cookie || "";
  if (cookie) {
    headers.set("cookie", cookie);
  }

  return headers;
}

function shouldUseBrowserFetchFallback(args, result) {
  if (args["no-browser"]) {
    return false;
  }

  if (args.browser) {
    return true;
  }

  if (!fs.existsSync(resolveStorageStateFile(args))) {
    return false;
  }

  if ([401, 403].includes(Number(result?.status))) {
    return true;
  }

  const haystack = [
    result?.statusText,
    result?.body
  ]
    .filter(Boolean)
    .join("\n");

  return /unauthorized|forbidden|not logged in|cloudflare|attention required/i.test(
    String(haystack || "")
  );
}

async function fetchPayloadInBrowser(args, requestUrl) {
  const { chromium } = require("playwright-core");
  const storageStatePath = resolveStorageStateFile(args);
  const executablePath = CHROME_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate)
  );

  if (!executablePath) {
    throw new Error(
      "Browser fetch fallback requires Chrome/Chromium. Set CHROME_PATH to a Chromium-based browser."
    );
  }

  if (!fs.existsSync(storageStatePath)) {
    throw new Error(
      `Browser fetch fallback requires a storage state file at ${storageStatePath}`
    );
  }

  const browser = await chromium.launch({
    executablePath,
    headless: !args.headful,
    args: ["--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: storageStatePath
    });
    const page = await context.newPage();
    await page.goto(CABINET_REQUESTS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: await response.text()
      };
    }, requestUrl);

    if (!result.ok) {
      throw new Error(
        `Browser fetch failed with ${result.status} ${result.statusText}\n${result.body.slice(0, 500)}`
      );
    }

    try {
      return JSON.parse(result.body);
    } catch {
      throw new Error(
        `Browser fetch returned invalid JSON. First 500 bytes:\n${result.body.slice(0, 500)}`
      );
    }
  } finally {
    await browser.close();
  }
}

function extractSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function applySetCookies(cookieHeader, setCookieHeaders) {
  const jar = new Map();

  for (const part of String(cookieHeader || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes("=")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }

  for (const setCookie of setCookieHeaders) {
    const first = String(setCookie).split(";")[0].trim();
    if (!first || !first.includes("=")) {
      continue;
    }
    const eq = first.indexOf("=");
    jar.set(first.slice(0, eq), first.slice(eq + 1));
  }

  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function extractTransfers(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data?.transfers)) {
    return payload.data.transfers;
  }

  if (Array.isArray(payload?.transfers)) {
    return payload.transfers;
  }

  throw new Error("Could not find a transfers array in the payload");
}

function normalizeJourney(transfer) {
  const childSeatsTotal =
    numberOrZero(transfer.child_seats) +
    numberOrZero(transfer.child_seats_infant) +
    numberOrZero(transfer.child_seats_convertible) +
    numberOrZero(transfer.child_seats_booster);

  return {
    id: transfer.id ?? null,
    type: transfer.type ?? null,
    pickup_at: transfer.date_to_local ?? null,
    return_at: transfer.date_return_local ?? null,
    passengers: transfer.pax ?? null,
    distance_km: transfer.distance ?? null,
    time_minutes: transfer.time ?? null,
    from_name: transfer.from?.name ?? null,
    from_country: transfer.from?.country ?? null,
    from_point: transfer.from?.point ?? null,
    from_types: joinArray(transfer.from?.types),
    from_chosen_on_map: Boolean(transfer.from?.chosen_on_map),
    to_name: transfer.to?.name ?? null,
    to_country: transfer.to?.country ?? null,
    to_point: transfer.to?.point ?? null,
    to_types: joinArray(transfer.to?.types),
    to_chosen_on_map: Boolean(transfer.to?.chosen_on_map),
    waiting_time_to: transfer.waiting_time_type_to ?? null,
    waiting_time_return: transfer.waiting_time_type_return ?? null,
    transport_types: joinArray(transfer.transport_type_ids),
    name_sign_present: Boolean(transfer.name_sign_present),
    watertaxi: Boolean(transfer.watertaxi),
    armored_option_available: Boolean(transfer.armored_option_available),
    air_conditioner_option_available: Boolean(
      transfer.air_conditioner_option_available
    ),
    child_seats_total: childSeatsTotal
  };
}

function renderJourneys(journeys, format) {
  if (format === "json") {
    return JSON.stringify(journeys, null, 2);
  }

  if (format === "csv") {
    return toCsv(journeys);
  }

  if (format === "pretty") {
    return toPrettyTable(journeys);
  }

  throw new Error(`Unsupported format: ${format}`);
}

function toCsv(rows) {
  const headers = [
    "id",
    "type",
    "pickup_at",
    "return_at",
    "passengers",
    "distance_km",
    "time_minutes",
    "from_name",
    "to_name",
    "waiting_time_to",
    "waiting_time_return",
    "transport_types",
    "name_sign_present",
    "child_seats_total"
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function toPrettyTable(rows) {
  const headers = [
    "id",
    "pickup_at",
    "type",
    "passengers",
    "distance_km",
    "from_name",
    "to_name",
    "transport_types"
  ];

  const formattedRows = rows.map((row) =>
    Object.fromEntries(
      headers.map((header) => [
        header,
        shorten(String(row[header] ?? ""), header === "pickup_at" ? 25 : 42)
      ])
    )
  );

  const widths = Object.fromEntries(
    headers.map((header) => [
      header,
      Math.max(
        header.length,
        ...formattedRows.map((row) => String(row[header]).length)
      )
    ])
  );

  const lines = [];
  lines.push(headers.map((header) => pad(header, widths[header])).join(" | "));
  lines.push(headers.map((header) => "-".repeat(widths[header])).join("-+-"));

  for (const row of formattedRows) {
    lines.push(
      headers.map((header) => pad(String(row[header]), widths[header])).join(" | ")
    );
  }

  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function joinArray(value) {
  return Array.isArray(value) ? value.join("|") : "";
}

function numberOrZero(value) {
  return typeof value === "number" ? value : 0;
}

function shorten(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function pad(value, width) {
  return value.padEnd(width, " ");
}

function writeTextFile(filePath, contents) {
  fs.writeFileSync(path.resolve(filePath), contents, "utf8");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait is acceptable here because the CLI is single-purpose and short-lived.
  }
}

function printHelp() {
  process.stdout.write(`GetTransfer Journey Extractor

Usage:
  node src/gettransfer.js login [options]
  node src/gettransfer.js fetch [options]
  node src/gettransfer.js extract --input <response.json> [options]

Options:
  --format <pretty|json|csv>   Output format. Default: pretty
  --output <file>              Write normalized output to a file
  --raw-output <file>          Save the raw response body to a file
  --session-file <file>        Session file. Defaults to ./.gettransfer-session.json,
                               then ./capture/session.json if present
  --url <request-url>          Override the default transfers endpoint
  --page <n>                   Page number. Default: 1
  --offers <value>             Offer filter. Default: except_my
  --pax-min <n>                Minimum passengers filter. Default: 0
  --pax-max <n>                Maximum passengers filter. Default: 4
  --search <text>              Search filter
  --date-since <value>         filtering[date_since]
  --date-till <value>          filtering[date_till]
  --asap <true|false>          filtering[asap]. Default: false
  --hidden <true|false>        filtering[hidden]. Default: false
  --sort-field <field>         sorting[field]. Default: created_at
  --sort-order <value>         sorting[order_by]. Default: desc
  --email <address>            Explicit login email. If passed, only this email target is used
  --phone <number>             Explicit login phone. If passed, only this phone target is used
  --timeout <seconds>          OTP wait timeout for login. Default: 180
  --otp-file <file>            OTP JSON file for phone login. Default: ./.latest-otp.json
  --no-browser-login           Force raw HTTP login instead of browser-context phone login
  --browser                    Use browser-context fetch, or allow browser fallback on auth failure
  --no-browser                 Disable browser-context fetch fallback
  --storage-state <file>       Playwright storage state. Default: ./capture/storage-state.json
  --headful                    Launch browser visibly for browser-context fetch
  --cookie <cookie-header>     Cookie header for live fetch mode
  --cookie-file <file>         File containing the Cookie header
  --header "Name: Value"       Extra request header. Can be repeated
  --referer <url>              Referer for live fetch mode
  --user-agent <ua>            Override the default user-agent
  --help                       Show this help

Examples:
  node src/gettransfer.js login
  node src/gettransfer.js login --phone <your-phone> --timeout 180
  node src/gettransfer.js login --email you@example.com
  node src/gettransfer.js extract --input fixtures/sample-response.json --format pretty
  node src/gettransfer.js fetch --session-file ./capture/session.json --format pretty
  node src/gettransfer.js fetch --browser --storage-state ./capture/storage-state.json --format pretty
  node src/gettransfer.js fetch --cookie "$GETTRANSFER_COOKIE" --format csv --output journeys.csv
  node src/gettransfer.js fetch --page 2 --offers except_my --pax-max 6 --format json
`);
}

module.exports = {
  CARRIER_PAGE_URL,
  CABINET_REQUESTS_URL,
  DEFAULT_QUERY,
  DEFAULT_SESSION_FILES,
  DEFAULT_TRANSFERS_ENDPOINT,
  LOGIN_REFERER,
  applySetCookies,
  buildHeaders,
  buildTransfersUrl,
  extractTransfers,
  fetchPayload,
  fetchPayloadInBrowser,
  loadSession,
  loginWithCode,
  normalizeJourney,
  parseArgs,
  renderJourneys,
  resolveLoginEmail,
  resolveLoginPhone,
  resolveOtpFile,
  resolveSessionInputFile,
  resolveSessionOutputFile,
  resolveStorageStateFile,
  shouldUseBrowserFetchFallback,
  writeTextFile
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
