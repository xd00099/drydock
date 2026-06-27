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
  // the in-place conversation overlay (a live Claude session's ⌘F target)
  const overlaySearch = useRef<PaneSearch | null>(null)
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

  const markExited = (id: number) => setTabs((p) => p.map((t) => (t.id === id ? { ...t, exited: true } : t)))

  const closeTab = (id: number) => {
    setTabs((p) => p.filter((t) => t.id !== id))
    setShellDirs((d) => (id in d ? Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== id)) : d))
    delete paneSearch.current[id]
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    const next = tabs.filter((t) => t.id !== id)
    setActiveId((a) => (a === id ? (next.length ? next[next.length - 1].id : null) : a))
  }

  // The active tab, and — while ⌘F is open over a live Claude session — the
  // session id whose conversation the in-place overlay searches (see render).
  const activeTab = tabs.find((t) => t.id === activeId)
  const overlaySession =
    findOpen && activeTab?.kind === 'pty' && activeTab.sessionId ? activeTab.sessionId : null

  // Find routes to that overlay for a live Claude session, else to the active
  // pane itself (a shell's scrollback or an open transcript tab).
  const activeSearch = () =>
    overlaySession ? overlaySearch.current : activeId != null ? paneSearch.current[activeId] : null
  const findStep = (dir: 'next' | 'prev') => activeSearch()?.find(findQuery, { dir })
  const closeFind = () => {
    setFindOpen(false)
    overlaySearch.current?.clear()
    Object.values(paneSearch.current).forEach((p) => p?.clear())
    setFindMatches({ index: -1, count: 0 })
  }

  newShellRef.current = () => newShell()
  closeActiveRef.current = () => { if (activeId !== null) closeTab(activeId) }
  starActiveRef.current = () => {
    const s = activeTab?.sessionId ? sessions.find((x) => x.session_id === activeTab.sessionId) : undefined
    if (s) invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)
  }
  // ⌘F: find within the active session. A Claude session runs as a fullscreen
  // (alt-buffer) app, so its live terminal holds only the visible frame — the
  // whole conversation lives in the indexed transcript. Rather than yank the user
  // to a separate tab, we overlay that transcript in place over the live terminal
  // (see the overlay in the render below); Esc returns to the live session, which
  // never stopped running. Shell tabs and open transcript tabs search themselves.
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
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setPaletteOpen((v) => !v) }
      // ⌘F: find within the active session (in-place conversation overlay for a
      // live Claude session, else the terminal's own scrollback)
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

  // A session rendered an artifact (via the loopback MCP server): file it under
  // its tab id for the Preview panel, and badge the tab if it's not in focus.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ pty_id: number; id: string; title: string; kind: string; content: string }>('artifact', (e) => {
      const p = e.payload
      const kind: ArtifactKind = p.kind === 'svg' || p.kind === 'markdown' ? p.kind : 'html'
      const art: Artifact = { id: p.id, title: p.title || 'Untitled', kind, content: p.content }
      setArtifactsByTab((prev) => ({ ...prev, [p.pty_id]: [...(prev[p.pty_id] ?? []), art] }))
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
      {claudeVersion === null && (
        <div style={{ position: 'fixed', top: 0, left: 300, right: 0, background: '#5a3030', color: '#f0d0d0', padding: '4px 12px', fontFamily: 'system-ui', fontSize: 12, zIndex: 40 }}>
          claude CLI not found in your login shell — resume/new sessions won't start. Install Claude Code or fix your PATH, then restart Drydock. Shell tabs still work.
        </div>
      )}
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
          {/* ⌘F on a live Claude session: overlay its full conversation in place
              (terminal stays live underneath; Esc closes and returns to it). */}
          {overlaySession && (
            <div style={{ position: 'absolute', inset: 8, zIndex: 10, background: '#10141a' }}>
              <TranscriptView
                ref={(h) => { overlaySearch.current = h }}
                overlay
                sessionId={overlaySession}
                session={sessions.find((x) => x.session_id === overlaySession)}
                onMatches={(index, count) => setFindMatches({ index, count })}
                onResumeHere={() => {}}
              />
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
            <button onClick={() => invoke('force_quit')} style={{ marginRight: 8 }}>Quit anyway</button>
            <button onClick={() => setQuitGuard(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
