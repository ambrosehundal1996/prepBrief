const { Anthropic } = require("@anthropic-ai/sdk");
const { BRIEF_PROMPT } = require("./prompts");
const {
  scrapeJobPostingUrl,
  isFirecrawlConfigured,
} = require("./firecrawlScrape");
const {
  extractCompanyIdentity,
  runStage1,
  normalizeDomain,
} = require("./companyResearch");
const { getFreshResearch, upsertResearch } = require("./researchCache");

/** Stage 2 (brief writer) model. Override with ANTHROPIC_MODEL in .env */
const MODEL =
  (typeof process.env.ANTHROPIC_MODEL === "string" &&
    process.env.ANTHROPIC_MODEL.trim()) ||
  "claude-sonnet-4-6";

/** Stage 2 output budget — the brief itself, no tool loops. */
const MAX_TOKENS = Math.min(
  64_000,
  Math.max(
    1024,
    Number.parseInt(process.env.RESEARCH_MAX_OUTPUT_TOKENS || "4000", 10) ||
      4000,
  ),
);

const INTERVIEW_STAGE = "hiring_manager";

/** Retries per Anthropic API call. */
const MAX_ANTHROPIC_RETRIES = Math.min(
  10,
  Math.max(
    1,
    Number.parseInt(process.env.ANTHROPIC_MAX_RETRIES || "5", 10) || 5,
  ),
);

const ANTHROPIC_RETRY_BASE_MS = Math.min(
  60_000,
  Math.max(
    400,
    Number.parseInt(process.env.ANTHROPIC_RETRY_BASE_MS || "2000", 10) ||
      2000,
  ),
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient Anthropic capacity / throttle errors — safe to retry whole request.
 * @param {unknown} err
 */
function isRetriableAnthropicError(err) {
  if (err == null || typeof err !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (err);
  const nested =
    o.error &&
    typeof o.error === "object" &&
    /** @type {Record<string, unknown>} */ (o.error).error;
  const deepType =
    nested && typeof nested === "object"
      ? /** @type {Record<string, unknown>} */ (nested).type
      : undefined;
  const midType =
    o.error && typeof o.error === "object"
      ? /** @type {Record<string, unknown>} */ (o.error).type
      : undefined;
  const t = deepType || midType || o.type;
  if (t === "overloaded_error" || t === "rate_limit_error") return true;
  const status = o.status;
  if (status === 429 || status === 503 || status === 529) return true;
  const msg = String(o.message || "");
  if (/overloaded|rate[_ ]limit|529|503|temporarily unavailable/i.test(msg)) {
    return true;
  }
  return false;
}

function anthropicRetryDelayMs(attemptIndex) {
  const exp = ANTHROPIC_RETRY_BASE_MS * 2 ** Math.max(0, attemptIndex - 1);
  const cap = 45_000;
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(cap, exp) + jitter;
}

/**
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {Parameters<import('@anthropic-ai/sdk').Anthropic['messages']['create']>[0]} params
 */
async function messagesCreateWithRetry(client, params) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ANTHROPIC_RETRIES; attempt += 1) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      if (!isRetriableAnthropicError(e) || attempt >= MAX_ANTHROPIC_RETRIES) {
        throw e;
      }
      const delay = anthropicRetryDelayMs(attempt);
      console.warn("[research] Anthropic messages.create retriable; retrying", {
        attempt,
        nextDelayMs: delay,
        error:
          e instanceof Error
            ? e.message
            : String(/** @type {object} */ (e)?.type || e),
      });
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Anthropic request failed after retries.");
}

