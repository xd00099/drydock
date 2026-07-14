import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SessionView } from './types'
import { clip, relAge, sessionLabel, shortPath } from './types'
import LiveIndicator from './LiveIndicator'

type SearchResult = { session: SessionView; snippet: string }
type SearchResponse = { results: SearchResult[]; semantic: string }

type Props = {
  open: boolean
  onClose: () => void
  onPick: (s: SessionView, transcript: boolean) => void
  // open the Home overlay (usage + recap log) without leaving the tab
  onOverlay?: () => void
}

export default function SearchPalette({ open, onClose, onPick, onOverlay }: Props) {
  const [q, setQ] = useState('')
  const [resp, setResp] = useState<SearchResponse>({ results: [], semantic: 'unavailable' })
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setResp((r) => ({ results: [], semantic: r.semantic })) // no stale results flash
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const mine = ++seq.current
    const t = setTimeout(() => {
      invoke<SearchResponse>('search', { query: q })
        .then((r) => { if (seq.current === mine) { setResp(r); setSel(0) } })
        .catch(console.error)
    }, 120)
    return () => clearTimeout(t)
  }, [q, open])

  if (!open) return null
  const results = resp.results
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', justifyContent: 'center', paddingTop: 80, zIndex: 95 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxHeight: '70vh', background: 'var(--dd-surface2)', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui', fontSize: 13, color: 'var(--dd-text1)' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return // IME composition (pinyin): Enter/Esc/arrows belong to the IME
            if (e.key === 'Escape') onClose()
            // keep the keyboard selection visible: the list scrolls, the rows
            // map 1:1 to children, and 'nearest' no-ops when already in view
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              const n = Math.min(sel + 1, results.length - 1)
              setSel(n)
              listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' })
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              const n = Math.max(sel - 1, 0)
              setSel(n)
              listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' })
            }
            if (e.key === 'Enter' && results[sel]) { onPick(results[sel].session, e.metaKey); onClose() }
          }}
          placeholder="search all sessions…  (proj:x  starred:  live:  ·  Enter resume · ⌘Enter transcript)"
          style={{ padding: '12px 14px', background: 'var(--dd-bg0)', border: 'none', outline: 'none', color: 'var(--dd-text)', fontSize: 14 }}
        />
        {resp.semantic !== 'ready' && q && (
          <div style={{ padding: '4px 14px', color: 'var(--dd-dim)', fontSize: 11 }}>
            {resp.semantic === 'indexing' ? 'semantic index catching up — keyword results' : 'keyword search'}
          </div>
        )}
        {/* Command row — pinned on empty query, or when explicitly asked for
            by keyword. NEVER interleaved with session results and NEVER part
            of the arrow-key selection: typing = searching sessions, always. */}
        {onOverlay && (q === '' || /^(usage|recaps?|log|timeline|home)/i.test(q.trim())) && (
          <button
            onClick={onOverlay}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--dd-border)', color: 'var(--dd-text2)', cursor: 'pointer', padding: '7px 14px', fontSize: 12, fontFamily: 'system-ui' }}
          >
            <span style={{ color: 'var(--dd-accent-muted)' }}>◱</span>
            <span style={{ flex: 1 }}>Usage &amp; recap log</span>
            <span style={{ color: 'var(--dd-dim2)', fontSize: 10 }}>overlay · ⌘0 for Home</span>
          </button>
        )}
        <div ref={listRef} style={{ overflowY: 'auto' }}>
          {results.map((r, i) => (
            <div
              key={r.session.session_id}
              onClick={() => { onPick(r.session, false); onClose() }}
              onMouseEnter={() => setSel(i)}
              style={{ padding: '8px 14px', background: i === sel ? 'var(--dd-border)' : 'transparent', cursor: 'pointer' }}
            >
              {/* flex, not float: a float that doesn't fit drops BELOW the title
                  line; here the title ellipsizes and the metadata stays put */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {r.session.live_status !== 'ended' && (
                  <span style={{ marginRight: 6, flexShrink: 0 }}>
                    <LiveIndicator status={r.session.live_status} />
                  </span>
                )}
                <span style={{ color: 'var(--dd-text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip(sessionLabel(r.session), 52)}</span>
                {r.session.starred && <span style={{ color: 'var(--dd-warn-bright)', flexShrink: 0 }}> ★</span>}
                <span style={{ marginLeft: 'auto', paddingLeft: 8, flexShrink: 0, whiteSpace: 'nowrap', color: 'var(--dd-dim)' }}>{clip(shortPath(r.session.project_path), 40)} · {relAge(r.session.last_message_at)}</span>
              </div>
              {r.snippet && <div style={{ color: 'var(--dd-text3)', fontSize: 12, marginTop: 2 }}>{clip(r.snippet, 90)}</div>}
            </div>
          ))}
          {q && results.length === 0 && <div style={{ padding: 14, color: 'var(--dd-dim)' }}>no matches</div>}
        </div>
      </div>
    </div>
  )
}
