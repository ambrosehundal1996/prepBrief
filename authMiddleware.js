/**
 * Express middleware: verify Supabase JWT and attach req.user.
 * When Supabase is not configured, passes through without a user (local dev).
 */

const { getSupabaseAdmin, isSupabaseAdminConfigured } = require("./supabaseAdmin");

function extractBearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  return token || null;
}

/** Require a valid Supabase session. */
async function requireAuth(req, res, next) {
  if (!isSupabaseAdminConfigured()) {
    console.warn(
      "[auth] Supabase not configured — research endpoints are open (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for production).",
    );
    req.user = null;
    return next();
  }

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Sign in required to generate a brief.",
      code: "AUTH_REQUIRED",
    });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({
      error: "Your session expired. Please sign in again.",
      code: "AUTH_INVALID",
    });
  }

  req.user = data.user;
  req.accessToken = token;
  return next();
}

/** Optional auth — attaches user when token present, never blocks. */
async function optionalAuth(req, res, next) {
  if (!isSupabaseAdminConfigured()) {
    req.user = null;
    return next();
  }
  const token = extractBearerToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.auth.getUser(token);
  req.user = data?.user ?? null;
  req.accessToken = token;
  return next();
}

module.exports = { requireAuth, optionalAuth, extractBearerToken };
