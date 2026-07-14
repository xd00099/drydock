import { useEffect, useMemo, useRef } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Artifact } from './types'

// Theme for wrapped fragments (svg/markdown, and bare HTML fragments). A full
// HTML document keeps its own <head>/<style>. Injected into the sandboxed
// srcdoc iframe, whose document has NO access to the app's --dd-* tokens —
// concrete hexes on purpose (artifact content renders on its own dark canvas
// regardless of the app theme).
const FRAME_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#0d1117;color:#e8edf4;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55}a{color:#7fb0ff}h1,h2,h3{line-height:1.25}pre{background:#161c25;padding:12px;border-radius:6px;overflow:auto}code{font-family:Menlo,Monaco,monospace;font-size:13px}table{border-collapse:collapse}td,th{border:1px solid #2c3647;padding:4px 8px}svg{max-width:100%;height:auto}img{max-width:100%}blockquote{margin:0;padding-left:12px;border-left:3px solid #2c3647;color:#9aa3af}`

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
export default function ArtifactView({
  artifact,
  style,
  reviewMode,
  accent,
  onReviewMsg,
}: {
  artifact: Artifact
  style?: React.CSSProperties
  /** annotate (true) vs explore (false) — pushed into the injected review SDK */
  reviewMode?: boolean
  /** session color for the SDK's highlights/annotation card */
  accent?: string
  /** dd-artifact:* messages from THIS artifact's iframe (source-verified) */
  onReviewMsg?: (msg: Record<string, unknown>) => void
}) {
  const srcDoc = useMemo(() => (artifact.kind === 'html' ? '' : toSrcDoc(artifact)), [artifact])
  const baseStyle: React.CSSProperties = { width: '100%', height: '100%', border: 'none', background: 'var(--dd-well)', ...style }
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // Push the current mode + accent into the frame's review SDK. Re-sent on every
  // change and whenever the SDK announces dd-artifact:ready (fresh document).
  const pushMode = () => {
    frameRef.current?.contentWindow?.postMessage({ type: 'dd-artifact:setMode', enabled: !!reviewMode, accent }, '*')
  }
  useEffect(() => {
    if (artifact.kind === 'html') pushMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode, accent, artifact.id])

  // Review bridge. TRUST GUARD: the sandboxed frame runs in an opaque origin
  // ("null"), so origin checks are useless — a message is trusted only when its
  // source IS this iframe's contentWindow, and its type is a dd-artifact:*
  // string. Everything else (other iframes, the Esc forwarder's drydock-esc,
  // random window.postMessage calls) is ignored here.
  useEffect(() => {
    if (!onReviewMsg || artifact.kind !== 'html') return
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const data = e.data as Record<string, unknown> | null
      const type = data && typeof data.type === 'string' ? data.type : ''
      if (!type.startsWith('dd-artifact:')) return
      if (type === 'dd-artifact:ready') {
        pushMode()
        return
      }
      onReviewMsg(data as Record<string, unknown>)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReviewMsg, reviewMode, accent, artifact.kind])

  if (artifact.kind === 'html') {
    // ids are server-generated URL-path-safe strings — live counters ("7") or
    // gallery paths ("saved/<uuid>/<ms>-<seq>.html", whose '/' must survive)
    return (
      // Keyed by artifact id: switching artifacts creates a NEW iframe (and a
      // new contentWindow), so an in-flight message from the previous document
      // fails the source-trust guard instead of being attributed to the new one.
      <iframe
        key={artifact.id}
        ref={frameRef}
        title={artifact.title}
        sandbox="allow-scripts allow-modals"
        src={`artifact://localhost/${artifact.id}`}
        style={baseStyle}
      />
    )
  }
  return <iframe title={artifact.title} sandbox="" srcDoc={srcDoc} style={baseStyle} />
}
