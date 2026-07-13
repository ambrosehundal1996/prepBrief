/**
 * Browser-level free-tier gating (no accounts). Generation is currently
 * unlimited; only the personalized-section blur is gated on the paid flag.
 */

const STORAGE_KEY_PAID = 'prepbrief.paid'

/** Manual/dev override until payments exist: localStorage.setItem('prepbrief.paid', 'true') */
export function isPaid() {
  try {
    return localStorage.getItem(STORAGE_KEY_PAID) === 'true'
  } catch {
    return false
  }
}
