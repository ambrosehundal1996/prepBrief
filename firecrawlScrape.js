const { Firecrawl } = require("@mendable/firecrawl-js");

const DEFAULT_MAX_MARKDOWN_CHARS = 100_000;

/**
 * @param {string} url
 * @param {{ maxMarkdownChars?: number }} [options]
 * @returns {Promise<{ ok: boolean, markdown: string, truncated?: boolean, error?: string, metadata?: object }>}
 */
async function scrapeJobPostingUrl(url, options = {}) {
  const maxChars = options.maxMarkdownChars ?? DEFAULT_MAX_MARKDOWN_CHARS;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || String(apiKey).trim() === "") {
    return { ok: false, error: "FIRECRAWL_API_KEY is not set", markdown: "" };
  }

  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) {
    return { ok: false, error: "URL is empty", markdown: "" };
  }

  try {
    const client = new Firecrawl({ apiKey: String(apiKey).trim() });
    const doc = await client.scrape(trimmed, {
      formats: ["markdown"],
      onlyMainContent: true,
    });

    let markdown =
      doc && typeof doc.markdown === "string" ? doc.markdown.trim() : "";
    if (!markdown && doc?.summary && typeof doc.summary === "string") {
      markdown = doc.summary.trim();
    }

    let truncated = false;
    if (markdown.length > maxChars) {
      markdown =
        `${markdown.slice(0, maxChars)}\n\n[… truncated for context limit …]`;
      truncated = true;
    }

    if (!markdown) {
      return {
        ok: false,
        error: "Firecrawl returned no markdown",
        markdown: "",
        metadata: doc?.metadata,
      };
    }

    return {
      ok: true,
      markdown,
      truncated,
      metadata: doc?.metadata,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[firecrawl] scrape failed", message);
    return { ok: false, error: message, markdown: "" };
  }
}

function isFirecrawlConfigured() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || typeof key !== "string") return false;
  const t = key.trim();
  if (!t || t === "your_firecrawl_key_here") return false;
  return true;
}

module.exports = {
  scrapeJobPostingUrl,
  DEFAULT_MAX_MARKDOWN_CHARS,
  isFirecrawlConfigured,
};
