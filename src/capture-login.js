#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const OUTPUT_DIR = path.resolve("capture");
const SESSION_FILE = path.join(OUTPUT_DIR, "session.json");
const TRACE_FILE = path.join(OUTPUT_DIR, "network-log.json");
const STORAGE_FILE = path.join(OUTPUT_DIR, "storage-state.json");
const HAR_FILE = path.join(OUTPUT_DIR, "login.har");
const START_URL = "https://gettransfer.com/en/carrier/#/cabinet/requests";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium"
].filter(Boolean);

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const executablePath = CHROME_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate)
  );

  if (!executablePath) {
    throw new Error(
      "Could not find Chrome/Chromium. Set CHROME_PATH to a Chromium-based browser."
    );
  }

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ["--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    recordHar: {
      path: HAR_FILE,
      mode: "full",
      content: "embed"
    }
  });

  const page = await context.newPage();
  const networkLog = [];
  let saved = false;
  let shuttingDown = false;

  context.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("gettransfer.com")) {
      return;
    }

    const request = response.request();
    const entry = {
      url,
      method: request.method(),
      status: response.status(),
      requestHeaders: await request.allHeaders(),
      responseHeaders: await response.allHeaders(),
      requestBody: request.postData() || ""
    };

    if (
      url.includes("/api/") ||
      url.includes("auth") ||
      url.includes("login") ||
      url.includes("confirm")
    ) {
      entry.body = await safeText(response);
    }

    networkLog.push(entry);

    if (
      !saved &&
      url.includes("/api/transfers") &&
      response.status() === 200 &&
      (entry.body || "").includes("\"transfers\"")
    ) {
      saved = true;
      await saveArtifacts(context, page, networkLog, url);
      console.log(`Saved session to ${SESSION_FILE}`);
      console.log(`Saved network trace to ${TRACE_FILE}`);
      console.log(`Saved storage state to ${STORAGE_FILE}`);
      console.log(`Saved HAR to ${HAR_FILE}`);
      await browser.close();
    }
  });

  page.on("close", async () => {
    await flushPartialArtifacts(
      { context, page, networkLog, saved, shuttingDown },
      "Browser closed before a successful /api/transfers response."
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await flushPartialArtifacts(
        { context, page, networkLog, saved, shuttingDown },
        `Capture interrupted with ${signal}.`
      );
      try {
        await browser.close();
      } catch {}
      process.exit(130);
    });
  }

  console.log("Chrome opened for GetTransfer login capture.");
  console.log("Log in normally. The script will save the session after the first successful /api/transfers response.");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
}

async function saveArtifacts(context, page, networkLog, lastUrl) {
  const cookies = await context.cookies();
  const cookieHeader = cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  let userAgent = "";

  try {
    userAgent = await page.evaluate(() => navigator.userAgent);
  } catch {}

  const session = {
    cookie: cookieHeader,
    headers: {
      Referer: "https://gettransfer.com/en/carrier/",
      "User-Agent": userAgent
    },
    last_url: lastUrl,
    saved_at: new Date().toISOString()
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
  fs.writeFileSync(TRACE_FILE, JSON.stringify(networkLog, null, 2), "utf8");
  await context.storageState({ path: STORAGE_FILE });
}

async function flushPartialArtifacts(state, message) {
  if (state.saved) {
    return;
  }

  try {
    await saveArtifacts(state.context, state.page, state.networkLog, "");
    console.log(message);
    console.log(`Partial artifacts saved under ${OUTPUT_DIR}`);
  } catch (error) {
    try {
      fs.writeFileSync(TRACE_FILE, JSON.stringify(state.networkLog, null, 2), "utf8");
    } catch {}
    console.log(message);
    console.log(`Only partial network trace could be saved: ${error.message}`);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
