import { useEffect, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SessionView } from '@/lib/types'
import { clip, relAge, sessionLabel, shortPath } from '@/lib/types'
import LiveIndicator from '@/features/session/LiveIndicator'
import Icon from '@/components/ui/Icon'
import css from '@/components/ui/Palette.module.css'

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
  const listId = useId()
  const [q, setQ] = useState('')
  const [resp, setResp] = useState<SearchResponse>({ results: [], semantic: 'unavailable' })
  const [sel, setSel] = useState(0)
  const selectionRef = useRef(sel)
  selectionRef.current = sel
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
      invoke<SearchResponse>('search', { query: q, semantic: false })
        .then(async (r) => {
          if (seq.current !== mine) return
          setResp(r); setSel(0)
          if (!q.trim()) return
          const enriched = await invoke<SearchResponse>('search', { query: q, semantic: true })
          if (seq.current === mine) {
            const selectedId = r.results[selectionRef.current]?.session.session_id
            setSel(Math.max(0, enriched.results.findIndex((hit) => hit.session.session_id === selectedId)))
            setResp(enriched)
          }
        })
        .catch(console.error)
    }, 120)
    return () => { clearTimeout(t); ++seq.current }
  }, [q, open])

  if (!open) return null
  const results = resp.results
  return (
    <div onClick={onClose} className={css.scrim} style={{ zIndex: 95 }}>
      <div onClick={(e) => e.stopPropagation()} className={css.box} role="dialog" aria-modal="true" aria-labelledby={`${listId}-title`}>
        <div className={css.header}><h2 className={css.title} id={`${listId}-title`}>Find a session</h2><kbd>esc</kbd></div>
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
          placeholder="Search projects, conversations, and code…"
          role="combobox" aria-label="Search sessions" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={listId} aria-activedescendant={results[sel] ? `${listId}-${sel}` : undefined}
          className={css.input}
        />
        {resp.semantic !== 'ready' && q && (
          <div className={css.hint}>
            {resp.semantic === 'indexing' ? 'semantic index catching up — keyword results' : 'keyword search'}
          </div>
        )}
        {/* Command row — pinned on empty query, or when explicitly asked for
            by keyword. NEVER interleaved with session results and NEVER part
            of the arrow-key selection: typing = searching sessions, always. */}
        {onOverlay && (q === '' || /^(usage|recaps?|log|timeline|home)/i.test(q.trim())) && (
          <button
            onClick={onOverlay}
            className={css.command}
          >
            <Icon name="terminal" />
            <span style={{ flex: 1 }}>Usage &amp; recap log</span>
            <span style={{ color: 'var(--dd-dim2)', fontSize: 10 }}>overlay · ⌘0 for Home</span>
          </button>
        )}
        <div ref={listRef} className={css.list} id={listId} role="listbox" aria-label="Sessions">
          {results.map((r, i) => (
            <div
              key={r.session.session_id}
              onClick={() => { onPick(r.session, false); onClose() }}
              onMouseEnter={() => setSel(i)}
              className={css.result} data-selected={i === sel} id={`${listId}-${i}`} role="option" aria-selected={i === sel}
            >
              {/* flex, not float: a float that doesn't fit drops BELOW the title
                  line; here the title ellipsizes and the metadata stays put */}
              <div className={css.resultHead}>
                {r.session.live_status !== 'ended' && (
                  <span style={{ marginRight: 6, flexShrink: 0 }}>
                    <LiveIndicator status={r.session.live_status} />
                  </span>
                )}
                <span className={css.resultLabel}>{clip(sessionLabel(r.session), 52)}</span>
                {r.session.starred && <span style={{ color: 'var(--dd-warn-bright)', flexShrink: 0 }}> ★</span>}

              </div>
              <div className={css.resultMeta}>{clip(shortPath(r.session.project_path), 60)} · {relAge(r.session.last_message_at)}</div>
              {r.snippet && <div className={css.snippet}>{clip(r.snippet, 90)}</div>}
            </div>
          ))}
          {q && results.length === 0 && <div className={css.empty}>No matching sessions</div>}
        </div>
        <div className={css.footer}><span><kbd>↑↓</kbd> Navigate · <kbd>↵</kbd> Resume · <kbd>⌘↵</kbd> Transcript</span><span className={css.shortcut}>proj: · starred: · live:</span></div>
      </div>
    </div>
  )
}
