/**
 * Supabase-backed cache for Stage 1 company research objects.
 *
 * Table (run once in the Supabase SQL editor):
 *
 *   create table research_objects (
 *     domain text primary key,
 *     company_name text not null,
 *     research jsonb not null,
 *     coverage_weak text[],
 *     researched_at timestamptz not null default now()
 *   );
 *
 * Cache validity (10 days) is enforced in the query, not the schema.
 * If SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset, every lookup is a
 * miss and writes are skipped, so local dev works without a database.
 */

const { createClient } = require("@supabase/supabase-js");

const CACHE_TTL_DAYS = 10;

let cachedClient = null;
let warnedUnconfigured = false;

function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

function getClient() {
  if (!isSupabaseConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[cache] Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — Stage 1 will run on every brief.",
      );
    }
    return null;
  }
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.SUPABASE_URL.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
      { auth: { persistSession: false } },
    );
  }
  return cachedClient;
}

/**
 * @param {string} domain
 * @returns {Promise<{ research: object, companyName: string } | null>} fresh cached object or null
 */
async function getFreshResearch(domain) {
  const client = getClient();
  const d = typeof domain === "string" ? domain.trim().toLowerCase() : "";
  if (!client || !d) return null;

  const cutoff = new Date(
    Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const { data, error } = await client
      .from("research_objects")
      .select("company_name, research, researched_at")
      .eq("domain", d)
      .gt("researched_at", cutoff)
      .maybeSingle();

    if (error) {
      console.warn("[cache] lookup failed — treating as miss", error.message);
      return null;
    }
    if (!data?.research) return null;

    console.log("[cache] hit", { domain: d, researchedAt: data.researched_at });
    return { research: data.research, companyName: data.company_name };
  } catch (e) {
    console.warn(
      "[cache] lookup threw — treating as miss",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/**
 * @param {string} domain
 * @param {string} companyName
 * @param {object} research validated Stage 1 research object
 */
async function upsertResearch(domain, companyName, research) {
  const client = getClient();
  const d = typeof domain === "string" ? domain.trim().toLowerCase() : "";
  if (!client || !d || !research) return;

  const coverageWeak = Array.isArray(research?.coverage?.weak)
    ? research.coverage.weak.filter((s) => typeof s === "string")
    : [];

  try {
    const { error } = await client.from("research_objects").upsert(
      {
        domain: d,
        company_name: companyName || research.company || d,
        research,
        coverage_weak: coverageWeak,
        researched_at: new Date().toISOString(),
      },
      { onConflict: "domain" },
    );
    if (error) {
      console.warn("[cache] upsert failed", error.message);
    } else {
      console.log("[cache] stored research object", {
        domain: d,
        coverageWeak,
      });
    }
  } catch (e) {
    console.warn(
      "[cache] upsert threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}

module.exports = {
  isSupabaseConfigured,
  getFreshResearch,
  upsertResearch,
  CACHE_TTL_DAYS,
};
