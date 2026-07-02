const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

/** Google Sheets allows ~50k chars per cell; stay under to avoid API errors. */
const MAX_CELL_CHARS = 49_000;

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/**
 * GOOGLE_APPLICATION_CREDENTIALS is normally a path. On Vercel many people paste
 * the whole service-account JSON there; path.resolve turns that into
 * /var/task/{...} and breaks auth. Accept inline JSON when it looks like JSON.
 * @returns {{ kind: 'file', path: string } | { kind: 'inline', credentials: object } | null}
 */
function credentialsFromGoogleApplicationEnv() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      if (
        o &&
        typeof o.client_email === "string" &&
        typeof o.private_key === "string"
      ) {
        return { kind: "inline", credentials: o };
      }
      console.warn(
        "[sheets] GOOGLE_APPLICATION_CREDENTIALS looks like JSON but is not a valid service account object (need client_email + private_key).",
      );
    } catch {
      console.warn(
        "[sheets] GOOGLE_APPLICATION_CREDENTIALS looks like JSON but failed to parse.",
      );
    }
    return null;
  }
  const resolved = path.resolve(s);
  if (fs.existsSync(resolved)) {
    return { kind: "file", path: resolved };
  }
  console.warn("[sheets] service account file not found:", resolved);
  return null;
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
  if (credentialsFromGoogleApplicationEnv()) return true;
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
  const fromApp = credentialsFromGoogleApplicationEnv();
  if (fromApp?.kind === "file") {
    const auth = new google.auth.GoogleAuth({
      keyFile: fromApp.path,
      scopes: [SHEETS_SCOPE],
    });
    return auth.getClient();
  }
  if (fromApp?.kind === "inline") {
    const o = fromApp.credentials;
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: o.client_email,
        private_key: normalizePrivateKey(o.private_key),
      },
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
 * Sheet row shape (7 columns: requestId, timestamp, jobUrl, resume, response,
 * inputTokens, outputTokens). Extra keys on `row` are ignored.
 *
 * @param {object} row
 * @param {string} row.requestId
 * @param {string} row.timestampIso
 * @param {string} [row.jobUrl]
 * @param {string} [row.resumeParsedText]
 * @param {string} [row.responseMarkdown]
 * @param {string} [row.errorMessage] used when responseMarkdown is empty (e.g. errors)
 * @param {number|string} [row.inputTokens]
 * @param {number|string} [row.outputTokens]
 */

/**
 * Coerce any logged field to a single flat string (never a nested array for the API).
 */
function oneCellString(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .flat(Infinity)
      .map((v) => (v == null ? "" : String(v)))
      .join("\n");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Normalize whitespace / control chars that confuse Sheets or CSV export.
 */
function sheetsPlainTextCell(value) {
  let s = oneCellString(value);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/\0/g, "");
  s = s.replace(/[\t\v\f\u0085\u2028\u2029]/g, " ");
  return s;
}

/**
 * USER_ENTERED value that always stays one text cell. Leading `'` tells Sheets to
 * treat the cell as text so lines starting with `-`, `+`, `=`, `@`, or digit
 * (common in resumes) are not parsed as formulas or numbers.
 * Internal single quotes are doubled per Sheets rules.
 */
function sheetsUserEnteredText(value) {
  const t = sheetsPlainTextCell(value);
  if (t === "") return "";
  return `'${t.replace(/'/g, "''")}`;
}

function tokenCountForSheet(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return String(n);
  }
  return "";
}

function buildRowArray(row) {
  let resumeParsed = sheetsPlainTextCell(row.resumeParsedText ?? "");
  if (resumeParsed.length > MAX_CELL_CHARS) {
    resumeParsed =
      resumeParsed.slice(0, MAX_CELL_CHARS) +
      "\n\n[… resume truncated for Google Sheets cell limit …]";
  }

  const md = sheetsPlainTextCell((row.responseMarkdown ?? "").trim());
  const err = sheetsPlainTextCell((row.errorMessage ?? "").trim());
  let response = md || err;
  if (response.length > MAX_CELL_CHARS) {
    response =
      response.slice(0, MAX_CELL_CHARS) +
      "\n\n[… truncated for Google Sheets cell limit …]";
  }

  const inTok = tokenCountForSheet(
    row.inputTokens ?? row.input_tokens,
  );
  const outTok = tokenCountForSheet(
    row.outputTokens ?? row.output_tokens,
  );

  return [
    sheetsUserEnteredText(row.requestId ?? ""),
    sheetsUserEnteredText(row.timestampIso ?? ""),
    sheetsUserEnteredText(row.jobUrl ?? ""),
    sheetsUserEnteredText(resumeParsed),
    sheetsUserEnteredText(response),
    inTok,
    outTok,
  ];
}

async function appendRowInternal(row) {
  if (!isSheetsConfigured()) return;

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID.trim();
  const tab =
    (process.env.GOOGLE_SHEETS_TAB_NAME || "logs").trim() || "logs";

  const auth = await getSheetsAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const range = `${tab}!A:G`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    /**
     * USER_ENTERED + leading apostrophe on text columns (see sheetsUserEnteredText)
     * keeps resume/body text in a single cell; resumes often start with `-` / `+` /
     * digits which RAW/Sheets can still treat oddly in some cases.
     */
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
          "[sheets] Hint: on Vercel paste the full key JSON into GOOGLE_SERVICE_ACCOUNT_JSON " +
            "(or GOOGLE_APPLICATION_CREDENTIALS as raw JSON — not a path), " +
            "or set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY with real newlines or \\n.",
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
    ...extra,
  });
}

/**
 * @param {{ input_tokens?: unknown, output_tokens?: unknown, inputTokens?: unknown, outputTokens?: unknown, usage?: object, web_search_requests?: number } | undefined} u
 */
function tokenFieldsForSheet(u) {
  if (!u || typeof u !== "object") {
    return { inputTokens: "", outputTokens: "", webSearchRequests: "" };
  }
  const src =
    u.usage && typeof u.usage === "object" ? u.usage : u;
  const inRaw =
    src.input_tokens ?? src.inputTokens ?? u.input_tokens ?? u.inputTokens;
  const outRaw =
    src.output_tokens ?? src.outputTokens ?? u.output_tokens ?? u.outputTokens;
  const inStr = tokenCountForSheet(inRaw);
  const outStr = tokenCountForSheet(outRaw);
  return {
    inputTokens: inStr,
    outputTokens: outStr,
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
