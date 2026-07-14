import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { PaneSearch, SessionView, TakeoverInfo, TEntry, TranscriptPage } from './types'
import { clip } from './types'

type ChunkView = { role: string; text: string; ts: number | null }
type AgentInfo = { agent_id: string; agent_type: string | null; description: string | null }

type Props = {
  sessionId: string
  session: SessionView | undefined // live row from useSessions, updates with the radar
  onResumeHere: () => void
  // set when this session's live terminal is open in THIS window — the header
  // then offers a jump back (the ⌘⇧T toggle's visible half)
  onFocusLive?: (() => void) | null
  // set for a session live in ANOTHER terminal — the header offers taking it
  // over (App owns the confirm dialog + kill + resume)
  onTakeover?: (() => void) | null
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
  return { kind, text: c.text, tool: null, tool_use_id: null, meta: false, error: false, persisted_path: null, ts: c.ts }
}

const chipBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--dd-text3)',
  fontFamily: 'Menlo, monospace',
  fontSize: 11,
  padding: '1px 0',
  textAlign: 'left',
}

const hBtn: React.CSSProperties = {
  background: 'var(--dd-border)',
  color: 'var(--dd-text)',
  border: '1px solid var(--dd-border2)',
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
  { sessionId, session, onResumeHere, onFocusLive, onTakeover, onInteract, onMatches },
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

  // Subagent conversations attached to this session (sidecar files). Loaded
  // once per session + refreshed on index ticks so a live fan-out appears.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentOpen, setAgentOpen] = useState<AgentInfo | null>(null)
  useEffect(() => {
    setAgents([])
    setAgentOpen(null)
    let cancelled = false
    let busy = false
    let lastJson = ''
    // index ticks are frequent; only re-render when the agent list CHANGED,
    // and never let a slow scan overlap the next one
    const load = () => {
      if (busy) return
      busy = true
      invoke<AgentInfo[]>('session_agents', { sessionId })
        .then((a) => {
          if (cancelled) return
          const j = JSON.stringify(a)
          if (j !== lastJson) { lastJson = j; setAgents(a) }
        })
        .catch(() => {})
        .finally(() => { busy = false })
    }
    load()
    let un: UnlistenFn | null = null
    listen('index-updated', load).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [sessionId])

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
        // ⌘F searches the PARENT transcript; an open agent overlay would hide
        // every hit behind itself — close it when a real query starts
        if (query) setAgentOpen(null)
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
          style={{ background: isActive ? 'var(--dd-warn-bright)' : 'var(--dd-border3)', color: isActive ? 'var(--dd-bg1)' : 'inherit', borderRadius: 2 }}
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
            <div key={idx} style={{ margin: '6px 0', color: 'var(--dd-dim2)', fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
              {renderText(e.text, marks)}
            </div>
          )
        return (
          <div key={idx} style={{ margin: '12px 0', padding: '6px 10px', borderLeft: '3px solid var(--dd-accent-muted)', background: 'rgba(90,127,176,.09)', borderRadius: 4, color: 'var(--dd-accent-text)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {renderText(e.text, marks)}
          </div>
        )
      case 'assistant':
        return (
          <div key={idx} style={{ margin: '8px 0', color: 'var(--dd-text1)' }}>
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
          <div key={idx} style={{ margin: '12px 0', padding: '6px 10px', borderLeft: '3px solid var(--dd-warn-bright)', background: 'rgba(232,195,90,.07)', borderRadius: 4, color: 'var(--dd-warn-bright)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            ※ {renderText(e.text, marks)}
          </div>
        )
      case 'compact':
        return (
          <div key={idx} style={{ textAlign: 'center', color: 'var(--dd-dim2)', fontSize: 11, margin: '12px 0' }}>
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
              <div style={{ margin: '2px 0 6px 16px', color: 'var(--dd-text3)', fontStyle: 'italic', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontSize: 11 }}>
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
              <span style={{ color: 'var(--dd-teal)', flexShrink: 0 }}>⏺ {e.tool ?? 'tool'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.text}</span>
              {r.result && (
                <span style={{ flexShrink: 0, color: r.result.error ? 'var(--dd-err)' : 'var(--dd-ok)' }}>{r.result.error ? '✗' : '✓'}</span>
              )}
            </button>
            {open && (
              <div style={{ margin: '2px 0 8px 16px', padding: '6px 8px', background: 'var(--dd-bg0)', border: '1px solid var(--dd-border)', borderRadius: 4, fontSize: 11, fontFamily: 'Menlo, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: 260, overflowY: 'auto' }}>
                <div style={{ color: 'var(--dd-text2)' }}>{e.text || '(no input summary)'}</div>
                {r.result && (
                  <div style={{ marginTop: 6, color: r.result.error ? 'var(--dd-err)' : 'var(--dd-text3)' }}>{r.result.text || '(no output)'}</div>
                )}
                {r.result?.persisted_path && (
                  <button
                    style={{ ...hBtn, marginTop: 6, fontSize: 11, padding: '2px 8px' }}
                    title={`The result was too large for the transcript; the full output is on disk.\n${r.result.persisted_path}`}
                    onClick={() =>
                      invoke('open_path', { path: r.result!.persisted_path, reveal: false }).catch((err) => flash(String(err), true))
                    }
                  >
                    Open full output
                  </button>
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
        <div key={`t${idx}`} style={{ textAlign: 'center', color: 'var(--dd-border3)', fontSize: 10, margin: '10px 0 2px' }}>
          {fmtTime(r.e.ts, prevTs)}
        </div>,
      )
    }
    if (r.e.ts != null) prevTs = r.e.ts
    body.push(renderRow(r, idx))
  })

  const live = session && session.live_status !== 'ended'
  // Live in another terminal: name WHERE it's running (host app · tty) — the
  // whole point is not having to hunt for that window. Best-effort; the plain
  // "another terminal" text stands when the process can't be located.
  const [loc, setLoc] = useState<TakeoverInfo | null>(null)
  const liveElsewhere = !!live && !onFocusLive
  // re-locate when the session's live state changes too (it may move terminals
  // or its status may flip) — not just on the first transition
  useEffect(() => {
    if (!liveElsewhere) { setLoc(null); return }
    let stale = false
    invoke<TakeoverInfo | null>('session_process_info', { sessionId })
      .then((i) => { if (!stale) setLoc(i) })
      .catch(() => {})
    return () => { stale = true }
  }, [sessionId, liveElsewhere, session?.live_status])
  return (
    <div
      // links in rendered markdown (parent transcript AND agent overlay) must
      // not navigate the app's own webview — capture-guard the whole pane
      onClickCapture={(ev) => {
        const a = (ev.target as HTMLElement).closest?.('a')
        if (a) ev.preventDefault()
      }}
      // opaque: a split pane's session tint stays in the pane's thin mat —
      // never washing the reading surface (or shifting it with focus)
      style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--dd-bg1)', color: 'var(--dd-text1)', fontFamily: 'system-ui', fontSize: 13 }}
    >
      <div style={{ padding: '6px 10px', background: 'var(--dd-surface2)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flexShrink: 0 }}>
          {live
            ? onFocusLive
              ? `read-only transcript — live in this window (${session?.live_status})`
              : `running in ${loc?.app ?? 'another terminal'}${loc?.tty ? ` · ${loc.tty}` : ''} (${session?.live_status}) — read-only live view`
            : 'session ended'}
        </span>
        {live && onFocusLive && (
          <button style={hBtn} title="Switch to the running terminal tab (⌘⇧T)" onClick={onFocusLive}>
            Go to live tab
          </button>
        )}
        {liveElsewhere && onTakeover && (
          <button style={hBtn} title="Stop that terminal's claude and resume this session here" onClick={onTakeover}>
            Take over here…
          </button>
        )}
        {!live && (
          <button style={hBtn} onClick={onResumeHere}>
            Resume here
          </button>
        )}
        <button style={hBtn} title="Export the full transcript as Markdown to your Downloads folder" onClick={exportMd}>
          Export .md
        </button>
        {msg && (
          <span title={msg.text} style={{ color: msg.error ? 'var(--dd-err)' : 'var(--dd-ok-bright)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {msg.text}
          </span>
        )}
        {fallback && (
          <span style={{ marginLeft: 'auto', color: 'var(--dd-dim)', fontSize: 11, flexShrink: 0 }} title="The session's .jsonl is gone (or not synced yet); showing the indexed text.">
            indexed text only
          </span>
        )}
      </div>
      {agents.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--dd-bg1)', borderBottom: '1px solid var(--dd-surface2)', overflowX: 'auto', flexShrink: 0 }}>
          <span style={{ color: 'var(--dd-dim)', fontSize: 11, flexShrink: 0 }}>⑂ {agents.length} subagent{agents.length > 1 ? 's' : ''}</span>
          {agents.map((a) => (
            <button
              key={a.agent_id}
              onClick={() => setAgentOpen(a)}
              title={`${a.agent_type ?? 'agent'}${a.description ? ` — ${a.description}` : ''}\nOpen this agent's conversation`}
              style={{ flexShrink: 0, background: 'var(--dd-btn)', border: '1px solid var(--dd-border2)', borderRadius: 10, color: 'var(--dd-text2)', padding: '1px 9px', fontSize: 11, cursor: 'pointer', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {a.agent_type ?? 'agent'}{a.description ? ` · ${clip(a.description, 24)}` : ''}
            </button>
          ))}
        </div>
      )}
      <div
        ref={scrollerRef}
        onWheel={onInteract}
        onMouseDown={onInteract}
        onScroll={() => {
          const el = scrollerRef.current
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        style={{ flex: 1, overflowY: 'auto', padding: 12, fontFamily: 'Menlo, monospace', fontSize: 12 }}
      >
        {shownStart > 0 && (
          <button
            style={{ ...chipBtn, color: 'var(--dd-accent-muted)', margin: '0 auto 8px', display: 'block' }}
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
        {rows.length === 0 && <div style={{ color: 'var(--dd-dim)' }}>no indexed content yet</div>}
        <div ref={bottomRef} />
      </div>
      {agentOpen && <AgentPane sessionId={sessionId} agent={agentOpen} onClose={() => setAgentOpen(null)} />}
    </div>
  )
})

/// A subagent's conversation, overlaid on its parent transcript. Read-only,
/// fetched whole (agent files are bounded); Esc or ‹ returns to the parent.
function AgentPane({ sessionId, agent, onClose }: { sessionId: string; agent: AgentInfo; onClose: () => void }) {
  const [entries, setEntries] = useState<TEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // incremental + live: same offset contract as the parent transcript, so a
  // still-running agent tails in, and a transient read error retries on the
  // next index tick instead of sticking forever
  useEffect(() => {
    let cancelled = false
    let busy = false
    const offset = { current: 0 }
    const load = () => {
      if (busy) return
      busy = true
      invoke<TranscriptPage>('agent_transcript', { sessionId, agentId: agent.agent_id, fromOffset: offset.current })
        .then((p) => {
          if (cancelled) return
          setErr(null)
          offset.current = p.next_offset
          if (p.reset) setEntries(p.entries)
          else if (p.entries.length) setEntries((prev) => [...(prev ?? []), ...p.entries])
          else setEntries((prev) => prev ?? [])
        })
        .catch((e) => { if (!cancelled) setErr(String(e)) })
        .finally(() => { busy = false })
    }
    load()
    let un: UnlistenFn | null = null
    listen('index-updated', load).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [sessionId, agent.agent_id])
  // Esc is scoped to the pane's own (focused) element — a window-capture
  // listener would swallow Escape for hidden tabs, the palette and find bar
  useEffect(() => { rootRef.current?.focus() }, [])

  const [open, setOpen] = useState<Set<number>>(new Set())
  const row = (e: TEntry, i: number) => {
    switch (e.kind) {
      case 'user':
        return (
          <div key={i} style={{ margin: '10px 0', padding: '6px 10px', background: e.meta ? 'transparent' : 'var(--dd-btn)', border: '1px solid var(--dd-border)', borderRadius: 6, color: e.meta ? 'var(--dd-dim)' : 'var(--dd-text1)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {e.text}
          </div>
        )
      case 'assistant':
        return (
          <div key={i} style={{ margin: '8px 0' }}>
            <MdBlock text={e.text} />
          </div>
        )
      case 'thinking':
      case 'tool_use':
      case 'tool_result': {
        const o = open.has(i)
        const label = e.kind === 'thinking' ? 'thinking' : e.kind === 'tool_use' ? `⏺ ${e.tool ?? 'tool'}` : e.error ? '✗ result' : '✓ result'
        return (
          <div key={i} style={{ margin: '2px 0' }}>
            <button style={chipBtn} onClick={() => setOpen((p) => { const n = new Set(p); if (o) n.delete(i); else n.add(i); return n })}>
              <span style={{ flexShrink: 0 }}>{o ? '▾' : '▸'}</span>
              <span style={{ color: e.error ? 'var(--dd-err)' : 'var(--dd-teal)', flexShrink: 0 }}>{label}</span>
              {!o && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{clip(e.text.replace(/\s+/g, ' '), 80)}</span>}
            </button>
            {o && (
              <div style={{ margin: '2px 0 6px 16px', color: 'var(--dd-text3)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontSize: 11 }}>{e.text}</div>
            )}
          </div>
        )
      }
      default:
        return null
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      }}
      style={{ position: 'absolute', inset: 0, background: 'var(--dd-bg1)', display: 'flex', flexDirection: 'column', zIndex: 20, outline: 'none' }}
    >
      <div style={{ padding: '6px 10px', background: 'var(--dd-surface2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button style={hBtn} onClick={onClose} title="Back to the session transcript (Esc)">‹ back</button>
        <span style={{ color: 'var(--dd-text2)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          subagent · {agent.agent_type ?? agent.agent_id}{agent.description ? ` — ${agent.description}` : ''}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, fontFamily: 'Menlo, monospace', fontSize: 12, color: 'var(--dd-text1)' }}>
        {err && <div style={{ color: 'var(--dd-err)' }}>{err}</div>}
        {entries === null && !err && <div style={{ color: 'var(--dd-dim)' }}>loading…</div>}
        {entries?.map(row)}
        {entries?.length === 0 && <div style={{ color: 'var(--dd-dim)' }}>empty agent transcript</div>}
      </div>
    </div>
  )
}

export default TranscriptView
