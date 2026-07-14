import { useEffect, useRef } from 'react'

type Props = {
  query: string
  onQuery: (q: string) => void
  matches: { index: number; count: number } // index is 0-based of the active match, -1 if none
  focusNonce: number // bump to refocus+select (e.g. ⌘F while already open)
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

// Browser/iTerm-style find bar for the active session, overlaid at the top-right
// of the content area. Drives the active pane's PaneSearch.
export default function FindBar({ query, onQuery, matches, focusNonce, onNext, onPrev, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [focusNonce])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return // IME (pinyin): Enter/Esc belong to the IME
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); onNext() } // arrows step matches, like editor find
    else if (e.key === 'ArrowUp') { e.preventDefault(); onPrev() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  // "i/n" when the pane can locate the active match; count-only "n" otherwise
  // (e.g. terminal search past its highlight limit)
  const label = !query
    ? ''
    : matches.count === 0
      ? 'No results'
      : matches.index >= 0
        ? `${matches.index + 1}/${matches.count}`
        : `${matches.count}`
  const btn = { background: 'none', border: 'none', color: 'var(--dd-text2)', cursor: 'pointer', fontSize: 13, padding: '0 4px' } as const
  // inline style overrides the UA's :disabled look, so dim it explicitly
  const dis = !matches.count
  const navBtn = { ...btn, ...(dis ? { color: 'var(--dd-dim)', cursor: 'default' as const } : null) }
  return (
    <div
      style={{
        position: 'absolute', top: 8, right: 16, zIndex: 50, display: 'flex', alignItems: 'center', gap: 4,
        background: 'var(--dd-row)', border: '1px solid var(--dd-border2)', borderRadius: 6, padding: '4px 6px',
        boxShadow: '0 6px 20px rgba(0,0,0,.4)', fontFamily: 'system-ui', fontSize: 12,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in session…"
        style={{ width: 180, background: 'var(--dd-bg0)', border: '1px solid var(--dd-border2)', borderRadius: 4, color: 'var(--dd-text)', padding: '3px 6px', outline: 'none', fontSize: 12 }}
      />
      <span style={{ color: matches.count || !query ? 'var(--dd-text3)' : 'var(--dd-err-bright)', minWidth: 44, textAlign: 'center' }}>{label}</span>
      <button style={navBtn} title="Previous (⇧⏎ or ↑)" onClick={onPrev} disabled={dis}>↑</button>
      <button style={navBtn} title="Next (⏎ or ↓)" onClick={onNext} disabled={dis}>↓</button>
      <button style={{ ...btn, color: 'var(--dd-text3)' }} title="Close (Esc)" onClick={onClose}>✕</button>
    </div>
  )
}
