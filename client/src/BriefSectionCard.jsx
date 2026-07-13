import { useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  prepareBriefSectionBodyForRender,
  sectionChunkToPlainText,
} from './briefDisplay'

function stripLeadingSectionHeading(md) {
  if (typeof md !== 'string') return ''
  return md.replace(/^##[^\n]+\n+/, '').trimStart()
}

/**
 * For sections where only the Behavioral group is gated: split the body at the
 * "**Role & company specific**" marker. Returns null when the marker is missing.
 */
function splitAtRoleGroup(bodyMd) {
  const match = bodyMd.match(/^\s*\*\*Role\b.*$/im)
  if (!match || match.index == null) return null
  return {
    locked: bodyMd.slice(0, match.index).trimEnd(),
    visible: bodyMd.slice(match.index).trimStart(),
  }
}

function ClipboardIcon() {
  return (
    <svg
      className="copy-btn-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function LockedOverlay({ label }) {
  return (
    <div className="brief-lock-overlay" role="note">
      <span className="brief-lock-overlay-label">{label}</span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {'full' | 'behavioral' | null} [props.lock] blur level for free tier
 * @param {string} [props.lockLabel] overlay label when locked
 */
export function BriefSectionCard({
  id,
  title,
  chunk,
  markdownComponents,
  lock = null,
  lockLabel = '',
}) {
  const [copied, setCopied] = useState(false)
  const bodyMd = stripLeadingSectionHeading(chunk)

  const behavioralSplit =
    lock === 'behavioral' ? splitAtRoleGroup(bodyMd) : null
  const effectiveLock =
    lock === 'behavioral' && !behavioralSplit ? null : lock

  const handleCopy = useCallback(() => {
    const text = `${title}\n\n${sectionChunkToPlainText(chunk)}`
    const done = () => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => done())
    } else {
      done()
    }
  }, [chunk, title])

  return (
    <article id={id} className="brief-section">
      <div className="brief-section-card-header">
        <h2 className="brief-section-card-title">{title}</h2>
        <div className="brief-section-card-header-actions">
          {copied && (
            <span className="copy-btn-feedback" role="status">
              Copied!
            </span>
          )}
          {effectiveLock !== 'full' && (
            <button
              type="button"
              className="copy-btn"
              onClick={handleCopy}
              aria-label={`Copy section: ${title}`}
            >
              <ClipboardIcon />
            </button>
          )}
        </div>
      </div>
      {effectiveLock === 'full' ? (
        <div className="brief-lock-wrap">
          <div className="markdown-output brief-locked-content" aria-hidden>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {prepareBriefSectionBodyForRender(bodyMd)}
            </ReactMarkdown>
          </div>
          <LockedOverlay label={lockLabel} />
        </div>
      ) : effectiveLock === 'behavioral' && behavioralSplit ? (
        <>
          {behavioralSplit.locked && (
            <div className="brief-lock-wrap">
              <div
                className="markdown-output brief-locked-content"
                aria-hidden
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {prepareBriefSectionBodyForRender(behavioralSplit.locked)}
                </ReactMarkdown>
              </div>
              <LockedOverlay label={lockLabel} />
            </div>
          )}
          <div className="markdown-output">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {prepareBriefSectionBodyForRender(behavioralSplit.visible)}
            </ReactMarkdown>
          </div>
        </>
      ) : (
        <div className="markdown-output">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {prepareBriefSectionBodyForRender(bodyMd)}
          </ReactMarkdown>
        </div>
      )}
    </article>
  )
}
