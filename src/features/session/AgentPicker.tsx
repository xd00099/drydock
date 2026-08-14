import { useEffect, useState } from 'react'
import type { ResolvedAgent } from '@/lib/agents'
import AgentLogo from '@/components/AgentLogo'

// The new-session agent step: pops from ⌘N / Home / sidebar ＋ whenever the
// user has ENABLED 2+ agents in Settings (with one, sessions launch directly
// and this never appears). Claude routes through the full session flow
// (pinned session id, hooks); everything else launches its command as a
// plain agent tab. Deliberately tiny: a list, arrows, Enter.

const S = {
  scrim: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(4,6,10,0.55)', display: 'flex', justifyContent: 'center', paddingTop: '18vh' } as React.CSSProperties,
  box: { width: 420, maxHeight: '50vh', alignSelf: 'flex-start', background: 'var(--dd-surface)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 10, boxShadow: '0 18px 50px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui', outline: 'none' } as React.CSSProperties,
  cap: { padding: '10px 14px 6px', fontSize: 10, color: 'var(--dd-dim)', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  list: { overflowY: 'auto', padding: '0 0 6px' } as React.CSSProperties,
  row: (sel: boolean) => ({ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer', background: sel ? 'var(--dd-row)' : 'none' }) as React.CSSProperties,
  name: { fontSize: 13, color: 'var(--dd-text)' } as React.CSSProperties,
  cmd: { fontSize: 11, color: 'var(--dd-dim)', fontFamily: 'ui-monospace, monospace', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 } as React.CSSProperties,
  hint: { padding: '6px 14px 10px', fontSize: 11, color: 'var(--dd-dim)', borderTop: '1px solid var(--dd-hairline)' } as React.CSSProperties,
}

export default function AgentPicker({ open, agents, cwd, onPick, onClose }: {
  open: boolean
  agents: ResolvedAgent[] // pickable (enabled ∧ available), claude first
  cwd: string | null // where the pick launches; shown so it's never a surprise
  onPick: (a: ResolvedAgent) => void
  onClose: () => void
}) {
  const [sel, setSel] = useState(0)
  useEffect(() => { if (open) setSel(0) }, [open])
  if (!open) return null
  // App freezes the offered list into the picker state at open, so Enter and
  // digit picks always hit the rows the user is looking at.
  const list = agents

  const pick = (a: ResolvedAgent) => { onPick(a); onClose() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return }
    if (e.key === 'Enter') { e.preventDefault(); if (list[sel]) pick(list[sel]); return }
    // bare 1-9 jump-picks; MODIFIED digits (⌘1 tab-switching muscle memory)
    // must not launch an agent
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = Number(e.key)
    if (n >= 1 && n <= list.length) { e.preventDefault(); pick(list[n - 1]) }
  }

  return (
    <div style={S.scrim} onClick={onClose}>
      <div style={S.box} onClick={(e) => e.stopPropagation()} onKeyDown={onKey} tabIndex={-1} ref={(el) => el?.focus()}>
        <div style={S.cap}>new session — which agent?</div>
        <div style={S.list}>
          {list.map((a, i) => (
            <div key={a.id} style={S.row(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => pick(a)}>
              <AgentLogo id={a.id} name={a.name} tint={a.tint} size={22} />
              <span style={S.name}>{a.name}</span>
              <span style={S.cmd}>{a.command}</span>
            </div>
          ))}
        </div>
        <div style={S.hint}>opens in {cwd ?? '~'} — configure agents in Settings</div>
      </div>
    </div>
  )
}
