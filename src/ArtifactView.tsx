import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Artifact } from './types'

// Theme for wrapped fragments (svg/markdown, and bare HTML fragments). A full
// HTML document keeps its own <head>/<style>.
const FRAME_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#0f1115;color:#e8edf4;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55}a{color:#7fb0ff}h1,h2,h3{line-height:1.25}pre{background:#161c25;padding:12px;border-radius:6px;overflow:auto}code{font-family:Menlo,Monaco,monospace;font-size:13px}table{border-collapse:collapse}td,th{border:1px solid #2c3647;padding:4px 8px}svg{max-width:100%;height:auto}img{max-width:100%}blockquote{margin:0;padding-left:12px;border-left:3px solid #2c3647;color:#9aa3af}`

// base target=_blank: clicking a link in a sandboxed srcdoc frame would
// otherwise navigate the frame ITSELF away from the artifact (self-navigation
// is always allowed in a sandbox) with no way back; _blank without allow-popups
// is silently blocked, so links become inert and the artifact stays put.
const wrapDoc = (inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${inner}</body></html>`

// Turn an artifact into a self-contained HTML document string. Everything is
// DOMPurify-sanitized first; the iframe then renders it with NO scripting (see
// the component). model-authored content is never trusted.
function toSrcDoc(a: Artifact): string {
  if (a.kind === 'markdown') {
    return wrapDoc(DOMPurify.sanitize(marked.parse(a.content) as string))
  }
  if (a.kind === 'svg') {
    return wrapDoc(DOMPurify.sanitize(a.content, { USE_PROFILES: { svg: true, svgFilters: true } }))
  }
  // html: a full document keeps its structure; a fragment gets the theme wrapper.
  const isDoc = /<!doctype|<html[\s>]/i.test(a.content)
  const clean = DOMPurify.sanitize(a.content, isDoc ? { WHOLE_DOCUMENT: true } : {})
  return isDoc ? clean : wrapDoc(clean)
}

/** Renders one artifact in a locked-down iframe.
 *
 *  HTML artifacts are meant to run (charts, animations, click handlers), so they
 *  are served from their own isolated `artifact://` origin (the backend scheme
 *  handler) under a per-artifact CSP that allows inline + well-known-CDN scripts
 *  but blocks outbound network (`connect-src 'none'`). The `sandbox` here keeps
 *  scripting on but withholds `allow-same-origin`, so the frame runs in an opaque
 *  origin walled off from the app — it cannot reach the parent, the filesystem,
 *  or Drydock's own APIs, and (no `allow-top-navigation`) cannot navigate us away.
 *
 *  SVG/Markdown never need scripting, so they keep the strict path: DOMPurify
 *  strips scripts/handlers, `sandbox=""` disables scripting, and the inherited
 *  app CSP blocks inline scripts — three independent layers. */
export default function ArtifactView({ artifact, style }: { artifact: Artifact; style?: React.CSSProperties }) {
  const srcDoc = useMemo(() => (artifact.kind === 'html' ? '' : toSrcDoc(artifact)), [artifact])
  const baseStyle: React.CSSProperties = { width: '100%', height: '100%', border: 'none', background: '#0f1115', ...style }
  if (artifact.kind === 'html') {
    return (
      <iframe
        title={artifact.title}
        sandbox="allow-scripts allow-modals"
        src={`artifact://localhost/${encodeURIComponent(artifact.id)}`}
        style={baseStyle}
      />
    )
  }
  return <iframe title={artifact.title} sandbox="" srcDoc={srcDoc} style={baseStyle} />
}
