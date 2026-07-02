import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { PaneSearch, SessionView, TEntry, TranscriptPage } from './types'
import { clip } from './types'

type ChunkView = { role: string; text: string; ts: number | null }

type Props = {
  sessionId: string
  session: SessionView | undefined // live row from useSessions, updates with the radar
  onResumeHere: () => void
  onInteract?: () => void // scrolling/clicking the transcript body
  onMatches?: (index: number, count: number) => void // ⌘F find results (active match, total)
}

// A display row: tool_result entries are folded into their tool_use's row (the
// pairing may span incremental pages, so it's done here over ALL entries).
type Row = { e: TEntry; result?: TEntry }

// Rows rendered initially / added per "show earlier" click. Bounds the DOM for
// months-long sessions without a virtualizer; search reveals everything.
const PAGE = 400

function buildRows(entries: TEntry[]): Row[] {
  const out: Row[] = []
  const byToolId = new Map<string, Row>()
  for (const e of entries) {
    if (e.kind === 'tool_result') {
      if (e.tool_use_id) {
        const row = byToolId.get(e.tool_use_id)
        if (row) row.result = e
      }
      continue // orphan results (no visible call) add nothing
    }
    const row: Row = { e }
    if (e.kind === 'tool_use' && e.tool_use_id) byToolId.set(e.tool_use_id, row)
    out.push(row)
  }
  return out
}

// ⌘F sees dialog text only: tool chips and thinking are collapsed, so a match
// inside them couldn't be shown.
function searchableText(r: Row): string | null {
  const k = r.e.kind
  return k === 'user' || k === 'assistant' || k === 'recap' || k === 'plain' ? r.e.text : null
}

type Match = { ci: number; start: number; len: number }

// Case-insensitive occurrences of `q` across all searchable rows, in order.
function computeMatches(rows: Row[], q: string): Match[] {
  const out: Match[] = []
  const needle = q.toLowerCase()
  if (!needle) return out
  for (let ci = 0; ci < rows.length; ci++) {
    const hay = searchableText(rows[ci])?.toLowerCase()
    if (!hay) continue
    let from = 0
    for (;;) {
      const idx = hay.indexOf(needle, from)
      if (idx < 0) break
      out.push({ ci, start: idx, len: q.length })
      from = idx + q.length
    }
  }
  return out
}

