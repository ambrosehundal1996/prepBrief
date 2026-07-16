# PrepBrief

**Walk into your interview knowing what they'll ask.**

PrepBrief turns a job posting and your resume into a personalized interview prep brief in about 60 seconds — predicted questions, talking points, company research, and smart questions to ask back. It is built for job seekers who are short on time and want to feel ready before they walk into the room, not reschedule out of anxiety.

**Production:** [https://prepbrief.com](https://prepbrief.com)

---

## What PrepBrief does

Most interview prep is either generic advice (“practice STAR stories”) or hours of manual research. PrepBrief does the work for a specific company and role:

- Reads the job description you provide
- Researches the company (recent news, exec interviews, hiring signals, strategic focus)
- Cross-analyzes your resume against the role requirements
- Writes a structured brief you can scan in a few minutes before the interview

The output is not a script to memorize. It is a game plan: which questions to expect, which stories from your background to reach for, what the company is betting on right now, and what to ask them that proves you did your homework.

---

## How to use PrepBrief

### 1. Create a free account

Go to [https://prepbrief.com](https://prepbrief.com) and sign up. New accounts include **3 free briefs** — no credit card required. Sign-in is required to generate briefs when auth is enabled in production.

### 2. Add the job posting

On the home page, use the **Job posting** field. You can provide the role in three ways:

| Mode | What to do |
|------|------------|
| **Link** | Paste a job posting URL (Lever, Greenhouse, Ashby, LinkedIn, company careers pages, etc.) |
| **Paste text** | Copy the full job description into the text area if you do not have a link or the page is hard to scrape |
| **Upload file** | Upload the job description as a PDF or `.docx` |

Pick one input method per brief. PrepBrief uses it to identify the company, extract role requirements, and drive the rest of the pipeline.

### 3. Add your resume (recommended)

Upload a PDF or `.docx` resume, or add one later from **My resume** in the top navigation. The resume is optional, but it unlocks the personalized sections:

- Behavioral questions mapped to your real projects
- “Tell me about yourself” talking points
- Which projects to lead with (and which to avoid)
- Resume-tied conversation hooks and “why us” angles

Without a resume, you still get company research, predicted role questions, and questions to ask them — but the brief is less tailored to your background.

### 4. Generate your brief

Click **Generate my brief →**. PrepBrief streams the brief as it is written (usually under two minutes). Progress messages appear while it reads the posting, identifies the company, runs research, and composes the brief.

### 5. Read and navigate the brief

Your brief appears below the form with two views:

- **Role specific** — interview prep: likely questions, your story, hooks, questions to ask, positioning
- **Company overview** — context: the company’s current bet, overview, brief summary, why-us talking points

Use the **Jump to** sidebar to move between sections. Questions and other list items with extra detail are **collapsible** — you see the headline first and expand for “why they ask,” “use this story,” “how to answer,” and similar notes. Copy any section with the copy button on the card.

### 6. Save and revisit

- **Saved briefs** — reopen past briefs from the top nav (stored in your account when signed in; also cached locally in the browser for quick access)
- **My resume** — preview, replace, or remove the resume stored in this browser

When you are ready for more volume, see [Pricing](https://prepbrief.com/pricing) on the site.

---

## What’s in a brief

Each brief follows a consistent structure. Sections appear in this order:

**Role-specific prep**

1. **What they're likely to ask you** — Predicted behavioral and role/company questions, tagged Likely or Curveball, with prep notes tied to your resume when available
2. **Tell me about yourself** — Open / middle / close talking points, not a paragraph to memorize
3. **Which projects to highlight** — What to lead with, what to avoid, and why for this role
4. **Conversation hooks** — Recent, specific facts you can mention naturally (with source links when available)
5. **Questions to ask them** — Ready-to-say questions grouped to show you read the JD, understand their strategy, and close strongly
6. **Interview positioning** — Skills to emphasize and JD phrases worth mirroring

**Company context**

7. **The company's current big bet** — What they are focused on now, with dated evidence
8. **Company overview** — What they do, the problem they solve, and optional “go deeper” links
9. **Brief summary** — Hiring-manager voice on what they want, how to position yourself, and your narrative thread
10. **Why us — talking points** — Motivation hooks for “why this company?” without generic culture filler

---

## How PrepBrief works (under the hood)

PrepBrief uses a **two-stage AI pipeline** powered by Anthropic Claude:

### Stage 1 — Company research

1. **Job content** — From URL (via Firecrawl when configured), pasted text, or extracted PDF/DOCX
2. **Company identity** — Name and domain inferred from the posting (not just the job board hostname)
3. **Research object** — A structured JSON cache of verified company intelligence: summary, big bet, recent news, exec statements, hiring signals, and risk flags. Research uses web search (and is cached per company domain in Supabase when configured, typically ~10 days) so repeat briefs for the same employer are faster

### Stage 2 — Brief generation

The research object, full job description, and optional resume text are sent to a brief-writing model with a detailed prompt (veteran hiring-manager persona, strict section order, length limits, and anti-generic rules). The model cross-analyzes resume vs. JD internally, then outputs markdown only — no raw research dump.

The API streams the brief over **Server-Sent Events** (`POST /api/research/stream`) so the UI can show text as it arrives.

### Accounts, limits, and billing

When Supabase auth is configured:

| Plan | Briefs | Notes |
|------|--------|--------|
| **Free** | 3 total | Company research + core sections |
| **Job Seeker** ($9/mo) | 20 / month | Full personalization, saved briefs |
| **Intensive** ($19/mo) | Unlimited | Everything in Job Seeker |

Paid plans are handled through Stripe Checkout. Usage is tracked on `prepbrief_profiles` in Supabase.

---

## Pricing (summary)

See the live page for current details: [https://prepbrief.com/pricing](https://prepbrief.com/pricing)

- **Free** — 3 briefs, great for trying the product
- **Job Seeker** — $9/month, 20 briefs, full personalized sections
- **Intensive** — $19/month, unlimited briefs for an active search

---

## Who it’s for

PrepBrief is for anyone with an interview coming up — especially when you are juggling multiple applications and only have a few minutes to prep. The copy and layout assume you might read the brief in the parking lot: headlines first, details on demand, no fluff.

If you used to reschedule because you did not feel ready, PrepBrief is meant to be the 60-second step that lets you walk in with a plan instead.

---

## Project structure (developers)

| Path | Purpose |
|------|---------|
| `client/` | React + Vite SPA (UI, auth, brief display) |
| `server.js` | Express API (research, streaming, Stripe, Supabase) |
| `api/index.js` | Vercel serverless entry |
| `research.js` | Two-stage brief pipeline |
| `companyResearch.js` | Stage 1 research + identity |
| `prompts.js` | Research and brief system prompts |
| `resumeExtract.js` | PDF/DOCX text extraction (resume + job description files) |
| `supabase/schema.sql` | Profiles, usage, and auth trigger |

### Run locally

**Requirements:** Node.js 22+, API keys in `.env` (see `.env.example`)

```bash
# API (from repo root)
npm install
npm start
# → http://localhost:3000

# Frontend (separate terminal)
cd client && npm install && npm run dev
# → http://localhost:5173
```

Copy `client/.env.example` to `client/.env` and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` if you want sign-in locally. Point `VITE_API_BASE_URL` at the API if needed (empty often works with the Vite proxy in dev).

Production deploys to **Vercel**: the built SPA in `client/dist` is served with API routes under `/api/*`.

---

## Links

- **App:** [https://prepbrief.com](https://prepbrief.com)
- **How it works:** [https://prepbrief.com/how-it-works](https://prepbrief.com/how-it-works)
- **About:** [https://prepbrief.com/about](https://prepbrief.com/about)
- **Pricing:** [https://prepbrief.com/pricing](https://prepbrief.com/pricing)

---

© PrepBrief. Personalized interview prep from your resume and their job description.
