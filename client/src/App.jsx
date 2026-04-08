import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

function isValidHttpUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function apiUrl(path) {
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
  return `${base}${path}`
}

const FREE_BRIEF_LIMIT_PROD = 3
const STORAGE_KEY_FREE_USES = 'prepbrief_free_uses_used'

/** `vite build` / production deploy, or set VITE_FORCE_TRIAL_LIMIT=true to test the cap locally. */
const isTrialCapped =
  import.meta.env.PROD ||
  import.meta.env.VITE_FORCE_TRIAL_LIMIT === 'true'

const FREE_BRIEF_LIMIT = FREE_BRIEF_LIMIT_PROD

function readFreeUsesConsumed() {
  if (!isTrialCapped) return 0
  try {
    const v = localStorage.getItem(STORAGE_KEY_FREE_USES)
    if (v == null) return 0
    const n = parseInt(v, 10)
    if (!Number.isFinite(n)) return 0
    return Math.min(FREE_BRIEF_LIMIT, Math.max(0, n))
  } catch {
    return 0
  }
}

function writeFreeUsesConsumed(n) {
  if (!isTrialCapped) return
  try {
    localStorage.setItem(
      STORAGE_KEY_FREE_USES,
      String(Math.min(FREE_BRIEF_LIMIT, Math.max(0, n))),
    )
  } catch {
    /* private mode — session only; state still updates in React */
  }
}

async function logTrialBlockedToServer(jobUrl, freeUsesConsumed) {
  try {
    await fetch(apiUrl('/api/log-client-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobUrl,
        freeUsesUsed: freeUsesConsumed,
      }),
    })
  } catch (e) {
    console.warn('[prepbrief] log-client-event failed', e)
  }
}

