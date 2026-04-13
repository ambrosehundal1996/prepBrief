import { Link } from 'react-router-dom'

const tiers = [
  {
    name: 'Free',
    price: '$0',
    tagline: 'Try it out',
    featured: false,
    features: [
      '3 briefs total',
      'Company research sections',
      'Predicted interview questions',
      'Why I’m interested talking points',
    ],
    cta: 'Get started free',
    ctaTo: '/#create-brief',
  },
  {
    name: 'Job Seeker',
    price: '$9',
    period: '/ month',
    tagline: 'For active job seekers',
    featured: true,
    badge: 'Most popular',
    features: [
      '20 briefs per month',
      'Everything in Free',
      'JD matching sections',
      'Tell me about yourself framework',
      'Which projects to highlight',
      'Interview positioning',
      'Save and revisit briefs',
    ],
    cta: 'Start for $9/month',
    ctaTo: '/#create-brief',
  },
  {
    name: 'Intensive',
    price: '$19',
    period: '/ month',
    tagline: 'For heavy job search',
    featured: false,
    features: [
      'Unlimited briefs',
      'Everything in Job Seeker',
      'Resume upload for personalized output',
      'Your strongest talking points section',
      'Priority generation speed',
    ],
    cta: 'Start for $19/month',
    ctaTo: '/#create-brief',
  },
]

export default function PricingPage() {
  return (
    <main className="marketing-page" aria-labelledby="pricing-heading">
      <div className="marketing-page-inner marketing-page-inner--wide">
        <h1 id="pricing-heading" className="marketing-h1">
          Simple pricing
        </h1>
        <p className="marketing-lead">
          Start free. Upgrade when you&apos;re ready.
        </p>

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
              <Link to={tier.ctaTo} className="pricing-tier-cta btn-primary">
                {tier.cta}
              </Link>
            </article>
          ))}
        </div>

        <p className="pricing-footnote">
          No credit card required to start. Cancel anytime.
        </p>
        <p className="pricing-disclaimer">
          Paid tiers describe planned product packaging. Today you can try PrepBrief
          with the free tier limits shown in the app.
        </p>
      </div>
    </main>
  )
}
