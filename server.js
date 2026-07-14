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
const {
  extractResumeText,
  extractDocumentText,
  MAX_FILE_BYTES,
} = require("./resumeExtract");
const { requireAuth, optionalAuth } = require("./authMiddleware");
const {
  getAccountForUser,
  assertCanGenerate,
  recordBriefGenerated,
} = require("./userUsage");
const {
  createCheckoutSession,
  handleStripeWebhook,
  isStripeConfigured,
} = require("./stripeHandlers");
const { isSupabaseAdminConfigured } = require("./supabaseAdmin");

const MAX_JOB_DESCRIPTION_CHARS = 80_000;

/**
 * Exactly one job input is required: URL, pasted text, or text extracted
 * from an uploaded job-description document.
 * @param {object} body request body
 * @param {string} [jdFromFile] text extracted from an uploaded JD file
 */
function normalizeJobInputs(body, jdFromFile) {
  const jobUrlRaw = typeof body?.jobUrl === "string" ? body.jobUrl.trim() : "";
  const jdPasted =
    typeof body?.jobDescriptionText === "string"
      ? body.jobDescriptionText.trim()
      : "";
  const jdFile = typeof jdFromFile === "string" ? jdFromFile.trim() : "";

  const provided = [jobUrlRaw, jdPasted, jdFile].filter(Boolean).length;
  if (provided > 1) {
    return {
      error:
        "Provide exactly one job input: a job URL, pasted job description text, or an uploaded job description file.",
    };
  }

  if (provided === 0) {
    return {
      error:
        "jobUrl is required (or provide jobDescriptionText / a jobDescription file with the posting).",
    };
  }

  const jdRaw = jdPasted || jdFile;
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

const researchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
}).fields([
  { name: "resume", maxCount: 1 },
  { name: "jobDescriptionFile", maxCount: 1 },
]);

function withResearchUpload(req, res, next) {
  researchUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: `Uploaded file is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`,
      });
    }
    return res.status(400).json({
      error: err.message || "File upload failed.",
    });
  });
}

/**
 * Parse JSON or multipart body (job fields + optional resume file).
 * @returns {Promise<{ error: string } | { job: object, companyUrlOpt?: string, resumeText: string | null, resumeMeta: { attached: boolean, chars: number, truncated: boolean } }>}
 */
async function parseResearchPayload(req) {
  // Uploaded JD document → text, then validated alongside URL / pasted text.
  let jdFromFile;
  const jdFile = req.files?.jobDescriptionFile?.[0];
  if (jdFile) {
    const jdResult = await extractDocumentText(
      jdFile.buffer,
      jdFile.mimetype,
      jdFile.originalname,
      { label: "job description", maxChars: MAX_JOB_DESCRIPTION_CHARS },
    );
    if (!jdResult.ok) return { error: jdResult.error };
    jdFromFile = jdResult.text;
    console.log("[api] job description extracted from upload", {
      chars: jdResult.text.length,
      truncated: Boolean(jdResult.truncated),
    });
  }

  const job = normalizeJobInputs(req.body, jdFromFile);
  if (job.error) return { error: job.error };
  const companyUrlOpt = optionalCompanyUrl(req.body);
  const file = req.files?.resume?.[0];
  const resumeMeta = { attached: false, chars: 0, truncated: false };
  if (!file) {
    // Resume is optional — a JD-only brief simply skips the personalized sections.
    return {
      job,
      companyUrlOpt,
      resumeText: null,
      resumeMeta,
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

// Stripe webhook needs the raw body — must be registered before express.json()
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"];
      await handleStripeWebhook(req.body, signature);
      res.json({ received: true });
    } catch (err) {
      console.error("[stripe] webhook error", err.message || err);
      const status = err.code === "STRIPE_SIGNATURE_INVALID" ? 400 : 500;
      res.status(status).json({ error: err.message || "Webhook failed." });
    }
  },
);

app.use(express.json());

function sendHealth(req, res) {
  res.json({ ok: true });
}

app.get("/health", sendHealth);
/** Same handler under /api for unified Vercel deploy (SPA rewrite keeps /health on index.html). */
app.get("/api/health", sendHealth);

/** Account + usage (auth required when Supabase is configured). */
app.get("/api/account", optionalAuth, async (req, res) => {
  const account = await getAccountForUser(req.user);
  res.json(account);
});

/** Create Stripe Checkout session for a paid plan. */
app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({
      error: "Sign in required.",
      code: "AUTH_REQUIRED",
    });
  }
  if (!isStripeConfigured()) {
    return res.status(503).json({
      error: "Payments are not configured yet. Contact support.",
      code: "STRIPE_NOT_CONFIGURED",
    });
  }

  const plan = req.body?.plan;
  if (plan !== "job_seeker" && plan !== "intensive") {
    return res.status(400).json({
      error: 'plan must be "job_seeker" or "intensive".',
    });
  }

  try {
    const session = await createCheckoutSession(req.user, plan);
    res.json(session);
  } catch (err) {
    console.error("[stripe] checkout session failed", err);
    res.status(500).json({
      error: err.message || "Could not start checkout.",
      code: err.code || "CHECKOUT_FAILED",
    });
  }
});

app.post("/api/research", requireAuth, withResearchUpload, async (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const parsed = await parseResearchPayload(req);
  if (parsed.error) {
    console.log(`[api:${reqId}] POST /api/research rejected: ${parsed.error}`);
    return res.status(400).json({ error: parsed.error });
  }

  const gate = await assertCanGenerate(req.user);
  if (!gate.ok) {
    return res.status(gate.status).json({
      error: gate.error,
      code: gate.code,
    });
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
    if (req.user?.id) {
      await recordBriefGenerated(req.user.id);
    }
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

app.post("/api/research/stream", requireAuth, withResearchUpload, async (req, res) => {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const parsed = await parseResearchPayload(req);
  if (parsed.error) {
    console.log(
      `[api:${reqId}] POST /api/research/stream rejected: ${parsed.error}`,
    );
    return res.status(400).json({ error: parsed.error });
  }

  const gate = await assertCanGenerate(req.user);
  if (!gate.ok) {
    return res.status(gate.status).json({
      error: gate.error,
      code: gate.code,
    });
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
      if (req.user?.id) {
        await recordBriefGenerated(req.user.id);
      }
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
      "API: GET /health, GET /api/account, POST /api/stripe/checkout, POST /api/stripe/webhook, POST /api/research, POST /api/research/stream",
    );
    if (isSupabaseAdminConfigured()) {
      console.log("[auth] Supabase auth + usage tracking enabled.");
    } else {
      console.log(
        "[auth] Supabase not configured — brief generation is open without sign-in.",
      );
    }
    if (isStripeConfigured()) {
      console.log("[stripe] Checkout + webhooks enabled.");
    } else {
      console.log("[stripe] Payments disabled (set STRIPE_SECRET_KEY).");
    }
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