/** Job-URL-only flow: attempt Firecrawl scrape before the pipeline (no pasted JD). */
async function maybeScrapeJobWithFirecrawl({ jobUrl, jobDescriptionText }) {
  const jd =
    typeof jobDescriptionText === "string" ? jobDescriptionText.trim() : "";
  if (jd.length > 0) return { markdown: null, error: null };
  const ju = typeof jobUrl === "string" ? jobUrl.trim() : "";
  if (!ju || !isFirecrawlConfigured()) return { markdown: null, error: null };

  const fc = await scrapeJobPostingUrl(ju);
  if (!fc.ok || !fc.markdown) {
    console.warn("[research] Firecrawl scrape failed", {
      error: fc.error,
    });
    return { markdown: null, error: fc.error || "unknown" };
  }

  console.log("[research] Firecrawl scrape ok", {
    markdownChars: fc.markdown.length,
    truncated: Boolean(fc.truncated),
  });
  return { markdown: fc.markdown, error: null };
}

function logPrimaryHost({ companyUrl, jobUrl }) {
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

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return {};
  const out = {
    input_tokens: usage.input_tokens ?? usage.inputTokens,
    output_tokens: usage.output_tokens ?? usage.outputTokens,
  };
  if (usage.server_tool_use?.web_search_requests != null) {
    out.web_search_requests = usage.server_tool_use.web_search_requests;
  }
  return out;
}

