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

export function BriefSectionCard({ id, title, chunk, markdownComponents }) {
  const [copied, setCopied] = useState(false)
  const bodyMd = stripLeadingSectionHeading(chunk)
  const prepared = prepareBriefSectionBodyForRender(bodyMd)

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
          <button
            type="button"
            className="copy-btn"
            onClick={handleCopy}
            aria-label={`Copy section: ${title}`}
          >
            <ClipboardIcon />
          </button>
        </div>
      </div>
      <div className="markdown-output">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {prepared}
        </ReactMarkdown>
      </div>
    </article>
  )
}
