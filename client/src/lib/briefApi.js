import { formatSavedBriefListTitle } from '../briefHistory.js'

function apiUrl(path) {
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
  return `${base}${path}`
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` }
}

function normalizeBrief(entry) {
  const markdown = String(entry?.markdown || '')
  const jobUrl = String(entry?.jobUrl || '')
  return {
    id: entry.id,
    savedAt: entry.savedAt || entry.saved_at || new Date().toISOString(),
    companyName:
      entry.companyName ||
      formatSavedBriefListTitle(markdown, jobUrl),
    jobUrl,
    markdown,
  }
}

export async function fetchUserBriefs(accessToken) {
  const res = await fetch(apiUrl('/api/briefs'), {
    headers: authHeaders(accessToken),
  })
  if (!res.ok) {
    throw new Error('Could not load your saved briefs.')
  }
  const data = await res.json()
  const briefs = Array.isArray(data.briefs) ? data.briefs : []
  return briefs.map(normalizeBrief)
}

export async function migrateLocalBriefs(accessToken, localBriefs) {
  const res = await fetch(apiUrl('/api/briefs/migrate'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(accessToken),
    },
    body: JSON.stringify({ briefs: localBriefs }),
  })
  if (!res.ok) {
    throw new Error('Could not migrate saved briefs.')
  }
  const data = await res.json()
  const briefs = Array.isArray(data.briefs) ? data.briefs : []
  return briefs.map(normalizeBrief)
}

export async function deleteUserBrief(accessToken, briefId) {
  const res = await fetch(apiUrl(`/api/briefs/${encodeURIComponent(briefId)}`), {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  })
  if (!res.ok) {
    throw new Error('Could not delete brief.')
  }
}

const MIGRATE_FLAG_PREFIX = 'prepbrief_briefs_migrated_'

export function hasMigratedBriefs(userId) {
  try {
    return localStorage.getItem(`${MIGRATE_FLAG_PREFIX}${userId}`) === '1'
  } catch {
    return false
  }
}

export function markBriefsMigrated(userId) {
  try {
    localStorage.setItem(`${MIGRATE_FLAG_PREFIX}${userId}`, '1')
  } catch {
    /* ignore */
  }
}

/**
 * Load briefs for a signed-in user; one-time migrate from localStorage if needed.
 */
export async function submitBriefLogFeedback(logId, { feedback, rating }) {
  const res = await fetch(apiUrl(`/api/brief-logs/${encodeURIComponent(logId)}/feedback`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback, rating }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || 'Could not save feedback.')
  }
  return data
}

export async function syncBriefsForUser(accessToken, userId, localBriefs) {
  if (!hasMigratedBriefs(userId) && localBriefs.length > 0) {
    const migrated = await migrateLocalBriefs(accessToken, localBriefs)
    markBriefsMigrated(userId)
    return migrated
  }
  return fetchUserBriefs(accessToken)
}
