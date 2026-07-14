import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'

const tiers = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    tagline: 'Try it out',
    featured: false,
    features: [
      '3 briefs total',
      'Company research sections',
      'Predicted interview questions',
      'Why us talking points',
    ],
    cta: 'Get started free',
    plan: null,
  },
  {
    id: 'job_seeker',
    name: 'Job Seeker',
    price: '$9',
    period: '/ month',
    tagline: 'For active job seekers',
    featured: true,
    badge: 'Most popular',
    features: [
      '20 briefs per month',
      'Everything in Free',
      'Full personalized sections',
      'Tell me about yourself framework',
      'Which projects to highlight',
      'Conversation hooks',
      'Save and revisit briefs',
    ],
    cta: 'Start for $9/month',
    plan: 'job_seeker',
  },
  {
    id: 'intensive',
    name: 'Intensive',
    price: '$19',
    period: '/ month',
    tagline: 'For heavy job search',
    featured: false,
    features: [
      'Unlimited briefs',
      'Everything in Job Seeker',
      'Resume-powered personalization',
      'Priority generation',
    ],
    cta: 'Start for $19/month',
    plan: 'intensive',
  },
]

export default function PricingPage() {
  const navigate = useNavigate()
  const { user, configured, startCheckout } = useAuth()
  const [loadingPlan, setLoadingPlan] = useState(null)
  const [error, setError] = useState('')

  async function handlePaidClick(plan) {
    setError('')
    if (!user) {
      navigate('/signup')
      return
    }
    setLoadingPlan(plan)
    try {
      await startCheckout(plan)
    } catch (e) {
      setError(e.message || 'Could not start checkout.')
      setLoadingPlan(null)
    }
  }

  return (
    <main className="marketing-page" aria-labelledby="pricing-heading">
      <div className="marketing-page-inner marketing-page-inner--wide">
        <h1 id="pricing-heading" className="marketing-h1">
          Simple pricing
        </h1>
        <p className="marketing-lead">
          3 free briefs when you sign up. Upgrade when you need more.
        </p>

        {error && (
          <p className="message message-error pricing-error" role="alert">
            {error}
          </p>
        )}

        <div className="pricing-grid">
          {tiers.map((tier) => (
            <article
              key={tier.name}
              className={
                tier.featured
                  ? 'pricing-tier card marketing-card pricing-tier--featured'
                  : 'pricing-tier card marketing-card'
              }
            >
              {tier.badge ? (
                <span className="pricing-tier-badge">{tier.badge}</span>
              ) : null}
              <h2 className="pricing-tier-name">{tier.name}</h2>
              <p className="pricing-tier-price">
                <span className="pricing-tier-amount">{tier.price}</span>
                {tier.period ? (
                  <span className="pricing-tier-period">{tier.period}</span>
                ) : null}
              </p>
              <p className="pricing-tier-tagline">{tier.tagline}</p>
              <ul className="pricing-tier-features">
                {tier.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {tier.plan ? (
                <button
                  type="button"
                  className="pricing-tier-cta btn-primary"
                  disabled={loadingPlan === tier.plan}
                  onClick={() => handlePaidClick(tier.plan)}
                >
                  {loadingPlan === tier.plan ? 'Redirecting…' : tier.cta}
                </button>
              ) : (
                <Link
                  to={configured && !user ? '/signup' : '/#create-brief'}
                  className="pricing-tier-cta btn-primary"
                >
                  {tier.cta}
                </Link>
              )}
            </article>
          ))}
        </div>

        <p className="pricing-footnote">
          No credit card required for the free tier. Cancel paid plans anytime.
        </p>
        {!configured && (
          <p className="pricing-disclaimer">
            Payments require Stripe configuration on the server. Auth and usage
            limits are enforced once Supabase is connected.
          </p>
        )}
      </div>
    </main>
  )
}
