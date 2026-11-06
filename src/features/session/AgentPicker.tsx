import { useEffect, useState } from 'react'
import type { ResolvedAgent } from '@/lib/agents'
import { shortPath } from '@/lib/types'
import AgentLogo from '@/components/AgentLogo'
import css from '@/components/ui/Palette.module.css'

// The new-session agent step: pops from ⌘N / Home / sidebar ＋ whenever the
// user has ENABLED 2+ agents in Settings (with one, sessions launch directly
// and this never appears). Claude routes through the full session flow
// (pinned session id, hooks); everything else launches its command as a
// plain agent tab. Deliberately tiny: a list, arrows, Enter.


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
    <div className={css.scrim} onClick={onClose}>
      <div className={css.box} role="dialog" aria-modal="true" aria-label="Choose an agent" onClick={(e) => e.stopPropagation()} onKeyDown={onKey} tabIndex={-1} ref={(el) => el?.focus()}>
        <div className={css.header}><h2 className={css.title}>Choose an agent</h2><kbd>esc</kbd></div>
        <div className={css.list}>
          {list.map((a, i) => (
            <div key={a.id} className={css.row} data-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(a)}>
              <AgentLogo id={a.id} name={a.name} tint={a.tint} size={22} />
              <span className={css.agentName}>{a.name}</span>
              <span className={css.agentCommand}>{a.command}</span>
            </div>
          ))}
        </div>
        <div className={css.footer} title={cwd ?? undefined}>opens in {cwd ? shortPath(cwd) : '~'} — configure agents in Settings</div>
      </div>
    </div>
  )
}
