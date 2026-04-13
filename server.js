require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const {
  AuthenticationError,
  RateLimitError,
  BadRequestError,
  APIError,
} = require("@anthropic-ai/sdk");
const { generateBrief, streamResearchBrief, MODEL } = require("./research");
const {
  logFromRequest,
  isSheetsConfigured,
  tokenFieldsForSheet,
} = require("./googleSheetsLogger");
const { extractResumeText, MAX_FILE_BYTES } = require("./resumeExtract");

const MAX_JOB_DESCRIPTION_CHARS = 80_000;

function normalizeJobInputs(body) {
  const jobUrlRaw = typeof body?.jobUrl === "string" ? body.jobUrl.trim() : "";
  const jdRaw =
    typeof body?.jobDescriptionText === "string"
      ? body.jobDescriptionText.trim()
      : "";

  if (jobUrlRaw && jdRaw) {
    return {
      error:
        "Provide either jobUrl or pasted job description text, not both.",
    };
  }

  if (!jobUrlRaw && !jdRaw) {
    return {
      error:
        "jobUrl is required (or provide jobDescriptionText if pasting the posting).",
    };
  }

  if (jdRaw.length > MAX_JOB_DESCRIPTION_CHARS) {
    return {
      error: `Pasted job description is too long (max ${MAX_JOB_DESCRIPTION_CHARS.toLocaleString()} characters).`,
    };
  }

  if (jobUrlRaw) {
    try {
      const u = new URL(jobUrlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { error: "jobUrl must use http or https." };
      }
    } catch {
      return { error: "jobUrl must be a valid URL." };
    }
  }

  return {
    jobUrl: jobUrlRaw || undefined,
    jobDescriptionText: jdRaw || undefined,
  };
}

/** Optional company website hint (legacy / power users). */
function optionalCompanyUrl(body) {
  const raw = typeof body?.companyUrl === "string" ? body.companyUrl.trim() : "";
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

function requestLogHost({ companyUrl, jobUrl }) {
  if (companyUrl) {
    try {
      return new URL(companyUrl).hostname;
    } catch {
      return companyUrl;
    }
  }
  if (jobUrl) {
    try {
      return new URL(jobUrl).hostname;
    } catch {
      return "—";
    }
  }
  return "—";
}

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
}).fields([{ name: "resume", maxCount: 1 }]);

function withResumeUpload(req, res, next) {
  resumeUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: `Resume file is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`,
      });
    }
    return res.status(400).json({
      error: err.message || "Resume upload failed.",
    });
  });
}

/**
 * Parse JSON or multipart body (job fields + required resume file).
 * @returns {Promise<{ error: string } | { job: object, companyUrlOpt?: string, resumeText: string, resumeMeta: { attached: boolean, chars: number, truncated: boolean } }>}
 */
async function parseResearchPayload(req) {
  const job = normalizeJobInputs(req.body);
  if (job.error) return { error: job.error };
  const companyUrlOpt = optionalCompanyUrl(req.body);
  const file = req.files?.resume?.[0];
  const resumeMeta = { attached: false, chars: 0, truncated: false };
  if (!file) {
    return {
      error: "A resume file (PDF or .docx) is required for each brief.",
    };
  }
  const result = await extractResumeText(
    file.buffer,
    file.mimetype,
    file.originalname,
  );
  if (!result.ok) return { error: result.error };
  resumeMeta.attached = true;
  resumeMeta.chars = result.text.length;
  resumeMeta.truncated = Boolean(result.truncated);
  console.log("[api] resume extracted for request", {
    chars: result.text.length,
    llmTruncated: resumeMeta.truncated,
  });
  return {
    job,
    companyUrlOpt,
    resumeText: result.text,
    resumeMeta,
  };
}

function sheetResumeFields(meta, resumeText) {
  const text =
    meta?.attached && typeof resumeText === "string" ? resumeText : "";
  return {
    resumeAttached: meta?.attached ? "yes" : "no",
    resumeChars: meta?.attached ? meta.chars : "",
    resumeParsedText: text,
  };
}

