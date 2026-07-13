import { Link } from 'react-router-dom'

const steps = [
  {
    title: 'Paste the job posting link',
    body: 'Drop in any URL from Lever, Greenhouse, Ashby, LinkedIn, or anywhere else. We read the posting to identify the company and the role requirements.',
  },
  {
    title: 'Add your resume',
    body: 'Upload your resume (required) so every section is personalized — your talking points for “tell me about yourself”, which projects to highlight, and questions to ask them, all mapped to this role.',
  },
  {
    title: 'Get your prep brief in 60 seconds',
    body: 'We research the company and cross-analyze your resume against the job description. You get a structured brief — predicted questions first, then your game plan.',
  },
  {
    title: 'Walk in ready',
    body: 'Read your brief in 2 minutes. Know what they’ll ask, how to frame your story, and what to ask them — so you don’t reschedule out of unreadiness.',
  },
]

const briefSections = [
  {
    title: 'What they’re likely to ask you',
    desc: 'Predicted questions for this company and role — first in the brief.',
  },
  {
    title: 'Tell me about yourself',
    desc: 'Structured talking points from your resume — not a script.',
  },
  {
    title: 'Which projects to highlight',
    desc: 'Which experiences to lead with and which to avoid.',
  },
  {
    title: 'Questions to ask them',
    desc: '5–7 smart questions grounded in their priorities and your role.',
  },
  {
    title: 'Interview positioning',
    desc: 'Skills to emphasize and JD language to mirror.',
  },
  {
    title: 'The company’s current big bet',
    desc: 'What they’re focused on right now.',
  },
  {
    title: 'Company overview',
    desc: 'What they do and the problem they solve.',
  },
  {
    title: 'Brief summary',
    desc: 'Hiring-manager read on the role and how to position yourself.',
  },
  {
    title: 'Why us — talking points',
    desc: 'Motivation hooks for “why this company?” — stay-ready framing.',
  },
]

export default function HowItWorksPage() {
  return (
    <main className="marketing-page" aria-labelledby="how-heading">
      <div className="marketing-page-inner marketing-page-inner--wide">
        <h1 id="how-heading" className="marketing-h1">
          How PrepBrief works
        </h1>
        <p className="marketing-lead">
          Built from your resume and their job description. Feel ready in about
          60 seconds.
        </p>

        <ol className="how-steps">
          {steps.map((s, i) => (
            <li key={s.title} className="how-step card marketing-card">
              <span className="how-step-num" aria-hidden>
                {i + 1}
              </span>
              <h2 className="how-step-title">{s.title}</h2>
              <p className="how-step-body">{s.body}</p>
            </li>
          ))}
        </ol>

        <section className="marketing-section" aria-labelledby="brief-sections-heading">
          <h2 id="brief-sections-heading" className="marketing-h2">
            What&apos;s in your brief
          </h2>
          <ul className="brief-sections-list">
            {briefSections.map((row) => (
              <li key={row.title} className="brief-sections-item">
                <strong>{row.title}</strong>
                {' — '}
                {row.desc}
              </li>
            ))}
          </ul>
          <p className="marketing-cta-wrap">
            <Link to="/#create-brief" className="marketing-cta">
              Create your first brief →
            </Link>
          </p>
        </section>
      </div>
    </main>
  )
}
