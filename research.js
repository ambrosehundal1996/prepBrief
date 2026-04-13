const { Anthropic } = require("@anthropic-ai/sdk");
const { RESEARCH_SYSTEM_PROMPT } = require("./researchPrompt");
const {
  scrapeJobPostingUrl,
  isFirecrawlConfigured,
} = require("./firecrawlScrape");

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 4000;
const MAX_PAUSE_CONTINUATIONS = 10;
const LOG_PREVIEW_CHARS = 2500;

const WEB_SEARCH_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 10,
  },
];

/** Retries per API call (streaming segment or messages.create turn). */
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
          e instanceof Error            ? e.message
            : String(/** @type {object} */ (e)?.type || e),
      });
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Anthropic request failed after retries.");
}

function buildUserMessage({
  companyUrl,
  jobUrl,
  jobDescriptionText,
} = {}) {
  const jdText =
    typeof jobDescriptionText === "string" ? jobDescriptionText.trim() : "";
  const hasPastedJd = jdText.length > 0;
  const jobUrlTrimmed =
    typeof jobUrl === "string" ? jobUrl.trim() : "";
  const hasJobUrl = jobUrlTrimmed.length > 0;
  const companyTrimmed =
    typeof companyUrl === "string" ? companyUrl.trim() : "";
  const hasCompany = companyTrimmed.length > 0;

  let text = `[SOURCE: web_research]

Research the company for an interview candidate using web search.

`;

  if (hasJobUrl && !hasPastedJd) {
    text += `The candidate provided a **job posting URL only** (no separate company website field is required):
${jobUrlTrimmed}

Workflow:
1. Use web search to open and read this job posting in full.
2. Identify the **employer** (company name) and any links in the posting to the company website, product, careers, or "About" pages.
3. Use web search to research **that employer** for the brief — start from the official site when you find it, then other reputable sources.
4. If the employer is unclear or the posting is for a third-party recruiter, say so briefly and infer the hiring company only when reasonable.

Always include the "## Interview Positioning" section — you have the job posting from the URL above.
`;
    if (hasCompany) {
      text += `
Optional: the user also supplied this company website — verify it matches the employer before treating it as authoritative:
${companyTrimmed}
`;
    }
  } else if (hasPastedJd) {
    text += `The candidate **pasted** the job description below (there is no job posting URL). Use this text only for the role details — do not assume a URL exists.

--- Job description (pasted) ---
${jdText}
--- End job description ---

Identify the employer from the text, then use web search to research that company. Include "## Interview Positioning" using the pasted JD.
`;
    if (hasCompany) {
      text += `
Optional company website from user (verify against employer): ${companyTrimmed}
`;
    }
  } else if (hasCompany) {
    text += `Company website (primary anchor):
${companyTrimmed}

No job posting URL or pasted JD was provided — omit the "## Interview Positioning" section entirely.
`;
  }

  text += `
Use web search when helpful to verify facts that change over time. Prefer primary and reputable sources. If something cannot be verified, say so briefly instead of guessing.

Output only the markdown brief (no preamble). Follow the exact section headers and structure from your system instructions.`;

  return text;
}

/**
 * Append extracted resume text to the user message when present.
 * @param {string} userContent
 * @param {string | null | undefined} resumeText
 */
function appendResumeToPrompt(userContent, resumeText) {
  const base =
    typeof userContent === "string" ? userContent.trimEnd() : "";
  const r =
    typeof resumeText === "string" ? resumeText.trim() : "";
  if (!r) return base;
  return `${base}

The user also provided their **resume** as extracted text below. Cross-reference it with the job description or posting for JD-specific sections. Use only facts stated in the resume; do not invent employers, titles, dates, or metrics.

--- Candidate resume (extracted text) ---
${r}
--- End resume ---`;
}

