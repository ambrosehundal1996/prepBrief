import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import { BriefSectionCard } from './BriefSectionCard'
import { TopNav } from './components/TopNav.jsx'
import AboutPage from './pages/AboutPage.jsx'
import HowItWorksPage from './pages/HowItWorksPage.jsx'
import PricingPage from './pages/PricingPage.jsx'
import {
  extractStickyBriefHeader,
  getBriefSectionGroup,
  stripStructuralInstructionLines,
} from './briefDisplay'
import {
  MAX_SAVED_BRIEFS,
  deleteBriefFromHistory,
  loadBriefHistory,
  saveBriefToHistory,
} from './briefHistory'
import {
  clearStoredResume,
  loadStoredResumeFile,
  saveStoredResume,
} from './resumeStorage'
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

function isPdfResume(file) {
  if (!file) return false
  const n = file.name.toLowerCase()
  return file.type === 'application/pdf' || n.endsWith('.pdf')
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
  const [resumePanelOpen, setResumePanelOpen] = useState(false)
  const [activeSavedId, setActiveSavedId] = useState(null)
  const outputRef = useRef(null)
  const savedBriefsSectionRef = useRef(null)
  const resumeSectionRef = useRef(null)
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
    void clearStoredResume()
    setResumeFile(null)
    if (resumeInputRef.current) resumeInputRef.current.value = ''
  }, [])

  const openSavedBrief = useCallback((entry) => {
    setSavedBriefsPanelOpen(false)
    setResumePanelOpen(false)
    setMarkdown(entry.markdown)
    setResponseTimeMs(null)
    setJobUrl(entry.jobUrl)
    setActiveSavedId(entry.id)
    setApiError('')
    setClientError('')
    window.setTimeout(() => {
      outputRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    }, 150)
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
    setResumePanelOpen(false)
    setSavedBriefsPanelOpen(true)
  }, [])

  const toggleSavedBriefsPanel = useCallback(() => {
    setSavedBriefsPanelOpen((prev) => {
      const next = !prev
      if (next) setResumePanelOpen(false)
      return next
    })
  }, [])

  const toggleResumePanel = useCallback(() => {
    setResumePanelOpen((prev) => {
      const next = !prev
      if (next) setSavedBriefsPanelOpen(false)
      return next
    })
  }, [])

  const openResumePanel = useCallback(() => {
    setSavedBriefsPanelOpen(false)
    setResumePanelOpen(true)
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

  useEffect(() => {
    if (!resumePanelOpen) return
    const id = window.setTimeout(() => {
      resumeSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    }, 50)
    return () => clearTimeout(id)
  }, [resumePanelOpen])

  useEffect(() => {
    let cancelled = false
    void loadStoredResumeFile().then((file) => {
      if (!cancelled && file) {
        setResumeFile((current) => current ?? file)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!resumeFile) return
    void saveStoredResume(resumeFile).catch((err) => {
      console.warn('[prepbrief] could not persist resume to this browser', err)
    })
  }, [resumeFile])

  const resumePreviewUrl = useMemo(() => {
    if (!resumeFile) return null
    return URL.createObjectURL(resumeFile)
  }, [resumeFile])

  useEffect(() => {
    return () => {
      if (resumePreviewUrl) URL.revokeObjectURL(resumePreviewUrl)
    }
  }, [resumePreviewUrl])

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

    if (!resumeFile) {
      setClientError(
        'Please upload your resume (PDF or .docx). It is required for every brief.',
      )
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
    formData.append('resume', resumeFile)

    console.log('[prepbrief] Generate Brief: streaming POST', {
      endpoint,
      jobUrl: trimmedJob,
      hasResume: true,
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

  const cleanedBriefMarkdown = useMemo(() => {
    if (markdown === null || typeof markdown !== 'string') return ''
    return stripStructuralInstructionLines(markdown)
  }, [markdown])

  const briefSections = useMemo(() => {
    if (markdown === null || typeof markdown !== 'string') return []
    return splitBriefIntoSections(cleanedBriefMarkdown)
  }, [markdown, cleanedBriefMarkdown])

  const sectionNavItems = useMemo(
    () =>
      briefSections.map((chunk, i) => {
        const title = getSectionTitle(chunk)
        const slug = sectionSlug(title) || `section-${i + 1}`
        return {
          id: `brief-section-${slug}-${i + 1}`,
          title,
        }
      }),
    [briefSections],
  )

  const [activeBriefNavId, setActiveBriefNavId] = useState(null)

  useEffect(() => {
    if (sectionNavItems.length === 0) {
      setActiveBriefNavId(null)
      return
    }

    const navThresholdPx = () => {
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize || '16',
      )
      if (!Number.isFinite(rem) || rem <= 0) return 96
      return 3.25 * rem + rem + 8
    }

    let raf = 0
    const updateActive = () => {
      const threshold = navThresholdPx()
      let current = sectionNavItems[0].id
      for (const item of sectionNavItems) {
        const el = document.getElementById(item.id)
        if (!el) continue
        if (el.getBoundingClientRect().top <= threshold) current = item.id
      }
      setActiveBriefNavId((prev) => (prev === current ? prev : current))
    }

    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(updateActive)
    }

    updateActive()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
    }
  }, [sectionNavItems])

  const stickyBriefContext = useMemo(() => {
    const md =
      typeof markdown === 'string' ? cleanedBriefMarkdown || markdown : ''
    return extractStickyBriefHeader(md, jobUrl)
  }, [cleanedBriefMarkdown, markdown, jobUrl])

  const markdownComponents = useMemo(
    () => ({
      table: ({ children, ...props }) => (
        <div className="table-wrap">
          <table {...props}>{children}</table>
        </div>
      ),
      img: ({ src, alt, ...rest }) => {
        if (src === 'prepbrief:badge-likely') {
          return (
            <span className="badge badge-likely">{alt || 'Likely'}</span>
          )
        }
        if (src === 'prepbrief:badge-curveball') {
          return (
            <span className="badge badge-curveball">{alt || 'Curveball'}</span>
          )
        }
        return <img src={src} alt={alt ?? ''} {...rest} />
      },
      a: ({ href, children, ...rest }) => {
        if (href === 'prepbrief:lbl-why') {
          return (
            <span className="brief-label brief-label--why">{children}</span>
          )
        }
        if (href === 'prepbrief:lbl-how') {
          return (
            <span className="brief-label brief-label--how">{children}</span>
          )
        }
        if (href === 'prepbrief:lbl-watch') {
          return (
            <span className="brief-label brief-label--watch">{children}</span>
          )
        }
        if (
          typeof href === 'string' &&
          (href.startsWith('http://') || href.startsWith('https://'))
        ) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          )
        }
        return (
          <a href={href} {...rest}>
            {children}
          </a>
        )
      },
    }),
    [],
  )

  return (
    <div className="layout">
      <div className="layout-shell">
        <aside className="sidebar" aria-label="Site">
          <Link to="/" className="sidebar-brand">
            PrepBrief
          </Link>
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
          {import.meta.env.DEV && (
            <span className="sidebar-pill sidebar-pill--dev">Dev · unlimited</span>
          )}
          <p className="sidebar-nav-label">Navigate</p>
          <nav className="sidebar-nav" aria-label="Main navigation">
            <Link
              to="/#create-brief"
              className="sidebar-link"
              onClick={() => {
                setSavedBriefsPanelOpen(false)
                setResumePanelOpen(false)
              }}
            >
              Create brief
            </Link>
            {markdown !== null && (
              <Link
                to="/#your-brief"
                className="sidebar-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                Your brief
              </Link>
            )}
            <button
              type="button"
              className={
                resumePanelOpen
                  ? 'sidebar-link sidebar-link--active'
                  : 'sidebar-link'
              }
              aria-expanded={resumePanelOpen}
              onClick={toggleResumePanel}
            >
              My resume
            </button>
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
          <TopNav />
          <div className="app">
            <Routes>
              <Route
                path="/"
                element={
                  <>
                    {!savedBriefsPanelOpen && !resumePanelOpen && (
          <header className="site-header">
            <h1 className="site-title">
              From job link to interview-ready in 60 seconds.
            </h1>
            <p className="tagline">
              No research. No guessing. Just paste and go.
            </p>
          </header>
        )}

        <main id="top">
        <input
          ref={resumeInputRef}
          id="resumeFile"
          name="resume"
          type="file"
          accept={RESUME_ACCEPT}
          className="resume-file-input"
          tabIndex={-1}
          disabled={loading}
          aria-label="Resume file: PDF or .docx, required for each brief"
          onChange={(ev) => setResumeFromFileList(ev.target.files)}
        />
        {!savedBriefsPanelOpen && !resumePanelOpen && (
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
              {import.meta.env.DEV && !isTrialCapped ? (
                <span className="uses-remaining--dev">
                  <em>
                    Development: unlimited briefs. The {FREE_BRIEF_LIMIT}-brief
                    limit applies in production builds only.
                  </em>
                </span>
              ) : isTrialCapped && trialExhausted ? (
                <span className="uses-remaining--exhausted">
                  No free briefs left on this browser.
                </span>
              ) : isTrialCapped ? (
                <>
                  <strong>{freeUsesRemaining}</strong> of {FREE_BRIEF_LIMIT}{' '}
                  free briefs left.
                </>
              ) : null}
            </p>
          </div>

          {!resumeFile && (
            <div className="field">
              <span className="field-label" id="resume-field-heading">
                Resume{' '}
                <span className="field-required" aria-hidden="true">
                  *
                </span>
              </span>
              <button
                type="button"
                className="resume-dropzone"
                disabled={loading || trialExhausted}
                aria-labelledby="resume-field-heading"
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
                <span className="resume-dropzone__main">
                  Drop your resume here or click to browse
                  <span className="resume-dropzone__sub">
                    PDF or .docx — required; we tailor every brief to your
                    background
                  </span>
                </span>
              </button>
              <p className="field-hint">
                After you upload once, we keep your resume in this browser so you
                do not have to add it here again. Use <strong>My resume</strong>{' '}
                in the sidebar to preview or replace it.
              </p>
            </div>
          )}

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
              disabled={loading || trialExhausted || !resumeFile}
            >
              Generate my brief →
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
            {briefSections.length > 0 && markdown !== '' && (
              <div className="sticky-brief-header" role="status">
                <span className="sticky-brief-header-company">
                  {stickyBriefContext.company}
                </span>
                <span className="sticky-brief-header-sep" aria-hidden>
                  ·
                </span>
                <span className="sticky-brief-header-role">
                  {stickyBriefContext.role}
                </span>
              </div>
            )}
            <div
              className={
                sectionNavItems.length > 0
                  ? 'brief-layout'
                  : 'brief-layout brief-layout--content-only'
              }
            >
              {sectionNavItems.length > 0 && (
                <nav className="toc-vertical" aria-label="Brief sections">
                  <p className="toc-vertical-title">Jump to</p>
                  <ul className="toc-vertical-list">
                    {sectionNavItems.map((item) => {
                      const isActive = activeBriefNavId === item.id
                      return (
                        <li key={item.id}>
                          <a
                            className={
                              isActive ? 'toc-tab toc-tab--active' : 'toc-tab'
                            }
                            href={`#${item.id}`}
                            aria-current={isActive ? 'location' : undefined}
                          >
                            {item.title}
                          </a>
                        </li>
                      )
                    })}
                  </ul>
                </nav>
              )}
              <div className="brief-stack">
                {briefSections.length === 0 ? (
                  <article className="brief-section brief-section--pending">
                    <p className="brief-pending">Generating…</p>
                  </article>
                ) : (
                  (() => {
                    let prevGroup = null
                    return briefSections.flatMap((chunk, i) => {
                      const title = getSectionTitle(chunk)
                      const id = sectionNavItems[i].id
                      const group = getBriefSectionGroup(title)
                      const pieces = []
                      if (group && group !== prevGroup) {
                        pieces.push(
                          <p
                            key={`group-${id}`}
                            className="section-group-label"
                          >
                            {group === 'interview'
                              ? 'Interview preparation'
                              : 'Company context'}
                          </p>,
                        )
                        prevGroup = group
                      } else if (!group) {
                        prevGroup = null
                      }
                      pieces.push(
                        <BriefSectionCard
                          key={id}
                          id={id}
                          title={title}
                          chunk={chunk}
                          markdownComponents={markdownComponents}
                        />,
                      )
                      return pieces
                    })
                  })()
                )}
              </div>
            </div>
          </section>
        )}

                    {!savedBriefsPanelOpen && !resumePanelOpen && (
                      <>
                        <section
                          className="home-stats-bar"
                          aria-label="PrepBrief summary"
                        >
                          <p>
                            Used by job seekers interviewing at Stripe, Google,
                            Anthropic, OpenAI, and 100+ companies
                          </p>
                        </section>

                        <section
                          className="home-before-after"
                          aria-labelledby="before-after-heading"
                        >
                          <h2 id="before-after-heading" className="visually-hidden">
                            Before and after PrepBrief
                          </h2>
                          <div className="home-before-after-grid">
                            <div className="home-ba-card home-ba-card--before card">
                              <h3 className="home-ba-title">Without PrepBrief</h3>
                              <ul className="home-ba-list">
                                <li>
                                  Open 8 tabs — company site, LinkedIn, Crunchbase,
                                  Glassdoor, news articles
                                </li>
                                <li>
                                  Spend 45 minutes piecing together a basic picture
                                </li>
                                <li>
                                  Still not sure what to say or how to present
                                  yourself
                                </li>
                                <li>Walk in feeling underprepared</li>
                              </ul>
                            </div>
                            <div className="home-ba-card home-ba-card--after card">
                              <h3 className="home-ba-title">With PrepBrief</h3>
                              <ul className="home-ba-list">
                                <li>Paste one job posting link</li>
                                <li>Wait 60 seconds</li>
                                <li>
                                  Read a 2-minute personalized cheat sheet
                                </li>
                                <li>Walk in feeling like an insider</li>
                              </ul>
                            </div>
                          </div>
                        </section>

                        <section
                          className="home-what-you-get"
                          aria-labelledby="what-you-get-heading"
                        >
                          <h2 id="what-you-get-heading" className="home-wyg-heading">
                            What you get
                          </h2>
                          <div className="home-wyg-grid">
                            <article className="home-wyg-card card">
                              <h3 className="home-wyg-card-title">
                                Know what&apos;s coming
                              </h3>
                              <p className="home-wyg-card-copy">
                                We predict the specific questions this company is
                                likely to ask — based on their stage, culture, and
                                the role — not generic prep advice.
                              </p>
                            </article>
                            <article className="home-wyg-card card">
                              <h3 className="home-wyg-card-title">
                                Your personal script
                              </h3>
                              <p className="home-wyg-card-copy">
                                Get a tailored &quot;tell me about yourself&quot;
                                framework built from your resume and the job
                                description. Know exactly what to lead with.
                              </p>
                            </article>
                            <article className="home-wyg-card card">
                              <h3 className="home-wyg-card-title">
                                Sound like an insider
                              </h3>
                              <p className="home-wyg-card-copy">
                                Understand what the company is focused on right now
                                — the strategic bet, the problem they solve, why
                                you&apos;re genuinely interested. Reference it in
                                the interview.
                              </p>
                            </article>
                          </div>
                        </section>
                      </>
                    )}

        {resumePanelOpen && (
          <section
            id="my-resume"
            ref={resumeSectionRef}
            className="card saved-briefs-card resume-panel"
            aria-labelledby="resume-panel-heading"
          >
            <div className="saved-briefs-header">
              <h2 id="resume-panel-heading" className="saved-briefs-title">
                My resume
              </h2>
              <button
                type="button"
                className="saved-briefs-close"
                onClick={() => setResumePanelOpen(false)}
                aria-label="Close resume panel"
              >
                Close
              </button>
            </div>
            <p className="saved-briefs-hint">
              Your resume is kept in this browser (IndexedDB). After you upload
              once, it is reused for every new brief until you replace or remove
              it.
            </p>
            {resumeFile && resumePreviewUrl ? (
              <div className="resume-panel-body">
                <p className="resume-panel-meta">
                  <strong>{resumeFile.name}</strong>
                  <span className="resume-panel-meta-sep" aria-hidden>
                    ·
                  </span>
                  {isPdfResume(resumeFile) ? 'PDF' : 'Word document'}
                </p>
                {isPdfResume(resumeFile) ? (
                  <div className="resume-preview-wrap">
                    <iframe
                      title="Resume PDF preview"
                      className="resume-preview-frame"
                      src={resumePreviewUrl}
                    />
                  </div>
                ) : (
                  <p className="resume-panel-docx-note">
                    In-browser preview is not available for .docx files. Your file
                    is saved and sent with each brief.{' '}
                    <a
                      href={resumePreviewUrl}
                      download={resumeFile.name}
                      className="resume-panel-download"
                    >
                      Download copy
                    </a>
                  </p>
                )}
                <div className="resume-panel-actions">
                  <button
                    type="button"
                    className="saved-briefs-close"
                    disabled={loading}
                    onClick={() => resumeInputRef.current?.click()}
                  >
                    Upload different resume
                  </button>
                  <button
                    type="button"
                    className="btn-text resume-panel-remove"
                    disabled={loading}
                    onClick={clearResume}
                  >
                    Remove from PrepBrief
                  </button>
                </div>
              </div>
            ) : (
              <div className="resume-panel-empty">
                <p className="resume-panel-empty-copy">
                  No resume on file yet. Upload a PDF or .docx—required before you
                  can generate a brief.
                </p>
                <button
                  type="button"
                  className="resume-dropzone resume-panel-dropzone"
                  disabled={loading}
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
                  <span className="resume-dropzone__main">
                    Drop your resume here or click to browse
                    <span className="resume-dropzone__sub">
                      PDF or .docx — max about 4 MB
                    </span>
                  </span>
                </button>
              </div>
            )}
          </section>
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
          <p className="saved-briefs-warning">
            Clearing your browser data or switching devices will remove your saved
            briefs.
          </p>
          {savedBriefs.length === 0 ? (
            <div className="saved-briefs-empty-state">
              <div className="saved-briefs-empty-icon" aria-hidden>
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </div>
              <p className="saved-briefs-empty-title">No saved briefs yet</p>
              <Link
                to="/#create-brief"
                className="saved-briefs-empty-cta"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                Generate your first brief to get started →
              </Link>
            </div>
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

        </main>
                  </>
                }
              />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/how-it-works" element={<HowItWorksPage />} />
              <Route path="/pricing" element={<PricingPage />} />
            </Routes>
          </div>

          <footer className="site-footer" role="contentinfo">
        <div className="site-footer-inner">
          <div className="site-footer-top">
            <div className="site-footer-brand-block">
              <span className="site-footer-brand">PrepBrief</span>
              <p className="site-footer-blurb">
                Stop spending an hour on company research. Get interview-ready in 60
                seconds.
              </p>
            </div>
            <nav className="site-footer-nav" aria-label="Footer">
              <Link
                to="/#create-brief"
                className="site-footer-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                Create brief
              </Link>
              {markdown !== null && (
                <Link
                  to="/#your-brief"
                  className="site-footer-link"
                  onClick={() => {
                    setSavedBriefsPanelOpen(false)
                    setResumePanelOpen(false)
                  }}
                >
                  Your brief
                </Link>
              )}
              <Link
                to="/how-it-works"
                className="site-footer-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                How it works
              </Link>
              <Link
                to="/about"
                className="site-footer-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                About
              </Link>
              <Link
                to="/pricing"
                className="site-footer-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                Pricing
              </Link>
              <Link
                to="/"
                className="site-footer-link"
                onClick={() => {
                  setSavedBriefsPanelOpen(false)
                  setResumePanelOpen(false)
                }}
              >
                Overview
              </Link>
              <a
                href="#my-resume"
                className="site-footer-link"
                onClick={(e) => {
                  e.preventDefault()
                  openResumePanel()
                }}
              >
                My resume
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