// Assistant markdown, sanitized. memo'd: entries are append-only, so old rows
// keep their parsed HTML across the constant index-updated re-renders.
const MdBlock = memo(function MdBlock({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

// Fallback rendering source: the indexed chunks (already role-prefixed text).
function chunkEntry(c: ChunkView): TEntry {
  const kind = c.role === 'recap' ? 'recap' : c.role === 'user' ? 'user' : 'plain'
  return { kind, text: c.text, tool: null, tool_use_id: null, meta: false, error: false, ts: c.ts }
}

const chipBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: '#7d8794',
  fontFamily: 'Menlo, monospace',
  fontSize: 11,
  padding: '1px 0',
  textAlign: 'left',
}

const hBtn: React.CSSProperties = {
  background: '#1d2530',
  color: '#e8edf4',
  border: '1px solid #2c3647',
  borderRadius: 5,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 12,
}

function fmtTime(ts: number, prev: number | null): string {
  const d = new Date(ts)
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = prev != null && new Date(prev).toDateString() === d.toDateString()
  return sameDay ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`
}

const TranscriptView = forwardRef<PaneSearch, Props>(function TranscriptView(
  { sessionId, session, onResumeHere, onInteract, onMatches },
  ref,
) {
  const [entries, setEntries] = useState<TEntry[]>([])
  const [fallback, setFallback] = useState(false) // no .jsonl → indexed chunks
  const [expanded, setExpanded] = useState<Set<number>>(new Set()) // row indexes
  const [visible, setVisible] = useState(PAGE)
  const [hl, setHl] = useState<{ q: string; active: number }>({ q: '', active: -1 })
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  // Follow the tail only while the user is AT the tail. Entries refresh on every
  // index-updated tick (a live session emits them constantly), and an
  // unconditional scroll-to-bottom would yank the reader away mid-scroll.
  // Starts true so the first load lands at the latest message.
  const pinnedRef = useRef(true)
  const prevHeightRef = useRef<number | null>(null) // scroll anchor for "show earlier"
  const activeMarkRef = useRef<HTMLElement | null>(null)
  const offsetRef = useRef(0)
  const fallbackRef = useRef(false)
  const busyRef = useRef(false)
  const againRef = useRef(false)
  const flashTimer = useRef(0)

  const rows = useMemo(() => buildRows(entries), [entries])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const hlRef = useRef(hl)
  hlRef.current = hl
  const onMatchesRef = useRef(onMatches)
  onMatchesRef.current = onMatches

  const flash = (text: string, error?: boolean) => {
    clearTimeout(flashTimer.current)
    setMsg({ text, error })
    flashTimer.current = window.setTimeout(() => setMsg(null), 4000)
  }
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // Incremental refresh: read only the bytes appended since last time. Guarded
  // against overlap — two in-flight reads from the same offset would duplicate
  // entries — with a trailing re-run so no update signal is lost.
  const refresh = useCallback(function run() {
    if (busyRef.current) {
      againRef.current = true
      return
    }
    busyRef.current = true
    const done = () => {
      busyRef.current = false
      if (againRef.current) {
        againRef.current = false
        run()
      }
    }
    const loadChunks = () =>
      invoke<ChunkView[]>('session_chunks', { sessionId })
        .then((cs) => setEntries(cs.map(chunkEntry)))
        .catch(console.error)
    if (fallbackRef.current) {
      loadChunks().finally(done)
      return
    }
    invoke<TranscriptPage>('session_transcript', { sessionId, fromOffset: offsetRef.current })
      .then((p) => {
        offsetRef.current = p.next_offset
        if (p.reset) {
          setEntries(p.entries)
          setExpanded(new Set())
        } else if (p.entries.length) {
          setEntries((prev) => [...prev, ...p.entries])
        }
      })
      .catch(() => {
        // no transcript file (radar stub, expired/deleted .jsonl): indexed chunks
        fallbackRef.current = true
        setFallback(true)
        return loadChunks()
      })
      .finally(done)
  }, [sessionId])

  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  useEffect(() => { if (pinnedRef.current) bottomRef.current?.scrollIntoView() }, [entries])

  // "show earlier" prepends rows; keep the reader's place by anchoring to the
  // distance from the bottom.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && prevHeightRef.current != null) {
      el.scrollTop = el.scrollHeight - prevHeightRef.current
      prevHeightRef.current = null
    }
  }, [visible])

  useImperativeHandle(ref, (): PaneSearch => ({
    find(query, { dir, incremental }) {
      try {
        if (!query) { setHl({ q: '', active: -1 }); onMatchesRef.current?.(-1, 0); return }
        const ms = computeMatches(rowsRef.current, query)
        if (ms.length === 0) { setHl({ q: query, active: -1 }); onMatchesRef.current?.(-1, 0); return }
        const prev = hlRef.current
        let active: number
        if (incremental) active = prev.active < 0 ? 0 : Math.min(prev.active, ms.length - 1) // live typing: hold position
        else if (prev.q !== query || prev.active < 0) active = 0 // first search for this query
        else active = dir === 'next' ? (prev.active + 1) % ms.length : (prev.active - 1 + ms.length) % ms.length
        setHl({ q: query, active })
        onMatchesRef.current?.(active, ms.length)
      } catch (e) {
        console.error('transcript find failed:', e)
      }
    },
    clear() { setHl({ q: '', active: -1 }) },
  }), [])

  // matches grouped by row with their global index, for highlighting
  const byRow = useMemo(() => {
    const map = new Map<number, { start: number; len: number; gi: number }[]>()
    computeMatches(rows, hl.q).forEach((m, gi) => {
      const arr = map.get(m.ci) ?? []
      arr.push({ start: m.start, len: m.len, gi })
      map.set(m.ci, arr)
    })
    return map
  }, [rows, hl.q])

  useEffect(() => {
    if (hl.active >= 0) activeMarkRef.current?.scrollIntoView({ block: 'center' })
  }, [hl.active, hl.q])

  // Entries load async. If a query was already set when they arrive (e.g. ⌘F
  // reopened with a retained query before the transcript finished fetching),
  // recompute and re-report so the count isn't stuck at the empty-buffer value.
  useEffect(() => {
    const q = hlRef.current.q
    if (!q) return
    const ms = computeMatches(rowsRef.current, q)
    const cur = hlRef.current.active
    const active = ms.length === 0 ? -1 : Math.min(cur < 0 ? 0 : cur, ms.length - 1)
    if (active !== cur) setHl({ q, active })
    onMatchesRef.current?.(active, ms.length)
  }, [rows])

  const renderText = (text: string, ms?: { start: number; len: number; gi: number }[]) => {
    if (!ms || ms.length === 0) return text
    const nodes: React.ReactNode[] = []
    let cursor = 0
    for (const m of ms) {
      if (m.start > cursor) nodes.push(text.slice(cursor, m.start))
      const isActive = m.gi === hl.active
      nodes.push(
        <mark
          key={m.gi}
          ref={isActive ? activeMarkRef : undefined}
          style={{ background: isActive ? '#e8c35a' : '#3a4656', color: isActive ? '#10141a' : 'inherit', borderRadius: 2 }}
        >
          {text.slice(m.start, m.start + m.len)}
        </mark>,
      )
      cursor = m.start + m.len
    }
    if (cursor < text.length) nodes.push(text.slice(cursor))
    return nodes
  }

  const toggleRow = (idx: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })

  const exportMd = () =>
    invoke<string>('export_transcript', { sessionId })
      .then(() => flash('Exported to Downloads — revealed in Finder'))
      .catch((e) => flash(String(e), true))

  // idx is the GLOBAL row index (stable under append; expanded/matches key on it)
  const renderRow = (r: Row, idx: number) => {
    const e = r.e
    const marks = byRow.get(idx)
    const searching = !!hl.q
    switch (e.kind) {
      case 'user':
        if (e.meta)
          return (
            <div key={idx} style={{ margin: '6px 0', color: '#4a5462', fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
              {renderText(e.text, marks)}
            </div>
          )
        return (
          <div key={idx} style={{ margin: '12px 0', padding: '6px 10px', borderLeft: '3px solid #5a7fb0', background: 'rgba(90,127,176,.09)', borderRadius: 4, color: '#c9d7ee', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {renderText(e.text, marks)}
          </div>
        )
      case 'assistant':
        return (
          <div key={idx} style={{ margin: '8px 0', color: '#c8cdd5' }}>
            {searching ? (
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{renderText(e.text, marks)}</div>
            ) : (
              <MdBlock text={e.text} />
            )}
          </div>
        )
      case 'plain':
        return (
          <div key={idx} style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {renderText(e.text, marks)}
          </div>
        )
      case 'recap':
        return (
          <div key={idx} style={{ margin: '12px 0', padding: '6px 10px', borderLeft: '3px solid #e8c35a', background: 'rgba(232,195,90,.07)', borderRadius: 4, color: '#e8c35a', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            ※ {renderText(e.text, marks)}
          </div>
        )
      case 'compact':
        return (
          <div key={idx} style={{ textAlign: 'center', color: '#4a5462', fontSize: 11, margin: '12px 0' }}>
            — conversation compacted —
          </div>
        )
      case 'thinking': {
        const open = expanded.has(idx)
        return (
          <div key={idx} style={{ margin: '3px 0' }}>
            <button style={chipBtn} onClick={() => toggleRow(idx)} title={open ? 'Collapse' : 'Expand'}>
              <span style={{ flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
              <span style={{ fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                thinking{open ? '' : ` — ${clip(e.text.replace(/\s+/g, ' '), 70)}`}
              </span>
            </button>
            {open && (
              <div style={{ margin: '2px 0 6px 16px', color: '#7d8794', fontStyle: 'italic', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontSize: 11 }}>
                {e.text}
              </div>
            )}
          </div>
        )
      }
      case 'tool_use': {
        const open = expanded.has(idx)
        return (
          <div key={idx} style={{ margin: '2px 0' }}>
            <button style={chipBtn} onClick={() => toggleRow(idx)} title={open ? 'Collapse' : 'Show input & result'}>
              <span style={{ flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
              <span style={{ color: '#7ecfc0', flexShrink: 0 }}>⏺ {e.tool ?? 'tool'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.text}</span>
              {r.result && (
                <span style={{ flexShrink: 0, color: r.result.error ? '#cf6b6b' : '#5fb98a' }}>{r.result.error ? '✗' : '✓'}</span>
              )}
            </button>
            {open && (
              <div style={{ margin: '2px 0 8px 16px', padding: '6px 8px', background: '#0b0e13', border: '1px solid #1d2530', borderRadius: 4, fontSize: 11, fontFamily: 'Menlo, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: 260, overflowY: 'auto' }}>
                <div style={{ color: '#9aa3af' }}>{e.text || '(no input summary)'}</div>
                {r.result && (
                  <div style={{ marginTop: 6, color: r.result.error ? '#cf6b6b' : '#7d8794' }}>{r.result.text || '(no output)'}</div>
                )}
              </div>
            )}
          </div>
        )
      }
      default:
        return null
    }
  }

  // While searching, every row is shown so any match can be scrolled to.
  const shownStart = hl.q ? 0 : Math.max(0, rows.length - visible)
  const shown = rows.slice(shownStart)

  // Interleave time dividers on ≥15-minute gaps (and at the visible top).
  const body: React.ReactNode[] = []
  let prevTs: number | null = null
  shown.forEach((r, i) => {
    const idx = shownStart + i
    if (r.e.ts != null && (prevTs == null || r.e.ts - prevTs > 15 * 60_000)) {
      body.push(
        <div key={`t${idx}`} style={{ textAlign: 'center', color: '#3a4350', fontSize: 10, margin: '10px 0 2px' }}>
          {fmtTime(r.e.ts, prevTs)}
        </div>,
      )
    }
    if (r.e.ts != null) prevTs = r.e.ts
    body.push(renderRow(r, idx))
  })

  const live = session && session.live_status !== 'ended'
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: '6px 10px', background: '#161c25', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flexShrink: 0 }}>
          {live
            ? `running in another terminal (${session?.live_status}) — read-only live view`
            : 'session ended'}
        </span>
        {!live && (
          <button style={hBtn} onClick={onResumeHere}>
            Resume here
          </button>
        )}
        <button style={hBtn} title="Export the full transcript as Markdown to your Downloads folder" onClick={exportMd}>
          Export .md
        </button>
        {msg && (
          <span title={msg.text} style={{ color: msg.error ? '#cf6b6b' : '#7ec8a0', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {msg.text}
          </span>
        )}
        {fallback && (
          <span style={{ marginLeft: 'auto', color: '#5b6675', fontSize: 11, flexShrink: 0 }} title="The session's .jsonl is gone (or not synced yet); showing the indexed text.">
            indexed text only
          </span>
        )}
      </div>
      <div
        ref={scrollerRef}
        onWheel={onInteract}
        onMouseDown={onInteract}
        onScroll={() => {
          const el = scrollerRef.current
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        // links in rendered markdown must not navigate the app's own webview
        onClickCapture={(ev) => {
          const a = (ev.target as HTMLElement).closest?.('a')
          if (a) ev.preventDefault()
        }}
        style={{ flex: 1, overflowY: 'auto', padding: 12, fontFamily: 'Menlo, monospace', fontSize: 12 }}
      >
        {shownStart > 0 && (
          <button
            style={{ ...chipBtn, color: '#5a7fb0', margin: '0 auto 8px', display: 'block' }}
            onClick={() => {
              const el = scrollerRef.current
              prevHeightRef.current = el ? el.scrollHeight - el.scrollTop : null
              setVisible((v) => v + PAGE)
            }}
          >
            ↑ show earlier ({shownStart} more)
          </button>
        )}
        {body}
        {rows.length === 0 && <div style={{ color: '#5b6675' }}>no indexed content yet</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  )
})

export default TranscriptView