function compactPreview(text, max = LOG_PREVIEW_CHARS) {
  if (typeof text !== "string" || !text.trim()) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)} …[truncated ${compact.length - max} chars]`;
}

/**
 * User message when the job posting body was scraped (Firecrawl) — model must not use web search.
 */
function buildUserMessageSingleSource({
  companyUrl,
  jobUrl,
  jobMarkdown,
} = {}) {
  const jobUrlTrimmed =
    typeof jobUrl === "string" ? jobUrl.trim() : "";
  const md =
    typeof jobMarkdown === "string" ? jobMarkdown.trim() : "";
  const companyTrimmed =
    typeof companyUrl === "string" ? companyUrl.trim() : "";
  const hasCompany = companyTrimmed.length > 0;

  let text = `[SOURCE: job_markdown]

Below is the **full job posting** scraped as markdown from this URL (your only source — do not use web search):
${jobUrlTrimmed}

`;

  if (hasCompany) {
    text += `Optional company website from the user (verify against the posting; you cannot browse it):
${companyTrimmed}

`;
  }

  text += `--- Job posting (markdown) ---
${md}
--- End job posting ---

Output only the markdown brief (no preamble). Follow the exact section headers and structure from your system instructions.`;

  return text;
}

/** Job-URL-only flow: attempt Firecrawl scrape before Claude (no pasted JD). */
async function maybeScrapeJobWithFirecrawl({ jobUrl, jobDescriptionText }) {
  const jd =
    typeof jobDescriptionText === "string" ? jobDescriptionText.trim() : "";
  if (jd.length > 0) return { markdown: null, error: null };
  const ju = typeof jobUrl === "string" ? jobUrl.trim() : "";
  if (!ju || !isFirecrawlConfigured()) return { markdown: null, error: null };

  const fc = await scrapeJobPostingUrl(ju);
  if (!fc.ok || !fc.markdown) {
    console.warn("[research] Firecrawl scrape failed — falling back to web search", {
      error: fc.error,
    });
    return { markdown: null, error: fc.error || "unknown" };
  }

  console.log("[research] Firecrawl single-source path", {
    markdownChars: fc.markdown.length,
    truncated: Boolean(fc.truncated),
  });
  console.log(
    "[research] Firecrawl markdown preview:",
    compactPreview(fc.markdown),
  );
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
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  };
  if (usage.server_tool_use?.web_search_requests != null) {
    out.web_search_requests = usage.server_tool_use.web_search_requests;
  }
  return out;
}

/** Running totals across multi-turn / streaming segments. */
function emptyTokenUsageTotals() {
  return { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
}

/**
 * @param {ReturnType<emptyTokenUsageTotals>} acc
 * @param {object | undefined} usage
 */
function accumulateUsage(acc, usage) {
  if (!usage || typeof usage !== "object") return;
  if (typeof usage.input_tokens === "number") {
    acc.input_tokens += usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    acc.output_tokens += usage.output_tokens;
  }
  const w = usage.server_tool_use?.web_search_requests;
  if (typeof w === "number") {
    acc.web_search_requests += w;
  }
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

  if (!Array.isArray(response.content)) return;

  for (let i = 0; i < response.content.length; i += 1) {
    const block = response.content[i];
    if (block.type === "text" && typeof block.text === "string") {
      const preview = block.text.slice(0, 100).replace(/\s+/g, " ");
      console.log(
        `[research]   block[${i}] text (${block.text.length} chars): ${preview}${
          block.text.length > 100 ? "…" : ""
        }`,
      );
    } else if (block.type === "server_tool_use") {
      console.log(`[research]   block[${i}] server_tool_use`, {
        name: block.name,
        input: block.input,
      });
    } else if (block.type === "web_search_tool_result") {
      const c = block.content;
      const isErr =
        c && typeof c === "object" && c.type === "web_search_tool_result_error";
      console.log(`[research]   block[${i}] web_search_tool_result`, {
        tool_use_id: block.tool_use_id,
        error: isErr ? c.error_code : undefined,
        result_items: Array.isArray(c)
          ? c.length
          : c && !isErr
            ? "object"
            : 0,
      });
    } else {
      console.log(`[research]   block[${i}]`, block.type);
    }
  }
}

/**
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
    hasOptionalCompanyUrl: Boolean(
      typeof companyUrl === "string" && companyUrl.trim(),
    ),
    hasJobUrl: Boolean(jobUrl),
    hasJobDescriptionText: Boolean(
      typeof jobDescriptionText === "string" && jobDescriptionText.trim(),
    ),
    hasResume,
    resumeChars: hasResume ? resumeText.trim().length : 0,
    firecrawlConfigured: isFirecrawlConfigured(),
    model: MODEL,
    max_tokens: MAX_TOKENS,
    web_search_max_uses: WEB_SEARCH_TOOLS[0]?.max_uses,
    max_pause_continuations: MAX_PAUSE_CONTINUATIONS,
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_key_here") {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const { markdown: firecrawlMarkdown } = await maybeScrapeJobWithFirecrawl({
    jobUrl,
    jobDescriptionText,
  });
  const useSingleSource = Boolean(firecrawlMarkdown);
  let userContent = useSingleSource
    ? buildUserMessageSingleSource({
        companyUrl,
        jobUrl,
        jobMarkdown: firecrawlMarkdown,
      })
    : buildUserMessage({
        companyUrl,
        jobUrl,
        jobDescriptionText,
      });
  userContent = appendResumeToPrompt(userContent, resumeText);

  console.log("[research] prompt mode", {
    mode: useSingleSource ? "single_source_firecrawl" : "web_search",
    userContentChars: userContent.length,
  });
  console.log("[research] user prompt preview:", compactPreview(userContent));

  const baseParams = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: RESEARCH_SYSTEM_PROMPT,
    ...(useSingleSource ? {} : { tools: WEB_SEARCH_TOOLS }),
  };

  const messages = [{ role: "user", content: userContent }];

  console.log("[research] messages.create (initial turn) …");
  let response = await messagesCreateWithRetry(client, {
    ...baseParams,
    messages,
  });
  logMessageStep("initial response", response);

  const tokenUsage = emptyTokenUsageTotals();
  accumulateUsage(tokenUsage, response.usage);

  let continuations = 0;
  while (
    response.stop_reason === "pause_turn" &&
    continuations < MAX_PAUSE_CONTINUATIONS
  ) {
    continuations += 1;
    console.log(
      `[research] stop_reason=pause_turn → continuation ${continuations}/${MAX_PAUSE_CONTINUATIONS} (appending assistant content, calling messages.create again) …`,
    );
    messages.push({ role: "assistant", content: response.content });
    response = await messagesCreateWithRetry(client, {
      ...baseParams,
      messages,
    });
    logMessageStep(`continuation #${continuations} response`, response);
    accumulateUsage(tokenUsage, response.usage);
  }

  if (response.stop_reason === "pause_turn") {
    console.error(
      "[research] still pause_turn after max continuations — failing",
    );
    const err = new Error(
      "Research paused without completing; try again or increase limits.",
    );
    err.code = "PAUSE_TURN_LIMIT";
    throw err;
  }

  console.log("[research] final stop_reason:", response.stop_reason);

  const markdown = extractTextFromContent(response.content);
  if (!markdown) {
    console.error("[research] no text blocks in final content");
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

function cloneMessagesForApi(messages) {
  return JSON.parse(JSON.stringify(messages));
}

/**
 * Stream markdown deltas to the client as SSE (data: JSON lines).
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
    hasOptionalCompanyUrl: Boolean(
      typeof companyUrl === "string" && companyUrl.trim(),
    ),
    hasJobUrl: Boolean(jobUrl),
    hasJobDescriptionText: Boolean(
      typeof jobDescriptionText === "string" && jobDescriptionText.trim(),
    ),
    hasResume,
    resumeChars: hasResume ? resumeText.trim().length : 0,
    firecrawlConfigured: isFirecrawlConfigured(),
    model: MODEL,
    max_tokens: MAX_TOKENS,
    web_search_max_uses: WEB_SEARCH_TOOLS[0]?.max_uses,
    max_pause_continuations: MAX_PAUSE_CONTINUATIONS,
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "your_key_here") {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const client = new Anthropic({ apiKey });
  const { markdown: firecrawlMarkdown } = await maybeScrapeJobWithFirecrawl({
    jobUrl,
    jobDescriptionText,
  });
  const useSingleSource = Boolean(firecrawlMarkdown);
  let userContent = useSingleSource
    ? buildUserMessageSingleSource({
        companyUrl,
        jobUrl,
        jobMarkdown: firecrawlMarkdown,
      })
    : buildUserMessage({
        companyUrl,
        jobUrl,
        jobDescriptionText,
      });
  userContent = appendResumeToPrompt(userContent, resumeText);

  console.log("[research] stream prompt mode", {
    mode: useSingleSource ? "single_source_firecrawl" : "web_search",
    userContentChars: userContent.length,
  });
  console.log(
    "[research] stream user prompt preview:",
    compactPreview(userContent),
  );

  const baseParams = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: RESEARCH_SYSTEM_PROMPT,
    ...(useSingleSource ? {} : { tools: WEB_SEARCH_TOOLS }),
  };

  let messages = [{ role: "user", content: userContent }];
  let continuations = 0;
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

  const tokenUsageTotals = emptyTokenUsageTotals();

  try {
    while (true) {
      let final;
      /** @type {import('@anthropic-ai/sdk').MessageStream | null} */
      let stream = null;
      let streamAttempt = 0;

      while (streamAttempt < MAX_ANTHROPIC_RETRIES) {
        streamAttempt += 1;
        let emittedTextThisAttempt = false;

        stream = client.messages.stream({
          ...baseParams,
          messages,
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
          writeSse(res, {
            type: "error",
            message: msg,
          });
          return {
            ok: false,
            errorMessage: msg,
            elapsedMs: Date.now() - t0,
            tokenUsage: tokenUsageTotals,
          };
        }
      }

      if (!final || !stream) {
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

      logMessageStep(
        continuations === 0 ? "stream initial response" : `stream continuation #${continuations}`,
        final,
      );

      accumulateUsage(tokenUsageTotals, final.usage);

      if (final.stop_reason !== "pause_turn") {
        const markdown = extractTextFromContent(final.content);
        if (!markdown) {
          writeSse(res, {
            type: "error",
            code: "EMPTY_OUTPUT",
            message: "The model returned no text for the brief.",
          });
          console.log("[research] streamResearchBrief done", {
            markdownChars: 0,
            elapsedMs: Date.now() - t0,
            stop_reason: final.stop_reason,
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
          stop_reason: final.stop_reason,
          tokenUsage: tokenUsageTotals,
        });
        return {
          ok: true,
          markdown,
          elapsedMs: Date.now() - t0,
          tokenUsage: tokenUsageTotals,
        };
      }

      if (continuations >= MAX_PAUSE_CONTINUATIONS) {
        console.error("[research] stream hit pause_turn limit");
        writeSse(res, {
          type: "error",
          code: "PAUSE_TURN_LIMIT",
          message:
            "Research paused too many times. Try again or raise MAX_PAUSE_CONTINUATIONS.",
        });
        return {
          ok: false,
          errorCode: "PAUSE_TURN_LIMIT",
          errorMessage:
            "Research paused too many times. Try again or raise MAX_PAUSE_CONTINUATIONS.",
          elapsedMs: Date.now() - t0,
          tokenUsage: tokenUsageTotals,
        };
      }

      continuations += 1;
      writeSse(res, { type: "phase", phase: "pause_turn_continuation" });
      messages = cloneMessagesForApi(stream.messages);
      console.log(
        `[research] stream pause_turn → continuation ${continuations}/${MAX_PAUSE_CONTINUATIONS}`,
      );
    }
  } finally {
    activeStream = null;
    res.off("close", onResponseClose);
  }
}

module.exports = { generateBrief, streamResearchBrief, MODEL };
