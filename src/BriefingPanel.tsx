import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, loadNum, relAge, baseName, type Artifact, type CardView, type McpServer, type Skill, type TimelineItem } from './types'
import ArtifactView from './ArtifactView'
import ResizeHandle from './ResizeHandle'

type RightTab = 'briefing' | 'skills' | 'mcp' | 'preview'

type Props = {
  sessionId: string | null // null for a brand-new claude tab with no session id yet
  projectPath?: string // active session's project, for per-project MCP lookup
  starred: boolean
  artifacts: Artifact[] // visual artifacts this tab's session has rendered
  onToggleStar?: () => void
}

const TABS: { id: RightTab; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'preview', label: 'Preview' },
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
  iconBtn: { background: 'none', border: '1px solid #2c3647', borderRadius: 4, cursor: 'pointer', color: '#9aa3af', fontSize: 12, lineHeight: 1, padding: '2px 6px' } as const,
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

function BriefingTab({ sessionId, card, starred, onToggleStar }: { sessionId: string | null; card: CardView | null; starred: boolean; onToggleStar?: () => void }) {
  if (!sessionId)
    return <div style={S.muted}>No indexed session yet — once this conversation is saved, its briefing card appears here.</div>
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

function PreviewTab({ artifacts }: { artifacts: Artifact[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  // Esc closes the expanded overlay.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  if (artifacts.length === 0)
    return <div style={{ ...S.muted, flex: 1, minHeight: 0, padding: 12 }}>No preview yet. When Claude renders an artifact (HTML, SVG, or Markdown) in this session, it shows up here.</div>

  // Default to the newest; a manual pick sticks until that artifact is gone.
  const current = artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1]
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 8px' }}>
        <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={current.title}>{current.title}</span>
        <span style={S.chip}>{current.kind}</span>
        <button style={S.iconBtn} title="Expand to full window" onClick={() => setFull(true)}>⤢</button>
      </div>
      {artifacts.length > 1 && (
        <select
          value={current.id}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ margin: '0 12px 8px', background: '#161c25', color: '#d6dbe3', border: '1px solid #2c3647', borderRadius: 4, padding: '3px 4px', fontSize: 11 }}
        >
          {artifacts.map((a, i) => (
            <option key={a.id} value={a.id}>{i + 1}. {a.title} ({a.kind})</option>
          ))}
        </select>
      )}
      {/* Fill the rest of the panel edge-to-edge, no frame. */}
      <ArtifactView artifact={current} style={{ flex: 1, minHeight: 0, border: 'none', borderRadius: 0 }} />
      {full && (
        // Full-window overlay so UI artifacts get usable space. zIndex below the
        // quit guard (100); translateZ(0) gives it its own compositing layer so
        // it's clickable over a terminal's WebGL canvas in WKWebView.
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: '#0b0e13', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1d2530' }}>
            <span style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.title}</span>
            <span style={S.chip}>{current.kind}</span>
            <button style={S.iconBtn} title="Close (Esc)" onClick={() => setFull(false)}>✕</button>
          </div>
          <ArtifactView artifact={current} style={{ flex: 1 }} />
        </div>
      )}
    </div>
  )
}

export default function BriefingPanel({ sessionId, projectPath, starred, artifacts, onToggleStar }: Props) {
  const [card, setCard] = useState<CardView | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.briefingCollapsed') === '1')
  const [width, setWidth] = useState(() => loadNum('dd.briefingWidth', 252))
  const [tab, setTab] = useState<RightTab>(() => (localStorage.getItem('dd.rightTab') as RightTab) || 'briefing')
  const widthRef = useRef(width)
  widthRef.current = width

  const refresh = useCallback(() => {
    if (!sessionId) { setCard(null); return } // a session-less new tab has no card
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

  // When a NEW artifact arrives for this tab, surface it: jump to the Preview
  // sub-tab, open the panel if collapsed, and give it room (~1/3 of the window,
  // never shrinking a panel the user already widened).
  const seenArtifacts = useRef(artifacts.length)
  useEffect(() => {
    if (artifacts.length > seenArtifacts.current) {
      setTab('preview'); localStorage.setItem('dd.rightTab', 'preview')
      setCollapsed(false); localStorage.setItem('dd.briefingCollapsed', '0')
      setWidth((w) => {
        const next = Math.max(w, clampPanelWidth(Math.round(window.innerWidth / 3)))
        localStorage.setItem('dd.briefingWidth', String(next))
        return next
      })
    }
    seenArtifacts.current = artifacts.length
  }, [artifacts.length])

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
      <div style={{ width, minWidth: width, boxSizing: 'border-box', background: '#0b0e13', fontFamily: 'system-ui', fontSize: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, padding: '12px 12px 0', flex: 'none' }}>
          <button onClick={toggleCollapsed} title="Collapse panel" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 15, padding: 0, lineHeight: 1, alignSelf: 'flex-end', marginBottom: 4 }}>»</button>
          <div style={{ display: 'flex', flex: 1, gap: 2 }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => selectTab(t.id)} style={S.tabBtn(t.id === tab)}>
                {t.label}
                {t.id === 'preview' && artifacts.length > 0 ? ` (${artifacts.length})` : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Preview fills the panel edge-to-edge; the other tabs scroll inside padding. */}
        {tab === 'preview' ? (
          <PreviewTab artifacts={artifacts} />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
            {tab === 'briefing' && <BriefingTab sessionId={sessionId} card={card} starred={starred} onToggleStar={onToggleStar} />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'mcp' && <McpTab projectPath={projectPath} />}
          </div>
        )}
      </div>
    </div>
  )
}
