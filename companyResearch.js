/**
 * Stage 1 of the two-stage pipeline: company identity extraction and the
 * Haiku-powered research object generator (web search, max 4 uses).
 */

const { RESEARCH_OBJECT_PROMPT } = require("./prompts");

const STAGE1_MODEL =
  (typeof process.env.STAGE1_MODEL === "string" &&
    process.env.STAGE1_MODEL.trim()) ||
  "claude-haiku-4-5-20251001";

const STAGE1_MAX_TOKENS = 2500;
const STAGE1_WEB_SEARCH_MAX_USES = 4;
/** JD excerpt char budgets — identity extraction needs less than research context. */
const IDENTITY_JD_EXCERPT_CHARS = 6000;
const STAGE1_JD_EXCERPT_CHARS = 4000;

function excerpt(text, maxChars) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n…[truncated]`;
}

/**
 * Repair JSON cut off mid-output (max_tokens): drop the incomplete trailing
 * value, then close every still-open brace/bracket. Returns null if hopeless.
 */
function repairTruncatedJson(t) {
  let inStr = false;
  let esc = false;
  let lastCloseIdx = -1;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "}" || c === "]") lastCloseIdx = i;
  }
  if (lastCloseIdx < 0) return null;

  let s = t.slice(0, lastCloseIdx + 1);
  inStr = false;
  esc = false;
  const stack = [];
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  while (stack.length) {
    s += stack.pop() === "{" ? "}" : "]";
  }
  try {
    const parsed = JSON.parse(s);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Strip ```json fences and surrounding prose, then parse. Throws on failure. */