/** Running totals across Stage 1 + Stage 2 calls. */
function emptyTokenUsageTotals() {
  return { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
}

/**
 * @param {ReturnType<emptyTokenUsageTotals>} acc
 * @param {object | undefined} usage
 */
function accumulateUsage(acc, usage) {
  if (!usage || typeof usage !== "object") return;
  const inT = usage.input_tokens ?? usage.inputTokens;
  const outT = usage.output_tokens ?? usage.outputTokens;
  if (typeof inT === "number" && Number.isFinite(inT)) {
    acc.input_tokens += inT;
  }
  if (typeof outT === "number" && Number.isFinite(outT)) {
    acc.output_tokens += outT;
  }
  const w = usage.server_tool_use?.web_search_requests;
  if (typeof w === "number") {
    acc.web_search_requests += w;
  }
}

/** Stage 1 search index (1-4) → SSE phase name for client narration. */
const STAGE1_SEARCH_PHASES = [
  "research_news",
  "research_exec",
  "research_hiring",
  "research_extra",
];

class PipelineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Shared two-stage front half: scrape → identity → cache → Stage 1 → upsert.
 * Returns everything Stage 2 needs. Throws PipelineError on unrecoverable input problems.
 *
 * @param {object} opts
 * @param {import('@anthropic-ai/sdk').Anthropic} opts.client
 * @param {string} [opts.companyUrl]
 * @param {string} [opts.jobUrl]
 * @param {string} [opts.jobDescriptionText]
 * @param {(phase: string) => void} opts.emitPhase
 * @param {ReturnType<emptyTokenUsageTotals>} opts.tokenUsage mutated with Stage 1 usage
 * @returns {Promise<{ research: object, jdContent: string, companyName: string, domain: string, cacheHit: boolean }>}
 */
async function prepareResearch({
  client,
  companyUrl,
  jobUrl,
  jobDescriptionText,
  emitPhase,
  tokenUsage,
}) {
  const pastedJd =
    typeof jobDescriptionText === "string" ? jobDescriptionText.trim() : "";
  const hasJobUrl = Boolean(typeof jobUrl === "string" && jobUrl.trim());

  // 1) JD content: pasted text wins; else Firecrawl scrape of the job URL.
  let jdContent = pastedJd;
  if (!jdContent && hasJobUrl) {
    emitPhase("scraping_jd");
    const { markdown, error } = await maybeScrapeJobWithFirecrawl({
      jobUrl,
      jobDescriptionText,
    });
    if (markdown) {
      jdContent = markdown;
    } else {
      throw new PipelineError(
        "We couldn't read that job posting URL. Paste the job description text instead and try again.",
        "SCRAPE_FAILED",
      );
    }
  }

  // 2) Company identity (name + domain) — needed before the cache lookup
  //    because postings live on lever/greenhouse/linkedin domains.
  emitPhase("identifying_company");
  let companyName = "";
  let domain = "";
  if (jdContent) {
    const identity = await extractCompanyIdentity(client, {
      jdScrape: jdContent,
      jobUrl,
      companyUrl,
    });
    accumulateUsage(tokenUsage, identity.usage);
    companyName = identity.companyName;
    domain = identity.domain;
  }
  if (!domain && companyUrl) domain = normalizeDomain(companyUrl);
  if (!companyName && domain) companyName = domain.split(".")[0];

  const isoDate = new Date().toISOString().slice(0, 10);

  // 3) Cache lookup (10-day freshness) → Stage 1 on miss → upsert.
  const cached = domain ? await getFreshResearch(domain) : null;
  if (cached) {
    return {
      research: cached.research,
      jdContent,
      companyName: cached.companyName || companyName,
      domain,
      cacheHit: true,
    };
  }

  const stage1 = await runStage1(client, {
    companyName,
    domain,
    isoDate,
    jdScrapeExcerpt: jdContent,
    onSearch: (searchIndex) => {
      const phase =
        STAGE1_SEARCH_PHASES[
          Math.min(searchIndex, STAGE1_SEARCH_PHASES.length) - 1
        ];
      if (phase) emitPhase(phase);
    },
  });
  accumulateUsage(tokenUsage, stage1.usage);

  if (domain && !stage1.usedFallback) {
    await upsertResearch(domain, companyName, stage1.research);
  }

  return {
    research: stage1.research,
    jdContent,
    companyName,
    domain,
    cacheHit: false,
  };
}

/** Stage 2 system blocks: brief prompt with prompt caching. */
function stage2System() {
  return [
    {
      type: "text",
      text: BRIEF_PROMPT.replace("{{INTERVIEW_STAGE}}", INTERVIEW_STAGE),
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** Stage 2 user message per spec. */
function stage2UserMessage({ research, jdContent, resumeText }) {
  const resume =
    typeof resumeText === "string" && resumeText.trim()
      ? resumeText.trim()
      : "not provided";
  return `RESEARCH OBJECT:
${JSON.stringify(research, null, 2)}

JOB DESCRIPTION (scraped):
${jdContent || "not provided"}

RESUME:
${resume}`;
}

function logMessageStep(label, response) {
  const types = Array.isArray(response.content)
    ? response.content.map((b) => b.type).join(", ")
    : "(no content array)";
  console.log(`[research] ${label}`, {
    id: response.id,
    model: response.model,
    stop_reason: response.stop_reason,
    usage: summarizeUsage(response.usage),
    block_types: types,
  });
}

/**
 * Non-streaming two-stage brief generation (used by /api/research).
 *
 * @param {object} opts
 * @param {string} [opts.companyUrl] optional hint when user supplies it
 * @param {string} [opts.jobUrl]
 * @param {string} [opts.jobDescriptionText]
 * @param {string | null} [opts.resumeText] optional extracted resume plain text
 * @returns {Promise<{ markdown: string, tokenUsage: ReturnType<emptyTokenUsageTotals> }>}
 */
async function generateBrief({
  companyUrl,
  jobUrl,
  jobDescriptionText,
  resumeText = null,
}) {
  const t0 = Date.now();
  const companyHost = logPrimaryHost({ companyUrl, jobUrl });
  const hasResume =
    typeof resumeText === "string" && resumeText.trim().length > 0;

  console.log("[research] generateBrief start", {
    companyHost,
    hasJobUrl: Boolean(jobUrl),
    hasJobDescriptionText: Boolean(
      typeof jobDescriptionText === "string" && jobDescriptionText.trim(),
    ),
    hasResume,
    firecrawlConfigured: isFirecrawlConfigured(),
    model: MODEL,
    max_tokens: MAX_TOKENS,
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_key_here") {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const tokenUsage = emptyTokenUsageTotals();

  const prepared = await prepareResearch({
    client,
    companyUrl,
    jobUrl,
    jobDescriptionText,
    emitPhase: (phase) => console.log("[research] phase:", phase),
    tokenUsage,
  });

  console.log("[research] Stage 2 (create) …", {
    cacheHit: prepared.cacheHit,
    company: prepared.companyName,
    domain: prepared.domain,
  });

  const response = await messagesCreateWithRetry(client, {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: stage2System(),
    messages: [
      {
        role: "user",
        content: stage2UserMessage({
          research: prepared.research,
          jdContent: prepared.jdContent,
          resumeText,
        }),
      },
    ],
  });
  logMessageStep("stage2 response", response);
  accumulateUsage(tokenUsage, response.usage);

  const markdown = extractTextFromContent(response.content);
  if (!markdown) {
    const err = new Error("The model returned no text output.");
    err.code = "EMPTY_OUTPUT";
    throw err;
  }

  console.log("[research] generateBrief done", {
    markdownChars: markdown.length,
    elapsedMs: Date.now() - t0,
    tokenUsage,
  });

  return { markdown, tokenUsage };
}

function writeSse(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Stream a two-stage brief to the client as SSE (data: JSON lines).
 * Emits `phase` events for narration, then `text` deltas from Stage 2.
 * Caller must set SSE headers before calling. Does not call res.end().
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ companyUrl?: string, jobUrl?: string, jobDescriptionText?: string, resumeText?: string | null }} opts
 * @returns {Promise<{ ok: boolean, markdown?: string, errorCode?: string, errorMessage?: string, elapsedMs?: number, tokenUsage?: ReturnType<emptyTokenUsageTotals> }>}
 */
async function streamResearchBrief(req, res, {
  companyUrl,
  jobUrl,
  jobDescriptionText,
  resumeText = null,
}) {
  const t0 = Date.now();
  const companyHost = logPrimaryHost({ companyUrl, jobUrl });
  const hasResume =
    typeof resumeText === "string" && resumeText.trim().length > 0;

  console.log("[research] streamResearchBrief start", {
    companyHost,
    hasJobUrl: Boolean(jobUrl),
    hasJobDescriptionText: Boolean(
      typeof jobDescriptionText === "string" && jobDescriptionText.trim(),
    ),
    hasResume,
    resumeChars: hasResume ? resumeText.trim().length : 0,
    firecrawlConfigured: isFirecrawlConfigured(),
    model: MODEL,
    max_tokens: MAX_TOKENS,
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_key_here") {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const tokenUsageTotals = emptyTokenUsageTotals();

  /** @type {import('@anthropic-ai/sdk').MessageStream | null} */
  let activeStream = null;

  // Do NOT use req.on("close") — it can fire after the POST body ends while the
  // SSE response is still open (keep-alive / proxies), which aborts the model stream
  // with APIUserAbortError. Only abort when the *response* closes before we finished it.
  const onResponseClose = () => {
    if (res.writableEnded) return;
    if (activeStream) {
      try {
        activeStream.abort();
      } catch {
        /* ignore */
      }
    }
  };
  res.once("close", onResponseClose);

  try {
    // ── Front half: scrape → identity → cache/Stage 1 ──
    let prepared;
    try {
      prepared = await prepareResearch({
        client,
        companyUrl,
        jobUrl,
        jobDescriptionText,
        emitPhase: (phase) => writeSse(res, { type: "phase", phase }),
        tokenUsage: tokenUsageTotals,
      });
    } catch (prepErr) {
      const code =
        prepErr instanceof PipelineError ? prepErr.code : "RESEARCH_FAILED";
      const msg =
        prepErr instanceof Error
          ? prepErr.message
          : "Company research failed before the brief could be written.";
      console.error("[research] pipeline front half failed", prepErr);
      writeSse(res, { type: "error", code, message: msg });
      return {
        ok: false,
        errorCode: code,
        errorMessage: msg,
        elapsedMs: Date.now() - t0,
        tokenUsage: tokenUsageTotals,
      };
    }

    console.log("[research] Stage 2 (stream) …", {
      cacheHit: prepared.cacheHit,
      company: prepared.companyName,
      domain: prepared.domain,
    });
    writeSse(res, { type: "phase", phase: "generating_brief" });

    const stage2Messages = [
      {
        role: "user",
        content: stage2UserMessage({
          research: prepared.research,
          jdContent: prepared.jdContent,
          resumeText,
        }),
      },
    ];

    // ── Stage 2: Sonnet stream, no tools ──
    let final = null;
    let streamAttempt = 0;

    while (streamAttempt < MAX_ANTHROPIC_RETRIES) {
      streamAttempt += 1;
      let emittedTextThisAttempt = false;

      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: stage2System(),
        messages: stage2Messages,
      });
      activeStream = stream;

      stream.on("text", (delta) => {
        if (delta) {
          emittedTextThisAttempt = true;
          writeSse(res, { type: "text", text: delta });
        }
      });

      try {
        final = await stream.finalMessage();
        activeStream = null;
        break;
      } catch (streamErr) {
        activeStream = null;
        try {
          stream.abort();
        } catch {
          /* ignore */
        }

        const canRetry =
          isRetriableAnthropicError(streamErr) &&
          !emittedTextThisAttempt &&
          streamAttempt < MAX_ANTHROPIC_RETRIES;

        if (canRetry) {
          const delay = anthropicRetryDelayMs(streamAttempt);
          console.warn(
            "[research] Anthropic stream retriable error; retrying segment",
            {
              streamAttempt,
              maxAttempts: MAX_ANTHROPIC_RETRIES,
              delayMs: delay,
              error:
                streamErr instanceof Error
                  ? streamErr.message
                  : String(streamErr),
            },
          );
          writeSse(res, { type: "phase", phase: "model_retry" });
          await sleep(delay);
          continue;
        }

        console.error("[research] stream segment failed", streamErr);
        const msg =
          streamErr instanceof Error
            ? streamErr.message
            : "Stream failed before completion.";
        if (/stream ended|without producing|prematurely/i.test(msg)) {
          console.error(
            "[research] Incomplete SSE often means the host cut the connection (e.g. Vercel maxDuration) or the API closed early.",
          );
        }
        writeSse(res, { type: "error", message: msg });
        return {
          ok: false,
          errorMessage: msg,
          elapsedMs: Date.now() - t0,
          tokenUsage: tokenUsageTotals,
        };
      }
    }

    if (!final) {
      const fallback =
        "The AI service is busy. Please try again in a few seconds.";
      console.error("[research] stream segment exhausted retries");
      writeSse(res, { type: "error", message: fallback });
      return {
        ok: false,
        errorMessage: fallback,
        elapsedMs: Date.now() - t0,
        tokenUsage: tokenUsageTotals,
      };
    }

    logMessageStep("stage2 stream response", final);
    accumulateUsage(tokenUsageTotals, final.usage);

    // Light guard: Stage 2 has no tools, so pause_turn should never happen.
    if (final.stop_reason === "pause_turn") {
      console.error("[research] unexpected pause_turn on tool-less Stage 2");
    }

    const markdown = extractTextFromContent(final.content);
    if (!markdown) {
      writeSse(res, {
        type: "error",
        code: "EMPTY_OUTPUT",
        message: "The model returned no text for the brief.",
      });
      return {
        ok: false,
        errorCode: "EMPTY_OUTPUT",
        errorMessage: "The model returned no text for the brief.",
        elapsedMs: Date.now() - t0,
        tokenUsage: tokenUsageTotals,
      };
    }

    writeSse(res, {
      type: "done",
      elapsedMs: Date.now() - t0,
    });
    console.log("[research] streamResearchBrief done", {
      markdownChars: markdown.length,
      elapsedMs: Date.now() - t0,
      cacheHit: prepared.cacheHit,
      stop_reason: final.stop_reason,
      tokenUsage: tokenUsageTotals,
    });
    return {
      ok: true,
      markdown,
      elapsedMs: Date.now() - t0,
      tokenUsage: tokenUsageTotals,
    };
  } finally {
    activeStream = null;
    res.off("close", onResponseClose);
  }
}

module.exports = { generateBrief, streamResearchBrief, MODEL };