const app = express();
const PORT = process.env.PORT || 3000;

const devOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

/** Same-origin SPA + API on Vercel: reflect browser Origin (VERCEL=1). */
const corsOptions = process.env.FRONTEND_URL
  ? { origin: process.env.FRONTEND_URL }
  : process.env.VERCEL
    ? { origin: true }
    : { origin: devOrigins };

app.set("trust proxy", 1);

app.use(cors(corsOptions));
app.use(express.json());

function sendHealth(req, res) {
  res.json({ ok: true });
}

app.get("/health", sendHealth);
/** Same handler under /api for unified Vercel deploy (SPA rewrite keeps /health on index.html). */
app.get("/api/health", sendHealth);

/**
 * Client-only trial block logging (no Anthropic call). Optional body:
 * { jobUrl?, freeUsesUsed?: number }
 */
app.post("/api/log-client-event", (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const jobUrl =
    typeof req.body?.jobUrl === "string" ? req.body.jobUrl.trim() : "";
  const freeUsesUsed = Number(req.body?.freeUsesUsed);
  const used =
    Number.isFinite(freeUsesUsed) && freeUsesUsed >= 0
      ? Math.min(99, Math.floor(freeUsesUsed))
      : "";

  logFromRequest(req, {
    requestId: reqId,
    endpoint: "/api/log-client-event",
    eventType: "trial_blocked",
    jobUrl,
    companyUrl: "",
    httpStatus: 200,
    errorCode: "CLIENT_TRIAL_CAP",
    errorMessage:
      used !== ""
        ? `Free trial uses exhausted (${used} used).`
        : "Free trial uses exhausted.",
    anthropicModel: "",
    elapsedMs: "",
    responseTruncated: false,
    responseMarkdown: "",
    ...tokenFieldsForSheet(undefined),
    ...sheetResumeFields({ attached: false }, null),
  });

  res.json({ ok: true, logged: isSheetsConfigured() });
});

