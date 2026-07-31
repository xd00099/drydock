import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { baseName, clip, relAge, type Artifact, type ArtifactKind, type ReviewPrompt, type ReviewState, type SavedArtifact } from '@/lib/types'
import ArtifactView from '@/features/artifacts/ArtifactView'
import { ReviewPanel } from './ReviewPanel'
import { S } from './styles'

// one from the session's on-disk gallery.
type GalleryItem = { id: string; title: string; kind: ArtifactKind; saved?: SavedArtifact }

export function PreviewTab({
  artifacts,
  sessionId,
  review,
  accent,
  onQueue,
  onDiscard,
  onSend,
}: {
  artifacts: Artifact[]
  sessionId: string | null
  review: ReviewState | null // null = tab can't review (annotation UI hidden)
  accent: string
  onQueue?: (p: ReviewPrompt) => void
  onDiscard?: (index: number) => void
  onSend?: (message: string, endReview: boolean) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [saved, setSaved] = useState<SavedArtifact[]>([])
  // fetched content of saved svg/markdown artifacts, keyed by file name
  const [contentCache, setContentCache] = useState<Record<string, string>>({})
  const overlayRef = useRef<HTMLDivElement>(null)
  // Transient confirmation/error line under the header (download/reveal results).
  // One timer, always restarted: two quick Downloads must not have the first
  // timer clear the second message early.
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const flashTimer = useRef(0)
  const flash = (text: string, error?: boolean) => {
    clearTimeout(flashTimer.current)
    setMsg({ text, error })
    flashTimer.current = window.setTimeout(() => setMsg(null), 3000)
  }
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // ---- interactive review (docs/artifact-review.md) ----
  const reviewable = review !== null
  const [reviewOn, setReviewOn] = useState(false) // annotate vs explore

  // ⌘I toggles annotate mode while the Artifacts tab is up. Capture-phase, and
  // the SDK forwards the same hotkey from inside the iframe (dd-artifact:toggleMode).
  // Focus-scoped: never steal the keystroke from the terminal or an editable
  // control (xterm's hidden textarea lives inside a .xterm container).
  useEffect(() => {
    if (!reviewable) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        const t = e.target as HTMLElement | null
        if (t && (t.closest?.('.xterm') || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        setReviewOn((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [reviewable])

  // Persisted gallery for this session; re-listed whenever a new render lands
  // (renders persist before the artifact event fires, so this stays fresh) and
  // after a rewind (items gain their "rewound" badge).
  const [savedNonce, setSavedNonce] = useState(0)
  useEffect(() => {
    if (!sessionId) { setSaved([]); return }
    let live = true
    invoke<SavedArtifact[]>('list_saved_artifacts', { sessionId })
      .then((s) => { if (live) setSaved(s) })
      .catch(() => { if (live) setSaved([]) })
    return () => { live = false }
  }, [sessionId, artifacts.length, savedNonce])
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string }>('artifact-rewound', (e) => {
      if (e.payload.session_id === sessionId) setSavedNonce((n) => n + 1)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [sessionId])

  // Gallery = persisted artifacts (older, deduped against the live list by
  // their render-time seq) followed by this run's live artifacts — so the
  // dropdown reads oldest → newest and the default stays "the newest".
  const liveIds = new Set(artifacts.map((a) => a.id))
  const items: GalleryItem[] = [
    ...(sessionId
      ? saved
          .filter((s) => !liveIds.has(String(s.seq)))
          .map((s): GalleryItem => ({
            id: `saved/${sessionId}/${s.file}`,
            title: s.title,
            kind: s.kind === 'svg' || s.kind === 'markdown' ? s.kind : 'html',
            saved: s,
          }))
      : []),
    ...artifacts.map((a): GalleryItem => ({ id: a.id, title: a.title, kind: a.kind })),
  ]
  // Default to the newest that ISN'T from a rewound-away timeline (after a
  // rewind the panel time-travels with the conversation); a manual pick —
  // including a rewound copy, for comparison — sticks until it's gone.
  const current =
    items.find((i) => i.id === selectedId) ??
    [...items].reverse().find((i) => !i.saved?.rewound) ??
    (items.length ? items[items.length - 1] : null)

  // Saved svg/markdown render through the sanitized srcdoc path and need their
  // content fetched once; saved html streams from artifact://saved/… directly.
  useEffect(() => {
    const s = current?.saved
    if (!s || current?.kind === 'html' || !sessionId) return
    if (contentCache[s.file] != null) return
    let live = true
    invoke<string>('read_saved_artifact', { sessionId, file: s.file })
      .then((c) => { if (live) setContentCache((m) => ({ ...m, [s.file]: c })) })
      .catch(() => { if (live) setContentCache((m) => ({ ...m, [s.file]: '' })) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, sessionId])

  // Esc closes the expanded overlay — even when the artifact iframe has focus.
  // A parent keydown listener never sees keys typed into an iframe, so: html
  // artifacts get a tiny Esc-forwarder script injected by the artifact:// server
  // (postMessage 'drydock-esc', since their scripts run anyway), and static
  // svg/markdown frames (scripts disabled, nothing to type into) just have
  // focus reclaimed by the overlay whenever they steal it.
  const currentKind = current?.kind
  useEffect(() => {
    if (!full) return
    overlayRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    const onMsg = (e: MessageEvent) => {
      if (e.data && (e.data as { type?: string }).type === 'drydock-esc') setFull(false)
    }
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) {
        if (currentKind !== 'html') setTimeout(() => overlayRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMsg)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMsg)
      window.removeEventListener('blur', onBlur)
    }
  }, [full, currentKind])

  // Resolve the selected item to a renderable Artifact. null = saved content
  // still fetching (a brief "loading…" shows instead of the frame).
  const shown: Artifact | null = !current
    ? null
    : !current.saved
      ? artifacts.find((a) => a.id === current.id) ?? null
      : current.kind === 'html'
        ? { id: current.id, title: current.title, kind: 'html', content: '', path: current.saved.path ?? undefined }
        : contentCache[current.saved.file] != null
          ? { id: current.id, title: current.title, kind: current.kind, content: contentCache[current.saved.file], path: current.saved.path ?? undefined }
          : null

  // ---- review wiring for the mounted artifact ----
  // Review is wired ONLY to the newest LIVE artifact: annotating an old
  // gallery/saved copy would feed stale selectors into the live session's loop.
  const latestLiveId = artifacts.length ? artifacts[artifacts.length - 1].id : null
  const reviewTarget = reviewable && !!current && !current.saved && current.id === latestLiveId && shown?.kind === 'html'

  // The iframe is UNTRUSTED (its scripts include the artifact's own): coerce
  // every field at this boundary so a malformed payload can neither crash the
  // React tree nor fail backend deserialization. Send/end are deliberately NOT
  // accepted from the frame — a page script calling window.dd.sendQueued()
  // must not deliver feedback to the model without a human gesture in the
  // trusted panel (prompt-injection guard). Queue only proposes visible pills.
  const asStr = (x: unknown) => (typeof x === 'string' ? x : '')
  const toReviewPrompt = (v: unknown): ReviewPrompt | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const prompt = asStr(o.prompt).trim()
    if (!prompt) return null
    return {
      uid: asStr(o.uid),
      prompt,
      selector: asStr(o.selector),
      tag: asStr(o.tag) || 'message',
      text: asStr(o.text),
      target: o.target,
      _ddQueueKey: typeof o._ddQueueKey === 'string' && o._ddQueueKey ? o._ddQueueKey : undefined,
    }
  }
  const onReviewMsg = (m: Record<string, unknown>) => {
    const t = m.type as string
    if (t === 'dd-artifact:queuePrompt') {
      const p = toReviewPrompt(m.prompt)
      if (p && onQueue) onQueue(p)
    } else if (t === 'dd-artifact:toggleMode') setReviewOn((v) => !v)
  }
  // "Send & end" also leaves annotate mode — ending the review should read as
  // an ending, not stay armed for more clicks.
  const sendFromPanel = (m: string, end: boolean) => {
    onSend?.(m, end)
    if (end) setReviewOn(false)
  }
  // Presence counts as activity: a session blocked in await_artifact_feedback
  // surfaces the panel even before the first annotation, so the user can see
  // "Claude is waiting" and reach Send & end.
  const reviewPanelUp =
    reviewable && !!review && (reviewOn || review.presence !== 'waiting' || review.prompts.length > 0 || review.chat.length > 0)

  // Download writes straight to ~/Downloads (backend) and reveals it; Open
  // shows the model's original source file in Finder (file-backed ones only).
  const download = (g: GalleryItem) => {
    const done = () => flash('Saved to Downloads — revealed in Finder')
    const fail = (e: unknown) => flash(String(e), true)
    if (g.saved && sessionId) invoke<string>('save_saved_artifact', { sessionId, file: g.saved.file }).then(done).catch(fail)
    else invoke<string>('save_artifact', { id: g.id }).then(done).catch(fail)
  }
  const actions = (g: GalleryItem) => (
    <>
      {shown?.path && (
        <button style={S.iconBtn} title={`Open in Finder\n${shown.path}`} onClick={() => invoke('open_path', { path: shown.path, reveal: true }).catch((e) => flash(String(e), true))}>Open</button>
      )}
      <button style={S.iconBtn} title="Download to your Downloads folder" onClick={() => download(g)}>Download</button>
    </>
  )

  if (!current)
    return <div style={{ ...S.muted, flex: 1, minHeight: 0, padding: 12 }}>No artifacts yet. When Claude renders an artifact (HTML, SVG, or Markdown) in this session, it shows up here.</div>

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 8px' }}>
        <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={current.title}>{current.title}</span>
        {current.saved && <span style={S.chip} title="Persisted from an earlier run of this session">saved</span>}
        <span style={S.chip}>{current.kind}</span>
        {actions(current)}
        {reviewTarget && (
          <button
            style={{ ...S.iconBtn, ...(reviewOn ? { background: accent, color: 'var(--dd-ink)', border: `1px solid ${accent}` } : {}) }}
            title={'Annotate mode (⌘I) — click elements or select text in the artifact to comment'}
            onClick={() => setReviewOn((v) => !v)}
          >
            ✎ Annotate
          </button>
        )}
        <button style={S.iconBtn} title="Expand to full window" onClick={() => setFull(true)}>⤢</button>
      </div>
      {/* always rendered at a constant height: the iframe below must not jump
          when a message appears/expires; long errors ellipsize (full text in title) */}
      <div
        title={msg?.text}
        style={{ padding: '0 12px 6px', fontSize: 10, lineHeight: '12px', height: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: msg?.error ? 'var(--dd-err)' : 'var(--dd-ok-bright)' }}
      >
        {msg?.text ?? ''}
      </div>
      {items.length > 1 && (
        <select
          value={current.id}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ margin: '0 12px 8px', background: 'var(--dd-surface2)', color: 'var(--dd-text1)', border: '1px solid var(--dd-border2)', borderRadius: 4, padding: '3px 4px', fontSize: 11 }}
        >
          {items.map((a, i) => (
            <option key={a.id} value={a.id}>{i + 1}. {a.title} ({a.kind}){a.saved?.rewound ? ' · rewound' : a.saved ? ' · saved' : ''}</option>
          ))}
        </select>
      )}
      {saved.length >= 50 && (
        <div style={{ ...S.muted, fontSize: 10, padding: '0 12px 6px' }}>gallery keeps the newest 50 per session</div>
      )}
      {/* Fill the rest of the panel edge-to-edge, no frame. Hidden while the
          full-window overlay is up — two mounted copies of an html artifact
          would each run its scripts (double execution). */}
      {!full && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {shown ? (
              <ArtifactView
                artifact={shown}
                style={{ border: 'none', borderRadius: 0 }}
                reviewMode={reviewTarget && reviewOn}
                accent={accent}
                onReviewMsg={reviewTarget ? onReviewMsg : undefined}
              />
            ) : (
              <div style={{ ...S.muted, padding: 12 }}>loading…</div>
            )}
          </div>
          {reviewPanelUp && review && (
            <ReviewPanel review={review} accent={accent} annotateOn={reviewOn} onDiscard={onDiscard} onSend={sendFromPanel} />
          )}
        </div>
      )}
      {full && (
        // Full-window overlay so UI artifacts get usable space. zIndex below the
        // quit guard (100); translateZ(0) gives it its own compositing layer so
        // it's clickable over a terminal's WebGL canvas in WKWebView. tabIndex
        // lets it hold focus so Esc lands here, not in a just-clicked iframe.
        <div ref={overlayRef} tabIndex={-1} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--dd-bg0)', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dd-border)' }}>
            <span style={{ flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.title}</span>
            {current.saved && <span style={S.chip}>saved</span>}
            <span style={S.chip}>{current.kind}</span>
            {actions(current)}
            {reviewTarget && (
              <button
                style={{ ...S.iconBtn, ...(reviewOn ? { background: accent, color: 'var(--dd-ink)', border: `1px solid ${accent}` } : {}) }}
                title={'Annotate mode (⌘I) — click elements or select text in the artifact to comment'}
                onClick={() => setReviewOn((v) => !v)}
              >
                ✎ Annotate
              </button>
            )}
            <button style={S.iconBtn} title="Close (Esc)" onClick={() => setFull(false)}>✕</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {shown ? (
                <ArtifactView
                  artifact={shown}
                  style={{ border: 'none' }}
                  reviewMode={reviewTarget && reviewOn}
                  accent={accent}
                  onReviewMsg={reviewTarget ? onReviewMsg : undefined}
                />
              ) : (
                <div style={{ ...S.muted, padding: 12 }}>loading…</div>
              )}
            </div>
            {reviewPanelUp && review && (
              <ReviewPanel review={review} accent={accent} annotateOn={reviewOn} onDiscard={onDiscard} onSend={sendFromPanel} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Queued-annotation pills + conversation log + sticky composer, accented in
 *  the session color. Sends are disabled while the model is `working` on
 *  already-delivered feedback (mirrors lavish-axi's presence gating). */