function parseJsonObject(rawText) {
  let t = typeof rawText === "string" ? rawText.trim() : "";
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  // Some models wrap JSON in prose — grab the outermost braces as a fallback.
  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(t);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Parsed JSON is not an object.");
    }
    return parsed;
  } catch (err) {
    const repaired = repairTruncatedJson(t);
    if (repaired) {
      console.warn("[stage1] JSON was truncated — repaired by closing brackets");
      return repaired;
    }
    throw err;
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function usageTotalsFrom(usage, acc) {
  if (!usage || typeof usage !== "object") return;
  const inT = usage.input_tokens ?? usage.inputTokens;
  const outT = usage.output_tokens ?? usage.outputTokens;
  if (typeof inT === "number" && Number.isFinite(inT)) acc.input_tokens += inT;
  if (typeof outT === "number" && Number.isFinite(outT)) {
    acc.output_tokens += outT;
  }
  const w = usage.server_tool_use?.web_search_requests;
  if (typeof w === "number") acc.web_search_requests += w;
}

/**
 * Normalize a domain-ish string to a bare lowercase hostname ("stripe.com").
 * @param {string} raw
 */
function normalizeDomain(raw) {
  let d = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!d) return "";
  try {
    if (/^https?:\/\//.test(d)) d = new URL(d).hostname;
  } catch {
    /* keep raw */
  }
  d = d.replace(/^www\./, "").replace(/\/.*$/, "");
  // Reject values that clearly aren't hostnames.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return "";
  return d;
}

/**
 * Small Haiku call (no tools): extract the employer's name and primary domain
 * from the scraped JD. Needed before cache lookup — postings live on
 * lever.co / greenhouse.io / linkedin.com domains, not the employer's.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {{ jdScrape: string, jobUrl?: string, companyUrl?: string }} opts
 * @returns {Promise<{ companyName: string, domain: string, usage: { input_tokens: number, output_tokens: number, web_search_requests: number } }>}
 */
async function extractCompanyIdentity(client, { jdScrape, jobUrl, companyUrl }) {
  const usage = { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };

  const userParts = [
    "Below is a scraped job posting. Identify the EMPLOYER (the company hiring, not the job board or recruiting platform).",
    "",
    `Job posting URL: ${jobUrl || "(not provided)"}`,
  ];
  if (companyUrl) {
    userParts.push(
      `Company website supplied by the candidate (verify it matches the employer): ${companyUrl}`,
    );
  }
  userParts.push(
    "",
    "--- Job posting content ---",
    excerpt(jdScrape, IDENTITY_JD_EXCERPT_CHARS),
    "--- End job posting ---",
    "",
    'Return ONLY a JSON object: {"company_name": "<official company name>", "domain": "<primary company website domain, e.g. stripe.com, empty string if unknown>"}',
    "The domain must be the employer's own website — never lever.co, greenhouse.io, ashbyhq.com, linkedin.com, indeed.com, or another job platform.",
  );

  const response = await client.messages.create({
    model: STAGE1_MODEL,
    max_tokens: 300,
    system:
      "You extract the hiring company's identity from job postings. You respond with a single JSON object and nothing else.",
    messages: [{ role: "user", content: userParts.join("\n") }],
  });
  usageTotalsFrom(response.usage, usage);

  let companyName = "";
  let domain = "";
  try {
    const parsed = parseJsonObject(textFromContent(response.content));
    if (typeof parsed.company_name === "string") {
      companyName = parsed.company_name.trim();
    }
    domain = normalizeDomain(parsed.domain);
  } catch (e) {
    console.warn(
      "[stage1] identity extraction parse failed",
      e instanceof Error ? e.message : String(e),
    );
  }

  // User-supplied company URL beats a missing/failed extraction.
  if (!domain && companyUrl) domain = normalizeDomain(companyUrl);

  console.log("[stage1] identity", { companyName, domain });
  return { companyName, domain, usage };
}

/** Deterministic fallback research object when Stage 1 output can't be parsed. */
function buildFallbackResearchObject({ companyName, domain, isoDate, jdScrapeExcerpt }) {
  return {
    company: companyName || domain || "",
    domain: domain || "",
    researched_at: isoDate,
    summary: {
      what_they_do: jdScrapeExcerpt
        ? "See job description content — structured research unavailable for this run."
        : "",
      problem_before_them: "",
      main_offerings: [],
    },
    big_bet: { claim: "", evidence: [] },
    recent_news: [],
    exec_statements: [],
    hiring_signals: [],
    risky_signals: [],
    coverage: { strong: [], weak: ["all"] },
  };
}

/** Light schema validation: required keys exist with roughly the right shapes. */
function validateResearchObject(obj) {
  if (obj == null || typeof obj !== "object") return false;
  if (typeof obj.company !== "string") return false;
  if (obj.summary == null || typeof obj.summary !== "object") return false;
  const arrays = [
    "recent_news",
    "exec_statements",
    "hiring_signals",
    "risky_signals",
  ];
  for (const key of arrays) {
    if (obj[key] != null && !Array.isArray(obj[key])) return false;
    if (obj[key] == null) obj[key] = [];
  }
  if (obj.coverage == null || typeof obj.coverage !== "object") {
    obj.coverage = { strong: [], weak: [] };
  }
  if (!Array.isArray(obj.coverage.strong)) obj.coverage.strong = [];
  if (!Array.isArray(obj.coverage.weak)) obj.coverage.weak = [];
  if (obj.big_bet == null || typeof obj.big_bet !== "object") {
    obj.big_bet = { claim: "", evidence: [] };
  }
  return true;
}

function stage1UserMessage({ companyName, domain, isoDate, jdScrapeExcerpt }) {
  return [
    `Company name: ${companyName || "(unknown — use the domain)"}`,
    `Company domain: ${domain || "(unknown)"}`,
    `Today's date: ${isoDate}`,
    "",
    "--- Job posting content (context for the summary only) ---",
    jdScrapeExcerpt || "(not available)",
    "--- End job posting content ---",
    "",
    "Research this company now and return the JSON research object.",
  ].join("\n");
}

/**
 * Run the Stage 1 research call (Haiku + web_search, max 4 uses).
 * Streams so `onSearch` can narrate each web search as it starts.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {object} opts
 * @param {string} opts.companyName
 * @param {string} opts.domain
 * @param {string} opts.isoDate e.g. "2026-07-13"
 * @param {string} opts.jdScrapeExcerpt
 * @param {(searchIndex: number, query?: string) => void} [opts.onSearch] called per web search (1-based)
 * @returns {Promise<{ research: object, usedFallback: boolean, usage: { input_tokens: number, output_tokens: number, web_search_requests: number } }>}
 */
async function runStage1(
  client,
  { companyName, domain, isoDate, jdScrapeExcerpt, onSearch },
) {
  const usage = { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
  const jd = excerpt(jdScrapeExcerpt, STAGE1_JD_EXCERPT_CHARS);
  const baseUser = stage1UserMessage({
    companyName,
    domain,
    isoDate,
    jdScrapeExcerpt: jd,
  });

  console.log("[stage1] runStage1 start", {
    companyName,
    domain,
    model: STAGE1_MODEL,
    max_tokens: STAGE1_MAX_TOKENS,
    web_search_max_uses: STAGE1_WEB_SEARCH_MAX_USES,
  });

  /**
   * @param {string} userContent
   * @returns {Promise<string>} final text output
   */
  async function runOnce(userContent) {
    let searchCount = 0;
    const stream = client.messages.stream({
      model: STAGE1_MODEL,
      max_tokens: STAGE1_MAX_TOKENS,
      system: RESEARCH_OBJECT_PROMPT,
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          max_uses: STAGE1_WEB_SEARCH_MAX_USES,
          // Haiku doesn't support programmatic tool calling; searches are model-issued.
          allowed_callers: ["direct"],
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") {
        searchCount += 1;
        const query =
          block.input && typeof block.input.query === "string"
            ? block.input.query
            : undefined;
        console.log("[stage1] web search", { searchCount, query });
        if (typeof onSearch === "function") {
          try {
            onSearch(searchCount, query);
          } catch {
            /* narration must never break research */
          }
        }
      }
    });

    const final = await stream.finalMessage();
    usageTotalsFrom(final.usage, usage);
    // Some tool versions report 0 in usage.server_tool_use — fall back to the
    // server_tool_use blocks we observed so cost logging stays accurate.
    const reported = final.usage?.server_tool_use?.web_search_requests;
    if ((typeof reported !== "number" || reported === 0) && searchCount > 0) {
      usage.web_search_requests += searchCount;
    }
    console.log("[stage1] segment done", {
      stop_reason: final.stop_reason,
      searches: searchCount,
    });
    return textFromContent(final.content);
  }

  let text = await runOnce(baseUser);
  try {
    const parsed = parseJsonObject(text);
    if (validateResearchObject(parsed)) {
      return { research: parsed, usedFallback: false, usage };
    }
    throw new Error("Research object failed schema validation.");
  } catch (firstErr) {
    console.warn(
      "[stage1] first parse failed — retrying with strict JSON instruction",
      firstErr instanceof Error ? firstErr.message : String(firstErr),
    );
  }

  try {
    text = await runOnce(
      `${baseUser}\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no prose, no explanation — just the JSON object.`,
    );
    const parsed = parseJsonObject(text);
    if (validateResearchObject(parsed)) {
      return { research: parsed, usedFallback: false, usage };
    }
    throw new Error("Research object failed schema validation on retry.");
  } catch (secondErr) {
    console.error(
      "[stage1] retry parse failed — using minimal fallback object",
      secondErr instanceof Error ? secondErr.message : String(secondErr),
    );
  }

  return {
    research: buildFallbackResearchObject({
      companyName,
      domain,
      isoDate,
      jdScrapeExcerpt: jd,
    }),
    usedFallback: true,
    usage,
  };
}

module.exports = {
  extractCompanyIdentity,
  runStage1,
  normalizeDomain,
  STAGE1_MODEL,
};
