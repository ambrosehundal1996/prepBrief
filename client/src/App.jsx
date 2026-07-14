import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import { BriefSectionCard } from './BriefSectionCard'
import { TopNav } from './components/TopNav.jsx'
import AboutPage from './pages/AboutPage.jsx'
import HowItWorksPage from './pages/HowItWorksPage.jsx'
import PricingPage from './pages/PricingPage.jsx'
import {
  extractStickyBriefHeader,
  getBriefNavMeta,
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
import { PREPBRIEF_LOGO_SRC } from './brand.js'
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
const DEMO_VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime'

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

/** SSE phase → narration shown while the pipeline runs. */
const PHASE_NARRATION = {
  scraping_jd: 'Reading the job posting…',
  identifying_company: 'Identifying the company…',
  research_news: 'Scanning recent news…',
  research_exec: 'Checking exec interviews…',
  research_hiring: 'Reading their hiring signals…',
  research_extra: 'Digging into their strategy…',
  generating_brief: 'Writing your brief…',
  model_retry: 'Reconnecting to the AI service…',
}

export default function App() {
  const [jobMode, setJobMode] = useState('url') // 'url' | 'paste' | 'file'
  const [jobUrl, setJobUrl] = useState('')
  const [jobText, setJobText] = useState('')
  const [jobFile, setJobFile] = useState(null)
  const [jobFileDragActive, setJobFileDragActive] = useState(false)
  const [resumeFile, setResumeFile] = useState(null)
  const [resumeDragActive, setResumeDragActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [phaseText, setPhaseText] = useState('')
  const [clientError, setClientError] = useState('')
  const [apiError, setApiError] = useState('')
  const [markdown, setMarkdown] = useState(null)
  const [responseTimeMs, setResponseTimeMs] = useState(null)
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
  const jobFileInputRef = useRef(null)
  const demoVideoInputRef = useRef(null)
  const [demoVideoFile, setDemoVideoFile] = useState(null)

  const setJobFileFromFileList = useCallback((fileList) => {
    const file = fileList?.[0]
    if (!file) return
    if (!isAllowedResumeFile(file)) {
      setClientError('Please upload the job description as a PDF or .docx file.')
      return
    }
    setClientError('')
    setJobFile(file)
  }, [])

  const switchJobMode = useCallback((mode) => {
    setJobMode(mode)
    setClientError('')
  }, [])

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

  const setDemoVideoFromFileList = useCallback((fileList) => {
    const file = fileList?.[0]
    if (!file) return
    if (!file.type?.startsWith('video/')) {
      setClientError('Please upload a video file for the homepage demo.')
      return
    }
    setClientError('')
    setDemoVideoFile(file)
  }, [])

  const openSavedBrief = useCallback((entry) => {
    setSavedBriefsPanelOpen(false)
    setResumePanelOpen(false)
    setMarkdown(entry.markdown)
    setBriefTab('prep')
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

  const demoVideoUrl = useMemo(() => {
    if (!demoVideoFile) return null
    return URL.createObjectURL(demoVideoFile)
  }, [demoVideoFile])

  useEffect(() => {
    return () => {
      if (resumePreviewUrl) URL.revokeObjectURL(resumePreviewUrl)
    }
  }, [resumePreviewUrl])

  useEffect(() => {
    return () => {
      if (demoVideoUrl) URL.revokeObjectURL(demoVideoUrl)
    }
  }, [demoVideoUrl])

  async function handleSubmit(e) {
    e.preventDefault()
    setClientError('')
    setApiError('')

    const trimmedJob = jobMode === 'url' ? jobUrl.trim() : ''
    const trimmedJobText = jobMode === 'paste' ? jobText.trim() : ''

    if (jobMode === 'url') {
      if (!trimmedJob) {
        setClientError('Please enter a job posting URL.')
        return
      }
      if (!isValidHttpUrl(trimmedJob)) {
        setClientError(
          'Please enter a valid job posting URL (including https://).',
        )
        return
      }
    } else if (jobMode === 'paste') {
      if (trimmedJobText.length < 100) {
        setClientError(
          'Please paste the full job description (at least a few sentences).',
        )
        return
      }
    } else if (jobMode === 'file') {
      if (!jobFile) {
        setClientError('Please upload the job description as a PDF or .docx.')
        return
      }
    }

    setLoading(true)
    setMarkdown('')
    streamMdRef.current = ''
    setResponseTimeMs(null)
    setPhaseText('')
    setBriefTab('prep')
    scrollOnStreamRef.current = false
    setActiveSavedId(null)

    const endpoint = apiUrl('/api/research/stream')
    const t0 = performance.now()
    const formData = new FormData()
    if (jobMode === 'url') {
      formData.append('jobUrl', trimmedJob)
    } else if (jobMode === 'paste') {
      formData.append('jobDescriptionText', trimmedJobText)
    } else {
      formData.append('jobDescriptionFile', jobFile)
    }
    if (resumeFile) formData.append('resume', resumeFile)

    console.log('[prepbrief] Generate Brief: streaming POST', {
      endpoint,
      jobMode,
      jobUrl: trimmedJob || undefined,
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
              const narration = PHASE_NARRATION[payload.phase]
              if (narration) setPhaseText(narration)
            } else if (payload.type === 'done') {
              sawDone = true
              const totalMs = Math.round(performance.now() - t0)
              setResponseTimeMs(totalMs)
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
      setPhaseText('')
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
        const { label, group } = getBriefNavMeta(title)
        return {
          id: `brief-section-${slug}-${i + 1}`,
          title,
          navLabel: label,
          navGroup: group,
        }
      }),
    [briefSections],
  )

  /** The two toggleable views; a tab disappears if it has no sections. */
  const briefTabs = useMemo(() => {
    const tabs = [
      { key: 'prep', label: 'Role specific', count: 0 },
      { key: 'company', label: 'Company overview', count: 0 },
    ]
    for (const item of sectionNavItems) {
      const tab = tabs.find((t) => t.key === item.navGroup) || tabs[0]
      tab.count += 1
    }
    return tabs.filter((t) => t.count > 0)
  }, [sectionNavItems])

  const [briefTab, setBriefTab] = useState('prep')

  // If the active tab has no sections (e.g. mid-stream), fall back to one that does.
  useEffect(() => {
    if (briefTabs.length === 0) return
    if (!briefTabs.some((t) => t.key === briefTab)) {
      setBriefTab(briefTabs[0].key)
    }
  }, [briefTabs, briefTab])

  const visibleNavItems = useMemo(
    () => sectionNavItems.filter((item) => item.navGroup === briefTab),
    [sectionNavItems, briefTab],
  )

  const switchBriefTab = useCallback((key) => {
    setBriefTab(key)
    requestAnimationFrame(() => {
      outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const [activeBriefNavId, setActiveBriefNavId] = useState(null)

  useEffect(() => {
    if (visibleNavItems.length === 0) {
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
      let current = visibleNavItems[0].id
      for (const item of visibleNavItems) {
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
  }, [visibleNavItems])

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
      // Bullets with nested detail bullets collapse behind the lead line, so
      // the brief scans as headlines and expands on demand.
      li: (props) => {
        // eslint-disable-next-line no-unused-vars
        const { children, node, ...rest } = props
        const kids = Children.toArray(children)
        const nestedIdx = kids.findIndex(
          (child) =>
            isValidElement(child) &&
            (child.type === 'ul' || child.type === 'ol'),
        )
        if (nestedIdx === -1) return <li {...rest}>{children}</li>
        return (
          <li className="brief-li-collapsible" {...rest}>
            <details className="brief-details">
              <summary className="brief-details-summary">
                {kids.slice(0, nestedIdx)}
              </summary>
              {kids.slice(nestedIdx)}
            </details>
          </li>
        )
      },
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
        <div className="layout-main">
          <TopNav
            hasBrief={markdown !== null}
            savedBriefsCount={savedBriefs.length}
            resumePanelOpen={resumePanelOpen}
            savedBriefsPanelOpen={savedBriefsPanelOpen}
            onClosePanels={() => {
              setSavedBriefsPanelOpen(false)
              setResumePanelOpen(false)
            }}
            onToggleResumePanel={toggleResumePanel}
            onOpenResumePanel={openResumePanel}
            onToggleSavedBriefsPanel={toggleSavedBriefsPanel}
            onOpenSavedBriefsPanel={openSavedBriefsPanel}
          />
          <div className="app">
            <Routes>
              <Route
                path="/"
                element={
                  <>
                    {!savedBriefsPanelOpen && !resumePanelOpen && (
          <header className="site-header">
            <h1 className="site-title">
              Walk into your interview knowing what they&apos;ll ask.
            </h1>
            <p className="tagline">
              A brief built from your resume and their job description — not
              generic advice. Ready in 60 seconds.
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
          aria-label="Resume file: PDF or .docx, optional — personalizes your brief"
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
            <span className="field-label" id="job-input-heading">
              Job posting
            </span>
            <div
              className="job-mode-toggle"
              role="group"
              aria-labelledby="job-input-heading"
            >
              {[
                { key: 'url', label: 'Link' },
                { key: 'paste', label: 'Paste text' },
                { key: 'file', label: 'Upload file' },
              ].map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  className={
                    jobMode === mode.key
                      ? 'job-mode-btn job-mode-btn-active'
                      : 'job-mode-btn'
                  }
                  aria-pressed={jobMode === mode.key}
                  disabled={loading}
                  onClick={() => switchJobMode(mode.key)}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {jobMode === 'url' && (
              <input
                id="jobUrl"
                name="jobUrl"
                type="url"
                inputMode="url"
                autoComplete="off"
                aria-label="Job posting URL"
                placeholder="https://jobs.lever.co/… or Greenhouse, Ashby, LinkedIn, etc."
                value={jobUrl}
                onChange={(ev) => setJobUrl(ev.target.value)}
                disabled={loading}
              />
            )}

            {jobMode === 'paste' && (
              <textarea
                id="jobText"
                name="jobDescriptionText"
                aria-label="Job description text"
                placeholder="Paste the full job description here — title, responsibilities, requirements…"
                value={jobText}
                onChange={(ev) => setJobText(ev.target.value)}
                disabled={loading}
              />
            )}

            {jobMode === 'file' && (
              <>
                <input
                  ref={jobFileInputRef}
                  id="jobFile"
                  name="jobDescriptionFile"
                  type="file"
                  accept={RESUME_ACCEPT}
                  className="resume-file-input"
                  tabIndex={-1}
                  disabled={loading}
                  aria-label="Job description file: PDF or .docx"
                  onChange={(ev) => setJobFileFromFileList(ev.target.files)}
                />
                <button
                  type="button"
                  className="resume-dropzone"
                  disabled={loading}
                  data-active={jobFileDragActive ? 'true' : undefined}
                  onClick={() => jobFileInputRef.current?.click()}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      jobFileInputRef.current?.click()
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setJobFileDragActive(true)
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setJobFileDragActive(false)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setJobFileDragActive(false)
                    setJobFileFromFileList(e.dataTransfer.files)
                  }}
                >
                  <span className="resume-dropzone__main">
                    {jobFile ? (
                      <strong>{jobFile.name}</strong>
                    ) : (
                      'Drop the job description here or click to browse'
                    )}
                    <span className="resume-dropzone__sub">
                      PDF or .docx of the job posting
                    </span>
                  </span>
                </button>
                {jobFile && (
                  <div className="resume-actions">
                    <button
                      type="button"
                      className="btn-text"
                      disabled={loading}
                      onClick={() => {
                        setJobFile(null)
                        if (jobFileInputRef.current) {
                          jobFileInputRef.current.value = ''
                        }
                      }}
                    >
                      Remove file
                    </button>
                  </div>
                )}
              </>
            )}

            <p className="field-hint">
              Built from your resume and their job description. We read the
              posting, then generate your prep brief — predicted questions,
              talking points, and company context.
            </p>
          </div>

          {!resumeFile && (
            <div className="field">
              <span className="field-label" id="resume-field-heading">
                Resume <span className="field-optional">(optional)</span>
              </span>
              <button
                type="button"
                className="resume-dropzone"
                disabled={loading}
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
                    PDF or .docx — optional, but it unlocks the personalized
                    sections of your brief
                  </span>
                </span>
              </button>
              <p className="field-hint">
                Without a resume you still get the company research; with one,
                every section is tailored to your background. After you upload
                once, we keep your resume in this browser. Use{' '}
                <strong>My resume</strong> in the top navigation to preview or
                replace it.
              </p>
            </div>
          )}

          <div className="submit-row">
        <button
              type="submit"
              className="btn-primary"
              disabled={loading}
            >
              Generate my brief →
            </button>
            {loading && (
              <div className="loading-inline" aria-live="polite">
                <span className="spinner" aria-hidden />
                {phaseText ||
                  (markdown === '' ? 'Starting research…' : 'Streaming brief…')}
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

        {!savedBriefsPanelOpen && !resumePanelOpen && (
          <blockquote className="home-founder-story">
            I used to reschedule interviews when I didn&apos;t feel ready. So I
            built the thing that makes me feel ready in 60 seconds.
          </blockquote>
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
            {briefTabs.length > 1 && (
              <div
                className="brief-tabs"
                role="tablist"
                aria-label="Brief views"
              >
                {briefTabs.map((tab) => {
                  const isActive = briefTab === tab.key
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={
                        isActive
                          ? 'brief-tab-btn brief-tab-btn--active'
                          : 'brief-tab-btn'
                      }
                      onClick={() => switchBriefTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>
            )}
            <div
              className={
                visibleNavItems.length > 0
                  ? 'brief-layout'
                  : 'brief-layout brief-layout--content-only'
              }
            >
              {visibleNavItems.length > 0 && (
                <nav className="toc-vertical" aria-label="Brief sections">
                  <p className="toc-vertical-title">Jump to</p>
                  <ul className="toc-vertical-list">
                    {visibleNavItems.map((item) => {
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
                            {item.navLabel}
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
                  briefSections.map((chunk, i) => {
                    const item = sectionNavItems[i]
                    if (item.navGroup !== briefTab) return null
                    return (
                      <BriefSectionCard
                        key={item.id}
                        id={item.id}
                        title={item.title}
                        chunk={chunk}
                        markdownComponents={markdownComponents}
                      />
                    )
                  })
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
                                  Still not sure how to frame your story or what
                                  to ask them
                                </li>
                                <li>Walk in anxious — or reschedule</li>
                              </ul>
                            </div>
                            <div className="home-ba-card home-ba-card--after card">
                              <h3 className="home-ba-title">With PrepBrief</h3>
                              <ul className="home-ba-list">
                                <li>Paste your job link and resume</li>
                                <li>Wait 60 seconds</li>
                                <li>
                                  Read a 2-minute personalized prep brief
                                </li>
                                <li>Walk in feeling ready</li>
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
                                Your talking points
                              </h3>
                              <p className="home-wyg-card-copy">
                                A tailored &quot;tell me about yourself&quot;
                                framework from your resume and the job
                                description — structured prep, not a script.
                              </p>
                            </article>
                            <article className="home-wyg-card card">
                              <h3 className="home-wyg-card-title">
                                Questions to ask them
                              </h3>
                              <p className="home-wyg-card-copy">
                                Smart questions grounded in their current
                                priorities and your role — so you sound prepared,
                                not passive.
                              </p>
                            </article>
                          </div>
                        </section>

                        <section
                          className="home-demo-video card"
                          aria-labelledby="demo-video-heading"
                        >
                          <h2 id="demo-video-heading" className="home-demo-heading">
                            Demo video
                          </h2>
                          <p className="home-demo-copy">
                            Upload a short walkthrough clip to preview how the
                            product works right on the homepage.
                          </p>
                          <input
                            ref={demoVideoInputRef}
                            id="demoVideoUpload"
                            name="demoVideoUpload"
                            type="file"
                            accept={DEMO_VIDEO_ACCEPT}
                            className="resume-file-input"
                            tabIndex={-1}
                            onChange={(ev) =>
                              setDemoVideoFromFileList(ev.target.files)
                            }
                          />
                          <div className="home-demo-actions">
                            <button
                              type="button"
                              className="saved-briefs-close"
                              onClick={() => demoVideoInputRef.current?.click()}
                            >
                              {demoVideoFile ? 'Replace demo video' : 'Upload demo video'}
                            </button>
                            {demoVideoFile && (
                              <span className="home-demo-filename">
                                {demoVideoFile.name}
                              </span>
                            )}
                          </div>
                          {demoVideoUrl ? (
                            <div className="home-demo-player-wrap">
                              <video
                                className="home-demo-player"
                                src={demoVideoUrl}
                                controls
                                preload="metadata"
                              >
                                Your browser does not support the video tag.
                              </video>
                            </div>
                          ) : (
                            <p className="home-demo-empty">
                              No demo video uploaded yet.
                            </p>
                          )}
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
                  No resume on file yet. Upload a PDF or .docx — optional, but
                  it unlocks the personalized sections of every brief.
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
              <span className="site-footer-brand">
                <img
                  src={PREPBRIEF_LOGO_SRC}
                  alt=""
                  className="site-footer-logo"
                  decoding="async"
                />
                <span className="visually-hidden">PrepBrief</span>
              </span>
              <p className="site-footer-blurb">
                Personalized interview prep from your resume and their job
                description. Feel ready in 60 seconds.
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
