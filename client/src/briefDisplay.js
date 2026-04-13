/**
 * Client-side transforms for rendered brief markdown (strip meta lines, markers).
 */

/** Lines that are prompt scaffolding, not candidate-facing content. */
function isStructuralInstructionLine(trimmed) {
  if (!trimmed) return false
  if (/^\d+\s+bullets?.+:$/i.test(trimmed)) return true
  if (/^\d+\s+bullets?\s+explaining.+:$/i.test(trimmed)) return true
  if (/^\d+\s+bullets?\s+explaining.+$/i.test(trimmed)) return true
  if (/^\d+\s+sentences?.+:$/i.test(trimmed)) return true
  if (/^exactly\s+\d+\s+bullets?.+:$/i.test(trimmed)) return true
  if (/^one line each.+:$/i.test(trimmed)) return true
  if (/^for each found.+:$/i.test(trimmed)) return true
  if (/^only return.+:$/i.test(trimmed)) return true
  if (/^each question must.+:$/i.test(trimmed)) return true
  if (/^format as.+:$/i.test(trimmed)) return true
  if (/^no preamble.+:$/i.test(trimmed)) return true
  if (/^keep each.+:$/i.test(trimmed)) return true
  if (/^based on.+:$/i.test(trimmed) && trimmed.length < 120) return true
  if (/^generate\s+\d.*/i.test(trimmed) && trimmed.endsWith(':')) return true
  return false
}

export function stripStructuralInstructionLines(md) {
  if (typeof md !== 'string' || !md) return md
  return md
    .split('\n')
    .filter((line) => !isStructuralInstructionLine(line.trim()))
    .join('\n')
}

const BADGE_LIKELY = 'prepbrief:badge-likely'
const BADGE_CURVEBALL = 'prepbrief:badge-curveball'

const LBL_WHY = 'prepbrief:lbl-why'
const LBL_HOW = 'prepbrief:lbl-how'
const LBL_WATCH = 'prepbrief:lbl-watch'

/**
 * Inject markdown image pseudo-links for badges and markdown links for labels
 * so ReactMarkdown `components` can render styled spans (no raw HTML).
 */
export function injectBriefDisplayMarkers(md) {
  if (typeof md !== 'string' || !md) return md
  let out = md.replace(/\[Likely\]/g, `![Likely](${BADGE_LIKELY})`)
  out = out.replace(/\[Curveball\]/g, `![Curveball](${BADGE_CURVEBALL})`)

  const labelSubs = [
    [/(\*\*Why they ask this:\*\*)/g, `[Why they ask this:](${LBL_WHY})`],
    [/(\*\*How to answer this:\*\*)/g, `[How to answer this:](${LBL_HOW})`],
    [/(\*\*Watch out:\*\*)/g, `[Watch out:](${LBL_WATCH})`],
    [/(\*\*Why ask this:\*\*)/g, `[Why ask this:](${LBL_WHY})`],
    [/(^|\n)([ \t]*)(Why they ask this:)/gm, `$1$2[Why they ask this:](${LBL_WHY})`],
    [/(^|\n)([ \t]*)(How to answer this:)/gm, `$1$2[How to answer this:](${LBL_HOW})`],
    [/(^|\n)([ \t]*)(Watch out:)/gm, `$1$2[Watch out:](${LBL_WATCH})`],
    [/(^|\n)([ \t]*)(Why ask this:)/gm, `$1$2[Why ask this:](${LBL_WHY})`],
  ]
  for (const [re, rep] of labelSubs) {
    out = out.replace(re, rep)
  }
  return out
}

/** Full document: strip scaffolding then inject markers (badges / labels). */
export function prepareBriefMarkdownForRender(md) {
  if (typeof md !== 'string') return ''
  return injectBriefDisplayMarkers(stripStructuralInstructionLines(md))
}

/** Section body only (parent already stripped the full brief). */
export function prepareBriefSectionBodyForRender(md) {
  if (typeof md !== 'string') return ''
  return injectBriefDisplayMarkers(md)
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const INTERVIEW_KEYS = [
  'tell me about yourself',
  "what they're likely to ask you",
  'what they are likely to ask you',
  'which projects to highlight',
  'interview positioning',
  'your strongest talking points',
  'questions to ask the interviewer',
]

const COMPANY_KEYS = [
  'company overview',
  'company summary',
  'current big bet',
  "why i'm interested",
  'why i am interested in this company',
  'the problem it solves',
  'core features',
  'product demo',
  'founder interviews',
  'competitors',
  'funding',
]

export function getBriefSectionGroup(sectionTitle) {
  const n = normalizeTitle(sectionTitle)
  if (INTERVIEW_KEYS.some((k) => n.includes(k) || n === k)) return 'interview'
  if (COMPANY_KEYS.some((k) => n.includes(k) || n === k)) return 'company'
  return null
}

export function extractStickyBriefHeader(markdown, jobUrl) {
  let company = ''
  let role = ''
  const hostFallback = (() => {
    try {
      return new URL(jobUrl).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()

  const roleFromUrl = (() => {
    try {
      const u = new URL(jobUrl)
      const parts = u.pathname.split('/').filter(Boolean)
      const last = parts[parts.length - 1]
      if (!last) return ''
      return decodeURIComponent(last).replace(/[-_+]/g, ' ').slice(0, 72)
    } catch {
      return ''
    }
  })()

  if (typeof markdown === 'string' && markdown.trim()) {
    const cs = markdown.match(/##\s*Company Summary\s*\n+([\s\S]*?)(?=\n##\s|$)/i)
    if (cs) {
      const body = cs[1].trim()
      const bullet = body.match(/^\s*[-*]\s*(.+)$/m)
      const line = body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))
      const raw = (bullet?.[1] || line || '').trim()
      company = raw.replace(/^[-*]\s*/, '').slice(0, 72)
    }

    const roleSection = markdown.match(
      /##\s*(?:Role|Position|Job title)\s*[:\s]*\n*\s*(.+)/i,
    )
    if (roleSection) role = roleSection[1].trim().slice(0, 80)

    const jdTitle = markdown.match(/\*\*(?:Title|Role)\*\*[:\s]*([^\n]+)/i)
    if (!role && jdTitle) role = jdTitle[1].trim().slice(0, 80)
  }

  if (!company) company = hostFallback || 'Company'
  if (!role) role = roleFromUrl || 'Interview brief'
  return { company, role }
}

/** Plain text for clipboard: strip common markdown syntax lightly. */
export function sectionChunkToPlainText(chunk) {
  if (typeof chunk !== 'string') return ''
  return chunk
    .replace(/^##.+\n?/m, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
