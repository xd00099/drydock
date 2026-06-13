import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { relAge } from './types'

type CardView = { goal: string; state: string; next_step: string; generated_at: number }

export default function BriefingPanel({ sessionId }: { sessionId: string }) {
  const [card, setCard] = useState<CardView | null>(null)
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

  const row = (label: string, text: string) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: '#7d8794', fontSize: 10, letterSpacing: 1 }}>{label}</div>
      <div style={{ color: '#c8cdd5' }}>{text}</div>
    </div>
  )
  return (
    <div style={{ width: 240, minWidth: 240, borderLeft: '1px solid #1d2530', background: '#0b0e13', padding: 12, fontFamily: 'system-ui', fontSize: 12, overflowY: 'auto' }}>
      {card ? (
        <>
          {row('GOAL', card.goal)}
          {row('STATE', card.state)}
          {row('NEXT', card.next_step)}
          <div style={{ color: '#5b6675', fontSize: 10 }}>card from {relAge(card.generated_at)} ago</div>
        </>
      ) : (
        <div style={{ color: '#5b6675' }}>no briefing card yet</div>
      )}
      <button style={{ marginTop: 10 }} onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}>
        Refresh card
      </button>
    </div>
  )
}
