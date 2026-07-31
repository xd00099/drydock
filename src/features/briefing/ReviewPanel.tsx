import { useEffect, useRef, useState } from 'react'
import { clip, type ReviewState } from '@/lib/types'
import { S } from './styles'

export function ReviewPanel({
  review,
  accent,
  annotateOn,
  onDiscard,
  onSend,
}: {
  review: ReviewState
  accent: string
  annotateOn: boolean
  onDiscard?: (index: number) => void
  onSend?: (message: string, endReview: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const busy = review.presence === 'working'
  const canSend = !busy && (draft.trim().length > 0 || review.prompts.length > 0)
  const send = (end: boolean) => {
    if (busy) return
    onSend?.(draft, end)
    setDraft('')
  }
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [review.chat.length, review.prompts.length])
  const presenceLine = busy
    ? 'Claude is working on your feedback…'
    : review.presence === 'listening'
      ? 'Claude is waiting for your feedback'
      : 'Feedback queues here until Claude checks for it'
  return (
    <div style={{ flex: 'none', maxHeight: '45%', display: 'flex', flexDirection: 'column', borderTop: `2px solid ${accent}`, background: 'var(--dd-well)', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 0', fontSize: 10, color: 'var(--dd-text3)', flex: 'none' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: busy ? 'var(--dd-warn-bright)' : review.presence === 'listening' ? 'var(--dd-ok-bright)' : 'var(--dd-dim)', flex: 'none' }} />
        <span style={{ flex: 1 }}>{presenceLine}</span>
      </div>
      <div ref={logRef} style={{ overflowY: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 40 }}>
        {review.chat.map((c, i) => (
          <div key={i} style={{ fontSize: 11, lineHeight: 1.4, color: c.role === 'agent' ? 'var(--dd-accent-muted)' : 'var(--dd-text1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            <span style={{ color: 'var(--dd-dim)' }}>{c.role === 'agent' ? 'claude · ' : 'you · '}</span>
            {c.text}
          </div>
        ))}
        {review.prompts.map((p, i) => (
          <div key={`q${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, lineHeight: 1.4, background: 'var(--dd-surface2)', border: `1px solid ${accent}`, borderRadius: 'var(--dd-r-md)', padding: '4px 6px' }}>
            <span style={{ flex: 1, color: 'var(--dd-text1)', overflowWrap: 'anywhere' }}>
              {p.tag !== 'message' && (
                <span style={{ color: accent }}>{p.tag === 'text' ? `“${clip(p.text, 40)}” ` : `⟨${p.tag}⟩ `}</span>
              )}
              {p.prompt}
            </span>
            <button onClick={() => onDiscard?.(i)} title="Discard this annotation" style={{ background: 'none', border: 'none', color: 'var(--dd-dim)', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1.4 }}>
              ✕
            </button>
          </div>
        ))}
        {annotateOn && review.prompts.length === 0 && review.chat.length === 0 && (
          <div style={{ ...S.muted, fontSize: 10 }}>Click an element or select text in the artifact to annotate it, or type below.</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 10px 8px', alignItems: 'flex-end', flex: 'none' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSend) send(false)
            }
          }}
          placeholder={busy ? 'Claude is applying your feedback…' : 'Message Claude about this artifact…'}
          disabled={busy}
          rows={2}
          style={{ flex: 1, resize: 'none', background: 'var(--dd-bg1)', color: 'var(--dd-text)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '6px 8px', fontSize: 11, fontFamily: 'system-ui' }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            onClick={() => send(false)}
            disabled={!canSend}
            title="Send queued annotations + message to Claude"
            style={{ background: canSend ? accent : 'var(--dd-hover)', color: canSend ? 'var(--dd-ink)' : 'var(--dd-dim)', border: 'none', borderRadius: 'var(--dd-r-md)', padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: canSend ? 'pointer' : 'default', whiteSpace: 'nowrap' }}
          >
            Send{review.prompts.length ? ` (${review.prompts.length})` : ''}
          </button>
          <button
            onClick={() => send(true)}
            disabled={busy}
            title="Send everything and end the review — Claude stops polling"
            style={{ background: 'none', color: busy ? 'var(--dd-dim2)' : 'var(--dd-text3)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '3px 10px', fontSize: 10, cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
          >
            Send & end
          </button>
        </div>
      </div>
    </div>
  )
}
