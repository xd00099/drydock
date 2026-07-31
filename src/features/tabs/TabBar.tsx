import { useEffect, useRef } from 'react'
import type { SessionView, Tab } from '@/lib/types'
import { baseName, clip, projectColor, sessionLabel } from '@/lib/types'
import { useChord } from '@/lib/keymap'
import { cx } from '@/components/ui'
import s from './TabBar.module.css'

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

/** Per-tab tint + edge marks. These are the only styles that stay inline: each
 *  value is derived from the tab's session color, so it can't be a static class.
 *  `accent` (session hue) and the on-stage mark are box-shadow insets rather
 *  than borders, so activating a tab never changes the strip's metrics. */
function chipTint(
  t: Tab,
  isActive: boolean,
  staged: boolean,
  accent: string | undefined,
  proj: string | null | undefined
): React.CSSProperties {
  // tint the chip in its PROJECT's color: a faint wash when inactive, stronger
  // when active; the solid strip stays at left. Kept even though sidebar rows
  // dropped their wash — a handful of chips is not a list you scan, so the
  // heterogeneity that made the wash costly there doesn't arise.
  const background = t.sessionId
    ? projectColor(proj, isActive ? 0.3 : staged ? 0.18 : 0.1)
    : isActive
      ? 'var(--dd-tint-active)'
      : staged
        ? 'var(--dd-tint)'
        : 'transparent'
  // "on stage" mark: a split can show several tabs at once — every visible one
  // wears it; the focused one also gets the strong wash.
  const stageMark = staged
    ? `inset 0 -2px 0 ${t.sessionId ? projectColor(proj) : 'var(--dd-accent-muted)'}`
    : null
  const accentMark = accent ? `inset 3px 0 0 ${accent}` : null
  const shadow = [accentMark, stageMark].filter(Boolean).join(', ')
  return { background, boxShadow: shadow || undefined }
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

  // ⌘digit badge, mirroring gotoTab's addressing exactly: visual order across
  // both lanes; with more than 9 tabs only 1-8 are direct and ⌘9 = LAST.
  const ordered = [...sessionTabs, ...termTabs]
  const chipNum = (id: number): string | null => {
    const pos = ordered.findIndex((x) => x.id === id) + 1
    if (pos === 0) return null
    if (ordered.length <= 9) return String(pos)
    if (pos <= 8) return String(pos)
    return pos === ordered.length ? '9' : null
  }

  const chip = (t: Tab, label: string, accent?: string, tip?: string, attention?: boolean, proj?: string | null) => {
    const staged = stagedIds.includes(t.id)
    const num = chipNum(t.id)
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
        className={cx(
          s.chip,
          t.id === activeId && s.active,
          t.exited && s.exited,
          t.id === draggedId && s.dragging
        )}
        style={chipTint(t, t.id === activeId, staged, accent, proj)}
      >
        {num && (
          <span title={`⌘${num}`} className={s.ordinal}>{num}</span>
        )}
        {attention && (
          <span className={cx(s.attn, 'dd-attn')} title="waiting for your input" />
        )}
        {/* a transcript tab is a READER, not a dead terminal: ≣ prefix instead
            of the (misleading) ·ended suffix */}
        <span className={cx(s.label, t.preview && s.preview)}>
          {t.kind === 'transcript' ? '≣ ' : ''}
          {clip(label, 22)}
          {t.exited && t.kind !== 'transcript' ? ' ·ended' : ''}
        </span>
        {unread[t.id] ? (
          <span title={`${unread[t.id]} new artifact${unread[t.id] > 1 ? 's' : ''}`} className={s.unread}>{unread[t.id]}</span>
        ) : null}
        <span
          className={s.close}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
        >
          ✕
        </span>
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
            {marking && insertMark.beforeId === t.id && <span className={s.mark} />}
            {el}
          </span>
        ))}
        {marking && insertMark.beforeId === null && <span className={s.mark} />}
      </>
    )
  }

  return (
    <div data-tabbar="1" className={s.bar}>
      {sessionTabs.length > 0 && (
        <div data-lane="s" className={s.lane}>
          <span className={s.laneLabel}>SESSIONS</span>
          {laneChips(
            sessionTabs.map((t) => {
              const s = t.sessionId ? sessions.find((x) => x.session_id === t.sessionId) : undefined
              const label = s ? sessionLabel(s) : t.title
              const tip = t.kind === 'transcript' ? `${label} — read-only transcript` : label
              return { t, el: chip(t, label, t.sessionId ? projectColor(s?.project_path) : undefined, tip, s?.live_status === 'needs_input', s?.project_path) }
            }),
            false
          )}
          {/* browser new-tab metaphor: ＋ opens Home (the launchpad), where a
              session is picked or started — spawning one blind needs a project */}
          <button onClick={onHome} title={`Home — pick or start a session (${homeChord})`} className={s.plus}>＋</button>
        </div>
      )}
      <div data-lane="t" className={cx(s.lane, sessionTabs.length > 0 && s.laneDivided)}>
        <span className={s.laneLabel}>TERMINALS</span>
        {laneChips(termTabs.map((t) => ({ t, el: chip(t, termNames[t.id], undefined, shellDirs[t.id] ?? 'shell') })), true)}
        <button onClick={onNewShell} title={`New shell tab (${shellChord})`} className={s.plus}>＋</button>
      </div>
    </div>
  )
}
