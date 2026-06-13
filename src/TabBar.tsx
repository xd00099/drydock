import type { Tab } from './types'
import { clip } from './types'

type Props = {
  tabs: Tab[]
  activeId: number | null
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onNewShell: () => void
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onNewShell }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: '#0b0e13', borderBottom: '1px solid #1d2530', padding: '4px 6px', fontFamily: 'system-ui', fontSize: 12 }}>
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
            background: t.id === activeId ? '#1d2530' : 'transparent',
            color: t.exited ? '#5b6675' : '#c8cdd5',
          }}
        >
          <span style={{ fontStyle: t.preview ? 'italic' : undefined }}>{clip(t.title, 22)}{t.exited ? ' ·ended' : ''}</span>
          <span style={{ color: '#5b6675' }} onClick={(e) => { e.stopPropagation(); onClose(t.id) }}>✕</span>
        </div>
      ))}
      <button onClick={onNewShell} title="New shell tab" style={{ background: 'none', border: 'none', color: '#7d8794', cursor: 'pointer', fontSize: 14 }}>＋</button>
    </div>
  )
}