app.post("/api/research", withResumeUpload, async (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const parsed = await parseResearchPayload(req);
  if (parsed.error) {
    console.log(`[api:${reqId}] POST /api/research rejected: ${parsed.error}`);
    return res.status(400).json({ error: parsed.error });
  }

  const { job, companyUrlOpt, resumeText, resumeMeta } = parsed;
  const companyHost = requestLogHost({
    companyUrl: companyUrlOpt,
    jobUrl: job.jobUrl,
  });

  console.log(`[api:${reqId}] POST /api/research accepted`, {
    companyHost,
    hasOptionalCompanyUrl: Boolean(companyUrlOpt),
    hasJobUrl: Boolean(job.jobUrl),
    hasJobDescriptionText: Boolean(job.jobDescriptionText),
    resumeAttached: resumeMeta.attached,
  });

  const t0 = Date.now();
  logFromRequest(req, {
    requestId: reqId,
    endpoint: "/api/research",
    eventType: "attempt_started",
    jobUrl: job.jobUrl || "",
    companyUrl: companyUrlOpt || "",
    httpStatus: "",
    errorCode: "",
    errorMessage: "",
    anthropicModel: MODEL,
    elapsedMs: "",
    responseTruncated: false,
    responseMarkdown: "",
    ...tokenFieldsForSheet(undefined),
    ...sheetResumeFields(resumeMeta, resumeText),
  });

  try {
    const { markdown, tokenUsage } = await generateBrief({
      companyUrl: companyUrlOpt,
      jobUrl: job.jobUrl,
      jobDescriptionText: job.jobDescriptionText,
      resumeText,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`[api:${reqId}] success`, {
      markdownChars: markdown.length,
      elapsedMs,
      tokenUsage,
    });
    logFromRequest(req, {
      requestId: reqId,
      endpoint: "/api/research",
      eventType: "success",
      jobUrl: job.jobUrl || "",
      companyUrl: companyUrlOpt || "",
      httpStatus: 200,
      errorCode: "",
      errorMessage: "",
      anthropicModel: MODEL,
      elapsedMs,
      responseTruncated: false,
      responseMarkdown: markdown,
      ...tokenFieldsForSheet(tokenUsage),
      ...sheetResumeFields(resumeMeta, resumeText),
    });
    res.json({ markdown });
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.error(`[api:${reqId}] error after ${elapsedMs}ms`, err.code || err.name, err.message);
    const statusForLog =
      err.code === "MISSING_API_KEY"
        ? 503
        : err.status && typeof err.status === "number"
          ? err.status
          : 502;
    logFromRequest(req, {
      requestId: reqId,
      endpoint: "/api/research",
      eventType: "error",
      jobUrl: job.jobUrl || "",
      companyUrl: companyUrlOpt || "",
      httpStatus: statusForLog,
      errorCode: err.code || err.name || "ERROR",
      errorMessage: err.message || String(err),
      anthropicModel: MODEL,
      elapsedMs,
      responseTruncated: false,
      responseMarkdown: "",
      ...tokenFieldsForSheet(undefined),
      ...sheetResumeFields(resumeMeta, resumeText),
    });
    if (err.code === "MISSING_API_KEY") {
      return res.status(503).json({
        error:
          "The research service is not configured. Set ANTHROPIC_API_KEY on the server.",
      });
    }
    if (err.code === "PAUSE_TURN_LIMIT" || err.code === "EMPTY_OUTPUT") {
      console.error(err);
      return res.status(502).json({
        error:
          "The AI could not finish the brief. Try again in a moment.",
      });
    }

    if (err instanceof AuthenticationError) {
      return res.status(502).json({
        error: "API authentication failed. Check ANTHROPIC_API_KEY.",
      });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({
        error: "Too many requests. Please wait and try again.",
      });
    }
    if (err instanceof BadRequestError) {
      return res.status(502).json({
        error:
          err.message ||
          "The AI service rejected the request. Check model access and tools.",
      });
    }
    if (err instanceof APIError) {
      console.error("Anthropic API error:", err.status, err.message);
      return res.status(502).json({
        error: "The AI service returned an error. Try again later.",
      });
    }

    console.error(err);
    return res.status(500).json({
      error: "Something went wrong while generating the brief.",
    });
  }
});

app.post("/api/research/stream", withResumeUpload, async (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const parsed = await parseResearchPayload(req);
  if (parsed.error) {
    console.log(
      `[api:${reqId}] POST /api/research/stream rejected: ${parsed.error}`,
    );
    return res.status(400).json({ error: parsed.error });
  }

  const { job, companyUrlOpt, resumeText, resumeMeta } = parsed;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "your_key_here") {
    return res.status(503).json({
      error:
        "The research service is not configured. Set ANTHROPIC_API_KEY on the server.",
    });
  }

  const companyHost = requestLogHost({
    companyUrl: companyUrlOpt,
    jobUrl: job.jobUrl,
  });

  console.log(`[api:${reqId}] POST /api/research/stream (SSE)`, {
    companyHost,
    hasOptionalCompanyUrl: Boolean(companyUrlOpt),
    hasJobUrl: Boolean(job.jobUrl),
    hasJobDescriptionText: Boolean(job.jobDescriptionText),
    resumeAttached: resumeMeta.attached,
  });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const t0 = Date.now();
  logFromRequest(req, {
    requestId: reqId,
    endpoint: "/api/research/stream",
    eventType: "attempt_started",
    jobUrl: job.jobUrl || "",
    companyUrl: companyUrlOpt || "",
    httpStatus: "",
    errorCode: "",
    errorMessage: "",
    anthropicModel: MODEL,
    elapsedMs: "",
    responseTruncated: false,
    responseMarkdown: "",
    ...tokenFieldsForSheet(undefined),
    ...sheetResumeFields(resumeMeta, resumeText),
  });

  try {
    const streamResult = await streamResearchBrief(req, res, {
      companyUrl: companyUrlOpt,
      jobUrl: job.jobUrl,
      jobDescriptionText: job.jobDescriptionText,
      resumeText,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`[api:${reqId}] stream finished in ${elapsedMs}ms`, {
      tokenUsage: streamResult?.tokenUsage,
    });

    if (streamResult?.ok) {
      logFromRequest(req, {
        requestId: reqId,
        endpoint: "/api/research/stream",
        eventType: "success",
        jobUrl: job.jobUrl || "",
        companyUrl: companyUrlOpt || "",
        httpStatus: 200,
        errorCode: "",
        errorMessage: "",
        anthropicModel: MODEL,
        elapsedMs: streamResult.elapsedMs ?? elapsedMs,
        responseTruncated: false,
        responseMarkdown: streamResult.markdown || "",
        ...tokenFieldsForSheet(streamResult.tokenUsage),
        ...sheetResumeFields(resumeMeta, resumeText),
      });
    } else if (streamResult) {
      logFromRequest(req, {
        requestId: reqId,
        endpoint: "/api/research/stream",
        eventType: "error",
        jobUrl: job.jobUrl || "",
        companyUrl: companyUrlOpt || "",
        httpStatus: 200,
        errorCode: streamResult.errorCode || "STREAM_ERROR",
        errorMessage: streamResult.errorMessage || "Stream failed",
        anthropicModel: MODEL,
        elapsedMs: streamResult.elapsedMs ?? elapsedMs,
        responseTruncated: false,
        responseMarkdown: "",
        ...tokenFieldsForSheet(streamResult.tokenUsage),
        ...sheetResumeFields(resumeMeta, resumeText),
      });
    } else {
      logFromRequest(req, {
        requestId: reqId,
        endpoint: "/api/research/stream",
        eventType: "error",
        jobUrl: job.jobUrl || "",
        companyUrl: companyUrlOpt || "",
        httpStatus: 200,
        errorCode: "STREAM_NO_RESULT",
        errorMessage: "Stream ended without a final result object.",
        anthropicModel: MODEL,
        elapsedMs,
        responseTruncated: false,
        responseMarkdown: "",
        ...tokenFieldsForSheet(undefined),
        ...sheetResumeFields(resumeMeta, resumeText),
      });
    }
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.error(
      `[api:${reqId}] stream error after ${elapsedMs}ms`,
      err.code || err.name,
      err.message,
    );
    logFromRequest(req, {
      requestId: reqId,
      endpoint: "/api/research/stream",
      eventType: "error",
      jobUrl: job.jobUrl || "",
      companyUrl: companyUrlOpt || "",
      httpStatus: err.code === "MISSING_API_KEY" ? 503 : 500,
      errorCode: err.code || err.name || "STREAM_EXCEPTION",
      errorMessage: err.message || String(err),
      anthropicModel: MODEL,
      elapsedMs,
      responseTruncated: false,
      responseMarkdown: "",
      ...tokenFieldsForSheet(undefined),
      ...sheetResumeFields(resumeMeta, resumeText),
    });
    if (!res.writableEnded) {
      if (res.headersSent) {
        try {
          res.write(
            sseLine({
              type: "error",
              message: "Something went wrong while streaming the brief.",
            }),
          );
        } catch {
          /* client gone */
        }
      } else {
        res.status(500).json({
          error: "Something went wrong while streaming the brief.",
        });
      }
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

function startServer() {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(
      "API: GET /health, GET /api/health, POST /api/research, POST /api/research/stream, POST /api/log-client-event",
    );
    if (isSheetsConfigured()) {
      console.log("[sheets] Usage logging to Google Sheets is enabled.");
    } else {
      console.log(
        "[sheets] Usage logging disabled (set GOOGLE_SHEETS_SPREADSHEET_ID + GOOGLE_APPLICATION_CREDENTIALS or email/key).",
      );
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
