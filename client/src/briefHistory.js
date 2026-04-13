import { extractStickyBriefHeader } from './briefDisplay.js'

const STORAGE_KEY = 'prepbrief_saved_briefs_v1'
export const MAX_SAVED_BRIEFS = 30
const MAX_MARKDOWN_CHARS = 100_000
const MAX_LIST_TITLE_CHARS = 100

function hostnameFromUrl(jobUrl) {
  try {
    const h = new URL(jobUrl).hostname.replace(/^www\./, '')
    return h || 'Saved brief'
  } catch {
    return 'Saved brief'
  }
}

/**
 * List title for saved briefs: "Job title (Company)" using the same parsing as the * in-brief sticky header (role + company from markdown / URL fallbacks).
 * @param {string} markdown
 * @param {string} jobUrl
 */
export function formatSavedBriefListTitle(markdown, jobUrl) {
  const { company, role } = extractStickyBriefHeader(
    typeof markdown === 'string' ? markdown : '',
    typeof jobUrl === 'string' ? jobUrl : '',
  )
  const jobTitle = String(role || '').replace(/\s+/g, ' ').trim() || 'Role'
  const co =
    String(company || '').replace(/\s+/g, ' ').trim() || hostnameFromUrl(jobUrl)
  let title = `${jobTitle} (${co})`
  if (title.length > MAX_LIST_TITLE_CHARS) {
    title = `${title.slice(0, MAX_LIST_TITLE_CHARS - 1)}…`
  }
  return title
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

  const ju = String(jobUrl || '').trim()
  const entry = {
    id: newId(),
    savedAt: new Date().toISOString(),
    companyName: formatSavedBriefListTitle(md, ju),
    jobUrl: ju,
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
