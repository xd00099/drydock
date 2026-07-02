import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Sidebar from './Sidebar'
import TabBar from './TabBar'
import TerminalPane from './TerminalPane'
import TranscriptView from './TranscriptView'
import SearchPalette from './SearchPalette'
import BriefingPanel from './BriefingPanel'
import FindBar from './FindBar'
import { useSessions } from './useSessions'
import type { Artifact, ArtifactKind, PaneSearch, SessionView, Tab } from './types'
import { clip, sessionLabel, uuidv4 } from './types'

let nextTabId = 1
const EMPTY_ARTIFACTS: Artifact[] = [] // stable ref so an artifact-less panel doesn't churn
// Artifacts live only in memory (never written to disk). Bound that memory: a
// session that re-renders many times keeps only its most recent N (each up to
// the backend's 4 MB cap); older versions are dropped.
const MAX_ARTIFACTS_PER_TAB = 20

export default function App() {
  const { sessions, hidden, refresh } = useSessions()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [quitGuard, setQuitGuard] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [claudeVersion, setClaudeVersion] = useState<string | null | 'checking'>('checking')
  const [shellDirs, setShellDirs] = useState<Record<number, string>>({})
  // Artifacts a session rendered (right-panel Preview), kept in memory per tab
  // id; `unread` counts artifacts that arrived for a non-active tab.
  const [artifactsByTab, setArtifactsByTab] = useState<Record<number, Artifact[]>>({})
  const [unread, setUnread] = useState<Record<number, number>>({})
  // ⌘F find-in-session state; each pane registers a PaneSearch controller by id
  const paneSearch = useRef<Record<number, PaneSearch | null>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatches, setFindMatches] = useState({ index: -1, count: 0 })
  const [findNonce, setFindNonce] = useState(0)

  useEffect(() => {
    invoke<string | null>('check_claude').then(setClaudeVersion).catch(() => setClaudeVersion(null))
  }, [])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeIdRef = useRef(activeId) // for the once-registered artifact listener
  activeIdRef.current = activeId
  const sessionsRef = useRef(sessions) // for once-registered attention/focus listeners
  sessionsRef.current = sessions
  // for the once-registered keydown handler: shortcuts must respect open overlays
  const quitGuardRef = useRef(quitGuard)
  quitGuardRef.current = quitGuard
  const paletteOpenRef = useRef(paletteOpen)
  paletteOpenRef.current = paletteOpen
  const newShellRef = useRef(() => {})
  const closeActiveRef = useRef(() => {})
  const starActiveRef = useRef(() => {})
  const openFindRef = useRef(() => {})

  // replaceSession: sweep up stale tabs (exited ptys, superseded transcripts) for that session
  const addTab = (t: Omit<Tab, 'id' | 'exited'> & { exited?: boolean }, replaceSession?: string) => {
    const tab: Tab = { exited: false, ...t, id: nextTabId++ }
    setTabs((p) => [
      ...p.filter(
        (x) =>
          !(tab.preview && x.preview) &&
          !(replaceSession && x.sessionId === replaceSession && x.exited)
      ),
      tab,
    ])
    setActiveId(tab.id)
  }

  // interacting with a preview tab makes it permanent
  const promote = (id: number) =>
    setTabs((p) =>
      p.find((t) => t.id === id)?.preview ? p.map((t) => (t.id === id ? { ...t, preview: false } : t)) : p
    )

  const resume = (s: SessionView, opts?: { transcript?: boolean; permanent?: boolean }) => {
    // already open in a running tab here: focus it instead of duplicating — but
    // an explicit transcript request (e.g. ⌘F's full-session search) still opens
    // the transcript even while the session is running in a tab.
    if (!opts?.transcript) {
      const runningHere = tabs.find((t) => t.sessionId === s.session_id && t.kind === 'pty' && !t.exited)
      if (runningHere) { setActiveId(runningHere.id); return }
    }
    const preview = !opts?.permanent
    if (opts?.transcript || s.live_status !== 'ended') {
      // live in another terminal (or transcript explicitly requested): read-only
      // transcript view (counts as exited for the quit guard)
      const open = tabs.find((t) => t.sessionId === s.session_id && t.kind === 'transcript')
      if (open) { setActiveId(open.id); return }
      addTab({ title: clip(sessionLabel(s), 24), kind: 'transcript', program: null, args: [], cwd: null, sessionId: s.session_id, exited: true, preview }, s.session_id)
      return
    }
    addTab({
      title: clip(sessionLabel(s), 24),
      kind: 'pty',
      program: null,
      args: ['-l', '-c', `exec claude --resume '${s.session_id}'`],
      cwd: s.project_path || null,
      sessionId: s.session_id,
      preview,
    }, s.session_id)
  }

  // A brand-new session has no id until claude generates one, so we'd have no way
  // to match its tab back to the sidebar (re-clicking would open a read-only
  // transcript instead of focusing the live tab, and the tab name would stay
  // "claude"). Pin the id ourselves via `--session-id` and set it on the tab, so
  // a new session behaves exactly like a resumed one. The label then resolves
  // live from the index once the session is picked up (see TabBar).
  const newSession = (projectPath: string) => {
    const sessionId = uuidv4()
    addTab({
      title: 'claude',
      kind: 'pty',
      program: null,
      args: ['-l', '-c', `exec claude --session-id '${sessionId}'`],
      cwd: projectPath,
      sessionId,
    })
  }

  const newShell = () => addTab({ title: 'shell', kind: 'pty', program: null, args: ['-l'], cwd: null, terminal: true })

  // A session's process exiting (claude quit / killed) frees its artifacts right
  // away — they're in-memory only, so an ended session shouldn't keep holding
  // them. The tab can stay open to read the final transcript; closeTab also
  // frees them for the case where the tab is closed while still live.
  const markExited = (id: number) => {
    setTabs((p) => p.map((t) => (t.id === id ? { ...t, exited: true } : t)))
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
  }

  const closeTab = (id: number) => {
    setTabs((p) => p.filter((t) => t.id !== id))
    setShellDirs((d) => (id in d ? Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== id)) : d))
    delete paneSearch.current[id]
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    const next = tabs.filter((t) => t.id !== id)
    setActiveId((a) => (a === id ? (next.length ? next[next.length - 1].id : null) : a))
  }

  const activeTab = tabs.find((t) => t.id === activeId)

  // Find searches the active pane itself: a terminal's scrollback (live claude
  // sessions and shells alike, via xterm's search addon) or an open transcript
  // tab. Closing hands focus back to the pane so typing resumes immediately.
  const activeSearch = () => (activeId != null ? paneSearch.current[activeId] : null)
  const findStep = (dir: 'next' | 'prev') => activeSearch()?.find(findQuery, { dir })
  const closeFind = () => {
    setFindOpen(false)
    Object.values(paneSearch.current).forEach((p) => p?.clear())
    setFindMatches({ index: -1, count: 0 })
    activeSearch()?.focus?.()
  }

  newShellRef.current = () => newShell()
  closeActiveRef.current = () => { if (activeId !== null) closeTab(activeId) }
  starActiveRef.current = () => {
    const s = activeTab?.sessionId ? sessions.find((x) => x.session_id === activeTab.sessionId) : undefined
    if (s) invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)
  }
  // ⌘F: find within the active pane — the terminal's own scrollback for live
  // claude sessions and shells, or an open transcript tab's text. (Searching a
  // claude session's full indexed history is still available by opening its
  // transcript from the sidebar or ⌘K.)
  openFindRef.current = () => {
    if (!tabs.length) return
    setFindOpen(true)
    setFindNonce((n) => n + 1)
  }

  // Shell tabs are named after their live working directory. Poll the PTYs
  // (the backend reads each shell process's cwd from the OS) every 2s, and
  // immediately whenever the set of shell tabs changes.
  const termKey = tabs.filter((t) => t.terminal && !t.exited).map((t) => t.id).join(',')
  useEffect(() => {
    if (!termKey) return
    const poll = () => {
      const ids = termKey.split(',').map(Number)
      invoke<[number, string][]>('pty_cwds', { ids })
        .then((pairs) =>
          setShellDirs((prev) => {
            let changed = false
            const next = { ...prev }
            for (const [id, dir] of pairs) if (next[id] !== dir) { next[id] = dir; changed = true }
            return changed ? next : prev
          })
        )
        .catch(() => {})
    }
    poll()
    const h = setInterval(poll, 2000)
    return () => clearInterval(h)
  }, [termKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return // never act on keys mid-IME-composition
      // While the quit-guard modal is up, keyboard shortcuts must not act on the
      // tabs behind it (⌘W closing a hidden tab, ⌘T opening one). Esc cancels.
      // preventDefault also keeps ⌘W from reaching the native File > Close
      // Window accelerator via WKWebView's unhandled-key re-dispatch.
      if (quitGuardRef.current) {
        if (e.key === 'Escape') setQuitGuard(false)
        if (e.metaKey && ['k', 'f', 't', 'w', 'd'].includes(e.key)) e.preventDefault()
        return
      }
      // Same for the search palette (it handles its own Esc/arrows/Enter); ⌘K
      // still toggles it closed.
      if (paletteOpenRef.current && e.metaKey && ['f', 't', 'w', 'd'].includes(e.key)) {
        e.preventDefault()
        return
      }
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setPaletteOpen((v) => !v) }
      // ⌘F: find within the active pane (terminal scrollback or transcript text)
      if (e.metaKey && e.key === 'f') { e.preventDefault(); openFindRef.current() }
      if (e.metaKey && e.key === 't') { e.preventDefault(); newShellRef.current() }
      if (e.metaKey && e.key === 'w') { e.preventDefault(); closeActiveRef.current() }
      if (e.metaKey && e.key === 'd') { e.preventDefault(); starActiveRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let un: (() => void) | null = null
    getCurrentWindow()
      .onCloseRequested((e) => {
        if (tabsRef.current.some((t) => !t.exited)) {
          e.preventDefault()
          setQuitGuard(true)
        }
      })
      .then((u) => { un = u })
    return () => { un?.() }
  }, [])

  // ⌘Q via the app menu: the backend defers to us while its PTY map is
  // non-empty. Re-check our own tabs — a just-closed tab's PTY may not be
  // reaped yet, and quitting must not silently no-op in that window.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('quit-requested', () => {
      if (tabsRef.current.some((t) => !t.exited)) setQuitGuard(true)
      else invoke('force_quit')
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // live (incremental) find as the query changes, the bar opens, or the tab switches
  useEffect(() => {
    if (!findOpen || activeId == null) return
    activeSearch()?.find(findQuery, { dir: 'next', incremental: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, activeId])

  // A session hit a permission prompt / went idle waiting (needs_input), or
  // finished its turn (done). Turn it into an OS notification unless the user
  // is already looking at that very tab (needs_input) / at Drydock (done) —
  // the sidebar/tab amber dots and dock badge come via index-updated instead.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string; pty_id: number; state: string; message: string }>('session-attention', (e) => {
      const p = e.payload
      const s = sessionsRef.current.find((x) => x.session_id === p.session_id)
      const label = clip(s ? sessionLabel(s) : 'Claude session', 60)
      if (p.state === 'needs_input') {
        if (document.hasFocus() && activeIdRef.current === p.pty_id) return
        invoke('notify_user', { title: label, body: p.message || 'Claude needs your input' }).catch(() => {})
      } else if (p.state === 'done') {
        if (document.hasFocus()) return
        invoke('notify_user', { title: label, body: 'Finished — ready for you' }).catch(() => {})
      }
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // Menu-bar "jump to session" (attention tray): focus its tab if open here,
  // else open it like a sidebar click.
  const focusSessionRef = useRef((_sid: string) => {})
  focusSessionRef.current = (sid: string) => {
    const t = tabs.find((x) => x.sessionId === sid && !x.exited) ?? tabs.find((x) => x.sessionId === sid)
    if (t) { setActiveId(t.id); return }
    const s = sessions.find((x) => x.session_id === sid)
    if (s) resume(s, { permanent: true })
  }
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<string>('focus-session', (e) => focusSessionRef.current(e.payload)).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // A session rendered an artifact (via the loopback MCP server): file it under
  // its tab id for the Preview panel, and badge the tab if it's not in focus.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ pty_id: number; id: string; title: string; kind: string; content: string; path: string | null }>('artifact', (e) => {
      const p = e.payload
      const kind: ArtifactKind = p.kind === 'svg' || p.kind === 'markdown' ? p.kind : 'html'
      const art: Artifact = { id: p.id, title: p.title || 'Untitled', kind, content: p.content, path: p.path ?? undefined }
      setArtifactsByTab((prev) => {
        const next = [...(prev[p.pty_id] ?? []), art]
        if (next.length > MAX_ARTIFACTS_PER_TAB) next.splice(0, next.length - MAX_ARTIFACTS_PER_TAB)
        return { ...prev, [p.pty_id]: next }
      })
      if (p.pty_id !== activeIdRef.current) setUnread((u) => ({ ...u, [p.pty_id]: (u[p.pty_id] ?? 0) + 1 }))
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // Focusing a tab clears its unread-artifact badge.
  useEffect(() => {
    if (activeId == null) return
    setUnread((u) => { if (!u[activeId]) return u; const n = { ...u }; delete n[activeId]; return n })
  }, [activeId])

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#10141a' }}>
      <Sidebar
        sessions={sessions}
        hidden={hidden}
        activeSessionId={activeTab?.sessionId ?? null}
        onResume={resume}
        onNewSession={newSession}
        onToggleStar={(s) => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)}
        onHide={(sessionId, hide) => invoke('set_hidden', { sessionId, hidden: hide }).then(refresh)}
        onDelete={(sessionId) => invoke('delete_session_permanently', { sessionId }).then(refresh)}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* In-flow (not fixed at a guessed sidebar offset): it always spans
            exactly the main column at any sidebar width or collapse state. */}
        {claudeVersion === null && (
          <div style={{ background: '#5a3030', color: '#f0d0d0', padding: '4px 12px', fontFamily: 'system-ui', fontSize: 12 }}>
            claude CLI not found in your login shell — resume/new sessions won't start. Install Claude Code or fix your PATH, then restart Drydock. Shell tabs still work.
          </div>
        )}
        <TabBar tabs={tabs} sessions={sessions} activeId={activeId} shellDirs={shellDirs} unread={unread} onSelect={setActiveId} onClose={closeTab} onNewShell={newShell} />
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {tabs.map((t) => (
            <div key={t.id} style={{ position: 'absolute', inset: 8, display: t.id === activeId ? 'block' : 'none' }}>
              {t.kind === 'pty' ? (
                <TerminalPane
                  ref={(h) => { paneSearch.current[t.id] = h }}
                  id={t.id}
                  program={t.program}
                  args={t.args}
                  cwd={t.cwd}
                  sessionId={t.sessionId}
                  visible={t.id === activeId}
                  onExit={() => markExited(t.id)}
                  onInteract={() => promote(t.id)}
                  onMatches={(index, count) => setFindMatches({ index, count })}
                />
              ) : (
                <TranscriptView
                  ref={(h) => { paneSearch.current[t.id] = h }}
                  sessionId={t.sessionId!}
                  session={sessions.find((x) => x.session_id === t.sessionId)}
                  onInteract={() => promote(t.id)}
                  onMatches={(index, count) => setFindMatches({ index, count })}
                  onResumeHere={() => {
                    const s = sessions.find((x) => x.session_id === t.sessionId)
                    closeTab(t.id)
                    if (s) resume({ ...s, live_status: 'ended' }, { permanent: true })
                  }}
                />
              )}
            </div>
          ))}
          {tabs.length === 0 && (
            <div style={{ color: '#5b6675', fontFamily: 'system-ui', fontSize: 13, padding: 24 }}>
              Pick a session on the left, or ＋ for a shell.
            </div>
          )}
          {findOpen && (
            <FindBar
              query={findQuery}
              onQuery={setFindQuery}
              matches={findMatches}
              focusNonce={findNonce}
              onNext={() => findStep('next')}
              onPrev={() => findStep('prev')}
              onClose={closeFind}
            />
          )}
        </div>
      </div>
      {/* Right panel for any claude/transcript tab (not plain shells). Keyed by
          tab id — NOT sessionId — so distinct tabs (e.g. a live session and its
          read-only transcript share one id) each keep their own panel state. */}
      {activeTab && !activeTab.terminal && (() => {
        const s = activeTab.sessionId ? sessions.find((x) => x.session_id === activeTab.sessionId) : undefined
        return (
          <BriefingPanel
            key={activeTab.id}
            sessionId={activeTab.sessionId ?? null}
            projectPath={s?.project_path ?? activeTab.cwd ?? undefined}
            starred={!!s?.starred}
            artifacts={artifactsByTab[activeTab.id] ?? EMPTY_ARTIFACTS}
            onToggleStar={
              s ? () => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh) : undefined
            }
          />
        )
      })()}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(s, transcript) => resume(s, { transcript })}
      />
      {quitGuard && (
        // zIndex + own compositing layer: every other overlay has a z-index, but
        // this modal had none, so over a terminal's WebGL canvas WebKit painted it
        // on top yet routed clicks to the canvas (visible but not clickable).
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, transform: 'translateZ(0)' }}>
          <div style={{ background: '#161c25', color: '#e8edf4', padding: 20, borderRadius: 8, fontFamily: 'system-ui', fontSize: 13 }}>
            <div style={{ marginBottom: 12 }}>Sessions are still running in tabs. Quit anyway?</div>
            <button
              style={{ background: '#7a2e2e', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 12, marginRight: 8 }}
              onClick={() => invoke('force_quit')}
            >
              Quit anyway
            </button>
            <button
              style={{ background: '#1d2530', color: '#e8edf4', border: '1px solid #2c3647', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
              onClick={() => setQuitGuard(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
