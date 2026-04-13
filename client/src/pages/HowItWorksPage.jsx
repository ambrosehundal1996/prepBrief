import { Link } from 'react-router-dom'

const steps = [
  {
    title: 'Paste the job posting link',
    body: 'Drop in any URL from Lever, Greenhouse, Ashby, LinkedIn, or anywhere else. We read the posting to identify the company and the role requirements.',
  },
  {
    title: 'Add your resume',
    body: 'Upload your resume (required for each brief) so every section is personalized to your actual background — your “tell me about yourself”, which projects to highlight, and your strongest talking points mapped directly to the role.',
  },
  {
    title: 'Get your cheat sheet in 60 seconds',
    body: 'We scrape the company’s website, synthesize everything through a world-class hiring manager lens, and generate a structured brief across 7 sections.',
  },
  {
    title: 'Walk in prepared',
    body: 'Read your brief in 2 minutes. Know what they’ll ask, how to answer it, and how to present yourself as the candidate they’re looking for.',
  },
]

const briefSections = [
  {
    title: 'Tell me about yourself',
    desc: 'A personalized open/middle/close framework built from your resume.',
  },
  {
    title: 'What they’re likely to ask',
    desc: 'Predicted questions specific to this company, not generic prep.',
  },
  {
    title: 'Which projects to highlight',
    desc: 'Exactly which experiences to lead with and which to avoid.',
  },
  {
    title: 'Interview positioning',
    desc: 'Skills to emphasize and JD language to mirror.',
  },
  {
    title: 'Company overview',
    desc: 'What they do and the problem they solve, in plain language.',
  },
  {
    title: 'The company’s current big bet',
    desc: 'What they’re focused on right now, so you sound like an insider.',
  },
  {
    title: 'Why I’m interested',
    desc: 'Ready-to-use talking points you can say naturally.',
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
          From job posting to interview-ready in under 60 seconds.
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
