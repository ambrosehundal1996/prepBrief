/**
 * Persist generated briefs per user in Supabase.
 */

const { getSupabaseAdmin, isSupabaseAdminConfigured } = require("./supabaseAdmin");

const BRIEFS_TABLE = "prepbrief_briefs";
const MAX_USER_BRIEFS = 30;
const MAX_MARKDOWN_CHARS = 100_000;

function trimMarkdown(markdown) {
  const md = String(markdown || "");
  if (md.length <= MAX_MARKDOWN_CHARS) return md;
  return `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[… truncated for storage …]`;
}

function toClientBrief(row) {
  return {
    id: row.id,
    savedAt: row.created_at,
    companyName: row.company_name || "Saved brief",
    jobUrl: row.job_url || "",
    markdown: row.markdown || "",
  };
}

/**
 * @param {string} userId
 * @param {{ jobUrl?: string, markdown: string, companyName?: string }} param1
 */
async function saveUserBrief(userId, { jobUrl, markdown, companyName }) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId || !isSupabaseAdminConfigured()) return null;

  const md = trimMarkdown(markdown);
  if (!md.trim()) return null;

  const { data, error } = await supabase
    .from(BRIEFS_TABLE)
    .insert({
      user_id: userId,
      job_url: String(jobUrl || "").trim(),
      company_name: companyName?.trim() || null,
      markdown: md,
    })
    .select("*")
    .single();

  if (error) {
    console.warn("[briefs] saveUserBrief failed", error.message);
    return null;
  }

  await trimBriefsForUser(userId);
  return toClientBrief(data);
}

async function trimBriefsForUser(userId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const { data: rows, error } = await supabase
    .from(BRIEFS_TABLE)
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !rows || rows.length <= MAX_USER_BRIEFS) return;

  const staleIds = rows.slice(MAX_USER_BRIEFS).map((r) => r.id);
  if (staleIds.length === 0) return;

  const { error: deleteError } = await supabase
    .from(BRIEFS_TABLE)
    .delete()
    .in("id", staleIds);

  if (deleteError) {
    console.warn("[briefs] trimBriefsForUser failed", deleteError.message);
  }
}

async function listUserBriefs(userId) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId || !isSupabaseAdminConfigured()) return [];

  const { data, error } = await supabase
    .from(BRIEFS_TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_USER_BRIEFS);

  if (error) {
    console.warn("[briefs] listUserBriefs failed", error.message);
    return [];
  }

  return (data || []).map(toClientBrief);
}

async function deleteUserBrief(userId, briefId) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId || !briefId) return false;

  const { error } = await supabase
    .from(BRIEFS_TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("id", briefId);

  if (error) {
    console.warn("[briefs] deleteUserBrief failed", error.message);
    return false;
  }
  return true;
}

/**
 * Import briefs from browser localStorage on first sign-in.
 * @param {string} userId
 * @param {Array<{ jobUrl?: string, markdown: string, companyName?: string, savedAt?: string }>} briefs
 */
async function migrateUserBriefs(userId, briefs) {
  if (!isSupabaseAdminConfigured() || !userId || !Array.isArray(briefs)) {
    return [];
  }

  const toInsert = briefs
    .filter((b) => b && typeof b.markdown === "string" && b.markdown.trim())
    .slice(0, MAX_USER_BRIEFS)
    .map((b) => ({
      user_id: userId,
      job_url: String(b.jobUrl || "").trim(),
      company_name: b.companyName?.trim() || null,
      markdown: trimMarkdown(b.markdown),
      created_at: b.savedAt || new Date().toISOString(),
    }));

  if (toInsert.length === 0) {
    return listUserBriefs(userId);
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(BRIEFS_TABLE).insert(toInsert);

  if (error) {
    console.warn("[briefs] migrateUserBriefs failed", error.message);
  }

  await trimBriefsForUser(userId);
  return listUserBriefs(userId);
}

module.exports = {
  BRIEFS_TABLE,
  MAX_USER_BRIEFS,
  saveUserBrief,
  listUserBriefs,
  deleteUserBrief,
  migrateUserBriefs,
};
