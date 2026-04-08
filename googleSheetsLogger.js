const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

/** Google Sheets allows ~50k chars per cell; stay under to avoid API errors. */
const MAX_CELL_CHARS = 49_000;

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function resolveServiceAccountKeyFilePath() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!raw || !String(raw).trim()) return null;
  const resolved = path.resolve(String(raw).trim());
  if (!fs.existsSync(resolved)) {
    console.warn("[sheets] service account file not found:", resolved);
    return null;
  }
  return resolved;
}

/** Full service account JSON as a string (for Vercel / serverless, no file path). */
function loadServiceAccountCredentialsFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw).trim());
    if (
      o &&
      typeof o.client_email === "string" &&
      typeof o.private_key === "string"
    ) {
      return o;
    }
  } catch {
    return null;
  }
  return null;
}

function isSheetsConfigured() {
  const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!id || !String(id).trim()) return false;
  if (resolveServiceAccountKeyFilePath()) return true;
  if (loadServiceAccountCredentialsFromEnv()) return true;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  return Boolean(
    email && String(email).trim() && key && String(key).trim(),
  );
}

/**
 * Fix common .env mistakes: BOM, wrapping quotes, literal \n vs real newlines.
 */
function normalizePrivateKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  let k = raw.trim().replace(/^\uFEFF/, "");
  if (
    (k.startsWith('"') && k.endsWith('"') && k.length > 1) ||
    (k.startsWith("'") && k.endsWith("'") && k.length > 1)
  ) {
    k = k.slice(1, -1);
  }
  k = k.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  k = k.replace(/\\n/g, "\n");
  return k.trim();
}

function looksLikePemPrivateKey(key) {
  return (
    typeof key === "string" &&
    /BEGIN [A-Z0-9 ]+PRIVATE KEY/.test(key) &&
    /END [A-Z0-9 ]+PRIVATE KEY/.test(key)
  );
}

/**
 * Prefer a JSON key file (avoids .env PEM escaping issues).
 * @returns {Promise<import('google-auth-library').JWT | import('google-auth-library').AuthClient>}
 */
async function getSheetsAuth() {
  const keyFile = resolveServiceAccountKeyFilePath();
  if (keyFile) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: [SHEETS_SCOPE],
    });
    return auth.getClient();
  }

  const jsonCreds = loadServiceAccountCredentialsFromEnv();
  if (jsonCreds) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: jsonCreds.client_email,
        private_key: normalizePrivateKey(jsonCreds.private_key),
      },
      scopes: [SHEETS_SCOPE],
    });
    return auth.getClient();
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || "");

  if (!clientEmail) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is missing.");
  }
  if (!looksLikePemPrivateKey(privateKey)) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY is not a valid PEM (expected BEGIN … PRIVATE KEY). " +
        "Use GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_SERVICE_ACCOUNT_JSON, or email+PEM.",
    );
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [SHEETS_SCOPE],
  });
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
}

function userAgent(req) {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : "";
}

/**
 * @param {object} row
 * @param {string} row.timestampIso
 * @param {string} row.requestId
 * @param {string} row.endpoint
 * @param {string} row.eventType
 * @param {string} [row.jobUrl]
 * @param {string} [row.companyUrl]
 * @param {string} [row.clientIp]
 * @param {string} [row.userAgent]
 * @param {number|string} [row.httpStatus]
 * @param {string} [row.errorCode]
 * @param {string} [row.errorMessage]
 * @param {string} [row.anthropicModel]
 * @param {number|string} [row.elapsedMs]
 * @param {number|string} [row.inputTokens]
 * @param {number|string} [row.outputTokens]
 * @param {number|string} [row.webSearchRequests]
 * @param {boolean} [row.responseTruncated]
 * @param {string} [row.responseMarkdown]
 * @param {string} [row.resumeAttached] "yes" | "no"
 * @param {number|string} [row.resumeChars]
 * @param {string} [row.resumeParsedText] extracted resume plain text (truncated in-sheet)
 */

