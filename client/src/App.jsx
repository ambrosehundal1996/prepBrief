import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  MAX_SAVED_BRIEFS,
  deleteBriefFromHistory,
  loadBriefHistory,
  saveBriefToHistory,
} from './briefHistory'
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

function formatSavedAt(iso) {
  if (!iso || typeof iso !== 'string') return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/** Split brief markdown into chunks at top-level ## headings (one card per section). */
function splitBriefIntoSections(md) {
  if (typeof md !== 'string' || !md.trim()) return []
  const parts = md.split(/\n(?=## )/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function getSectionTitle(sectionMarkdown) {
  if (typeof sectionMarkdown !== 'string') return 'Section'
  const match = sectionMarkdown.match(/^##\s+(.+)$/m)
  return match?.[1]?.trim() || 'Section'
}

function sectionSlug(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

const RESUME_ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function TopNav({
  markdown,
  savedBriefs,
  savedBriefsPanelOpen,
  onLeaveSavedView,
  onToggleSavedBriefs,
}) {
  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <a
          href="#top"
          className="top-nav-brand"
          onClick={onLeaveSavedView}
        >
          PrepBrief
        </a>
        <nav className="top-nav-links" aria-label="Primary navigation">
          <a
            href="#create-brief"
            className="top-nav-link"
            onClick={onLeaveSavedView}
          >
            Create brief
          </a>
          {markdown !== null && (
            <a href="#your-brief" className="top-nav-link">
              Your brief
            </a>
          )}
          <a
            href="#top"
            className="top-nav-link top-nav-link--muted"
            onClick={onLeaveSavedView}
          >
            Overview
          </a>
          <button
            type="button"
            className={
              savedBriefsPanelOpen
                ? 'top-nav-link top-nav-link--muted top-nav-link--active'
                : 'top-nav-link top-nav-link--muted'
            }
            aria-expanded={savedBriefsPanelOpen}
            onClick={onToggleSavedBriefs}
          >
            Saved briefs
            {savedBriefs.length > 0 && (
              <span className="top-nav-count">{savedBriefs.length}</span>
            )}
          </button>
        </nav>
      </div>
    </header>
  )
}

function isAllowedResumeFile(file) {
  if (!file || typeof file.name !== 'string') return false
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.pdf') || lower.endsWith('.docx')) return true
  const t = (file.type || '').toLowerCase()
  return (
    t === 'application/pdf' ||
    t ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
}

export default function App() {
  const [jobUrl, setJobUrl] = useState('')
  const [resumeFile, setResumeFile] = useState(null)
  const [resumeDragActive, setResumeDragActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [clientError, setClientError] = useState('')
  const [apiError, setApiError] = useState('')
  const [markdown, setMarkdown] = useState(null)
  const [responseTimeMs, setResponseTimeMs] = useState(null)
  const [freeUsesConsumed, setFreeUsesConsumed] = useState(() =>
    isTrialCapped ? readFreeUsesConsumed() : 0,
  )
  const [savedBriefs, setSavedBriefs] = useState(() => loadBriefHistory())
  const [savedBriefsPanelOpen, setSavedBriefsPanelOpen] = useState(false)
  const [activeSavedId, setActiveSavedId] = useState(null)
  const outputRef = useRef(null)
  const savedBriefsSectionRef = useRef(null)
  const scrollOnStreamRef = useRef(false)
  const streamMdRef = useRef('')
  const resumeInputRef = useRef(null)

  const setResumeFromFileList = useCallback((fileList) => {
    const file = fileList?.[0]
    if (!file) return
    if (!isAllowedResumeFile(file)) {
      setClientError('Please upload a PDF or .docx resume.')
      return
    }
    setClientError('')
    setResumeFile(file)
  }, [])

  const clearResume = useCallback(() => {
    setResumeFile(null)
    if (resumeInputRef.current) resumeInputRef.current.value = ''
  }, [])

  const openSavedBrief = useCallback((entry) => {
    setSavedBriefsPanelOpen(false)
    setMarkdown(entry.markdown)
    setResponseTimeMs(null)
    setJobUrl(entry.jobUrl)
    setActiveSavedId(entry.id)
    setApiError('')
    setClientError('')
    requestAnimationFrame(() => {
      outputRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }, [])

  const handleDeleteSaved = useCallback((id) => {
    const next = deleteBriefFromHistory(id)
    setSavedBriefs(next)
    if (activeSavedId === id) {
      setActiveSavedId(null)
      setMarkdown(null)
    }
  }, [activeSavedId])

  const openSavedBriefsPanel = useCallback(() => {
    setSavedBriefsPanelOpen(true)
  }, [])

  const toggleSavedBriefsPanel = useCallback(() => {
    setSavedBriefsPanelOpen((prev) => !prev)
  }, [])

  useEffect(() => {
    if (!savedBriefsPanelOpen) return
    const id = window.setTimeout(() => {
      savedBriefsSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    }, 50)
    return () => clearTimeout(id)
  }, [savedBriefsPanelOpen])

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
    streamMdRef.current = ''
    setResponseTimeMs(null)
    scrollOnStreamRef.current = false
    setActiveSavedId(null)

    const endpoint = apiUrl('/api/research/stream')
    const t0 = performance.now()
    const formData = new FormData()
    formData.append('jobUrl', trimmedJob)
    if (resumeFile) formData.append('resume', resumeFile)

    console.log('[prepbrief] Generate Brief: streaming POST', {
      endpoint,
      jobUrl: trimmedJob,
      hasResume: Boolean(resumeFile),
    })

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
        },
        body: formData,
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
                streamMdRef.current = next
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
      } else {
        const finalMd = streamMdRef.current.trim()
        if (finalMd) {
          const { items } = saveBriefToHistory({
            jobUrl: trimmedJob,
            markdown: finalMd,
          })
          setSavedBriefs(items)
        }
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
  const sectionNavItems = briefSections.map((chunk, i) => {
    const title = getSectionTitle(chunk)
    const slug = sectionSlug(title) || `section-${i + 1}`
    return {
      id: `brief-section-${slug}-${i + 1}`,
      title,
    }
  })

  const markdownComponents = {
    table: ({ children, ...props }) => (
      <div className="table-wrap">
        <table {...props}>{children}</table>
      </div>
    ),
  }

  return (
    <div className="layout">
      <div className="layout-shell">
        <aside className="sidebar" aria-label="Site">
          <a href="#top" className="sidebar-brand">
            PrepBrief
          </a>
          {isTrialCapped && (
            <span
              className={
                trialExhausted
                  ? 'sidebar-pill sidebar-pill--exhausted'
                  : 'sidebar-pill'
              }
              aria-live="polite"
            >
              {trialExhausted
                ? 'No free briefs left'
                : `${freeUsesRemaining} free brief${freeUsesRemaining === 1 ? '' : 's'} left`}
            </span>
          )}
          {!isTrialCapped && (
            <span className="sidebar-pill sidebar-pill--dev">Dev · unlimited</span>
          )}
          <p className="sidebar-nav-label">Navigate</p>
          <nav className="sidebar-nav" aria-label="Main navigation">
            <a
              href="#create-brief"
              className="sidebar-link"
              onClick={() => setSavedBriefsPanelOpen(false)}
            >
              Create brief
            </a>
            {markdown !== null && (
              <a href="#your-brief" className="sidebar-link">
                Your brief
              </a>
            )}
            <a
              href="#top"
              className="sidebar-link sidebar-link--muted"
              onClick={() => setSavedBriefsPanelOpen(false)}
            >
              Overview
            </a>
            <button
              type="button"
              className={
                savedBriefsPanelOpen
                  ? 'sidebar-link sidebar-link--muted sidebar-link--active'
                  : 'sidebar-link sidebar-link--muted'
              }
              aria-expanded={savedBriefsPanelOpen}
              onClick={toggleSavedBriefsPanel}
            >
              Saved briefs
              {savedBriefs.length > 0 && (
                <span className="sidebar-count">{savedBriefs.length}</span>
              )}
            </button>
          </nav>
        </aside>

        <div className="layout-main">
          <TopNav
            markdown={markdown}
            savedBriefs={savedBriefs}
            savedBriefsPanelOpen={savedBriefsPanelOpen}
            onLeaveSavedView={() => setSavedBriefsPanelOpen(false)}
            onToggleSavedBriefs={toggleSavedBriefsPanel}
          />
          <div className="app">
        {!savedBriefsPanelOpen && (
          <header className="site-header">
            <h1 className="site-title">Interview-ready company briefs</h1>
            <p className="tagline">
              Paste a job posting link — we identify the company and prep you for
              the interview. Add your resume for tailored talking points.
            </p>
          </header>
        )}

        <main id="top">
        {!savedBriefsPanelOpen && (
        <form
          id="create-brief"
          className="card"
          onSubmit={handleSubmit}
          noValidate
        >
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

          <div className="field">
            <span className="field-label" id="resume-label">
              Resume <span className="field-optional">(optional)</span>
            </span>
            <input
              ref={resumeInputRef}
              id="resumeFile"
              name="resume"
              type="file"
              accept={RESUME_ACCEPT}
              className="resume-file-input"
              disabled={loading || trialExhausted}
              aria-labelledby="resume-label"
              onChange={(ev) =>
                setResumeFromFileList(ev.target.files)
              }
            />
            <button
              type="button"
              className="resume-dropzone"
              disabled={loading || trialExhausted}
              aria-labelledby="resume-label"
              data-active={resumeDragActive ? 'true' : undefined}
              onClick={() => resumeInputRef.current?.click()}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  resumeInputRef.current?.click()
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setResumeDragActive(true)
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setResumeDragActive(false)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setResumeDragActive(false)
                setResumeFromFileList(e.dataTransfer.files)
              }}
            >
              {resumeFile ? (
                <span className="resume-dropzone__main">
                  <strong>{resumeFile.name}</strong>
                  <span className="resume-dropzone__sub">
                    Click to replace, or drop a new file
                  </span>
                </span>
              ) : (
                <span className="resume-dropzone__main">
                  Drop your resume here or click to browse
                  <span className="resume-dropzone__sub">
                    PDF or .docx — used to tailor talking points to your
                    background
                  </span>
                </span>
              )}
            </button>
            {resumeFile && (
              <div className="resume-actions">
                <button
                  type="button"
                  className="btn-text"
                  disabled={loading || trialExhausted}
                  onClick={clearResume}
                >
                  Remove file
                </button>
              </div>
            )}
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
        )}

        {savedBriefsPanelOpen && (
        <section
          id="saved-briefs"
          ref={savedBriefsSectionRef}
          className="card saved-briefs-card"
          aria-labelledby="saved-briefs-heading"
        >
          <div className="saved-briefs-header">
            <h2 id="saved-briefs-heading" className="saved-briefs-title">
              Saved briefs
            </h2>
            <button
              type="button"
              className="saved-briefs-close"
              onClick={() => setSavedBriefsPanelOpen(false)}
              aria-label="Close saved briefs"
            >
              Close
            </button>
          </div>
          <p className="saved-briefs-hint">
            Stored only in this browser (localStorage). Up to {MAX_SAVED_BRIEFS}{' '}
            briefs; oldest are removed if you hit the limit.
          </p>
          {savedBriefs.length === 0 ? (
            <p className="saved-briefs-empty">
              No saved briefs yet. Choose <strong>Create brief</strong> in the
              sidebar to generate one — it will appear here automatically.
            </p>
          ) : (
            <ul className="saved-briefs-list">
              {savedBriefs.map((entry) => (
                <li key={entry.id} className="saved-briefs-item">
                  <div className="saved-briefs-item-main">
                    <span className="saved-briefs-company">{entry.companyName}</span>
                    <span className="saved-briefs-meta">
                      {formatSavedAt(entry.savedAt)}
                      {entry.jobUrl ? (
                        <>
                          {' · '}
                          <span className="saved-briefs-host" title={entry.jobUrl}>
                            {(() => {
                              try {
                                return new URL(entry.jobUrl).hostname.replace(
                                  /^www\./,
                                  '',
                                )
                              } catch {
                                return 'Job link'
                              }
                            })()}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="saved-briefs-actions">
                    <button
                      type="button"
                      className="saved-briefs-btn"
                      onClick={() => openSavedBrief(entry)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="saved-briefs-btn saved-briefs-btn--danger"
                      onClick={() => handleDeleteSaved(entry.id)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        {markdown !== null && (
          <section
            id="your-brief"
            className="output-section"
            ref={outputRef}
            aria-label="Research brief"
          >
            {activeSavedId && (
              <div className="history-banner" role="status">
                <span>Viewing a saved brief from this browser.</span>
                <button
                  type="button"
                  className="history-banner-dismiss"
                  onClick={() => {
                    setActiveSavedId(null)
                    setMarkdown(null)
                  }}
                >
                  Close
                </button>
              </div>
            )}
            <div className="output-header">
              <h2>Your brief</h2>
              {responseTimeMs != null && (
                <p className="response-time">
                  Total time: {formatResponseTime(responseTimeMs)}
                </p>
              )}
            </div>
            {sectionNavItems.length > 0 && (
              <nav className="section-jump-nav" aria-label="Jump to brief section">
                {sectionNavItems.map((item) => (
                  <a key={item.id} className="section-jump-link" href={`#${item.id}`}>
                    {item.title}
                  </a>
                ))}
              </nav>
            )}
            <div className="brief-stack">
              {briefSections.length === 0 ? (
                <article className="brief-section brief-section--pending">
                  <p className="brief-pending">Generating…</p>
                </article>
              ) : (
                briefSections.map((chunk, i) => (
                  <article key={i} id={sectionNavItems[i].id} className="brief-section">
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
          </div>

          <footer className="site-footer" role="contentinfo">
        <div className="site-footer-inner">
          <div className="site-footer-top">
            <div className="site-footer-brand-block">
              <span className="site-footer-brand">PrepBrief</span>
              <p className="site-footer-blurb">
                Company research and talking points tailored to each role.
              </p>
            </div>
            <nav className="site-footer-nav" aria-label="Footer">
              <a
                href="#create-brief"
                className="site-footer-link"
                onClick={() => setSavedBriefsPanelOpen(false)}
              >
                Create brief
              </a>
              {markdown !== null && (
                <a href="#your-brief" className="site-footer-link">
                  Your brief
                </a>
              )}
              <a href="#top" className="site-footer-link">
                Overview
              </a>
              <a
                href="#saved-briefs"
                className="site-footer-link"
                onClick={(e) => {
                  e.preventDefault()
                  openSavedBriefsPanel()
                }}
              >
                Saved briefs
              </a>
            </nav>
          </div>
          <div className="site-footer-bottom">
            <span>
              © {new Date().getFullYear()} PrepBrief. All rights reserved.
            </span>
            <span className="site-footer-sep" aria-hidden="true">
              ·
            </span>
            <span>Powered by Claude</span>
          </div>
        </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
