import type { SessionView } from './types'
import { clip, relAge, shortPath } from './types'

type Props = {
  sessions: SessionView[]
  pinned: string[]
  onResume: (s: SessionView) => void
  onNewSession: (projectPath: string) => void
  onToggleStar: (s: SessionView) => void
  onTogglePin: (projectPath: string) => void
}

type Group = { path: string; sessions: SessionView[]; latest: number }

function groupSessions(sessions: SessionView[], pinned: string[]): Group[] {
  const byPath = new Map<string, SessionView[]>()
  for (const s of sessions) {
    if (s.hidden) continue
    const list = byPath.get(s.project_path) ?? []
    list.push(s)
    byPath.set(s.project_path, list)
  }
  const groups: Group[] = [...byPath.entries()].map(([path, list]) => {
    list.sort((a, b) => Number(b.starred) - Number(a.starred) || (b.last_message_at ?? 0) - (a.last_message_at ?? 0))
    return { path, sessions: list, latest: Math.max(...list.map((s) => s.last_message_at ?? 0)) }
  })
  const pinRank = (p: string) => { const i = pinned.indexOf(p); return i === -1 ? Infinity : i }
  groups.sort((a, b) => pinRank(a.path) - pinRank(b.path) || b.latest - a.latest)
  return groups
}

const S = {
  side: { width: 300, minWidth: 300, height: '100%', overflowY: 'auto', background: '#0b0e13', color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 12, borderRight: '1px solid #1d2530' } as const,
  head: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 4px', color: '#7d8794', fontWeight: 600 } as const,
  row: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#c8cdd5', padding: '5px 10px 5px 22px', cursor: 'pointer', fontSize: 12 } as const,
  btn: { background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 12 } as const,
}

export default function Sidebar({ sessions, pinned, onResume, onNewSession, onToggleStar, onTogglePin }: Props) {
  const groups = groupSessions(sessions, pinned)
  return (
    <div style={S.side}>
      <div style={{ padding: '10px 10px 2px', fontWeight: 700, color: '#e8edf4' }}>DRYDOCK</div>
      {groups.map((g) => (
        <div key={g.path}>
          <div style={S.head} title={g.path}>
            <button style={S.btn} title={pinned.includes(g.path) ? 'Unpin project' : 'Pin project'} onClick={() => onTogglePin(g.path)}>
              {pinned.includes(g.path) ? '📌' : '○'}
            </button>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortPath(g.path)}</span>
            <button style={S.btn} title="New claude session here" onClick={() => onNewSession(g.path)}>＋</button>
          </div>
          {g.sessions.map((s) => (
            <button key={s.session_id} style={S.row} onClick={() => onResume(s)} title={`${s.title}\n${s.session_id}`}>
              <span
                style={{ ...S.btn, marginRight: 4, color: s.starred ? '#e8c35a' : '#3a4350' }}
                onClick={(e) => { e.stopPropagation(); onToggleStar(s) }}
              >
                ★
              </span>
              <span style={{ marginRight: 4 }}>
                {s.live_status === 'busy' ? '🟢' : s.live_status === 'idle' ? '🟡' : ''}
              </span>
              <span style={{ color: '#e8edf4' }}>{clip(s.title, 30)}</span>
              <span style={{ float: 'right', color: '#5b6675' }}>{relAge(s.last_message_at)}</span>
              {s.latest_recap && (
                <div style={{ color: '#5b6675', paddingLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {clip(s.latest_recap, 42)}
                </div>
              )}
            </button>
          ))}
        </div>
      ))}
      {groups.length === 0 && <div style={{ padding: 16, color: '#5b6675' }}>indexing ~/.claude…</div>}
    </div>
  )
}
