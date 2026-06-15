import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { PaneSearch, SessionView } from './types'

type ChunkView = { role: string; text: string; ts: number | null }

type Props = {
  sessionId: string
  session: SessionView | undefined // live row from useSessions, updates with the radar
  onResumeHere: () => void
  onInteract?: () => void // scrolling/clicking the transcript body
  onMatches?: (index: number, count: number) => void // ⌘F find results (active match, total)
}

type Match = { ci: number; start: number; len: number }

// Case-insensitive occurrences of `q` across all chunks, in document order.
function computeMatches(chunks: ChunkView[], q: string): Match[] {
  const out: Match[] = []
  const needle = q.toLowerCase()
  if (!needle) return out
  for (let ci = 0; ci < chunks.length; ci++) {
    const hay = chunks[ci].text.toLowerCase()
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

const TranscriptView = forwardRef<PaneSearch, Props>(function TranscriptView(
  { sessionId, session, onResumeHere, onInteract, onMatches },
  ref,
) {
  const [chunks, setChunks] = useState<ChunkView[]>([])
  const [hl, setHl] = useState<{ q: string; active: number }>({ q: '', active: -1 })
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeMarkRef = useRef<HTMLElement | null>(null)
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks
  const hlRef = useRef(hl)
  hlRef.current = hl
  const onMatchesRef = useRef(onMatches)
  onMatchesRef.current = onMatches

  const refresh = useCallback(() => {
    invoke<ChunkView[]>('session_chunks', { sessionId }).then(setChunks).catch(console.error)
  }, [sessionId])

  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  useEffect(() => { bottomRef.current?.scrollIntoView() }, [chunks])

  useImperativeHandle(ref, (): PaneSearch => ({
    find(query, { dir, incremental }) {
      try {
        if (!query) { setHl({ q: '', active: -1 }); onMatchesRef.current?.(-1, 0); return }
        const ms = computeMatches(chunksRef.current, query)
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

  // matches grouped by chunk with their global index, for highlighting
  const byChunk = useMemo(() => {
    const map = new Map<number, { start: number; len: number; gi: number }[]>()
    computeMatches(chunks, hl.q).forEach((m, gi) => {
      const arr = map.get(m.ci) ?? []
      arr.push({ start: m.start, len: m.len, gi })
      map.set(m.ci, arr)
    })
    return map
  }, [chunks, hl.q])

  useEffect(() => {
    if (hl.active >= 0) activeMarkRef.current?.scrollIntoView({ block: 'center' })
  }, [hl.active, hl.q])

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

  const live = session && session.live_status !== 'ended'
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: '6px 10px', background: '#161c25', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>
          {live
            ? `running in another terminal (${session?.live_status}) — read-only live view`
            : 'session ended'}
        </span>
        {!live && <button onClick={onResumeHere}>Resume here</button>}
      </div>
      <div onWheel={onInteract} onMouseDown={onInteract} style={{ flex: 1, overflowY: 'auto', padding: 12, whiteSpace: 'pre-wrap', fontFamily: 'Menlo, monospace', fontSize: 12 }}>
        {chunks.map((c, i) => (
          <div key={i} style={{ marginBottom: 10, color: c.role === 'recap' ? '#e8c35a' : c.role === 'user' ? '#8ab4f8' : '#c8cdd5' }}>
            {renderText(c.text, byChunk.get(i))}
          </div>
        ))}
        {chunks.length === 0 && <div style={{ color: '#5b6675' }}>no indexed content yet</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  )
})

export default TranscriptView
