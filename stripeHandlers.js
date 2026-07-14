/**
 * Stripe Checkout + webhook handlers for PrepBrief subscriptions.
 */

const Stripe = require("stripe");
const { getSupabaseAdmin, isSupabaseAdminConfigured } = require("./supabaseAdmin");
const {
  PROFILES_TABLE,
  updateSubscription,
  findProfileByStripeCustomerId,
  ensureProfile,
} = require("./userUsage");

function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

function getStripe() {
  if (!isStripeConfigured()) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY.trim());
}

function appBaseUrl() {
  if (process.env.APP_URL?.trim()) return process.env.APP_URL.trim().replace(/\/$/, "");
  if (process.env.FRONTEND_URL?.trim()) {
    return process.env.FRONTEND_URL.trim().replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:5173";
}

function priceIdForPlan(plan) {
  if (plan === "job_seeker") {
    return process.env.STRIPE_PRICE_ID_JOB_SEEKER?.trim() || null;
  }
  if (plan === "intensive") {
    return process.env.STRIPE_PRICE_ID_INTENSIVE?.trim() || null;
  }
  return null;
}

/**
 * @param {import('@supabase/supabase-js').User} user
 * @param {'job_seeker' | 'intensive'} plan
 */
async function createCheckoutSession(user, plan) {
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error("Stripe is not configured on the server.");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }

  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    const err = new Error(`No Stripe price configured for plan: ${plan}`);
    err.code = "STRIPE_PRICE_MISSING";
    throw err;
  }

  const supabase = getSupabaseAdmin();
  const profile = await ensureProfile(user);
  let customerId = profile?.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    if (supabase) {
      await supabase
        .from(PROFILES_TABLE)
        .update({
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);
    }
  }

  const base = appBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pricing`,
    client_reference_id: user.id,
    metadata: {
      supabase_user_id: user.id,
      plan,
    },
    subscription_data: {
      metadata: {
        supabase_user_id: user.id,
        plan,
      },
    },
  });

  return { url: session.url, sessionId: session.id };
}

async function handleStripeWebhook(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripe || !secret) {
    const err = new Error("Stripe webhook not configured.");
    err.code = "STRIPE_WEBHOOK_NOT_CONFIGURED";
    throw err;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    const err = new Error(`Webhook signature verification failed: ${e.message}`);
    err.code = "STRIPE_SIGNATURE_INVALID";
    throw err;
  }

  console.log("[stripe] webhook", event.type);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId =
        session.client_reference_id ||
        session.metadata?.supabase_user_id;
      const plan = session.metadata?.plan || "job_seeker";
      if (userId && session.subscription) {
        await updateSubscription({
          userId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          subscriptionStatus: "active",
          plan,
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      const plan = sub.metadata?.plan || "job_seeker";
      if (userId) {
        await updateSubscription({
          userId,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
          plan: sub.status === "active" || sub.status === "trialing" ? plan : "free",
        });
      } else if (sub.customer) {
        const profile = await findProfileByStripeCustomerId(sub.customer);
        if (profile) {
          await updateSubscription({
            userId: profile.id,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            subscriptionStatus: sub.status,
            plan:
              sub.status === "active" || sub.status === "trialing"
                ? plan
                : "free",
          });
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      const profile =
        userId
          ? { id: userId }
          : await findProfileByStripeCustomerId(sub.customer);
      if (profile?.id) {
        await updateSubscription({
          userId: profile.id,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: null,
          subscriptionStatus: "canceled",
          plan: "free",
        });
      }
      break;
    }
    default:
      break;
  }

  return { received: true };
}

module.exports = {
  isStripeConfigured,
  createCheckoutSession,
  handleStripeWebhook,
  appBaseUrl,
};
