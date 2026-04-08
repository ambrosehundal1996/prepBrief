const STORAGE_KEY = 'prepbrief_saved_briefs_v1'
export const MAX_SAVED_BRIEFS = 30
const MAX_MARKDOWN_CHARS = 100_000

function hostnameFromUrl(jobUrl) {
  try {
    const h = new URL(jobUrl).hostname.replace(/^www\./, '')
    return h || 'Saved brief'
  } catch {
    return 'Saved brief'
  }
}

/**
 * Best-effort company label from brief markdown (matches our prompt section headers).
 * @param {string} markdown
 * @param {string} jobUrl
 */
export function extractCompanyLabel(markdown, jobUrl) {
  const fallback = hostnameFromUrl(jobUrl)
  if (!markdown || typeof markdown !== 'string') return fallback

  const trimTitle = (raw) => {
    let t = String(raw).replace(/\*\*/g, '').replace(/^[-*]\s*/, '').trim()
    t = t.replace(/\s+/g, ' ')
    if (t.length > 72) return `${t.slice(0, 69)}…`
    return t || fallback
  }

  const sectionBodyAfter = (headingRegex) => {
    const m = markdown.match(headingRegex)
    if (!m || m.index === undefined) return null
    const start = m.index + m[0].length
    const rest = markdown.slice(start)
    const next = rest.search(/\n##\s/)
    const chunk = next === -1 ? rest : rest.slice(0, next)
    return chunk
  }

  const overviewChunk = sectionBodyAfter(/^##\s*Company overview\s*$/im)
  if (overviewChunk) {
    const bullet = overviewChunk.match(/^\s*[-*]\s+(.+)$/m)
    if (bullet?.[1]) return trimTitle(bullet[1])
  }

  const summaryChunk = sectionBodyAfter(/^##\s*Company Summary\s*$/im)
  if (summaryChunk) {
    const text = summaryChunk.trim().split(/\n{2,}/)[0]?.replace(/\n/g, ' ').trim()
    if (text) return trimTitle(text)
  }

  return fallback
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function loadBriefHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (x) =>
        x &&
        typeof x.id === 'string' &&
        typeof x.markdown === 'string' &&
        typeof x.jobUrl === 'string',
    )
  } catch {
    return []
  }
}

function persistBriefs(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    return true
  } catch (e) {
    if (e?.name === 'QuotaExceededError' && items.length > 1) {
      const half = Math.max(1, Math.floor(items.length / 2))
      return persistBriefs(items.slice(0, half))
    }
    console.warn('[prepbrief] brief history save failed', e)
    return false
  }
}

/**
 * @param {{ jobUrl: string, markdown: string }} param0
 * @returns {{ ok: boolean, items: Array<{ id: string, savedAt: string, companyName: string, jobUrl: string, markdown: string }>, savedEntry?: { id: string } }}
 */
export function saveBriefToHistory({ jobUrl, markdown }) {
  const md =
    typeof markdown === 'string' && markdown.length > MAX_MARKDOWN_CHARS
      ? `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[… truncated for local storage …]`
      : String(markdown || '')

  if (!md.trim()) return { ok: false, items: loadBriefHistory() }

  const entry = {
    id: newId(),
    savedAt: new Date().toISOString(),
    companyName: extractCompanyLabel(md, jobUrl),
    jobUrl: String(jobUrl || '').trim(),
    markdown: md,
  }

  const prev = loadBriefHistory()
  const next = [entry, ...prev].slice(0, MAX_SAVED_BRIEFS)
  const ok = persistBriefs(next)
  return {
    ok,
    items: ok ? next : loadBriefHistory(),
    savedEntry: ok ? entry : undefined,
  }
}

/**
 * @param {string} id
 */
export function deleteBriefFromHistory(id) {
  const prev = loadBriefHistory()
  const next = prev.filter((x) => x.id !== id)
  persistBriefs(next)
  return next
}
