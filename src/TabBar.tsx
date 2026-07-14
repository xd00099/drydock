import { useEffect, useRef } from 'react'
import type { SessionView, Tab } from './types'
import { baseName, clip, sessionColor, sessionLabel } from './types'
import { useChord } from './keymap'

type Props = {
  tabs: Tab[]
  sessions: SessionView[] // index, for resolving a session tab's live label
  activeId: number | null
  stagedIds: number[] // tabs currently visible on stage (split panes); ⊇ active
  shellDirs: Record<number, string> // live cwd per shell tab id
  unread: Record<number, number> // unseen artifact count per tab id
  // drag-to-split / drag-to-reorder (App owns the pointer drag; chips only arm it)
  draggedId: number | null
  insertMark: { beforeId: number | null } | null // reorder slot in the dragged tab's lane
  onChipPress: (e: React.PointerEvent, id: number, label: string) => void
  onChipDouble: (id: number) => void
  onChipMenu: (e: React.MouseEvent, id: number) => void
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onNewShell: () => void
  onHome: () => void // the sessions-lane ＋: Home is where sessions start
}

// Name each terminal after its directory's basename; disambiguate repeats with
// (2), (3)… in creation order so the numbering is stable.
function terminalLabels(termTabs: Tab[], dirs: Record<number, string>): Record<number, string> {
  const counts: Record<string, number> = {}
  const out: Record<number, string> = {}
  for (const t of [...termTabs].sort((a, b) => a.id - b.id)) {
    const dir = dirs[t.id]
    const base = dir ? baseName(dir) : 'shell'
    const n = (counts[base] = (counts[base] ?? 0) + 1)
    out[t.id] = n === 1 ? base : `${base} (${n})`
  }
  return out
}

const S = {
  lane: { display: 'flex', alignItems: 'center', gap: 2, padding: '3px 6px', overflowX: 'auto', whiteSpace: 'nowrap' } as const,
  laneLabel: { flexShrink: 0, fontSize: 9, letterSpacing: 1, color: '#4a5462', marginRight: 6, width: 58, textAlign: 'right' } as const,
  // userSelect none: chips are drag handles — a drag across labels must not
  // leave text selections behind
  chip: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', borderLeft: '3px solid transparent', borderBottom: '2px solid transparent', userSelect: 'none' } as const,
  close: { color: '#5b6675' } as const,
  plus: { flexShrink: 0, background: 'none', border: 'none', color: '#7d8794', cursor: 'pointer', fontSize: 14 } as const,
  mark: { flexShrink: 0, width: 2, height: 16, background: '#7fb0ff', borderRadius: 1 } as const,
}

