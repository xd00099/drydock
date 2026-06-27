import type { Tab } from './types'
import { baseName, clip, sessionColor } from './types'

type Props = {
  tabs: Tab[]
  activeId: number | null
  shellDirs: Record<number, string> // live cwd per shell tab id
  unread: Record<number, number> // unseen artifact count per tab id
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onNewShell: () => void
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
  chip: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', borderLeft: '3px solid transparent' } as const,
  close: { color: '#5b6675' } as const,
  plus: { flexShrink: 0, background: 'none', border: 'none', color: '#7d8794', cursor: 'pointer', fontSize: 14 } as const,
}

export default function TabBar({ tabs, activeId, shellDirs, unread, onSelect, onClose, onNewShell }: Props) {
  const sessionTabs = tabs.filter((t) => !t.terminal)
  const termTabs = tabs.filter((t) => t.terminal)
  const termNames = terminalLabels(termTabs, shellDirs)

  const chip = (t: Tab, label: string, accent?: string, tip?: string) => (
    <div
      key={t.id}
      onClick={() => onSelect(t.id)}
      title={tip}
      style={{
        ...S.chip,
        // tint the chip in its session's color (like the sidebar rows): a faint
        // wash when inactive, stronger when active; the solid strip stays at left
        background: t.sessionId
          ? sessionColor(t.sessionId, t.id === activeId ? 0.3 : 0.1)
          : t.id === activeId ? '#1d2530' : 'transparent',
        borderLeftColor: accent ?? 'transparent',
        color: t.exited ? '#5b6675' : '#c8cdd5',
      }}
    >
      <span style={{ fontStyle: t.preview ? 'italic' : undefined }}>{clip(label, 22)}{t.exited ? ' ·ended' : ''}</span>
      {unread[t.id] ? (
        <span title={`${unread[t.id]} new preview${unread[t.id] > 1 ? 's' : ''}`} style={{ background: '#5a7fb0', color: '#0b0e13', borderRadius: 8, fontSize: 9, fontWeight: 700, padding: '0 5px', lineHeight: '14px' }}>{unread[t.id]}</span>
      ) : null}
      <span style={S.close} onClick={(e) => { e.stopPropagation(); onClose(t.id) }}>✕</span>
    </div>
  )

  return (
    <div style={{ background: '#0b0e13', borderBottom: '1px solid #1d2530', fontFamily: 'system-ui', fontSize: 12 }}>
      {sessionTabs.length > 0 && (
        <div style={S.lane}>
          <span style={S.laneLabel}>SESSIONS</span>
          {sessionTabs.map((t) => chip(t, t.title, t.sessionId ? sessionColor(t.sessionId) : undefined, t.title))}
        </div>
      )}
      <div style={{ ...S.lane, borderTop: sessionTabs.length > 0 ? '1px solid #161c25' : undefined }}>
        <span style={S.laneLabel}>TERMINALS</span>
        {termTabs.map((t) => chip(t, termNames[t.id], undefined, shellDirs[t.id] ?? 'shell'))}
        <button onClick={onNewShell} title="New shell tab (⌘T)" style={S.plus}>＋</button>
      </div>
    </div>
  )
}