/** Human-readable duration from click to full response (ms). */
function formatResponseTime(ms) {
  if (ms < 1000) return `${ms} ms`
  const sec = ms / 1000
  if (sec < 60) {
    const rounded = sec >= 10 ? Math.round(sec) : Math.round(sec * 10) / 10
    return `${rounded} s`
  }
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

/** Split brief markdown into chunks at top-level ## headings (one card per section). */
function splitBriefIntoSections(md) {
  if (typeof md !== 'string' || !md.trim()) return []
  const parts = md.split(/\n(?=## )/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

export default function App() {
  const [jobUrl, setJobUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [clientError, setClientError] = useState('')
  const [apiError, setApiError] = useState('')
  const [markdown, setMarkdown] = useState(null)
  const [responseTimeMs, setResponseTimeMs] = useState(null)
  const [freeUsesConsumed, setFreeUsesConsumed] = useState(() =>
    isTrialCapped ? readFreeUsesConsumed() : 0,
  )
  const outputRef = useRef(null)
  const scrollOnStreamRef = useRef(false)

  const freeUsesRemaining = isTrialCapped
    ? Math.max(0, FREE_BRIEF_LIMIT - freeUsesConsumed)
    : null
  const trialExhausted =
    isTrialCapped && freeUsesConsumed >= FREE_BRIEF_LIMIT

  async function handleSubmit(e) {
    e.preventDefault()
    setClientError('')
    setApiError('')

    const trimmedJob = jobUrl.trim()
    if (!trimmedJob) {
      setClientError('Please enter a job posting URL.')
      return
    }

    if (!isValidHttpUrl(trimmedJob)) {
      setClientError('Please enter a valid job posting URL (including https://).')
      return
    }

    const consumed = readFreeUsesConsumed()
    if (isTrialCapped && consumed >= FREE_BRIEF_LIMIT) {
      void logTrialBlockedToServer(trimmedJob, consumed)
      setClientError(
        'You have used all free briefs for this browser. Paid access is coming soon.',
      )
      return
    }

    setLoading(true)
    setMarkdown('')
    setResponseTimeMs(null)
    scrollOnStreamRef.current = false

    const endpoint = apiUrl('/api/research/stream')
    const t0 = performance.now()
    console.log('[prepbrief] Generate Brief: streaming POST', {
      endpoint,
      jobUrl: trimmedJob,
    })

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ jobUrl: trimmedJob }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.log('[prepbrief] stream request failed', {
          status: res.status,
          error: data.error,
          elapsedMs: Math.round(performance.now() - t0),
        })
        setMarkdown(null)
        setApiError(
          typeof data.error === 'string'
            ? data.error
            : `Something went wrong (${res.status}). Try again.`,
        )
        return
      }

      if (!res.body) {
        setMarkdown(null)
        setApiError('No response body from the server.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawDone = false
      let streamError = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sep
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawBlock = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of rawBlock.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let payload
            try {
              payload = JSON.parse(line.slice(6))
            } catch {
              console.warn('[prepbrief] bad SSE JSON', line)
              continue
            }

            if (payload.type === 'text' && payload.text) {
              setMarkdown((prev) => {
                const next = (prev || '') + payload.text
                return next
              })
              if (!scrollOnStreamRef.current) {
                scrollOnStreamRef.current = true
                requestAnimationFrame(() => {
                  outputRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                })
              }
            } else if (payload.type === 'phase') {
              console.log('[prepbrief] stream phase', payload.phase)
            } else if (payload.type === 'done') {
              sawDone = true
              const totalMs = Math.round(performance.now() - t0)
              setResponseTimeMs(totalMs)
              if (isTrialCapped) {
                const next = readFreeUsesConsumed() + 1
                writeFreeUsesConsumed(next)
                setFreeUsesConsumed(next)
              }
              console.log('[prepbrief] stream done', {
                totalElapsedMs: totalMs,
                serverElapsedMs: payload.elapsedMs,
              })
            } else if (payload.type === 'error') {
              streamError =
                typeof payload.message === 'string'
                  ? payload.message
                  : 'Stream reported an error.'
              if (payload.code) {
                console.warn('[prepbrief] stream error code', payload.code)
              }
            }
          }
        }
      }

      if (streamError) {
        setApiError(streamError)
      } else if (!sawDone) {
        setApiError('Stream ended before the brief was complete. Try again.')
      }
    } catch (err) {
      console.error('[prepbrief] fetch failed', err)
      setMarkdown(null)
      setApiError(
        'Could not reach the server. Make sure the API is running (e.g. npm start on port 3000).',
      )
    } finally {
      setLoading(false)
    }
  }

  const briefSections =
    markdown !== null ? splitBriefIntoSections(markdown) : []

  const markdownComponents = {
    table: ({ children, ...props }) => (
      <div className="table-wrap">
        <table {...props}>{children}</table>
      </div>
    ),
  }

  return (
    <div className="app">
      <header className="site-header">
        <h1>PrepBrief</h1>
        <p className="tagline">
          Paste a job posting link — we identify the company and prep you for the
          interview.
        </p>
      </header>

      <main>
        <form className="card" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="jobUrl">Job posting URL</label>
            <input
              id="jobUrl"
              name="jobUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://jobs.lever.co/… or Greenhouse, Ashby, LinkedIn, etc."
              value={jobUrl}
              onChange={(ev) => setJobUrl(ev.target.value)}
              disabled={loading || trialExhausted}
            />
            <p className="field-hint">
              We read the posting to find the employer, then build your company
              brief and role-specific talking points.
            </p>
            <p className="uses-remaining" aria-live="polite">
              {!isTrialCapped ? (
                <span className="uses-remaining--dev">
                  Development: unlimited briefs. The {FREE_BRIEF_LIMIT}-brief
                  limit applies in production builds only.
                </span>
              ) : trialExhausted ? (
                <span className="uses-remaining--exhausted">
                  No free briefs left on this browser.
                </span>
              ) : (
                <>
                  <strong>{freeUsesRemaining}</strong> of {FREE_BRIEF_LIMIT}{' '}
                  free briefs left.
                </>
              )}
            </p>
          </div>

          {trialExhausted && (
            <div className="paywall-card" role="region" aria-label="Upgrade">
              <p className="paywall-title">Thanks for trying PrepBrief</p>
              <p className="paywall-copy">
                You have used all {FREE_BRIEF_LIMIT} free generations in this
                browser. We are building paid plans — check back soon or reach
                out if you want early access.
              </p>
            </div>
          )}

          <div className="submit-row">
            <button
              type="submit"
              className="btn-primary"
              disabled={loading || trialExhausted}
            >
              Generate Brief
            </button>
            {loading && (
              <div className="loading-inline" aria-live="polite">
                <span className="spinner" aria-hidden />
                {markdown === ''
                  ? 'Starting research…'
                  : 'Streaming brief…'}
              </div>
            )}
          </div>

          {clientError && (
            <p className="message message-error" role="alert">
              {clientError}
            </p>
          )}
          {apiError && (
            <p className="message message-error" role="alert">
              {apiError}
            </p>
          )}
        </form>

        {markdown !== null && (
          <section
            className="output-section"
            ref={outputRef}
            aria-label="Research brief"
          >
            <div className="output-header">
              <h2>Your brief</h2>
              {responseTimeMs != null && (
                <p className="response-time">
                  Total time: {formatResponseTime(responseTimeMs)}
                </p>
              )}
            </div>
            <div className="brief-stack">
              {briefSections.length === 0 ? (
                <article className="brief-section brief-section--pending">
                  <p className="brief-pending">Generating…</p>
                </article>
              ) : (
                briefSections.map((chunk, i) => (
                  <article key={i} className="brief-section">
                    <div className="markdown-output">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                      >
                        {chunk}
                      </ReactMarkdown>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="site-footer">Powered by Claude</footer>
    </div>
  )
}
