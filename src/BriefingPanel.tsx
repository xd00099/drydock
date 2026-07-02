import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, loadNum, relAge, baseName, type Artifact, type CardView, type FileTouch, type McpServer, type Skill, type TimelineItem } from './types'
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
  { id: 'preview', label: 'Artifacts' }, // id stays 'preview' so saved dd.rightTab keeps working
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
      // flex items default to min-width:auto — without minWidth: 0 the labels
      // set a floor and the strip overflows/clips at narrow panel widths
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
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

/// Path shown project-relative when it lives under the session's project.
function relPath(p: string, root?: string): string {
  return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p
}

function FilesChanged({ files, projectPath }: { files: FileTouch[]; projectPath?: string }) {
  // Transient error line (file deleted since, editor_cmd broken, …).
  const [err, setErr] = useState<string | null>(null)
  const errTimer = useRef(0)
  const flashErr = (text: string) => {
    clearTimeout(errTimer.current)
    setErr(text)
    errTimer.current = window.setTimeout(() => setErr(null), 4000)
  }
  useEffect(() => () => clearTimeout(errTimer.current), [])
  if (files.length === 0) return null
  const open = (path: string, reveal: boolean) =>
    invoke('open_path', { path, reveal }).catch((e) => flashErr(String(e)))
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ color: '#7d8794', fontWeight: 600, fontSize: 11, marginBottom: 4 }}>Files changed · {files.length}</div>
      {files.slice(0, 30).map((f) => (
        <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, minWidth: 0 }}>
          <button
            onClick={() => open(f.path, false)}
            title={`${f.path}\nOpen in your editor (settings "editor_cmd", else the default app)`}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: '#9cc3ff', fontFamily: 'Menlo, monospace', fontSize: 11, padding: '1px 0', direction: 'rtl' }}
          >
            {/* rtl ellipsis keeps the filename end visible; the tooltip has the full path */}
            <span style={{ unicodeBidi: 'plaintext' }}>{relPath(f.path, projectPath)}</span>
          </button>
          <span style={{ flexShrink: 0, color: '#4a5462', fontSize: 10 }} title={`${f.edits} edit(s) · ${f.writes} write(s)`}>
            ×{f.edits + f.writes}
          </span>
          <button style={{ ...S.iconBtn, fontSize: 10, padding: '1px 5px' }} title="Reveal in Finder" onClick={() => open(f.path, true)}>
            ⊙
          </button>
        </div>
      ))}
      {files.length > 30 && <div style={{ ...S.muted, fontSize: 10 }}>+{files.length - 30} more</div>}
      {err && <div style={{ color: '#cf6b6b', fontSize: 10, marginTop: 4 }}>{err}</div>}
    </div>
  )
}

function BriefingTab({ sessionId, card, starred, files, projectPath, onToggleStar }: { sessionId: string | null; card: CardView | null; starred: boolean; files: FileTouch[]; projectPath?: string; onToggleStar?: () => void }) {
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
      <FilesChanged files={files} projectPath={projectPath} />
      <button
        style={{ marginTop: 10, background: '#1d2530', color: '#e8edf4', border: '1px solid #2c3647', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
        onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}
      >
        Refresh card
      </button>
    </>
  )
}

function SkillsTab({ projectPath }: { projectPath?: string }) {
  // Fetched per-mount (~17 file reads) so it stays fresh when plugins change and
  // a transient failure isn't pinned by a module cache. Includes plugin +
  // personal (~/.claude) skills and this project's own (<project>/.claude/skills).
  const [state, setState] = useState<'loading' | 'error' | Skill[]>('loading')
  // Groups start collapsed (just a header + count); persisted so an expand
  // survives the panel's per-session remount.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadStrSet('dd.skillsExpanded'))
  useEffect(() => {
    let live = true
    setState('loading')
    invoke<Skill[]>('list_skills', { projectPath: projectPath ?? null })
      .then((s) => live && setState(s))
      .catch(() => live && setState('error'))
    return () => { live = false }
  }, [projectPath])

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
      <div style={{ color: '#5b6675', fontSize: 10, marginBottom: 8 }}>{state.length} skills · plugin, personal &amp; project</div>
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

// Connection-health dot color per status token from `claude mcp list`.
const STATUS_COLOR: Record<string, string> = {
  connected: '#5fb98a',
  failed: '#cf6b6b',
  pending: '#d6b24a',
  unknown: '#5b6675',
  checking: '#3a4350',
}

function StatusDot({ status, title }: { status: string; title: string }) {
  return <span title={title} style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: STATUS_COLOR[status] ?? '#5b6675' }} />
}

// A small on/off switch. `on` = Drydock offers this server to the sessions it
// launches; off denies its tools to new sessions (the server config is untouched).
function Toggle({ on, busy, onClick, title }: { on: boolean; busy: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      style={{ flex: 'none', width: 26, height: 15, borderRadius: 8, border: '1px solid #2c3647', background: on ? '#2f6b4f' : '#222a36', position: 'relative', cursor: busy ? 'default' : 'pointer', padding: 0, opacity: busy ? 0.5 : 1 }}
    >
      <span style={{ position: 'absolute', top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: '50%', background: '#cdd5df', transition: 'left .12s' }} />
    </button>
  )
}