/** Avoid Google Sheets interpreting cell as formula (= + - @). */
function sheetsSafeCell(value) {
  const s = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(s)) return `'${s}`;
  return s;
}

function buildRowArray(row) {
  let md = row.responseMarkdown ?? "";
  let truncated = Boolean(row.responseTruncated);
  if (md.length > MAX_CELL_CHARS) {
    md = md.slice(0, MAX_CELL_CHARS) + "\n\n[… truncated for Google Sheets cell limit …]";
    truncated = true;
  }
  let resumeParsed = row.resumeParsedText ?? "";
  if (resumeParsed.length > MAX_CELL_CHARS) {
    resumeParsed =
      resumeParsed.slice(0, MAX_CELL_CHARS) +
      "\n\n[… resume truncated for Google Sheets cell limit …]";
  }
  return [
    sheetsSafeCell(row.timestampIso),
    sheetsSafeCell(row.requestId),
    sheetsSafeCell(row.endpoint),
    sheetsSafeCell(row.eventType),
    sheetsSafeCell(row.jobUrl ?? ""),
    sheetsSafeCell(row.companyUrl ?? ""),
    sheetsSafeCell(row.clientIp ?? ""),
    sheetsSafeCell(row.userAgent ?? ""),
    sheetsSafeCell(row.httpStatus ?? ""),
    sheetsSafeCell(row.errorCode ?? ""),
    sheetsSafeCell(row.errorMessage ?? ""),
    sheetsSafeCell(row.anthropicModel ?? ""),
    sheetsSafeCell(row.elapsedMs ?? ""),
    sheetsSafeCell(row.inputTokens ?? ""),
    sheetsSafeCell(row.outputTokens ?? ""),
    sheetsSafeCell(row.webSearchRequests ?? ""),
    truncated ? "true" : "false",
    sheetsSafeCell(md),
    sheetsSafeCell(row.resumeAttached ?? ""),
    sheetsSafeCell(row.resumeChars ?? ""),
    sheetsSafeCell(resumeParsed),
  ];
}

async function appendRowInternal(row) {
  if (!isSheetsConfigured()) return;

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID.trim();
  const tab =
    (process.env.GOOGLE_SHEETS_TAB_NAME || "logs").trim() || "logs";

  const auth = await getSheetsAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const range = `${tab}!A:U`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [buildRowArray(row)],
    },
  });
}

/**
 * Fire-and-forget append; never throws to caller.
 * @param {Parameters<typeof buildRowArray>[0]} row
 */
function appendUsageLog(row) {
  if (!isSheetsConfigured()) return;

  const run = async () => {
    try {
      await appendRowInternal(row);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("[sheets] append failed", msg);
      if (/DECODER|unsupported|PEM|private key/i.test(msg)) {
        console.error(
          "[sheets] Hint: put the downloaded service-account JSON on disk and set " +
            "GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/key.json (recommended), " +
            "or fix GOOGLE_PRIVATE_KEY newlines (real line breaks or \\n inside quotes).",
        );
      }
    }
  };

  void run();
}

/**
 * @param {import('express').Request} req
 * @param {object} extra
 */
function logFromRequest(req, extra) {
  appendUsageLog({
    timestampIso: new Date().toISOString(),
    clientIp: clientIp(req),
    userAgent: userAgent(req),
    ...extra,
  });
}

/**
 * @param {{ input_tokens?: number, output_tokens?: number, web_search_requests?: number } | undefined} u
 */
function tokenFieldsForSheet(u) {
  if (!u || typeof u !== "object") {
    return { inputTokens: "", outputTokens: "", webSearchRequests: "" };
  }
  return {
    inputTokens:
      typeof u.input_tokens === "number" ? u.input_tokens : "",
    outputTokens:
      typeof u.output_tokens === "number" ? u.output_tokens : "",
    webSearchRequests:
      typeof u.web_search_requests === "number"
        ? u.web_search_requests
        : "",
  };
}

module.exports = {
  isSheetsConfigured,
  appendUsageLog,
  logFromRequest,
  clientIp,
  userAgent,
  MAX_CELL_CHARS,
  tokenFieldsForSheet,
};
