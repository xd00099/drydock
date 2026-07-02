import type { SessionView } from './types'

// A rotating ring (SVG SMIL, so it needs no global CSS): a faint full ring with
// a brighter half-arc spinning over it. Signals a session that's actively working.
// inline-block + middle baseline so it sits correctly in both flex rows (sidebar)
// and inline text rows (search palette).
function Spinner({ size = 11, color = '#8ab4f8' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}>
      <title>running</title>
      <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={3.5} />
      <path d="M12 3 a 9 9 0 0 1 0 18" fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="0.75s" repeatCount="indefinite" />
      </path>
    </svg>
  )
}

// Status glyph for a session: pulsing amber when it's waiting on the user,
// spinner when busy, a steady green dot when idle (open in a terminal but not
// actively working), nothing once ended.
export default function LiveIndicator({ status }: { status: SessionView['live_status'] | null }) {
  if (status === 'needs_input')
    return (
      <span
        className="dd-attn"
        title="waiting for your input"
        style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: '#e8a33d', display: 'inline-block', verticalAlign: 'middle' }}
      />
    )
  if (status === 'busy') return <Spinner />
  if (status === 'idle')
    return (
      <span
        title="idle — open in a terminal"
        style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: '#4ec77e', display: 'inline-block', verticalAlign: 'middle' }}
      />
    )
  return null
}
