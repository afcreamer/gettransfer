#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = process.env.OTP_LISTEN_HOST || "0.0.0.0";
const PORT = Number(process.env.OTP_LISTEN_PORT || "8765");
const OUTPUT_FILE = path.resolve(
  process.env.OTP_OUTPUT_FILE || ".latest-otp.json"
);
const MAX_BODY_BYTES = Number(process.env.OTP_MAX_BODY_BYTES || "32768");
const EXPECTED_SENDER_PATTERNS = [
  /gettransfer/i,
  /gettransfer support team/i,
  /\+?1\s*\(?276\)?\s*500[-\s]*0405/,
  /2765000405/
];
const EXPECTED_TITLE_PATTERNS = [
  /gettransfer support team/i,
  /\+?1\s*\(?276\)?\s*500[-\s]*0405/
];
const EXPECTED_MESSAGE_PATTERNS = [
  /(?<!\d)(\d{4,8})\s+is your verification code\./i,
  /your login code:\s*(\d{4,8})\s+gettransfer\.com/i
];

function main() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && req.url === "/otp") {
        const payload = readLatestOtp(OUTPUT_FILE);
        if (!payload) {
          return sendJson(res, 404, { ok: false, error: "No OTP captured yet" });
        }
        return sendJson(res, 200, summarizeOtpPayload(payload));
      }

      if (req.method === "POST" && req.url === "/otp") {
        const raw = await readBody(req);
        const payload = processIncomingOtp({
          raw,
          remoteAddress: req.socket.remoteAddress || "",
          outputFile: OUTPUT_FILE
        });
        return sendJson(res, 200, payload);
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `OTP receiver listening on http://${HOST}:${PORT}\nWriting latest OTP to ${OUTPUT_FILE}\n`
    );
  });
}

function readLatestOtp(outputFile = OUTPUT_FILE) {
  if (!fs.existsSync(outputFile)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(outputFile, "utf8"));
}

function processIncomingOtp({ raw, remoteAddress = "", outputFile = OUTPUT_FILE }) {
  const body = parseIncoming(raw);
  const validationError = validateIncoming(body);

  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  const code = extractCode(body);
  if (!code) {
    const error = new Error("Could not extract a 4-8 digit OTP code");
    error.statusCode = 400;
    throw error;
  }

  const payload = {
    ok: true,
    code,
    source: body.source || "tasker",
    received_at: new Date().toISOString(),
    remote_address: remoteAddress,
    raw: body
  };

  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  return payload;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        const error = new Error(`Request body too large: limit is ${MAX_BODY_BYTES} bytes`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      text += chunk;
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

function parseIncoming(raw) {
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function extractCode(body) {
  const candidates = [
    body.code,
    body.text,
    body.message,
    body.notification_text,
    body.notification_title
  ]
    .filter(Boolean)
    .map(String);

  for (const candidate of candidates) {
    const match = matchExpectedOtp(candidate);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function matchExpectedOtp(candidate) {
  for (const pattern of EXPECTED_MESSAGE_PATTERNS) {
    const match = String(candidate || "").match(pattern);
    if (match) {
      return match;
    }
  }

  return null;
}

function validateIncoming(body) {
  const source = String(body.source || "").toLowerCase();
  const titleCandidates = [
    body.notification_title,
    body.title,
    body.sender,
    body.from
  ]
    .filter(Boolean)
    .map(String);
  const textCandidates = [
    body.notification_text,
    body.text,
    body.message,
    body.body
  ]
    .filter(Boolean)
    .map(String);

  const hasExpectedTitle = titleCandidates.some((candidate) =>
    EXPECTED_TITLE_PATTERNS.some((pattern) => pattern.test(candidate))
  );
  const hasExpectedSender = titleCandidates.some((candidate) =>
    EXPECTED_SENDER_PATTERNS.some((pattern) => pattern.test(candidate))
  );
  const hasGetTransferText = textCandidates.some((candidate) =>
    /gettransfer/i.test(candidate)
  );
  const hasExpectedMessage =
    textCandidates.length > 0 &&
    textCandidates.some((candidate) => Boolean(matchExpectedOtp(candidate)));

  if (!hasExpectedMessage) {
    return "Notification text did not match a supported GetTransfer OTP format";
  }

  if (source.includes("whatsapp")) {
    if (!hasExpectedTitle) {
      return "WhatsApp notification sender/title did not match the expected GetTransfer sender";
    }
    return "";
  }

  if (source.includes("sms") || source.includes("text")) {
    if (titleCandidates.length === 0 || hasGetTransferText) {
      return "";
    }

    if (!hasExpectedSender) {
      return "SMS sender did not match an expected GetTransfer sender";
    }

    return "";
  }

  if (
    titleCandidates.length > 0 &&
    (hasExpectedTitle || hasExpectedSender || hasGetTransferText)
  ) {
    return "";
  }

  return "Sender/title did not match an expected GetTransfer WhatsApp or SMS sender";
}

function summarizeOtpPayload(payload) {
  if (!payload) {
    return null;
  }

  return {
    ok: true,
    source: payload.source || null,
    received_at: payload.received_at || null,
    title:
      payload.raw?.notification_title ||
      payload.raw?.title ||
      payload.raw?.sender ||
      payload.raw?.from ||
      null,
    code_preview: payload.code ? `${String(payload.code).slice(0, 2)}**` : null
  };
}

function buildSecurityHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    ...buildSecurityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

module.exports = {
  EXPECTED_MESSAGE_PATTERNS,
  extractCode,
  matchExpectedOtp,
  parseIncoming,
  processIncomingOtp,
  readBody,
  readLatestOtp,
  sendJson,
  summarizeOtpPayload,
  validateIncoming
};

if (require.main === module) {
  main();
}
