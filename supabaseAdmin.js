/**
 * Shared Supabase admin client (service role) for auth verification,
 * prepbrief_profiles, and usage tracking.
 */

const { createClient } = require("@supabase/supabase-js");

let cachedClient = null;

function isSupabaseAdminConfigured() {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

function getSupabaseAdmin() {
  if (!isSupabaseAdminConfigured()) return null;
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.SUPABASE_URL.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return cachedClient;
}

module.exports = { getSupabaseAdmin, isSupabaseAdminConfigured };
