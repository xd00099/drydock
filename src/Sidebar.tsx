import { useEffect, useRef, useState } from 'react'
import type { SessionView } from './types'
import { clampPanelWidth, clip, loadNum, relAge, sessionColor, sessionLabel, shortPath } from './types'
import ResizeHandle from './ResizeHandle'

type Props = {
  sessions: SessionView[]
  hidden: string[] // session ids the user hid from Drydock
  onResume: (s: SessionView) => void
  onNewSession: (projectPath: string) => void
  onToggleStar: (s: SessionView) => void
  onHide: (sessionId: string, hide: boolean) => void
  onDelete: (sessionId: string) => void
}

type Group = { path: string; sessions: SessionView[]; latest: number }

const STARRED_KEY = '__starred__'

// Visible = not an auto-hidden ghost and (not user-hidden unless revealing hidden).
function isVisible(s: SessionView, hiddenSet: Set<string>, showHidden: boolean): boolean {
  if (s.hidden) return false
  if (hiddenSet.has(s.session_id) && !showHidden) return false
  return true
}

// Project groups, starred sessions excluded (they live in their own section).
function groupSessions(sessions: SessionView[], hiddenSet: Set<string>, showHidden: boolean): Group[] {
  const byPath = new Map<string, SessionView[]>()
  for (const s of sessions) {
    if (s.starred) continue
    if (!isVisible(s, hiddenSet, showHidden)) continue
    const list = byPath.get(s.project_path) ?? []
    list.push(s)
    byPath.set(s.project_path, list)
  }
  const groups: Group[] = [...byPath.entries()].map(([path, list]) => {
    list.sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))
    return { path, sessions: list, latest: Math.max(...list.map((s) => s.last_message_at ?? 0)) }
  })
  groups.sort((a, b) => b.latest - a.latest)
  return groups
}

const S = {
  side: { width: 300, minWidth: 300, height: '100%', overflowY: 'auto', background: '#0b0e13', color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 12, borderRight: '1px solid #1d2530' } as const,
  rail: { width: 30, minWidth: 30, height: '100%', background: '#0b0e13', borderRight: '1px solid #1d2530', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 } as const,
  bar: { display: 'flex', alignItems: 'center', padding: '10px 8px 4px' } as const,
  head: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px 4px', color: '#7d8794', fontWeight: 600 } as const,
  row: { display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left', background: 'none', border: 'none', borderLeft: '3px solid transparent', color: '#c8cdd5', padding: '5px 10px', cursor: 'pointer', fontSize: 12 } as const,
  btn: { background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 12, padding: 0 } as const,
  chev: { background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 10, padding: 0, width: 14 } as const,
  menu: { position: 'fixed', background: '#1b2230', border: '1px solid #2c3647', borderRadius: 6, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,.4)', zIndex: 60, fontFamily: 'system-ui', fontSize: 12, minWidth: 180 } as const,
  menuItem: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#d6dbe3', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 } as const,
}

function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]) } catch { return new Set() }
}

function groupDot(list: SessionView[]): string {
  if (list.some((s) => s.live_status === 'busy')) return '🟢'
  if (list.some((s) => s.live_status === 'idle')) return '🟡'
  return ''
}