export default function TabBar({ tabs, sessions, activeId, stagedIds, shellDirs, unread, draggedId, insertMark, onChipPress, onChipDouble, onChipMenu, onSelect, onClose, onNewShell, onHome }: Props) {
  const homeChord = useChord('home.show')
  const shellChord = useChord('shell.new')
  const sessionTabs = tabs.filter((t) => !t.terminal)
  const termTabs = tabs.filter((t) => t.terminal)
  const termNames = terminalLabels(termTabs, shellDirs)
  const draggedLane = draggedId !== null ? !!tabs.find((t) => t.id === draggedId)?.terminal : null

  // When a lane overflows, a newly activated chip can sit fully off-screen with
  // no affordance. Reveal it whenever the active tab changes (only then — other
  // re-renders must not touch scroll position); 'nearest' no-ops when visible.
  const activeChipRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId])

  const chip = (t: Tab, label: string, accent?: string, tip?: string, attention?: boolean, hue?: number | null) => {
    const staged = stagedIds.includes(t.id)
    return (
      <div
        key={t.id}
        ref={t.id === activeId ? activeChipRef : undefined}
        data-tabchip={t.id}
        onClick={() => onSelect(t.id)}
        onDoubleClick={() => onChipDouble(t.id)}
        onPointerDown={(e) => onChipPress(e, t.id, label)}
        onContextMenu={(e) => onChipMenu(e, t.id)}
        title={tip}
        style={{
          ...S.chip,
          // tint the chip in its session's color (like the sidebar rows): a faint
          // wash when inactive, stronger when active; the solid strip stays at left
          background: t.sessionId
            ? sessionColor(t.sessionId, t.id === activeId ? 0.3 : staged ? 0.18 : 0.1, hue)
            : t.id === activeId ? '#1d2530' : staged ? '#161c25' : 'transparent',
          borderLeftColor: accent ?? 'transparent',
          // "on stage" underline: a split can show several tabs at once — every
          // visible one wears the mark; the focused one also gets the strong wash
          borderBottomColor: staged ? (t.sessionId ? sessionColor(t.sessionId, 1, hue) : '#5a7fb0') : 'transparent',
          color: t.exited ? '#5b6675' : '#c8cdd5',
          opacity: t.id === draggedId ? 0.4 : 1,
        }}
      >
        {attention && (
          <span className="dd-attn" title="waiting for your input" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: '50%', background: '#e8a33d' }} />
        )}
        {/* a transcript tab is a READER, not a dead terminal: ≣ prefix instead
            of the (misleading) ·ended suffix */}
        <span style={{ fontStyle: t.preview ? 'italic' : undefined }}>
          {t.kind === 'transcript' ? '≣ ' : ''}
          {clip(label, 22)}
          {t.exited && t.kind !== 'transcript' ? ' ·ended' : ''}
        </span>
        {unread[t.id] ? (
          <span title={`${unread[t.id]} new artifact${unread[t.id] > 1 ? 's' : ''}`} style={{ background: '#5a7fb0', color: '#0b0e13', borderRadius: 8, fontSize: 9, fontWeight: 700, padding: '0 5px', lineHeight: '14px' }}>{unread[t.id]}</span>
        ) : null}
        <span style={S.close} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(t.id) }}>✕</span>
      </div>
    )
  }

  // Reorder feedback: a slim slot marker in the dragged tab's own lane.
  const laneChips = (chips: { t: Tab; el: React.ReactNode }[], isTermLane: boolean) => {
    const marking = insertMark !== null && draggedLane === isTermLane
    return (
      <>
        {chips.map(({ t, el }) => (
          <span key={t.id} style={{ display: 'contents' }}>
            {marking && insertMark.beforeId === t.id && <span style={S.mark} />}
            {el}
          </span>
        ))}
        {marking && insertMark.beforeId === null && <span style={S.mark} />}
      </>
    )
  }

  return (
    <div data-tabbar="1" style={{ background: '#0b0e13', borderBottom: '1px solid #1d2530', fontFamily: 'system-ui', fontSize: 12 }}>
      {sessionTabs.length > 0 && (
        <div data-lane="s" style={S.lane}>
          <span style={S.laneLabel}>SESSIONS</span>
          {laneChips(
            sessionTabs.map((t) => {
              const s = t.sessionId ? sessions.find((x) => x.session_id === t.sessionId) : undefined
              const label = s ? sessionLabel(s) : t.title
              const tip = t.kind === 'transcript' ? `${label} — read-only transcript` : label
              return { t, el: chip(t, label, t.sessionId ? sessionColor(t.sessionId, 1, s?.hue) : undefined, tip, s?.live_status === 'needs_input', s?.hue) }
            }),
            false
          )}
          {/* browser new-tab metaphor: ＋ opens Home (the launchpad), where a
              session is picked or started — spawning one blind needs a project */}
          <button onClick={onHome} title={`Home — pick or start a session (${homeChord})`} style={S.plus}>＋</button>
        </div>
      )}
      <div data-lane="t" style={{ ...S.lane, borderTop: sessionTabs.length > 0 ? '1px solid #161c25' : undefined }}>
        <span style={S.laneLabel}>TERMINALS</span>
        {laneChips(termTabs.map((t) => ({ t, el: chip(t, termNames[t.id], undefined, shellDirs[t.id] ?? 'shell') })), true)}
        <button onClick={onNewShell} title={`New shell tab (${shellChord})`} style={S.plus}>＋</button>
      </div>
    </div>
  )
}
