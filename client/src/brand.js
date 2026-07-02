/** Public asset URL (works with Vite `base`). */
const base = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')

export const PREPBRIEF_LOGO_SRC = `${base}prepbrief-logo.png`
