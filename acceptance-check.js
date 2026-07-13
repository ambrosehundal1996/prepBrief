/* One-off acceptance checks for the two-stage pipeline. Delete after running. */
require("dotenv").config();
const fs = require("fs");
const { generateBrief } = require("./research");

const STRIPE_JD = `Backend Engineer, Payments Infrastructure — Stripe

Stripe builds economic infrastructure for the internet. Millions of businesses use our software to accept payments and manage their operations online.

We're hiring a Backend Engineer on the Payments Infrastructure team in San Francisco. You will design and operate the systems that process billions of dollars of payments.

What you'll do:
- Build and scale distributed systems in Ruby and Go handling millions of API requests per day
- Improve reliability of the core charge pipeline (five nines availability target)
- Work with Kafka, Mongo, and our internal orchestration platform
- Partner with product teams on new payment methods

Requirements:
- 4+ years of backend engineering experience
- Experience operating high-throughput distributed systems
- Strong debugging and incident response skills
- Experience with async collaboration across time zones is a plus (our team spans 5 time zones)

Apply at stripe.com/jobs`;

const RESUME = `Jordan Lee
Senior Backend Engineer — San Francisco, CA

EXPERIENCE

Senior Backend Engineer, Plaid (2022–present)
- Own the transactions ingestion pipeline (Go, Kafka) processing 900M bank transactions/day
- Led migration from monolith to event-driven services, cutting p99 latency from 1.2s to 210ms
- On-call lead for the payments-initiation service; drove incident postmortem program adoption across 6 teams

Backend Engineer, Segment (2019–2022)
- Built the retry/dedupe layer for the delivery pipeline (Kafka, DynamoDB), raising delivery success from 99.2% to 99.95%
- Scaled the audience-computation service 10x during Twilio acquisition integration
- Mentored 3 junior engineers; ran the team's async design-review process across SF/Dublin/Melbourne

Software Engineer, Yelp (2017–2019)
- Shipped ads-budget pacing service in Python; +$4.2M annual ad revenue
- Reduced MySQL replication lag incidents 80% via query audit tooling

SKILLS: Go, Ruby, Python, Kafka, DynamoDB, MongoDB, distributed systems, incident response

EDUCATION: B.S. Computer Science, UC San Diego, 2017`;

const OBSCURE_JD = `Founding Full-Stack Engineer — PolicyFly

PolicyFly is a small insurtech startup building underwriting software for specialty insurance (MGAs and carriers). We digitize the submission-to-bind workflow for complex commercial lines.

We're hiring a founding full-stack engineer (remote, US).

What you'll do:
- Ship features across our React/TypeScript frontend and Node/Postgres backend
- Work directly with underwriters at customer MGAs to design workflows
- Own projects end to end in a team of under ten engineers

Requirements:
- 3+ years full-stack experience
- Comfort with ambiguity and direct customer contact
- Postgres schema design experience

Apply: policyfly.com/careers`;

async function run(name, opts) {
  console.log(`\n================ ${name} ================\n`);
  const t0 = Date.now();
  try {
    const { markdown, tokenUsage } = await generateBrief(opts);
    const file = `/tmp/acceptance-${name}.md`;
    fs.writeFileSync(file, markdown);
    console.log(`\n[${name}] OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`, {
      chars: markdown.length,
      tokenUsage,
      file,
    });
  } catch (e) {
    console.error(`\n[${name}] FAILED`, e.code || "", e.message);
  }
}

(async () => {
  // Check 1: known company + real resume
  await run("known-company", {
    jobDescriptionText: STRIPE_JD,
    resumeText: RESUME,
  });
  // Check 2: obscure company (same resume so behavioral sections generate)
  await run("obscure-company", {
    jobDescriptionText: OBSCURE_JD,
    resumeText: RESUME,
  });
  // Check 4: JD-only, no resume
  await run("jd-only", {
    jobDescriptionText: STRIPE_JD,
    resumeText: null,
  });
})();
