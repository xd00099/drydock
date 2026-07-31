import type { SessionView } from '@/lib/types'

// A rotating ring (SVG SMIL, so it needs no global CSS): a faint full ring with
// a brighter half-arc spinning over it. Signals a session that's actively working.
// inline-block + middle baseline so it sits correctly in both flex rows (sidebar)
// and inline text rows (search palette).
function Spinner({ size = 11, color = 'var(--dd-accent)' }: { size?: number; color?: string }) {
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

// A check: the turn finished and the user hasn't looked at it yet. Deliberately
// quiet — it never pulses and never counts toward the dock badge, because "done"
// is news, not a request. Clears once the pane is visible AND the window is
// focused: a staged pane in a background window hasn't been seen by anyone.
function Finished({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}>
      <title>finished — ready for you</title>
      <path d="M4 13 l5 5 L20 6" fill="none" stroke="var(--dd-ok)" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A solid disc with a bang knocked out of it: this session is blocked on you.
// The four glyphs are deliberately four different SILHOUETTES, not one shape in
// four colors. "Waiting for you" and "idle" used to be the same 8px filled dot
// separated only by amber vs green — which is CIEDE2000 14.2 apart under
// protanopia, i.e. the single most important distinction in the sidebar rested
// on the one channel some people don't have. Shape costs nothing and survives
// all three dichromacies.
function Blocked({ size = 11 }: { size?: number }) {
  return (
    <svg className="dd-attn" width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}>
      <title>waiting for your input</title>
      <circle cx="12" cy="12" r="9" fill="var(--dd-warn)" />
      <rect x="10.6" y="6" width="2.8" height="8" rx="1.4" fill="var(--dd-bg0)" />
      <circle cx="12" cy="17.4" r="1.6" fill="var(--dd-bg0)" />
    </svg>
  )
}

// A hollow ring: open in a terminal, nothing happening. Hollow so it reads as
// "present but quiet" next to the solid disc that wants something.
function Idle({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}>
      <title>idle — open in a terminal</title>
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="var(--dd-ok)" strokeWidth={3} />
    </svg>
  )
}

// Status glyph for a session: pulsing amber disc when it's blocked on the user,
// a check when its turn just finished unseen, spinner when busy, a hollow ring
// when idle (open in a terminal but not actively working), nothing once ended.
// The disc and the check are different claims — one wants an answer, the other
// just has news — and only the disc is allowed to pulse or make a sound.
export default function LiveIndicator({ status }: { status: SessionView['live_status'] | null }) {
  if (status === 'needs_input') return <Blocked />
  if (status === 'done') return <Finished />
  if (status === 'busy') return <Spinner />
  if (status === 'idle') return <Idle />
  return null
}