export default function Sidebar({ sessions, hidden, onResume, onNewSession, onToggleStar, onHide, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.sidebarCollapsed') === '1')
  const [width, setWidth] = useState(() => loadNum('dd.sidebarWidth', 300))
  const widthRef = useRef(width)
  widthRef.current = width
  const [closed, setClosed] = useState<Set<string>>(() => loadSet('dd.closedGroups'))
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionView } | null>(null)
  const [confirmDel, setConfirmDel] = useState<SessionView | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('keydown', onEsc)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('keydown', onEsc); window.removeEventListener('resize', close) }
  }, [menu])

  const toggleSidebar = () =>
    setCollapsed((c) => { const n = !c; localStorage.setItem('dd.sidebarCollapsed', n ? '1' : '0'); return n })

  const toggleGroup = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      localStorage.setItem('dd.closedGroups', JSON.stringify([...next]))
      return next
    })

  if (collapsed) {
    return (
      <div style={S.rail}>
        <button style={{ ...S.btn, fontSize: 15 }} title="Expand sidebar" onClick={toggleSidebar}>»</button>
      </div>
    )
  }

  const hiddenSet = new Set(hidden)
  const starred = sessions
    .filter((s) => s.starred && isVisible(s, hiddenSet, showHidden))
    .sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))
  const groups = groupSessions(sessions, hiddenSet, showHidden)

  // One session row, shared by the Starred section and project groups.
  const sessionRow = (s: SessionView, showProject: boolean) => {
    const isHidden = hiddenSet.has(s.session_id)
    const sub = showProject ? shortPath(s.project_path) : s.latest_recap
    return (
      <button
        key={s.session_id}
        style={{ ...S.row, opacity: isHidden ? 0.45 : 1, borderLeftColor: sessionColor(s.session_id), background: sessionColor(s.session_id, 0.1) }}
        onClick={() => onResume(s)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s }) }}
        title={`${s.title}\n${s.session_id}\n(right-click for options)`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {(s.live_status === 'busy' || s.live_status === 'idle') && (
            <span style={{ flexShrink: 0 }}>{s.live_status === 'busy' ? '🟢' : '🟡'}</span>
          )}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e8edf4' }}>
            {sessionLabel(s)}
          </span>
          <span style={{ flexShrink: 0, marginLeft: 6, color: '#5b6675' }}>{relAge(s.last_message_at)}</span>
        </div>
        {sub && (
          <div style={{ color: '#5b6675', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {sub}
          </div>
        )}
      </button>
    )
  }

  const starredClosed = closed.has(STARRED_KEY)
  return (
    <div style={{ display: 'flex', height: '100%' }}>
    <div style={{ ...S.side, width, minWidth: width, borderRight: 'none' }}>
      <div style={S.bar}>
        <span style={{ flex: 1, fontWeight: 700, color: '#e8edf4' }}>DRYDOCK</span>
        <button style={{ ...S.btn, fontSize: 15 }} title="Collapse sidebar" onClick={toggleSidebar}>«</button>
      </div>

      {starred.length > 0 && (
        <div>
          <div style={S.head}>
            <button style={S.chev} title={starredClosed ? 'Expand' : 'Collapse'} onClick={() => toggleGroup(STARRED_KEY)}>
              {starredClosed ? '▸' : '▾'}
            </button>
            <span style={{ flex: 1, cursor: 'pointer', color: '#e8c35a' }} onClick={() => toggleGroup(STARRED_KEY)}>
              ★ Starred
            </span>
            <span style={{ color: '#5b6675' }}>{starred.length}</span>
          </div>
          {!starredClosed && starred.map((s) => sessionRow(s, true))}
        </div>
      )}

      {groups.map((g) => {
        const isClosed = closed.has(g.path)
        return (
          <div key={g.path}>
            <div style={S.head} title={g.path}>
              <button style={S.chev} title={isClosed ? 'Expand folder' : 'Collapse folder'} onClick={() => toggleGroup(g.path)}>
                {isClosed ? '▸' : '▾'}
              </button>
              <span
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={() => toggleGroup(g.path)}
              >
                {shortPath(g.path)}
              </span>
              <span style={{ color: '#5b6675' }}>{g.sessions.length}</span>
              {isClosed && <span>{groupDot(g.sessions)}</span>}
              <button style={S.btn} title="New claude session here" onClick={() => onNewSession(g.path)}>＋</button>
            </div>
            {!isClosed && g.sessions.map((s) => sessionRow(s, false))}
          </div>
        )
      })}
      {groups.length === 0 && starred.length === 0 && <div style={{ padding: 16, color: '#5b6675' }}>indexing ~/.claude…</div>}
      {hidden.length > 0 && (
        <button
          style={{ ...S.btn, display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginTop: 4, color: '#5b6675' }}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? '▾' : '▸'} {hidden.length} hidden
        </button>
      )}

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div style={{ ...S.menu, left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 140) }}>
            <button style={S.menuItem} onClick={() => { onToggleStar(menu.s); setMenu(null) }}>
              {menu.s.starred ? 'Unstar' : 'Star'}
            </button>
            {hiddenSet.has(menu.s.session_id) ? (
              <button style={S.menuItem} onClick={() => { onHide(menu.s.session_id, false); setMenu(null) }}>Unhide</button>
            ) : (
              <button style={S.menuItem} onClick={() => { onHide(menu.s.session_id, true); setMenu(null) }}>Hide from Drydock</button>
            )}
            <button style={{ ...S.menuItem, color: '#e8907a' }} onClick={() => { setConfirmDel(menu.s); setMenu(null) }}>
              Delete permanently…
            </button>
          </div>
        </>
      )}

      {confirmDel && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }}>
          <div style={{ background: '#161c25', color: '#e8edf4', padding: 20, borderRadius: 8, fontFamily: 'system-ui', fontSize: 13, maxWidth: 380 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Delete permanently?</div>
            <div style={{ color: '#b3bcc8', marginBottom: 14, lineHeight: 1.45 }}>
              “{clip(sessionLabel(confirmDel), 48)}” — this deletes the transcript from <code>~/.claude</code>. It will no longer be resumable in Claude Code, and this can’t be undone.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmDel(null)}>Cancel</button>
              <button
                style={{ background: '#7a2e2e', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 5, cursor: 'pointer' }}
                onClick={() => { onDelete(confirmDel.session_id); setConfirmDel(null) }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w + dx))}
        onEnd={() => localStorage.setItem('dd.sidebarWidth', String(widthRef.current))}
      />
    </div>
  )
}
