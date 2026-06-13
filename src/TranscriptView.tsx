import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SessionView } from './types'

type ChunkView = { role: string; text: string; ts: number | null }

type Props = {
  sessionId: string
  session: SessionView | undefined // live row from useSessions, updates with the radar
  onResumeHere: () => void
  onInteract?: () => void // scrolling/clicking the transcript body
}

export default function TranscriptView({ sessionId, session, onResumeHere, onInteract }: Props) {
  const [chunks, setChunks] = useState<ChunkView[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const refresh = useCallback(() => {
    invoke<ChunkView[]>('session_chunks', { sessionId }).then(setChunks).catch(console.error)
  }, [sessionId])

  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  useEffect(() => { bottomRef.current?.scrollIntoView() }, [chunks])

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
            {c.text}
          </div>
        ))}
        {chunks.length === 0 && <div style={{ color: '#5b6675' }}>no indexed content yet</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
