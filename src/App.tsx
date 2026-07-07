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
import HomeView from './HomeView'
import FindBar from './FindBar'
import { useSessions } from './useSessions'
import type { Artifact, ArtifactKind, PaneSearch, RestoreTab, SessionView, Tab } from './types'
import { clip, sessionLabel, uuidv4 } from './types'

let nextTabId = 1
const EMPTY_ARTIFACTS: Artifact[] = [] // stable ref so an artifact-less panel doesn't churn
// Artifacts live only in memory (never written to disk). Bound that memory: a
// session that re-renders many times keeps only its most recent N (each up to
// the backend's 4 MB cap); older versions are dropped.
const MAX_ARTIFACTS_PER_TAB = 20

export default function App() {
  const { sessions, hidden, folders, ready: sessionsReady, refresh } = useSessions()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [quitGuard, setQuitGuard] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // full-window Home overlay (⌘K → "usage & timeline"): global data without
  // leaving the active terminal — Esc returns exactly where you were
  const [homeOverlay, setHomeOverlay] = useState(false)
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
  const shellDirsRef = useRef(shellDirs) // for the update-restart stash (built at call time)
  shellDirsRef.current = shellDirs
  // for the once-registered keydown handler: shortcuts must respect open overlays
  const quitGuardRef = useRef(quitGuard)
  quitGuardRef.current = quitGuard
  const paletteOpenRef = useRef(paletteOpen)
  paletteOpenRef.current = paletteOpen
  const homeOverlayRef = useRef(homeOverlay)
  homeOverlayRef.current = homeOverlay
  const newShellRef = useRef(() => {})
  const closeActiveRef = useRef(() => {})
  const starActiveRef = useRef(() => {})
  const openFindRef = useRef(() => {})
  const goHomeRef = useRef(() => {})
  const toggleTranscriptRef = useRef(() => {})

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

  // Rebuild the workspace stashed just before an update restart (the backend
  // deletes the snapshot on read, so this applies exactly once). claude tabs
  // resume their session — scrollback resets but the conversation is intact;
  // tabs whose process had already exited come back as read-only transcripts.
  useEffect(() => {
    invoke<RestoreTab[] | null>('take_stashed_tabs')
      .then((saved) => {
        if (!saved?.length) return
        let active: number | null = null
        const restored: Tab[] = []
        for (const r of saved) {
          // session ids are spliced single-quoted into a shell -c; our own
          // uuids are quote-free, so anything else in the snapshot is
          // malformed — skip it rather than build a broken command
          if (r.session_id?.includes("'")) continue
          const id = nextTabId++
          if (r.kind === 'claude' && r.session_id) {
            restored.push({ id, title: r.title || 'claude', kind: 'pty', program: null, args: ['-l', '-c', `exec claude --resume '${r.session_id}'`], cwd: r.cwd, sessionId: r.session_id, exited: false })
          } else if (r.kind === 'transcript' && r.session_id) {
            restored.push({ id, title: r.title || 'session', kind: 'transcript', program: null, args: [], cwd: null, sessionId: r.session_id, exited: true })
          } else if (r.kind === 'shell') {
            restored.push({ id, title: r.title || 'shell', kind: 'pty', program: null, args: ['-l'], cwd: r.cwd, exited: false, terminal: true })
          } else {
            continue
          }
          if (r.active) active = id
        }
        if (!restored.length) return
        setTabs((prev) => [...prev, ...restored])
        setActiveId(active ?? restored[restored.length - 1].id)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A session's process exiting (claude quit / killed) frees its artifacts right
  // away — they're in-memory only, so an ended session shouldn't keep holding
  // them. The tab can stay open to read the final transcript; closeTab also
  // frees them for the case where the tab is closed while still live.
  const markExited = (id: number) => {
    setTabs((p) => p.map((t) => (t.id === id ? { ...t, exited: true } : t)))
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
  }

  const closeTab = (id: number, opts?: { keepFind?: boolean }) => {
    setTabs((p) => p.filter((t) => t.id !== id))
    setShellDirs((d) => (id in d ? Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== id)) : d))
    delete paneSearch.current[id]
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    // Lane-aware selection: closing a tab stays among its own kind (sessions
    // vs terminals, matching the TabBar lanes). A terminal lane that empties
    // falls back to a session; a SESSION lane that empties lands on Home even
    // while shells stay open unselected — Home is where you pick what's next.
    const closed = tabs.find((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    const lane = next.filter((t) => !!t.terminal === !!closed?.terminal)
    const fallback = closed?.terminal ? next.filter((t) => !t.terminal) : []
    const landing = lane.length ? lane[lane.length - 1].id : fallback.length ? fallback[fallback.length - 1].id : null
    // Home has no pane — a find bar there would search nothing. keepFind is for
    // close-and-replace flows (resume-here): the caller opens a new tab in the
    // same breath, so the user never actually lands on Home.
    if (activeId === id && landing === null && !opts?.keepFind) closeFind()
    setActiveId((a) => (a === id ? landing : a))
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
  goHomeRef.current = () => {
    closeFind()
    setActiveId(null)
  }
  // no active pane on Home — a find bar there would search nothing
  openFindRef.current = () => {
    if (!tabs.length || activeId == null) return
    setFindOpen(true)
    setFindNonce((n) => n + 1)
  }
  // ⌘⇧T: flip the active session between its terminal and its read-only
  // transcript. From a terminal tab → open/focus the transcript; from a
  // transcript tab → focus the live terminal if one is open here (never
  // resumes — that stays an explicit act).
  toggleTranscriptRef.current = () => {
    const t = activeTab
    if (!t?.sessionId) return
    if (t.kind === 'transcript') {
      const liveTab = tabs.find((x) => x.sessionId === t.sessionId && x.kind === 'pty' && !x.exited)
      if (liveTab) setActiveId(liveTab.id)
      return
    }
    const s = sessions.find((x) => x.session_id === t.sessionId)
    if (s) resume(s, { transcript: true })
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
        if (e.metaKey && ['k', 'f', 't', 'T', 'w', 'd', '0'].includes(e.key)) e.preventDefault()
        return
      }
      // Same for the search palette (it handles its own Esc/arrows/Enter); ⌘K
      // still toggles it closed.
      if (paletteOpenRef.current && e.metaKey && ['f', 't', 'T', 'w', 'd', '0'].includes(e.key)) {
        e.preventDefault()
        return
      }
      if (homeOverlayRef.current) {
        if (e.key === 'Escape') { setHomeOverlay(false); return }
        // ⌘0 under the overlay = "Home proper": close the overlay and go
        // there — never two mounted Homes, never a deselect behind a curtain
        if (e.metaKey && e.key === '0') { e.preventDefault(); setHomeOverlay(false); goHomeRef.current(); return }
        // ⌘K: search wins — drop the overlay so the palette isn't buried
        if (e.metaKey && e.key === 'k') { e.preventDefault(); setHomeOverlay(false); setPaletteOpen(true); return }
        // Everything else must not act on tabs hidden behind the overlay
        // (⌘W closing an invisible tab); preventDefault keeps ⌘W from the
        // native Close Window accelerator, same as the quit-guard branch.
        if (e.metaKey && ['f', 't', 'T', 'w', 'd'].includes(e.key)) e.preventDefault()
        return
      }
      if (e.metaKey && e.key === 'k') { e.preventDefault(); setPaletteOpen((v) => !v) }
      // ⌘0: Home — deselect the active tab (tabs stay open; ⌘0 is a view,
      // not a close). Closes ⌘F first: a find bar has no pane on Home.
      if (e.metaKey && e.key === '0') { e.preventDefault(); goHomeRef.current() }
      // ⌘F: find within the active pane (terminal scrollback or transcript text)
      if (e.metaKey && e.key === 'f') { e.preventDefault(); openFindRef.current() }
      // ⌘⇧T (key is 'T' with shift held): terminal ⇄ transcript for the active session
      if (e.metaKey && e.shiftKey && e.key === 'T') { e.preventDefault(); toggleTranscriptRef.current() }
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
        // sound only here: an audible ping always means "blocked on you"
        invoke('notify_user', { title: label, body: p.message || 'Claude needs your input', sound: true }).catch(() => {})
      } else if (p.state === 'done') {
        if (document.hasFocus()) return
        invoke('notify_user', { title: label, body: 'Finished — ready for you', sound: false }).catch(() => {})
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

  // claude tabs currently mid-turn: the update flow's "restart anyway?" gate.
  const updateBusyCount = tabs.filter(
    (t) =>
      t.kind === 'pty' && !t.terminal && !t.exited && t.sessionId &&
      sessions.find((s) => s.session_id === t.sessionId)?.live_status === 'busy'
  ).length

  // The update is installed (bundle already swapped on disk): snapshot the
  // open tabs for the next launch, then restart into the new version. The
  // stash is best-effort — a failed snapshot must not strand a half-applied
  // update, and every session stays reachable from the sidebar regardless.
  // Built from refs: the install download takes a while and tabs may have
  // changed since the click.
  const restartForUpdate = async () => {
    const snapshot = tabsRef.current
      .filter((t) => !(t.terminal && t.exited)) // dead shells aren't worth reopening
      .map((t) => ({
        kind: t.kind === 'transcript' || t.exited ? ('transcript' as const) : t.terminal ? ('shell' as const) : ('claude' as const),
        session_id: t.sessionId ?? null,
        cwd: t.terminal ? shellDirsRef.current[t.id] ?? t.cwd : t.cwd,
        title: t.title,
        active: t.id === activeIdRef.current,
      }))
      .filter((r) => r.kind === 'shell' || r.session_id) // claude/transcript need a session id
    await invoke('stash_tabs', { tabs: snapshot }).catch(() => {})
    await invoke('restart_app').catch(() => {})
  }

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#10141a' }}>
      <Sidebar
        onHome={() => goHomeRef.current()}
        sessions={sessions}
        folders={folders}
        hidden={hidden}
        activeSessionId={activeTab?.sessionId ?? null}
        onResume={resume}
        onTranscript={(s) => resume(s, { transcript: true })}
        onNewSession={newSession}
        onToggleStar={(s) => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)}
        onHide={(sessionId, hide) => invoke('set_hidden', { sessionId, hidden: hide }).then(refresh)}
        onDelete={(sessionId) => invoke('delete_session_permanently', { sessionId }).then(refresh)}
        onRefresh={refresh}
        updateBusyCount={updateBusyCount}
        onRestartForUpdate={restartForUpdate}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* In-flow (not fixed at a guessed sidebar offset): it always spans
            exactly the main column at any sidebar width or collapse state. */}
        {claudeVersion === null && (
          <div style={{ background: '#5a3030', color: '#f0d0d0', padding: '4px 12px', fontFamily: 'system-ui', fontSize: 12 }}>
            claude CLI not found in your login shell — resume/new sessions won't start. Install Claude Code or fix your PATH, then restart Drydock. Shell tabs still work.
          </div>
        )}
        <TabBar tabs={tabs} sessions={sessions} activeId={activeId} shellDirs={shellDirs} unread={unread} onSelect={setActiveId} onClose={closeTab} onNewShell={newShell} onHome={() => goHomeRef.current()} />
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
                  onFocusLive={(() => {
                    const liveTab = tabs.find((x) => x.sessionId === t.sessionId && x.kind === 'pty' && !x.exited)
                    return liveTab ? () => setActiveId(liveTab.id) : null
                  })()}
                  onInteract={() => promote(t.id)}
                  onMatches={(index, count) => setFindMatches({ index, count })}
                  onResumeHere={() => {
                    const s = sessions.find((x) => x.session_id === t.sessionId)
                    // keepFind only when resume will actually run: a missing
                    // session means we genuinely land on Home, find and all
                    closeTab(t.id, { keepFind: !!s })
                    if (s) resume({ ...s, live_status: 'ended' }, { permanent: true })
                  }}
                />
              )}
            </div>
          ))}
          {activeId === null && (
            <HomeView sessions={sessions} sessionsReady={sessionsReady} onFocusSession={(sid) => focusSessionRef.current(sid)} />
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
            label={s ? sessionLabel(s) : null}
            initialUnread={(unread[activeTab.id] ?? 0) > 0}
            artifacts={artifactsByTab[activeTab.id] ?? EMPTY_ARTIFACTS}
            onToggleStar={
              s ? () => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh) : undefined
            }
            onRename={
              s ? (name) => invoke('set_session_name', { sessionId: s.session_id, name }).then(refresh).catch(console.error) : undefined
            }
          />
        )
      })()}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(s, transcript) => { setHomeOverlay(false); resume(s, { transcript }) }}
        onOverlay={() => { setPaletteOpen(false); setHomeOverlay(true) }}
      />
      {homeOverlay && (
        // full-window, above panes/find (z<90 artifact-expand, <100 quit guard);
        // own compositing layer so it's clickable over a terminal's WebGL canvas
        <div
          ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus() } }}
          tabIndex={-1}
          style={{ position: 'fixed', inset: 0, zIndex: 85, background: '#0b0e13', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1d2530', fontFamily: 'system-ui' }}>
            <span style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13 }}>Usage & recap log</span>
            <button
              onClick={() => setHomeOverlay(false)}
              title="Close (Esc)"
              style={{ background: 'none', border: '1px solid #2c3647', borderRadius: 4, cursor: 'pointer', color: '#9aa3af', fontSize: 12, lineHeight: 1, padding: '2px 6px' }}
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <HomeView
              sessions={sessions}
              sessionsReady={sessionsReady}
              onFocusSession={(sid) => { setHomeOverlay(false); focusSessionRef.current(sid) }}
            />
          </div>
        </div>
      )}
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
