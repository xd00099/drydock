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
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const label = query ? (matches.count ? `${matches.index + 1}/${matches.count}` : 'No results') : ''
  const btn = { background: 'none', border: 'none', color: '#9aa3af', cursor: 'pointer', fontSize: 13, padding: '0 4px' } as const
  return (
    <div
      style={{
        position: 'absolute', top: 8, right: 16, zIndex: 30, display: 'flex', alignItems: 'center', gap: 4,
        background: '#1b2230', border: '1px solid #2c3647', borderRadius: 6, padding: '4px 6px',
        boxShadow: '0 6px 20px rgba(0,0,0,.4)', fontFamily: 'system-ui', fontSize: 12,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in session…"
        style={{ width: 180, background: '#0b0e13', border: '1px solid #2c3647', borderRadius: 4, color: '#e8edf4', padding: '3px 6px', outline: 'none', fontSize: 12 }}
      />
      <span style={{ color: matches.count || !query ? '#7d8794' : '#e8907a', minWidth: 44, textAlign: 'center' }}>{label}</span>
      <button style={btn} title="Previous (⇧⏎)" onClick={onPrev} disabled={!matches.count}>↑</button>
      <button style={btn} title="Next (⏎)" onClick={onNext} disabled={!matches.count}>↓</button>
      <button style={{ ...btn, color: '#7d8794' }} title="Close (Esc)" onClick={onClose}>✕</button>
    </div>
  )
}
