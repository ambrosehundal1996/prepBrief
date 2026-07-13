/**
 * Browser-level free-tier gating (no accounts): localStorage counter for
 * generated briefs plus a manual "paid" override until payments exist.
 */

export const FREE_BRIEF_LIMIT = 2

const STORAGE_KEY_BRIEFS_USED = 'prepbrief.freeBriefsUsed'
const STORAGE_KEY_PAID = 'prepbrief.paid'

export function getFreeBriefsUsed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BRIEFS_USED)
    const n = Number.parseInt(raw ?? '0', 10)
    if (!Number.isFinite(n) || n < 0) return 0
    return n
  } catch {
    return 0
  }
}

export function incrementFreeBriefsUsed() {
  const next = getFreeBriefsUsed() + 1
  try {
    localStorage.setItem(STORAGE_KEY_BRIEFS_USED, String(next))
  } catch {
    /* private mode — session only */
  }
  return next
}

/** Manual/dev override until payments exist: localStorage.setItem('prepbrief.paid', 'true') */
export function isPaid() {
  try {
    return localStorage.getItem(STORAGE_KEY_PAID) === 'true'
  } catch {
    return false
  }
}

export function hasFreeBriefsRemaining() {
  return isPaid() || getFreeBriefsUsed() < FREE_BRIEF_LIMIT
}
