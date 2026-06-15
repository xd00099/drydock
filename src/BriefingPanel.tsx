import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, loadNum, relAge, type CardView, type TimelineItem } from './types'
import ResizeHandle from './ResizeHandle'

type Props = {
  sessionId: string
  starred: boolean
  onToggleStar?: () => void
}

function Item({ it }: { it: TimelineItem }) {
  return (
    <li style={{ marginBottom: 6 }}>
      <span style={{ color: it.in_progress ? '#7ec8a0' : '#c8cdd5' }}>
        {it.in_progress ? '◐ ' : ''}
        {it.text}
        {it.in_progress && <span style={{ color: '#5b6675', fontStyle: 'italic' }}> — in progress</span>}
      </span>
      {it.detail.length > 0 && (
        <ul style={{ margin: '3px 0 0', paddingLeft: 16, listStyle: 'none' }}>
          {it.detail.map((d, i) => (
            <li key={i} style={{ color: '#9aa3af', marginBottom: 2 }}>
              <span style={{ color: '#4a5462' }}>– </span>
              {d}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export default function BriefingPanel({ sessionId, starred, onToggleStar }: Props) {
  const [card, setCard] = useState<CardView | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.briefingCollapsed') === '1')
  const [width, setWidth] = useState(() => loadNum('dd.briefingWidth', 252))
  const widthRef = useRef(width)
  widthRef.current = width
  const refresh = useCallback(() => {
    invoke<CardView | null>('get_card', { sessionId }).then(setCard).catch(console.error)
  }, [sessionId])
  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  const toggleCollapsed = () =>
    setCollapsed((c) => { const n = !c; localStorage.setItem('dd.briefingCollapsed', n ? '1' : '0'); return n })

  // collapsed: a thin rail with an expand button, mirroring the left sidebar
  if (collapsed) {
    return (
      <div style={{ width: 30, minWidth: 30, height: '100%', background: '#0b0e13', borderLeft: '1px solid #1d2530', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <button onClick={toggleCollapsed} title="Expand panel" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 15, padding: 0 }}>«</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
    <ResizeHandle
      onDelta={(dx) => setWidth((w) => clampPanelWidth(w - dx))}
      onEnd={() => localStorage.setItem('dd.briefingWidth', String(widthRef.current))}
    />
    <div style={{ width, minWidth: width, boxSizing: 'border-box', background: '#0b0e13', padding: 12, fontFamily: 'system-ui', fontSize: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <button onClick={toggleCollapsed} title="Collapse panel" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 15, padding: 0, lineHeight: 1 }}>»</button>
        <button
          onClick={onToggleStar}
          disabled={!onToggleStar}
          title={starred ? 'Unstar this session' : 'Star this session'}
          style={{ background: 'none', border: 'none', cursor: onToggleStar ? 'pointer' : 'default', color: starred ? '#e8c35a' : '#3a4350', fontSize: 16, padding: 0, lineHeight: 1 }}
        >
          ★
        </button>
        <div style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>
          {card?.summary || 'Session'}
        </div>
      </div>

      {card ? (
        <>
          {card.timeline.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {card.timeline.map((it, i) => (
                <Item key={i} it={it} />
              ))}
            </ul>
          ) : (
            <div style={{ color: '#5b6675' }}>no timeline yet</div>
          )}
          <div style={{ color: '#5b6675', fontSize: 10, marginTop: 12 }}>card from {relAge(card.generated_at)} ago</div>
        </>
      ) : (
        <div style={{ color: '#5b6675' }}>no briefing card yet</div>
      )}
      <button style={{ marginTop: 10 }} onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}>
        Refresh card
      </button>
    </div>
    </div>
  )
}
