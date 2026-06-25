import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, loadNum, relAge, baseName, type CardView, type McpServer, type Skill, type TimelineItem } from './types'
import ResizeHandle from './ResizeHandle'

type RightTab = 'briefing' | 'skills' | 'mcp'

type Props = {
  sessionId: string
  projectPath?: string // active session's project, for per-project MCP lookup
  starred: boolean
  onToggleStar?: () => void
}

const TABS: { id: RightTab; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
]

const loadStrSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[])
  } catch {
    return new Set()
  }
}

const S = {
  muted: { color: '#5b6675' } as const,
  tabBtn: (active: boolean) =>
    ({
      flex: 1,
      background: active ? '#161c25' : 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid #5a7fb0' : '2px solid #1d2530',
      color: active ? '#e8edf4' : '#7d8794',
      cursor: 'pointer',
      fontSize: 11,
      padding: '5px 2px',
      fontFamily: 'system-ui',
    }) as const,
  groupBtn: { display: 'flex', alignItems: 'center', gap: 4, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontWeight: 600, fontSize: 11, padding: '3px 0', textAlign: 'left' } as const,
  name: { color: '#d6dbe3' } as const,
  desc: {
    color: '#7d8794',
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  } as const,
  chip: { fontSize: 9, color: '#9aa3af', background: '#1b2230', border: '1px solid #2c3647', borderRadius: 4, padding: '0 5px' } as const,
}