function McpTab({ projectPath }: { projectPath?: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  // null = not fetched yet (show "checking"); {} = fetched, no statuses
  const [status, setStatus] = useState<Record<string, string> | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    setServers(null)
    setStatus(null)
    invoke<McpServer[]>('list_mcp_servers', { projectPath: projectPath ?? null })
      .then((list) => {
        if (!live) return
        setServers(list)
        // only health-check (spawns the user's servers) if there are external ones
        if (list.some((s) => !s.builtin)) {
          invoke<[string, string][]>('mcp_status', { projectPath: projectPath ?? null })
            .then((pairs) => { if (live) setStatus(Object.fromEntries(pairs)) })
            .catch(() => { if (live) setStatus({}) })
        } else {
          setStatus({})
        }
      })
      .catch(() => {
        if (!live) return
        setServers([])
        setStatus({})
      })
    return () => { live = false }
  }, [projectPath])

  const toggleExpand = (name: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n })

  const toggle = async (s: McpServer) => {
    setBusy((prev) => new Set(prev).add(s.name))
    try {
      await invoke('set_mcp_enabled', { name: s.name, enabled: !s.enabled })
      setServers((prev) => prev && prev.map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x)))
    } catch (e) {
      console.error(e)
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(s.name); return n })
    }
  }

  // Health dot: the builtin loopback server is "connected" whenever enabled;
  // external servers reflect the live `claude mcp list` check (or "checking").
  const dotFor = (s: McpServer): { status: string; title: string } => {
    if (s.builtin)
      return s.enabled
        ? { status: 'connected', title: 'Listening · renders to the Artifacts tab' }
        : { status: 'unknown', title: 'Off — new sessions won’t get the render tool' }
    if (status === null) return { status: 'checking', title: 'Checking…' }
    const st = status[s.name] ?? 'unknown'
    const title =
      st === 'connected' ? 'Connected' : st === 'failed' ? 'Failed to connect' : st === 'pending' ? 'Pending approval' : 'Status unknown'
    return { status: st, title }
  }

  const proj = projectPath ? baseName(projectPath) : undefined
  return (
    <div>
      {proj && (
        <div style={{ color: '#7d8794', marginBottom: 4 }}>
          for project: <span style={{ color: '#c8cdd5' }}>{proj}</span>
        </div>
      )}
      <div style={{ color: '#5b6675', fontSize: 10, marginBottom: 8, lineHeight: 1.4 }}>● live status · toggling applies to new sessions · secrets hidden</div>
      {servers === null ? (
        <div style={S.muted}>loading…</div>
      ) : servers.length === 0 ? (
        <div style={S.muted}>no MCP servers configured{proj ? ' for this project' : ''}</div>
      ) : (
        servers.map((s) => {
          const open = expanded.has(s.name)
          const hasTools = s.tools.length > 0
          const dot = dotFor(s)
          return (
            <div key={s.name} style={{ marginBottom: 9, opacity: s.enabled ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {hasTools ? (
                  <button onClick={() => toggleExpand(s.name)} title={open ? 'Hide tools' : 'Show tools'} style={{ ...S.groupBtn, width: 10, flex: 'none', padding: 0 }}>
                    <span style={{ color: '#5b6675' }}>{open ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <span style={{ width: 10, flex: 'none' }} />
                )}
                <StatusDot status={dot.status} title={dot.title} />
                <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                <span style={S.chip}>{s.kind}</span>
                <span style={{ color: '#4a5462', fontSize: 9 }}>{s.scope}</span>
                <Toggle
                  on={s.enabled}
                  busy={busy.has(s.name)}
                  onClick={() => toggle(s)}
                  title={s.enabled ? 'Disable for new Drydock sessions' : 'Enable for new Drydock sessions'}
                />
              </div>
              {s.detail && (
                <div style={{ color: '#7d8794', wordBreak: 'break-all', fontFamily: 'Menlo, monospace', fontSize: 11, marginTop: 1, paddingLeft: 16 }}>{s.detail}</div>
              )}
              {open &&
                s.tools.map((t) => (
                  <div key={t} style={{ paddingLeft: 24, marginTop: 4 }}>
                    <div style={S.name}>{t}</div>
                    {s.builtin && (
                      <div style={S.desc}>Renders a self-contained HTML / SVG / Markdown artifact into Drydock’s Artifacts tab.</div>
                    )}
                  </div>
                ))}
            </div>
          )
        })
      )}
    </div>
  )
}

function PreviewTab({ artifacts }: { artifacts: Artifact[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Transient confirmation/error line under the header (download/reveal results).
  // One timer, always restarted: two quick Downloads must not have the first
  // timer clear the second message early.
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const flashTimer = useRef(0)
  const flash = (text: string, error?: boolean) => {
    clearTimeout(flashTimer.current)
    setMsg({ text, error })
    flashTimer.current = window.setTimeout(() => setMsg(null), 3000)
  }
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  // Download writes straight to ~/Downloads (backend) and reveals it; Reveal
  // shows the model's original source file in Finder (only for file-backed ones).
  const download = (a: Artifact) =>
    invoke<string>('save_artifact', { id: a.id })
      .then(() => flash('Saved to Downloads — revealed in Finder'))
      .catch((e) => flash(String(e), true))
  const reveal = (a: Artifact) => invoke('reveal_artifact', { id: a.id }).catch((e) => flash(String(e), true))
  const actions = (a: Artifact) => (
    <>
      {a.path && (
        <button style={S.iconBtn} title={`Open in Finder\n${a.path}`} onClick={() => reveal(a)}>Open</button>
      )}
      <button style={S.iconBtn} title="Download to your Downloads folder" onClick={() => download(a)}>Download</button>
    </>
  )
  // Esc closes the expanded overlay — even when the artifact iframe has focus.
  // A parent keydown listener never sees keys typed into an iframe, so: html
  // artifacts get a tiny Esc-forwarder script injected by the artifact:// server
  // (postMessage 'drydock-esc', since their scripts run anyway), and static
  // svg/markdown frames (scripts disabled, nothing to type into) just have
  // focus reclaimed by the overlay whenever they steal it.
  useEffect(() => {
    if (!full) return
    overlayRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    const onMsg = (e: MessageEvent) => {
      if (e.data && (e.data as { type?: string }).type === 'drydock-esc') setFull(false)
    }
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) {
        // same default as `current` below: an explicit pick, else the newest
        const kind = (artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1])?.kind
        if (kind !== 'html') setTimeout(() => overlayRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMsg)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMsg)
      window.removeEventListener('blur', onBlur)
    }
  }, [full, artifacts, selectedId])

  if (artifacts.length === 0)
    return <div style={{ ...S.muted, flex: 1, minHeight: 0, padding: 12 }}>No artifacts yet. When Claude renders an artifact (HTML, SVG, or Markdown) in this session, it shows up here.</div>

  // Default to the newest; a manual pick sticks until that artifact is gone.
  const current = artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1]
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 8px' }}>
        <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={current.title}>{current.title}</span>
        <span style={S.chip}>{current.kind}</span>
        {actions(current)}
        <button style={S.iconBtn} title="Expand to full window" onClick={() => setFull(true)}>⤢</button>
      </div>
      {/* always rendered at a constant height: the iframe below must not jump
          when a message appears/expires; long errors ellipsize (full text in title) */}
      <div
        title={msg?.text}
        style={{ padding: '0 12px 6px', fontSize: 10, lineHeight: '12px', height: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: msg?.error ? '#cf6b6b' : '#7ec8a0' }}
      >
        {msg?.text ?? ''}
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
      {/* Fill the rest of the panel edge-to-edge, no frame. Hidden while the
          full-window overlay is up — two mounted copies of an html artifact
          would each run its scripts (double execution). */}
      {!full && <ArtifactView artifact={current} style={{ flex: 1, minHeight: 0, border: 'none', borderRadius: 0 }} />}
      {full && (
        // Full-window overlay so UI artifacts get usable space. zIndex below the
        // quit guard (100); translateZ(0) gives it its own compositing layer so
        // it's clickable over a terminal's WebGL canvas in WKWebView. tabIndex
        // lets it hold focus so Esc lands here, not in a just-clicked iframe.
        <div ref={overlayRef} tabIndex={-1} style={{ position: 'fixed', inset: 0, zIndex: 90, background: '#0b0e13', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1d2530' }}>
            <span style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.title}</span>
            <span style={S.chip}>{current.kind}</span>
            {actions(current)}
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
  const [files, setFiles] = useState<FileTouch[]>([])
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.briefingCollapsed') === '1')
  // clamp on load AND on window resize: a width persisted (or auto-widened) on a
  // big monitor must not overflow a smaller window later
  const [width, setWidth] = useState(() => clampPanelWidth(loadNum('dd.briefingWidth', 252)))
  const [tab, setTab] = useState<RightTab>(() => (localStorage.getItem('dd.rightTab') as RightTab) || 'briefing')
  const widthRef = useRef(width)
  widthRef.current = width
  useEffect(() => {
    const reclamp = () => setWidth((w) => clampPanelWidth(w))
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [])

  const refresh = useCallback(() => {
    if (!sessionId) { setCard(null); setFiles([]); return } // a session-less new tab has no card
    invoke<CardView | null>('get_card', { sessionId }).then(setCard).catch(console.error)
    // no transcript file yet (radar stub / expired) → just no files section
    invoke<FileTouch[]>('session_files', { sessionId }).then(setFiles).catch(() => setFiles([]))
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
          <div style={{ display: 'flex', flex: 1, gap: 2, minWidth: 0 }}>
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
            {tab === 'briefing' && <BriefingTab sessionId={sessionId} card={card} starred={starred} files={files} projectPath={projectPath} onToggleStar={onToggleStar} />}
            {tab === 'skills' && <SkillsTab projectPath={projectPath} />}
            {tab === 'mcp' && <McpTab projectPath={projectPath} />}
          </div>
        )}
      </div>
    </div>
  )
}
