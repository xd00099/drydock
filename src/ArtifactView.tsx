import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Artifact } from './types'

// Theme for wrapped fragments (svg/markdown, and bare HTML fragments). A full
// HTML document keeps its own <head>/<style>.
const FRAME_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#0f1115;color:#e8edf4;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55}a{color:#7fb0ff}h1,h2,h3{line-height:1.25}pre{background:#161c25;padding:12px;border-radius:6px;overflow:auto}code{font-family:Menlo,Monaco,monospace;font-size:13px}table{border-collapse:collapse}td,th{border:1px solid #2c3647;padding:4px 8px}svg{max-width:100%;height:auto}img{max-width:100%}blockquote{margin:0;padding-left:12px;border-left:3px solid #2c3647;color:#9aa3af}`

const wrapDoc = (inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_CSS}</style></head><body>${inner}</body></html>`

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

/** Renders one artifact in a locked-down iframe. Three independent layers keep
 *  model-authored HTML from running code: DOMPurify strips scripts/handlers;
 *  `sandbox=""` disables scripting + same-origin entirely; and the inherited
 *  main CSP (`script-src 'self'`) blocks any inline script in the srcdoc. */
export default function ArtifactView({ artifact, style }: { artifact: Artifact; style?: React.CSSProperties }) {
  const srcDoc = useMemo(() => toSrcDoc(artifact), [artifact])
  return (
    <iframe
      title={artifact.title}
      sandbox=""
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', border: 'none', background: '#0f1115', ...style }}
    />
  )
}