function Item({ it }: { it: TimelineItem }) {
  return (
    <li style={{ marginBottom: 6 }}>
      <span style={{ color: it.in_progress ? '#7ec8a0' : '#c8cdd5' }}>
        {it.in_progress ? '◐ ' : ''}
        {it.text}
        {it.in_progress && <span style={{ color: '#5b6675', fontStyle: 'italic' }}> — in progress</span>}
      </span>
      {it.detail.length > 0 && (
        <ul style={{ margin: '3px 0 0', paddingLeft: 16, listStyle: 'none' }}>
          {it.detail.map((d, i) => (
            <li key={i} style={{ color: '#9aa3af', marginBottom: 2 }}>
              <span style={{ color: '#4a5462' }}>– </span>
              {d}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function BriefingTab({ sessionId, card, starred, onToggleStar }: { sessionId: string; card: CardView | null; starred: boolean; onToggleStar?: () => void }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <button
          onClick={onToggleStar}
          disabled={!onToggleStar}
          title={starred ? 'Unstar this session' : 'Star this session'}
          style={{ background: 'none', border: 'none', cursor: onToggleStar ? 'pointer' : 'default', color: starred ? '#e8c35a' : '#3a4350', fontSize: 16, padding: 0, lineHeight: 1 }}
        >
          ★
        </button>
        <div style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{card?.summary || 'Session'}</div>
      </div>
      {card ? (
        <>
          {card.timeline.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {card.timeline.map((it, i) => (
                <Item key={i} it={it} />
              ))}
            </ul>
          ) : (
            <div style={S.muted}>no timeline yet</div>
          )}
          <div style={{ color: '#5b6675', fontSize: 10, marginTop: 12 }}>card from {relAge(card.generated_at)} ago</div>
        </>
      ) : (
        <div style={S.muted}>no briefing card yet</div>
      )}
      <button style={{ marginTop: 10 }} onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}>
        Refresh card
      </button>
    </>
  )
}

function SkillsTab() {
  // Skills are global, but fetching per-mount (~17 file reads) keeps them fresh
  // when plugins change and avoids a module cache that would pin a transient
  // failure forever.
  const [state, setState] = useState<'loading' | 'error' | Skill[]>('loading')
  // Groups start collapsed (just a header + count); persisted so an expand
  // survives the panel's per-session remount.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadStrSet('dd.skillsExpanded'))
  useEffect(() => {
    let live = true
    setState('loading')
    invoke<Skill[]>('list_skills')
      .then((s) => live && setState(s))
      .catch(() => live && setState('error'))
    return () => { live = false }
  }, [])

  const toggle = (plugin: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(plugin)) next.delete(plugin); else next.add(plugin)
      localStorage.setItem('dd.skillsExpanded', JSON.stringify([...next]))
      return next
    })

  if (state === 'loading') return <div style={S.muted}>loading skills…</div>
  if (state === 'error') return <div style={S.muted}>couldn’t load skills</div>
  if (state.length === 0) return <div style={S.muted}>no plugin skills found</div>

  const groups = new Map<string, Skill[]>()
  for (const s of state) {
    if (!groups.has(s.plugin)) groups.set(s.plugin, [])
    groups.get(s.plugin)!.push(s)
  }
  return (
    <div>
      <div style={{ color: '#5b6675', fontSize: 10, marginBottom: 8 }}>{state.length} skills · available to every session</div>
      {[...groups.entries()].map(([plugin, list]) => {
        const open = expanded.has(plugin)
        return (
          <div key={plugin} style={{ marginBottom: 4 }}>
            <button style={S.groupBtn} onClick={() => toggle(plugin)} title={open ? 'Collapse' : 'Expand'}>
              <span style={{ width: 10, color: '#5b6675' }}>{open ? '▾' : '▸'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plugin}</span>
              <span style={{ color: '#5b6675', fontWeight: 400 }}>{list.length}</span>
            </button>
            {open &&
              list.map((s) => (
                <div key={s.name} style={{ marginBottom: 7, paddingLeft: 14 }}>
                  <div style={S.name}>{s.name}</div>
                  <div style={S.desc} title={s.description}>{s.description}</div>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

function McpTab({ projectPath }: { projectPath?: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  useEffect(() => {
    let live = true
    setServers(null)
    invoke<McpServer[]>('list_mcp_servers', { projectPath: projectPath ?? null })
      .then((s) => live && setServers(s))
      .catch(() => live && setServers([]))
    return () => { live = false }
  }, [projectPath])

  const proj = projectPath ? baseName(projectPath) : undefined
  return (
    <div>
      {proj && (
        <div style={{ color: '#7d8794', marginBottom: 4 }}>
          for project: <span style={{ color: '#c8cdd5' }}>{proj}</span>
        </div>
      )}
      <div style={{ color: '#5b6675', fontSize: 10, marginBottom: 8 }}>ⓘ configured, not live status · secrets hidden</div>
      {servers === null ? (
        <div style={S.muted}>loading…</div>
      ) : servers.length === 0 ? (
        <div style={S.muted}>no MCP servers configured{proj ? ' for this project' : ''}</div>
      ) : (
        servers.map((s) => (
          <div key={s.name} style={{ marginBottom: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={S.name}>{s.name}</span>
              <span style={S.chip}>{s.kind}</span>
              <span style={{ color: '#4a5462', fontSize: 9 }}>{s.scope}</span>
            </div>
            {s.detail && (
              <div style={{ color: '#7d8794', wordBreak: 'break-all', fontFamily: 'Menlo, monospace', fontSize: 11, marginTop: 1 }}>{s.detail}</div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

export default function BriefingPanel({ sessionId, projectPath, starred, onToggleStar }: Props) {
  const [card, setCard] = useState<CardView | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.briefingCollapsed') === '1')
  const [width, setWidth] = useState(() => loadNum('dd.briefingWidth', 252))
  const [tab, setTab] = useState<RightTab>(() => (localStorage.getItem('dd.rightTab') as RightTab) || 'briefing')
  const widthRef = useRef(width)
  widthRef.current = width

  const refresh = useCallback(() => {
    invoke<CardView | null>('get_card', { sessionId }).then(setCard).catch(console.error)
  }, [sessionId])
  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  const toggleCollapsed = () =>
    setCollapsed((c) => { const n = !c; localStorage.setItem('dd.briefingCollapsed', n ? '1' : '0'); return n })
  const selectTab = (t: RightTab) => { setTab(t); localStorage.setItem('dd.rightTab', t) }

  // collapsed: a thin rail with an expand button, mirroring the left sidebar
  if (collapsed) {
    return (
      <div style={{ width: 30, minWidth: 30, height: '100%', background: '#0b0e13', borderLeft: '1px solid #1d2530', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <button onClick={toggleCollapsed} title="Expand panel" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 15, padding: 0 }}>«</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w - dx))}
        onEnd={() => localStorage.setItem('dd.briefingWidth', String(widthRef.current))}
      />
      <div style={{ width, minWidth: width, boxSizing: 'border-box', background: '#0b0e13', padding: 12, fontFamily: 'system-ui', fontSize: 12, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, marginBottom: 12 }}>
          <button onClick={toggleCollapsed} title="Collapse panel" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 15, padding: 0, lineHeight: 1, alignSelf: 'flex-end', marginBottom: 4 }}>»</button>
          <div style={{ display: 'flex', flex: 1, gap: 2 }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => selectTab(t.id)} style={S.tabBtn(t.id === tab)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'briefing' && <BriefingTab sessionId={sessionId} card={card} starred={starred} onToggleStar={onToggleStar} />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab projectPath={projectPath} />}
      </div>
    </div>
  )
}
