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
import { useSessions } from './useSessions'
import type { SessionView, Tab } from './types'
import { clip, sessionLabel } from './types'

let nextTabId = 1

export default function App() {
  const { sessions, hidden, refresh } = useSessions()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [quitGuard, setQuitGuard] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [claudeVersion, setClaudeVersion] = useState<string | null | 'checking'>('checking')
  const [shellDirs, setShellDirs] = useState<Record<number, string>>({})

  useEffect(() => {
    invoke<string | null>('check_claude').then(setClaudeVersion).catch(() => setClaudeVersion(null))
  }, [])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const newShellRef = useRef(() => {})
  const closeActiveRef = useRef(() => {})
  const starActiveRef = useRef(() => {})

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
    // already open in a running tab here: focus it instead of duplicating
    const runningHere = tabs.find((t) => t.sessionId === s.session_id && t.kind === 'pty' && !t.exited)
    if (runningHere) { setActiveId(runningHere.id); return }
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

  const newSession = (projectPath: string) =>
    addTab({ title: 'claude', kind: 'pty', program: null, args: ['-l', '-c', 'exec claude'], cwd: projectPath })

  const newShell = () => addTab({ title: 'shell', kind: 'pty', program: null, args: ['-l'], cwd: null, terminal: true })

  const markExited = (id: number) => setTabs((p) => p.map((t) => (t.id === id ? { ...t, exited: true } : t)))

  const closeTab = (id: number) => {
    setTabs((p) => p.filter((t) => t.id !== id))
    setShellDirs((d) => (id in d ? Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== id)) : d))
    const next = tabs.filter((t) => t.id !== id)
    setActiveId((a) => (a === id ? (next.length ? next[next.length - 1].id : null) : a))
  }

  newShellRef.current = () => newShell()
  closeActiveRef.current = () => { if (activeId !== null) closeTab(activeId) }
  starActiveRef.current = () => {
    const active = tabs.find((t) => t.id === activeId)
    const s = active?.sessionId ? sessions.find((x) => x.session_id === active.sessionId) : undefined
    if (s) invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)
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
      // ⌘K and ⌘F both open the search palette (⌘F is the habitual "find")
      if (e.metaKey && (e.key === 'k' || e.key === 'f')) { e.preventDefault(); setPaletteOpen((v) => !v) }
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
        onResume={resume}
        onNewSession={newSession}
        onToggleStar={(s) => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)}
        onHide={(sessionId, hide) => invoke('set_hidden', { sessionId, hidden: hide }).then(refresh)}
        onDelete={(sessionId) => invoke('delete_session_permanently', { sessionId }).then(refresh)}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TabBar tabs={tabs} activeId={activeId} shellDirs={shellDirs} onSelect={setActiveId} onClose={closeTab} onNewShell={newShell} />
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {tabs.map((t) => (
            <div key={t.id} style={{ position: 'absolute', inset: 8, display: t.id === activeId ? 'block' : 'none' }}>
              {t.kind === 'pty' ? (
                <TerminalPane id={t.id} program={t.program} args={t.args} cwd={t.cwd} visible={t.id === activeId} onExit={() => markExited(t.id)} onInteract={() => promote(t.id)} />
              ) : (
                <TranscriptView
                  sessionId={t.sessionId!}
                  session={sessions.find((x) => x.session_id === t.sessionId)}
                  onInteract={() => promote(t.id)}
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
        </div>
      </div>
      {(() => {
        const active = tabs.find((t) => t.id === activeId)
        if (!active?.sessionId) return null
        const s = sessions.find((x) => x.session_id === active.sessionId)
        return (
          <BriefingPanel
            key={active.sessionId}
            sessionId={active.sessionId}
            starred={!!s?.starred}
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
