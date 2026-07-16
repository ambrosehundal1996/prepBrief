/**
 * Admin-only brief generation logs (user testing / visibility).
 * Written via service role — no client access.
 */

const { getSupabaseAdmin, isSupabaseAdminConfigured } = require("./supabaseAdmin");

const BRIEF_LOGS_TABLE = "prepbrief_brief_logs";
const MAX_MARKDOWN_CHARS = 100_000;
const MAX_FEEDBACK_CHARS = 2_000;

function trimMarkdown(markdown) {
  const md = String(markdown || "");
  if (md.length <= MAX_MARKDOWN_CHARS) return md;
  return `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[… truncated for storage …]`;
}

function trimFeedback(feedback) {
  if (feedback == null) return null;
  const text = String(feedback).trim();
  if (!text) return null;
  if (text.length <= MAX_FEEDBACK_CHARS) return text;
  return `${text.slice(0, MAX_FEEDBACK_CHARS)}…`;
}

function tokenCounts(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object") {
    return { inputTokens: null, outputTokens: null };
  }
  const input =
    tokenUsage.input_tokens ?? tokenUsage.inputTokens ?? null;
  const output =
    tokenUsage.output_tokens ?? tokenUsage.outputTokens ?? null;
  return {
    inputTokens: typeof input === "number" ? input : null,
    outputTokens: typeof output === "number" ? output : null,
  };
}

/**
 * @param {{
 *   requestId?: string,
 *   endpoint: string,
 *   userId?: string | null,
 *   userEmail?: string | null,
 *   plan?: string | null,
 *   jobUrl?: string,
 *   companyUrl?: string,
 *   markdown: string,
 *   elapsedMs?: number,
 *   tokenUsage?: object,
 *   resumeAttached?: boolean,
 * }} entry
 * @returns {Promise<string | null>} log row id
 */
async function logBriefGeneration(entry) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !isSupabaseAdminConfigured()) return null;

  const md = trimMarkdown(entry.markdown);
  if (!md.trim()) return null;

  const { inputTokens, outputTokens } = tokenCounts(entry.tokenUsage);

  const { data, error } = await supabase
    .from(BRIEF_LOGS_TABLE)
    .insert({
      request_id: entry.requestId || null,
      user_id: entry.userId || null,
      user_email: entry.userEmail || null,
      plan: entry.plan || null,
      endpoint: entry.endpoint,
      job_url: String(entry.jobUrl || "").trim(),
      company_url: String(entry.companyUrl || "").trim() || null,
      markdown: md,
      elapsed_ms:
        typeof entry.elapsedMs === "number" && Number.isFinite(entry.elapsedMs)
          ? Math.round(entry.elapsedMs)
          : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      resume_attached: Boolean(entry.resumeAttached),
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[brief-logs] insert failed", error.message);
    return null;
  }

  return data?.id ?? null;
}

/**
 * @param {string} logId
 * @param {{ feedback?: string | null, rating: number }} param1
 */
async function saveBriefLogFeedback(logId, { feedback, rating }) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !logId || !isSupabaseAdminConfigured()) {
    return { ok: false, error: "Feedback is not available." };
  }

  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 10) {
    return { ok: false, error: "Rating must be a whole number from 1 to 10." };
  }

  const { data, error } = await supabase
    .from(BRIEF_LOGS_TABLE)
    .update({
      feedback: trimFeedback(feedback),
      rating: ratingNum,
      feedback_submitted_at: new Date().toISOString(),
    })
    .eq("id", logId)
    .is("feedback_submitted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[brief-logs] feedback update failed", error.message);
    return { ok: false, error: "Could not save feedback." };
  }

  if (!data) {
    return { ok: false, error: "Feedback was already submitted for this brief." };
  }

  return { ok: true };
}

module.exports = {
  BRIEF_LOGS_TABLE,
  MAX_FEEDBACK_CHARS,
  logBriefGeneration,
  saveBriefLogFeedback,
};
