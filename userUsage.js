/**
 * Per-user brief usage: 3 free briefs, then paid plans via Stripe.
 */

const { getSupabaseAdmin, isSupabaseAdminConfigured } = require("./supabaseAdmin");

const PROFILES_TABLE = "prepbrief_profiles";

const FREE_BRIEF_LIMIT = 3;
const JOB_SEEKER_MONTHLY_LIMIT = 20;

function currentPeriodStart() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function isActiveSubscription(profile) {
  const s = profile?.subscription_status;
  return s === "active" || s === "trialing";
}

/**
 * @param {object} profile
 * @returns {{ canGenerate: boolean, limit: number | null, remaining: number | null, reason?: string }}
 */
function evaluateUsage(profile) {
  if (!profile) {
    return {
      canGenerate: false,
      limit: FREE_BRIEF_LIMIT,
      remaining: 0,
      reason: "AUTH_REQUIRED",
    };
  }

  const plan = profile.plan || "free";
  const briefsUsed = profile.briefs_used ?? 0;
  const periodUsed = profile.period_briefs_used ?? 0;

  if (plan === "intensive" && isActiveSubscription(profile)) {
    return { canGenerate: true, limit: null, remaining: null };
  }

  if (plan === "job_seeker" && isActiveSubscription(profile)) {
    const remaining = Math.max(0, JOB_SEEKER_MONTHLY_LIMIT - periodUsed);
    return {
      canGenerate: remaining > 0,
      limit: JOB_SEEKER_MONTHLY_LIMIT,
      remaining,
      reason: remaining > 0 ? undefined : "MONTHLY_LIMIT",
    };
  }

  const remaining = Math.max(0, FREE_BRIEF_LIMIT - briefsUsed);
  return {
    canGenerate: remaining > 0,
    limit: FREE_BRIEF_LIMIT,
    remaining,
    reason: remaining > 0 ? undefined : "FREE_LIMIT",
  };
}

/**
 * @param {import('@supabase/supabase-js').User} user
 */
async function ensureProfile(user) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !user?.id) return null;

  const { data: existing } = await supabase
    .from(PROFILES_TABLE)
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from(PROFILES_TABLE)
    .insert({
      id: user.id,
      email: user.email || null,
    })
    .select("*")
    .single();

  if (error) {
    console.warn("[usage] ensureProfile insert failed", error.message);
    return null;
  }
  return created;
}

async function getProfile(userId) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[usage] getProfile failed", error.message);
    return null;
  }
  return data;
}

/**
 * Reset monthly counter when period rolls over (job_seeker plan).
 */
async function maybeResetPeriod(profile) {
  if (!profile || profile.plan !== "job_seeker") return profile;
  const periodStart = currentPeriodStart();
  if (profile.period_start === periodStart) return profile;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .update({
      period_start: periodStart,
      period_briefs_used: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profile.id)
    .select("*")
    .single();

  if (error) {
    console.warn("[usage] period reset failed", error.message);
    return profile;
  }
  return data;
}

/**
 * @param {import('@supabase/supabase-js').User} user
 */
async function getAccountForUser(user) {
  if (!isSupabaseAdminConfigured() || !user?.id) {
    return {
      configured: false,
      plan: "free",
      briefsUsed: 0,
      limit: FREE_BRIEF_LIMIT,
      remaining: FREE_BRIEF_LIMIT,
      canGenerate: true,
      subscriptionStatus: null,
    };
  }

  let profile = await ensureProfile(user);
  if (!profile) {
    return {
      configured: true,
      plan: "free",
      briefsUsed: 0,
      limit: FREE_BRIEF_LIMIT,
      remaining: 0,
      canGenerate: false,
      subscriptionStatus: null,
    };
  }

  profile = await maybeResetPeriod(profile);
  const usage = evaluateUsage(profile);

  return {
    configured: true,
    plan: profile.plan,
    briefsUsed: profile.briefs_used ?? 0,
    periodBriefsUsed: profile.period_briefs_used ?? 0,
    limit: usage.limit,
    remaining: usage.remaining,
    canGenerate: usage.canGenerate,
    subscriptionStatus: profile.subscription_status,
    stripeCustomerId: profile.stripe_customer_id,
  };
}

/**
 * Gate before generation. Throws-style return for HTTP handlers.
 * @returns {Promise<{ ok: true, profile: object } | { ok: false, status: number, code: string, error: string }>}
 */
async function assertCanGenerate(user) {
  if (!isSupabaseAdminConfigured()) {
    return { ok: true, profile: null };
  }
  if (!user?.id) {
    return {
      ok: false,
      status: 401,
      code: "AUTH_REQUIRED",
      error: "Sign in required to generate a brief.",
    };
  }

  let profile = await ensureProfile(user);
  profile = await maybeResetPeriod(profile);
  const usage = evaluateUsage(profile);

  if (!usage.canGenerate) {
    const msg =
      usage.reason === "MONTHLY_LIMIT"
        ? `You've used all ${JOB_SEEKER_MONTHLY_LIMIT} briefs this month. Upgrade to Intensive for unlimited briefs.`
        : `You've used all ${FREE_BRIEF_LIMIT} free briefs. Upgrade to keep generating.`;
    return {
      ok: false,
      status: 402,
      code: usage.reason || "LIMIT_REACHED",
      error: msg,
    };
  }

  return { ok: true, profile };
}

/** Increment counters after a successful brief. */
async function recordBriefGenerated(userId) {
  if (!isSupabaseAdminConfigured() || !userId) return;

  const profile = await getProfile(userId);
  if (!profile) return;

  const updates = {
    briefs_used: (profile.briefs_used ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };

  if (profile.plan === "job_seeker" && isActiveSubscription(profile)) {
    updates.period_briefs_used = (profile.period_briefs_used ?? 0) + 1;
    if (!profile.period_start) {
      updates.period_start = currentPeriodStart();
    }
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from(PROFILES_TABLE)
    .update(updates)
    .eq("id", userId);

  if (error) {
    console.warn("[usage] recordBriefGenerated failed", error.message);
  }
}

/**
 * Apply Stripe subscription state to profile.
 */
async function updateSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  subscriptionStatus,
  plan,
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const updates = {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    subscription_status: subscriptionStatus,
    plan: plan || "free",
    updated_at: new Date().toISOString(),
  };

  if (plan === "job_seeker") {
    updates.period_start = currentPeriodStart();
    updates.period_briefs_used = 0;
  }

  const { error } = await supabase
    .from(PROFILES_TABLE)
    .update(updates)
    .eq("id", userId);

  if (error) {
    console.error("[usage] updateSubscription failed", error.message);
  } else {
    console.log("[usage] subscription updated", { userId, plan, subscriptionStatus });
  }
}

async function findProfileByStripeCustomerId(customerId) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !customerId) return null;
  const { data } = await supabase
    .from(PROFILES_TABLE)
    .select("*")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data;
}

module.exports = {
  PROFILES_TABLE,
  FREE_BRIEF_LIMIT,
  JOB_SEEKER_MONTHLY_LIMIT,
  getAccountForUser,
  assertCanGenerate,
  recordBriefGenerated,
  updateSubscription,
  findProfileByStripeCustomerId,
  ensureProfile,
};
