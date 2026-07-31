import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Sidebar from '@/features/sidebar/Sidebar'
import TabBar from '@/features/tabs/TabBar'
import TerminalPane, { bytesToB64 } from '@/features/terminal/TerminalPane'
import TranscriptView from '@/features/transcript/TranscriptView'
import SearchPalette from '@/features/search/SearchPalette'
import NewSessionDialog from '@/features/session/NewSessionDialog'
import SettingsOverlay from '@/features/settings/SettingsOverlay'
import BriefingPanel from '@/features/briefing/BriefingPanel'
import HomeView from '@/features/home/HomeView'
import FindBar from '@/features/search/FindBar'
import { useSessions } from '@/hooks/useSessions'
import ConfirmCloseDialog from './dialogs/ConfirmCloseDialog'
import QuitGuardDialog from './dialogs/QuitGuardDialog'
import TakeoverDialog from './dialogs/TakeoverDialog'
import { useStageDrag } from './useStageDrag'
import { serializeChord, effectiveKeymap, loadOverrides, KEYMAP_EVENT } from '@/lib/keymap'
import type { ActionId } from '@/lib/keymap'
import { getSetting } from '@/lib/settings'
import type { Artifact, ArtifactKind, PaneSearch, RestoreTab, ReviewPrompt, ReviewState, SessionView, Tab, TakeoverInfo } from '@/lib/types'
import { EMPTY_REVIEW, baseName, clip, interruptsWork, projectColor, sessionLabel, uuidv4 } from '@/lib/types'
import {
  canSplit, closeStaged, focusNeighbor, layoutRects, pruneStage, setRatio, showTab, stagedIds,
} from '@/lib/split'
import type { DividerRect, Edge, Rect, Stage } from '@/lib/split'

let nextTabId = 1
const EMPTY_ARTIFACTS: Artifact[] = [] // stable ref so an artifact-less panel doesn't churn
// Artifacts live only in memory (never written to disk). Bound that memory: a
// session that re-renders many times keeps only its most recent N (each up to
// the backend's 4 MB cap); older versions are dropped.
const MAX_ARTIFACTS_PER_TAB = 20

export default function App() {
  const { sessions, hidden, folders, ready: sessionsReady, refresh } = useSessions()
  const [tabs, setTabs] = useState<Tab[]>([])
  // The stage: which tabs are visible (split layout tree) and which pane has
  // focus. layout === null is classic single-pane mode; `active` drives ALL
  // per-tab chrome (BriefingPanel, find, sidebar highlight, ⌘W…) exactly as
  // the old single activeId did. Layout + focus live in ONE state so
  // close-then-open flows compose through functional updates atomically.
  const [stage, setStage] = useState<Stage>({ layout: null, active: null })
  const { layout, active: activeId } = stage
  const [quitGuard, setQuitGuard] = useState(false)
  // Take-over confirm dialog: which live-elsewhere session, where it's
  // running (fetched async; located=false until the lookup lands), and any
  // kill error. null = closed.
  const [takeover, setTakeover] = useState<{ s: SessionView; info: TakeoverInfo | null; located: boolean; err: string | null; killing: boolean } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newDialog, setNewDialog] = useState(false) // ⌘N: new session in any folder
  const [settingsOpen, setSettingsOpen] = useState(false) // ⌘, / footer gear
  const [confirmClose, setConfirmClose] = useState<number | null>(null) // close-guard: tab id awaiting confirm
  // full-window Home overlay (⌘K → "usage & timeline"): global data without
  // leaving the active terminal — Esc returns exactly where you were
  const [homeOverlay, setHomeOverlay] = useState(false)
  const [claudeVersion, setClaudeVersion] = useState<string | null | 'checking'>('checking')
  // Panel collapse lives here (not in the panels) so ⌘B/⌘J can drive it; the
  // panels render it. Same localStorage keys as before the lift.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('dd.sidebarCollapsed') === '1')
  const [briefingCollapsed, setBriefingCollapsed] = useState(() => localStorage.getItem('dd.briefingCollapsed') === '1')
  // ⌘⇧B/P/J: expand the briefing panel and land on a specific sub-tab
  const [panelJump, setPanelJump] = useState<{ tab: 'briefing' | 'project' | 'preview'; n: number }>({ tab: 'preview', n: 0 })
  const setSidebarC = (c: boolean) => { setSidebarCollapsed(c); localStorage.setItem('dd.sidebarCollapsed', c ? '1' : '0') }
  const setBriefingC = (c: boolean) => { setBriefingCollapsed(c); localStorage.setItem('dd.briefingCollapsed', c ? '1' : '0') }
  const [shellDirs, setShellDirs] = useState<Record<number, string>>({})
  // Artifacts a session rendered (right-panel Preview), kept in memory per tab
  // id; `unread` counts artifacts that arrived for a non-active tab.
  const [artifactsByTab, setArtifactsByTab] = useState<Record<number, Artifact[]>>({})
  const [unread, setUnread] = useState<Record<number, number>>({})
  // Interactive artifact review, per tab: queued annotations, sent history,
  // and agent presence (docs/artifact-review.md). ALL
  // writes go through mutateReview: it updates the ref mirror SYNCHRONOUSLY
  // (before React flushes), so two message events in one tick (queue then
  // send) never read stale state, and reviewSend's invoke sees every queued
  // prompt exactly once.
  const [reviewByTab, setReviewByTab] = useState<Record<number, ReviewState>>({})
  const reviewRef = useRef(reviewByTab)
  const mutateReview = (fn: (prev: Record<number, ReviewState>) => Record<number, ReviewState>) => {
    reviewRef.current = fn(reviewRef.current)
    setReviewByTab(reviewRef.current)
  }
  // one pending "working → waiting" decay timer per tab (model stopped polling)
  const reviewDecayTimers = useRef<Record<number, number>>({})
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
  const stageRef = useRef(stage) // for pointer-drag handlers registered mid-gesture
  stageRef.current = stage
  // Zoom: the focused pane temporarily fills the stage; the split waits
  // beneath, untouched. The same gesture restores it — and so does anything
  // that mutates the tree (drop, close, ⌘0) or moves focus off the zoomed
  // pane: a changed stage must be SEEN, and a stale zoomTab must never
  // re-trigger later when its pane happens to regain focus.
  const [zoomTab, setZoomTab] = useState<number | null>(null)
  const zoomOn = layout !== null && zoomTab !== null && zoomTab === activeId
  useEffect(() => { setZoomTab(null) }, [layout])
  useEffect(() => { setZoomTab((p) => (p !== null && p !== activeId ? null : p)) }, [activeId])
  const chipDragLiveRef = useRef(false) // a live chip drag owns the stage: no zooming mid-gesture
  const toggleZoomRef = useRef<(id: number) => void>(() => {})
  toggleZoomRef.current = (id) => {
    if (stageRef.current.layout !== null && !chipDragLiveRef.current) setZoomTab((p) => (p === id ? null : id))
  }
  // staged = every tab in the layout; visible = what the user can actually
  // SEE (a zoom hides the sibling panes). The once-registered attention and
  // artifact listeners key off VISIBLE — only a pane the user can see needs
  // no notification or unread badge. A zoom-hidden session that blocks on
  // you must ping exactly like an unstaged one.
  const staged = stagedIds(stage)
  const visible = zoomOn && activeId !== null ? [activeId] : staged
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const sessionsRef = useRef(sessions) // for once-registered attention/focus listeners
  sessionsRef.current = sessions
  const shellDirsRef = useRef(shellDirs) // for the update-restart stash (built at call time)
  shellDirsRef.current = shellDirs
  // for the once-registered keydown handler: shortcuts must respect open overlays
  const quitGuardRef = useRef(quitGuard)
  quitGuardRef.current = quitGuard
  const takeoverRef = useRef(takeover)
  takeoverRef.current = takeover
  const takeoverSeqRef = useRef(0) // guards the async process lookup against reopen races
  const paletteOpenRef = useRef(paletteOpen)
  paletteOpenRef.current = paletteOpen
  const newDialogRef = useRef(newDialog)
  newDialogRef.current = newDialog
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen
  const confirmCloseRef = useRef(confirmClose)
  confirmCloseRef.current = confirmClose
  const homeOverlayRef = useRef(homeOverlay)
  homeOverlayRef.current = homeOverlay
  const newShellRef = useRef(() => {})
  const closeActiveRef = useRef(() => {})
  // for the once-registered keydown listener's confirm-close Enter: closeTab
  // is recreated per render (its lane-aware landing reads fresh tabs/stage) —
  // calling it directly from the [] effect would freeze the FIRST render's
  // empty tabs and always land on Home
  const closeTabRef = useRef((_id: number) => {})
  const starActiveRef = useRef(() => {})
  const openFindRef = useRef(() => {})
  const goHomeRef = useRef(() => {})
  const toggleTranscriptRef = useRef(() => {})
  const focusNavRef = useRef((_key: string) => {}) // ⌘⌥ arrows: move pane focus

  // Effective chord→action map for the once-registered keydown dispatcher;
  // rebuilt whenever the Settings → Shortcuts tab saves a rebind.
  const keymapRef = useRef(effectiveKeymap(loadOverrides()))
  useEffect(() => {
    const reload = () => { keymapRef.current = effectiveKeymap(loadOverrides()) }
    window.addEventListener(KEYMAP_EVENT, reload)
    return () => window.removeEventListener(KEYMAP_EVENT, reload)
  }, [])
  // ⌘1-9 / ⌘⇧[] address tabs in VISUAL order — the TabBar's lanes (sessions,
  // then terminals) — not creation order.
  const orderedTabs = () => {
    const t = tabsRef.current
    return [...t.filter((x) => !x.terminal), ...t.filter((x) => x.terminal)]
  }
  const gotoTab = (n: number) => {
    const ordered = orderedTabs()
    if (!ordered.length) return
    const target = n === 9 ? ordered[ordered.length - 1] : ordered[n - 1]
    if (target) setStage((st) => showTab(st, target.id))
  }
  const cycleTab = (d: 1 | -1) => {
    const ordered = orderedTabs()
    if (!ordered.length) return
    const i = ordered.findIndex((t) => t.id === stageRef.current.active)
    const target = i < 0
      ? ordered[d > 0 ? 0 : ordered.length - 1]
      : ordered[(i + d + ordered.length) % ordered.length]
    setStage((st) => showTab(st, target.id))
  }
  const gotoTabRef = useRef(gotoTab)
  gotoTabRef.current = gotoTab

  // Reassigned every render (same pattern as toggleZoomRef), so case arms may
  // close over fresh state directly.
  const runActionRef = useRef<(id: ActionId) => void>(() => {})
  runActionRef.current = (id) => {
    switch (id) {
      case 'palette.toggle': setPaletteOpen((v) => !v); break
      case 'home.show': goHomeRef.current(); break
      case 'find.open': openFindRef.current(); break
      case 'shell.new': newShellRef.current(); break
      case 'transcript.toggle': toggleTranscriptRef.current(); break
      case 'tab.close': closeActiveRef.current(); break
      case 'session.star': starActiveRef.current(); break
      case 'pane.zoom': {
        const a = stageRef.current.active
        if (a !== null) toggleZoomRef.current(a)
        break
      }
      case 'pane.focus.left': focusNavRef.current('ArrowLeft'); break
      case 'pane.focus.right': focusNavRef.current('ArrowRight'); break
      case 'pane.focus.up': focusNavRef.current('ArrowUp'); break
      case 'pane.focus.down': focusNavRef.current('ArrowDown'); break
      case 'sidebar.toggle': setSidebarC(!sidebarCollapsed); break
      case 'briefing.toggle': setBriefingC(!briefingCollapsed); break
      // expand + land on a specific sub-tab (no-op when the active tab has
      // no briefing panel — plain shells don't mount one)
      case 'briefing.preview': setBriefingC(false); setPanelJump((p) => ({ tab: 'preview', n: p.n + 1 })); break
      case 'briefing.tab.briefing': setBriefingC(false); setPanelJump((p) => ({ tab: 'briefing', n: p.n + 1 })); break
      case 'briefing.tab.project': setBriefingC(false); setPanelJump((p) => ({ tab: 'project', n: p.n + 1 })); break
      case 'tab.prev': cycleTab(-1); break
      case 'tab.next': cycleTab(1); break
      case 'session.new': setNewDialog(true); break
      case 'settings.toggle': setSettingsOpen((v) => !v); break
      default: break
    }
  }

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
    // showTab: in a split, the new tab takes over the focused pane (viewport
    // semantics) instead of collapsing the layout
    setStage((st) => showTab(st, tab.id))
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
      if (runningHere) { setStage((st) => showTab(st, runningHere.id)); return }
    }
    const preview = !opts?.permanent
    if (opts?.transcript || s.live_status !== 'ended') {
      // live in another terminal (or transcript explicitly requested): read-only
      // transcript view (counts as exited for the quit guard)
      const open = tabs.find((t) => t.sessionId === s.session_id && t.kind === 'transcript')
      if (open) { setStage((st) => showTab(st, open.id)); return }
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

  // "Take over here": stop the terminal that owns a live-elsewhere session,
  // then resume it in a Drydock tab. Opens the confirm dialog naming exactly
  // what dies; a session that's live in THIS window just gets its tab focused.
  const openTakeover = (s: SessionView) => {
    const here = tabsRef.current.find((t) => t.sessionId === s.session_id && t.kind === 'pty' && !t.exited)
    if (here) { setStage((st) => showTab(st, here.id)); return }
    // token guards the async lookup: cancelling and reopening (even the same
    // session) must not let a stale fetch land its info on the new dialog
    const token = ++takeoverSeqRef.current
    setTakeover({ s, info: null, located: false, err: null, killing: false })
    const apply = (patch: Partial<NonNullable<typeof takeover>>) =>
      setTakeover((t) => (t && takeoverSeqRef.current === token ? { ...t, ...patch } : t))
    invoke<TakeoverInfo | null>('session_process_info', { sessionId: s.session_id })
      .then((info) => apply({ info, located: true }))
      .catch(() => apply({ located: true }))
  }
  const confirmTakeover = () => {
    const t = takeoverRef.current
    if (!t || t.killing) return
    if (!t.info) {
      // process already gone — the session just hasn't flipped to ended in
      // the index yet; resume directly (the override the resume-here flow uses)
      setTakeover(null)
      resume({ ...t.s, live_status: 'ended' }, { permanent: true })
      return
    }
    setTakeover({ ...t, killing: true, err: null })
    invoke('takeover_kill', { sessionId: t.s.session_id })
      .then(() => {
        setTakeover(null)
        resume({ ...t.s, live_status: 'ended' }, { permanent: true })
      })
      .catch((e) => setTakeover((x) => (x ? { ...x, killing: false, err: String(e) } : x)))
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

  // ⌘T: a new shell starts where you're working — the active shell's live cwd,
  // or the active session's project folder; home only as the Home-view fallback.
  const newShell = () => {
    const t = tabs.find((x) => x.id === activeId)
    let cwd: string | null = null
    if (t?.terminal) cwd = shellDirs[t.id] ?? t.cwd ?? null
    else if (t) {
      const s = t.sessionId ? sessions.find((x) => x.session_id === t.sessionId) : undefined
      cwd = s?.project_path ?? t.cwd ?? null
    }
    addTab({ title: 'shell', kind: 'pty', program: null, args: ['-l'], cwd, terminal: true })
  }

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
        const show = active ?? restored[restored.length - 1].id
        setStage((st) => showTab(st, show))
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
    window.clearTimeout(reviewDecayTimers.current[id])
    mutateReview((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
  }

  const closeTab = (id: number, opts?: { keepFind?: boolean }) => {
    setTabs((p) => p.filter((t) => t.id !== id))
    setShellDirs((d) => (id in d ? Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== id)) : d))
    delete paneSearch.current[id]
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    window.clearTimeout(reviewDecayTimers.current[id])
    mutateReview((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    // Lane-aware selection: closing a tab stays among its own kind (sessions
    // vs terminals, matching the TabBar lanes). A terminal lane that empties
    // falls back to a session; a SESSION lane that empties lands on Home even
    // while shells stay open unselected — Home is where you pick what's next.
    const closed = tabs.find((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    const lane = next.filter((t) => !!t.terminal === !!closed?.terminal)
    const fallback = closed?.terminal ? next.filter((t) => !t.terminal) : []
    const landing = lane.length ? lane[lane.length - 1].id : fallback.length ? fallback[fallback.length - 1].id : null
    // Home has no pane — a find bar there would search nothing. keepFind is
    // for close-and-replace flows (resume-here): activeId/tabs here are the
    // RENDER's values, so when the caller already restaged in the same
    // handler this stale check would misfire. A tab closed out of a SPLIT
    // never lands on Home either: its pane collapses into the sibling, which
    // takes focus (closeStaged below).
    const inSplit = layout !== null && staged.includes(id)
    if (!inSplit && activeId === id && landing === null && !opts?.keepFind) closeFind()
    setStage((st) => {
      const r = closeStaged(st, id)
      if (r.wasStaged) return r.stage
      return st.active === id ? { layout: null, active: landing } : st
    })
  }

  // ⌘W / chip ✕ asks first ONLY when this tab's session is mid-turn (and the
  // closeGuard setting allows asking) — the same predicate as the quit guard,
  // scoped to one tab. Idle sessions close silently: the session stays
  // resumable from the sidebar and nothing in flight is lost. Programmatic
  // closes (resume-here replace flows, restore) stay on closeTab.
  const requestCloseTab = (id: number) => {
    const t = tabsRef.current.find((x) => x.id === id)
    if (t && interruptsWork([t], sessionsRef.current) && getSetting('closeGuard', '1') === '1') setConfirmClose(id)
    else closeTab(id)
  }

  const activeTab = tabs.find((t) => t.id === activeId)

  // ⌘N recents: most-recent distinct project folders across all known sessions
  const recentDirs = (() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of [...sessions].sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))) {
      if (s.project_path && !seen.has(s.project_path)) { seen.add(s.project_path); out.push(s.project_path) }
      if (out.length >= 6) break
    }
    return out
  })()

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
  closeActiveRef.current = () => { if (activeId !== null) requestCloseTab(activeId) }
  closeTabRef.current = closeTab
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
    // Home = an empty stage: any split is dismantled (every tab returns to the
    // deck — nothing closes). The ⌘K Home OVERLAY is the non-destructive peek.
    setStage({ layout: null, active: null })
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
      if (liveTab) setStage((st) => showTab(st, liveTab.id))
      return
    }
    const s = sessions.find((x) => x.session_id === t.sessionId)
    if (s) resume(s, { transcript: true })
  }

  // ---- Split screen: geometry, drag-to-split, dividers, chip menu ----

  // The stage (content area) box, tracked so pane rects can be computed. Panes
  // are positioned by rect in one flat layer — never re-parented — so
  // terminals survive any re-layout; their own ResizeObservers re-fit.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [contentSize, setContentSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContentSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const stageBox: Rect | null = contentSize
    ? { x: 8, y: 8, w: Math.max(0, contentSize.w - 16), h: Math.max(0, contentSize.h - 16) }
    : null
  const geom = layout !== null && stageBox
    ? zoomOn
      ? { panes: [{ tabId: activeId as number, rect: stageBox }], dividers: [] as DividerRect[] }
      : layoutRects(layout, stageBox)
    : null
  const paneRect = (id: number | null) => (id === null ? undefined : geom?.panes.find((p) => p.tabId === id)?.rect)
  // Panes lit for attention: a session blocked on you, in a pane that is NOT
  // focused (you're already looking at that one). Derived ONCE because two
  // places consume it and they must never disagree — the pane's own border
  // goes transparent exactly where the .dd-attnring overlay takes over, and a
  // pane lit in one place but not the other would show either no frame at all
  // or a session-tinted one bleeding through the ring's dim phase.
  const attnPanes = new Set(
    tabs
      .filter((t) => t.id !== activeId && sessions.find((x) => x.session_id === t.sessionId)?.live_status === 'needs_input')
      .map((t) => t.id),
  )

  // A staged tab whose id vanished from `tabs` (e.g. a preview tab on stage
  // replaced by the next preview, or the exited-tab sweep) must not leave a
  // dead pane behind. Reconcile whenever the tabs array changes.
  useEffect(() => {
    setStage((st) => pruneStage(st, new Set(tabs.map((t) => t.id))))
    // same hazard for the chip context menu: its tab can be closed (⌘W)
    // while the menu is open — acting on the dead id would re-inject it
    setChipMenu((m) => (m && !tabs.some((t) => t.id === m.tabId) ? null : m))
  }, [tabs])

  // Everything the user can SEE counts as seen: landing in a (visible) pane
  // clears its badge. Zoom-hidden panes keep accruing until revealed.
  const stagedKey = visible.join(',')
  useEffect(() => {
    if (!stagedKey) return
    const ids = stagedKey.split(',').map(Number)
    setUnread((u) => {
      const hit = ids.filter((i) => u[i])
      if (!hit.length) return u
      const n = { ...u }
      for (const i of hit) delete n[i]
      return n
    })
    // Same idea for the backend's "finished, unseen" markers — but only while
    // the window is actually focused. Staged panes in a background window have
    // not been seen by anyone, and the focus listener below picks them up when
    // the user comes back.
    if (document.hasFocus()) invoke('attention_seen', { ptyIds: ids }).catch(() => {})
  }, [stagedKey])

  // Coming back to Drydock is when work that finished while you were away gets
  // seen. Without this the check would sit on a pane you're staring at until
  // you typed in it — the same "nothing clears it" trap that made the amber dot
  // meaningless before.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    const sweep = () => {
      const ids = visibleRef.current
      if (ids.length) invoke('attention_seen', { ptyIds: ids }).catch(() => {})
    }
    const w = getCurrentWindow()
    // onFocusChanged only fires on a CHANGE, so ask once: if the window is
    // already focused at mount (a relaunch with restored tabs), no event is
    // coming and the staged-panes effect may have run before the webview took
    // DOM focus, leaving document.hasFocus() false and the marker stuck.
    w.isFocused().then((f) => { if (!cancelled && f) sweep() }).catch(() => {})
    w.onFocusChanged(({ payload: focused }) => { if (focused) sweep() })
      .then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // Focus history: lets "Split right" on the FOCUSED tab's own chip pick a
  // partner (the tab you were just looking at) — a pane can't split with its
  // own tab, since a tab's content mounts exactly once.
  const mruRef = useRef<number[]>([])
  useEffect(() => {
    if (activeId === null) return
    mruRef.current = [activeId, ...mruRef.current.filter((x) => x !== activeId)].slice(0, 12)
  }, [activeId])

  focusNavRef.current = (key: string) => {
    if (layout === null || !stageBox) return
    const edge: Edge = key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : key === 'ArrowUp' ? 'top' : 'bottom'
    const next = focusNeighbor(layoutRects(layout, stageBox).panes, activeId, edge)
    if (next !== null) setStage((st) => ({ ...st, active: next }))
  }

  // All pointer-driven stage manipulation lives in one place — see useStageDrag.
  const {
    chipDrag, dragXY, stageHit, insertMark,
    chipMenu, setChipMenu,
    suppressClickRef, dividerDraggedRef,
    beginChipDrag, beginDividerDrag, splitFromMenu,
  } = useStageDrag({
    tabsRef, stageRef, contentRef, setTabs, setStage, setZoomTab, promote,
    chipDragLiveRef, layout, activeId, zoomTab,
  })

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
      const chord = serializeChord(e)
      const action = chord ? keymapRef.current.get(chord) : undefined
      // ⌘W must NEVER reach the native File > Close Window accelerator (via
      // WKWebView's unhandled-key re-dispatch) — even when the user rebinds
      // or unbinds "Close tab", a muscle-memory ⌘W closing the whole window
      // (or summoning the quit guard) is worse than a no-op.
      if (chord === 'meta+w') e.preventDefault()
      // While a modal is up, shortcuts must not act on the tabs behind it —
      // any chord that IS a registered shortcut gets swallowed (preventDefault
      // also keeps ⌘W from reaching the native Close Window accelerator via
      // WKWebView's unhandled-key re-dispatch). Priority order matches render
      // z-order: quit guard, take-over, palette, home overlay.
      if (quitGuardRef.current) {
        if (e.key === 'Escape') setQuitGuard(false)
        if (action) e.preventDefault()
        return
      }
      // Take-over dialog: Esc cancels unless the kill is already in flight
      if (takeoverRef.current) {
        if (e.key === 'Escape' && !takeoverRef.current.killing) setTakeover(null)
        if (action) e.preventDefault()
        return
      }
      // Close-guard confirm: BARE Enter closes the live session (a modified
      // Enter is muscle memory for something else — ⇧⌘⏎ zoom — and must not
      // defeat the very accident-guard this modal is), Esc keeps it.
      if (confirmCloseRef.current !== null) {
        if (e.key === 'Escape') { setConfirmClose(null); return }
        if (e.key === 'Enter' && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
          e.preventDefault()
          closeTabRef.current(confirmCloseRef.current)
          setConfirmClose(null)
          return
        }
        if (action) e.preventDefault()
        return
      }
      // Settings overlay: Esc or the toggle chord closes; everything else is
      // swallowed. (While the Shortcuts tab RECORDS a chord, its own
      // capture-phase listener stops propagation — no key reaches here.)
      if (settingsOpenRef.current) {
        if (e.key === 'Escape') { setSettingsOpen(false); return }
        if (action === 'settings.toggle') { e.preventDefault(); setSettingsOpen(false); return }
        if (action) e.preventDefault()
        return
      }
      // ⌘N dialog: its input handles arrows/Tab/Enter itself; Esc must work
      // even when the input lost focus (a click on the hint text), and the
      // toggle chord re-closes it. Every other shortcut is swallowed.
      if (newDialogRef.current) {
        if (e.key === 'Escape') { setNewDialog(false); return }
        if (action === 'session.new') { e.preventDefault(); setNewDialog(false); return }
        if (action) e.preventDefault()
        return
      }
      // The palette handles its own Esc/arrows/Enter on its input; the toggle
      // chord still closes it, every other shortcut is swallowed.
      if (paletteOpenRef.current) {
        if (action === 'palette.toggle') { e.preventDefault(); setPaletteOpen(false) }
        else if (action) e.preventDefault()
        return
      }
      if (homeOverlayRef.current) {
        if (e.key === 'Escape') { setHomeOverlay(false); return }
        // Home chord under the overlay = "Home proper": close the overlay and
        // go there — never two mounted Homes, never a deselect behind a curtain
        if (action === 'home.show') { e.preventDefault(); setHomeOverlay(false); goHomeRef.current(); return }
        // palette chord: search wins — drop the overlay so it isn't buried
        if (action === 'palette.toggle') { e.preventDefault(); setHomeOverlay(false); setPaletteOpen(true); return }
        if (action) e.preventDefault()
        return
      }
      // ⌘1-9: fixed tab-switch family (⌘9 = last tab) — deliberately not in
      // the registry, so not rebindable.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        gotoTabRef.current(Number(e.key))
        return
      }
      if (action) {
        e.preventDefault()
        runActionRef.current(action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The guard fires only when quitting would interrupt a turn IN FLIGHT (a
  // busy session in a live tab — see quitInterruptsWork). Idle and waiting
  // sessions resume on relaunch, so nagging about them taught the user to
  // click through the dialog, which is worse than no dialog.
  useEffect(() => {
    let un: (() => void) | null = null
    getCurrentWindow()
      .onCloseRequested((e) => {
        if (interruptsWork(tabsRef.current, sessionsRef.current)) {
          e.preventDefault()
          setQuitGuard(true)
        }
      })
      .then((u) => { un = u })
    return () => { un?.() }
  }, [])

  // ⌘Q via the app menu: the backend defers to us while its PTY map is
  // non-empty (it cannot see busy-ness; only the index can), so this listener
  // is the actual decision point — confirm mid-turn work, otherwise quit.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('quit-requested', () => {
      if (interruptsWork(tabsRef.current, sessionsRef.current)) setQuitGuard(true)
      else invoke('force_quit')
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // live (incremental) find as the query changes, the bar opens, or the tab switches
  const lastFindPaneRef = useRef<number | null>(null)
  useEffect(() => {
    if (!findOpen || activeId == null) return
    // retargeting to another pane: wipe the departing pane's marks first — in
    // a split it stays VISIBLE, and two panes must not both show an "active"
    // match while the counter describes only one of them
    if (lastFindPaneRef.current !== null && lastFindPaneRef.current !== activeId) {
      paneSearch.current[lastFindPaneRef.current]?.clear()
    }
    lastFindPaneRef.current = activeId
    activeSearch()?.find(findQuery, { dir: 'next', incremental: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, activeId])

  // A session is blocked on an answer ('needs_input'), finished its turn
  // ('done'), or has something to announce that isn't about its own state
  // ('info' — a background agent finished, or the agent pushed a notification).
  // Turn it into an OS notification unless the user is already looking at that
  // very tab (needs_input/done) or at Drydock (info). Idle sessions produce
  // NOTHING here: attention::classify drops those before they are emitted, which
  // is what stopped every walked-away-from session from claiming to need you.
  // The visual side — amber dot, check glyph, dock badge — arrives separately
  // via index-updated.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string; pty_id: number; state: string; message: string }>('session-attention', (e) => {
      const p = e.payload
      const s = sessionsRef.current.find((x) => x.session_id === p.session_id)
      const label = clip(s ? sessionLabel(s) : 'Claude session', 60)
      if (p.state === 'done' && document.hasFocus() && visibleRef.current.includes(p.pty_id)) {
        // Watched it finish: retire the marker now rather than leaving a check
        // on the pane the user is looking at. Runs regardless of the notify
        // setting — this is state, not a notification.
        invoke('attention_seen', { ptyIds: [p.pty_id] }).catch(() => {})
        return
      }
      if (getSetting('notifyEnabled', '1') === '0') return // Settings → General toggle
      if (p.state === 'needs_input') {
        // staged, not just active: any pane the user can SEE (split screen)
        if (document.hasFocus() && visibleRef.current.includes(p.pty_id)) return
        // Sound only here. That claim is only true because attention::classify
        // filters the Notification hook: an idle nag and a completion both
        // arrive on the same event and neither is worth a noise.
        invoke('notify_user', { title: label, body: p.message || 'Claude needs your input', sound: true }).catch(() => {})
      } else if (p.state === 'done') {
        if (document.hasFocus()) return
        // A StopFailure names why it died; a clean Stop carries nothing. Saying
        // "finished" for a turn killed by a rate limit is the lie this avoids.
        const body = p.message ? `Stopped — ${clip(p.message, 80)}` : 'Finished — ready for you'
        invoke('notify_user', { title: label, body, sound: false }).catch(() => {})
      } else if (p.state === 'info' && p.message) {
        // Not about this session's own state (so nothing was stored for it) —
        // announce it and leave the session's indicator alone.
        if (document.hasFocus()) return
        invoke('notify_user', { title: label, body: clip(p.message, 90), sound: false }).catch(() => {})
      }
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // Menu-bar "jump to session" (attention tray): focus its tab if open here,
  // else open it like a sidebar click.
  const focusSessionRef = useRef((_sid: string) => {})
  focusSessionRef.current = (sid: string) => {
    const t = tabs.find((x) => x.sessionId === sid && !x.exited) ?? tabs.find((x) => x.sessionId === sid)
    if (t) { setStage((st) => showTab(st, t.id)); return }
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
      // visible on stage = already seen; only badge tabs the user can't see
      if (!visibleRef.current.includes(p.pty_id)) setUnread((u) => ({ ...u, [p.pty_id]: (u[p.pty_id] ?? 0) + 1 }))
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // The session's transcript rewound (Claude Code Esc-Esc): artifacts rendered
  // after the rewound-to point show a discarded future — the backend pruned
  // them; drop them here too, and clear the review round's pills (they
  // annotated that discarded timeline).
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string; pty_id: number | null; removed_ids: string[] }>('artifact-rewound', (e) => {
      const p = e.payload
      if (p.pty_id == null) return
      const pty = p.pty_id
      if (p.removed_ids.length) {
        const gone = new Set(p.removed_ids)
        setArtifactsByTab((prev) => {
          const cur = prev[pty]
          if (!cur?.length) return prev
          const kept = cur.filter((a) => !gone.has(a.id))
          return kept.length === cur.length ? prev : { ...prev, [pty]: kept }
        })
      }
      mutateReview((prev) => {
        const cur = prev[pty]
        if (!cur || cur.prompts.length === 0) return prev
        return { ...prev, [pty]: { ...cur, prompts: [] } }
      })
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Review-loop signals from the backend poll tool: presence transitions
  // (listening/working/waiting around await_artifact_feedback) and optional
  // agent replies for the conversation panel.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ pty_id: number; presence?: string; reply?: string }>('artifact-review', (e) => {
      const p = e.payload
      // Drop events for tabs that closed/exited — a straggler poll finishing
      // after teardown must not resurrect an orphaned review entry.
      const t = tabsRef.current.find((x) => x.id === p.pty_id)
      if (!t || t.kind !== 'pty' || t.exited) return
      mutateReview((prev) => {
        const cur = prev[p.pty_id] ?? EMPTY_REVIEW
        const presence =
          p.presence === 'listening' || p.presence === 'working' || p.presence === 'waiting' ? p.presence : cur.presence
        const chat = p.reply ? [...cur.chat, { role: 'agent' as const, text: p.reply }] : cur.chat
        return { ...prev, [p.pty_id]: { ...cur, presence, chat } }
      })
      // 'working' means "feedback delivered, model revising" — but a model
      // that stops polling (turn ended, crash) would wedge the composer shut.
      // Decay to 'waiting' unless a newer presence event lands first.
      window.clearTimeout(reviewDecayTimers.current[p.pty_id])
      if (p.presence === 'working') {
        reviewDecayTimers.current[p.pty_id] = window.setTimeout(() => {
          mutateReview((prev) => {
            const cur = prev[p.pty_id]
            if (!cur || cur.presence !== 'working') return prev
            return { ...prev, [p.pty_id]: { ...cur, presence: 'waiting' } }
          })
        }, 60_000)
      }
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  // ---- interactive review handlers (bound per tab at the BriefingPanel) ----

  // Queue one annotation from the SDK. A repeat _ddQueueKey replaces the unsent
  // prior update for the same input (radio/checkbox/field), like lavish-axi.
  const reviewQueue = (tabId: number, prompt: ReviewPrompt) => {
    mutateReview((prev) => {
      const cur = prev[tabId] ?? EMPTY_REVIEW
      const key = prompt._ddQueueKey
      const kept = key ? cur.prompts.filter((p) => p._ddQueueKey !== key) : cur.prompts
      return { ...prev, [tabId]: { ...cur, prompts: [...kept, prompt] } }
    })
  }

  const reviewDiscard = (tabId: number, index: number) => {
    mutateReview((prev) => {
      const cur = prev[tabId] ?? EMPTY_REVIEW
      return { ...prev, [tabId]: { ...cur, prompts: cur.prompts.filter((_, i) => i !== index) } }
    })
  }

  // Send everything queued (plus an optional composer message) to the session's
  // feedback queue; endReview marks the review finished. Reads the ref (kept
  // fresh by mutateReview) so the invoke happens exactly once.
  const reviewSend = (tabId: number, message: string, endReview: boolean) => {
    const cur = reviewRef.current[tabId] ?? EMPTY_REVIEW
    if (cur.presence === 'working') return // model is mid-revision; panel shows why
    const all = [...cur.prompts]
    const msg = message.trim()
    if (msg) all.push({ uid: '', prompt: msg, selector: '', tag: 'message', text: '' })
    if (!all.length && !endReview) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const stripped = all.map(({ _ddQueueKey, ...rest }) => rest)
    invoke('submit_artifact_feedback', { ptyId: tabId, prompts: stripped, endReview }).catch(console.error)
    const chat = [
      ...cur.chat,
      ...all.map((p) => ({
        role: 'user' as const,
        text: p.tag === 'message' ? p.prompt : `⟨${p.tag}⟩${p.text ? ` “${clip(p.text, 60)}”` : ''} — ${p.prompt}`,
      })),
    ]
    mutateReview((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? EMPTY_REVIEW), prompts: [], chat } }))
    // The poll only runs WHILE the model is in a turn. presence 'waiting' means
    // nobody is listening (the turn ended — e.g. the model hit the empty-poll
    // limit), so the queued feedback would sit silently until the user typed
    // something. Nudge the session ourselves: type a prompt into its PTY
    // exactly as the user would, starting a turn that collects the queue.
    if (cur.presence === 'waiting') {
      const nudge = endReview
        ? 'I finished reviewing the artifact — call await_artifact_feedback to collect my final feedback if you have not already, apply it, and continue with the work.'
        : 'I left review feedback on the artifact — call await_artifact_feedback to collect and apply it.'
      // pty_write takes base64 bytes. The Enter must be a separate write after a
      // beat: text+\r in one chunk trips the TUI's paste detection, which turns
      // the \r into a composer newline instead of a submit (verified against a
      // live claude PTY — single chunk parks the text unsent, split submits).
      const enc = new TextEncoder()
      invoke('pty_write', { id: tabId, data: bytesToB64(enc.encode(nudge)) })
        .then(() => new Promise((r) => setTimeout(r, 200)))
        .then(() => invoke('pty_write', { id: tabId, data: bytesToB64(enc.encode('\r')) }))
        .catch(console.error)
    }
  }

  // (unread badges clear via the staged-tabs effect above — landing on stage,
  // focused or not, counts as seen)

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
        active: t.id === stageRef.current.active,
      }))
      .filter((r) => r.kind === 'shell' || r.session_id) // claude/transcript need a session id
    await invoke('stash_tabs', { tabs: snapshot }).catch(() => {})
    await invoke('restart_app').catch(() => {})
  }

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--dd-bg1)' }}>
      <Sidebar
        onHome={() => goHomeRef.current()}
        sessions={sessions}
        folders={folders}
        hidden={hidden}
        activeSessionId={activeTab?.sessionId ?? null}
        onResume={resume}
        onTranscript={(s) => resume(s, { transcript: true })}
        onTakeover={openTakeover}
        onNewSession={newSession}
        onToggleStar={(s) => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh)}
        onHide={(sessionId, hide) => invoke('set_hidden', { sessionId, hidden: hide }).then(refresh)}
        onDelete={(sessionId) => invoke('delete_session_permanently', { sessionId }).then(refresh)}
        onRefresh={refresh}
        updateBusyCount={updateBusyCount}
        onRestartForUpdate={restartForUpdate}
        collapsed={sidebarCollapsed}
        onSetCollapsed={setSidebarC}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* In-flow (not fixed at a guessed sidebar offset): it always spans
            exactly the main column at any sidebar width or collapse state. */}
        {claudeVersion === null && (
          <div style={{ background: 'var(--dd-err-bg-strong)', color: 'var(--dd-err-text)', padding: '4px 12px', fontFamily: 'system-ui', fontSize: 12 }}>
            claude CLI not found in your login shell — resume/new sessions won't start. Install Claude Code or fix your PATH, then restart Drydock. Shell tabs still work.
          </div>
        )}
        <TabBar
          tabs={tabs}
          sessions={sessions}
          activeId={activeId}
          stagedIds={staged}
          shellDirs={shellDirs}
          unread={unread}
          draggedId={chipDrag?.tabId ?? null}
          insertMark={insertMark}
          onChipPress={beginChipDrag}
          onChipDouble={(id) => {
            // the double-click's own two clicks already staged + focused the
            // tab (showTab); if they were drag-suppressed, don't zoom either
            if (!suppressClickRef.current && stageRef.current.active === id) toggleZoomRef.current(id)
          }}
          onChipMenu={(e, id) => { e.preventDefault(); setChipMenu({ x: e.clientX, y: e.clientY, tabId: id }) }}
          onSelect={(id) => { if (suppressClickRef.current) return; setStage((st) => showTab(st, id)) }}
          onClose={requestCloseTab}
          onNewShell={newShell}
          onHome={() => goHomeRef.current()}
        />
        <div ref={contentRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {tabs.map((t) => {
            const onStage = staged.includes(t.id)
            const r = onStage ? paneRect(t.id) : undefined
            const sess = t.sessionId ? sessions.find((x) => x.session_id === t.sessionId) : undefined
            // In a split every pane wears a frame: accent = focused (keyboard
            // + right panel live there), amber pulse = an unfocused pane whose
            // session is blocked on you — the pulsing ring itself is a sibling
            // overlay rendered after this map, since a pane clips its own
            // children. Single-pane mode keeps today's frameless inset exactly.
            const attn = attnPanes.has(t.id)
            // Zoomed: staged panes without a rect stay mounted but hidden —
            // same display:none contract as unstaged tabs.
            const shown = onStage && (layout === null || r !== undefined)
            return (
              <div
                key={t.id}
                data-pane={t.id}
                data-staged={onStage ? '1' : '0'}
                data-focused={t.id === activeId ? '1' : undefined}
                data-attn={r && attn ? '1' : undefined}
                onPointerDownCapture={
                  r ? () => setStage((st) => (st.active !== t.id && stagedIds(st).includes(t.id) ? { ...st, active: t.id } : st)) : undefined
                }
                style={
                  r
                    ? {
                        position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h,
                        boxSizing: 'border-box', display: 'block', overflow: 'hidden',
                        borderRadius: 'var(--dd-r-lg)',
                        // Session-color chrome: the frame plus a thin tinted
                        // mat wear the session's color so panes read as THEIR
                        // session at a glance; shells keep the neutral steel.
                        // Focus = full-strength border. A lit pane hands its
                        // border to the .dd-attnring overlay: still 2px (so no
                        // pixel of content moves) but transparent, because the
                        // ring's dim phase must composite over this pane's
                        // BACKGROUND — exactly what the old border-color
                        // animation faded to. Leave a session tint under it and
                        // the trough turns grey instead of amber.
                        padding: 3,
                        border: `2px solid ${
                          attn
                            ? 'transparent'
                            : t.sessionId
                              ? projectColor(sess?.project_path, t.id === activeId ? 1 : 0.45)
                              : t.id === activeId ? 'var(--dd-accent-border)' : 'var(--dd-hover)'
                        }`,
                        background: t.sessionId
                          ? projectColor(sess?.project_path, t.id === activeId ? 0.12 : 0.06)
                          : 'var(--dd-bg1)',
                      }
                    : {
                        // Unsplit stage: an inset card rather than a bare
                        // rectangle bleeding into the chrome. box-sizing is
                        // load-bearing — xterm's FitAddon sizes cols/rows from
                        // the content box, so the hairline has to come out of
                        // the pane's own width, not push the PTY 2px wider than
                        // its container.
                        position: 'absolute', inset: 8, display: shown ? 'block' : 'none',
                        boxSizing: 'border-box', overflow: 'hidden',
                        borderRadius: 'var(--dd-r-lg)',
                        border: '1px solid var(--dd-hairline)',
                        boxShadow: 'var(--dd-shadow-1)',
                      }
                }
              >
              {t.kind === 'pty' ? (
                <TerminalPane
                  ref={(h) => { paneSearch.current[t.id] = h }}
                  id={t.id}
                  program={t.program}
                  args={t.args}
                  cwd={t.cwd}
                  sessionId={t.sessionId}
                  visible={shown}
                  focused={t.id === activeId}
                  onExit={() => markExited(t.id)}
                  onInteract={() => promote(t.id)}
                  onMatches={(index, count) => setFindMatches({ index, count })}
                />
              ) : (
                <TranscriptView
                  ref={(h) => { paneSearch.current[t.id] = h }}
                  sessionId={t.sessionId!}
                  session={sess}
                  onFocusLive={(() => {
                    const liveTab = tabs.find((x) => x.sessionId === t.sessionId && x.kind === 'pty' && !x.exited)
                    return liveTab ? () => setStage((st) => showTab(st, liveTab.id)) : null
                  })()}
                  onTakeover={sess && sess.live_status !== 'ended' ? () => openTakeover(sess) : null}
                  onInteract={() => promote(t.id)}
                  onMatches={(index, count) => setFindMatches({ index, count })}
                  onResumeHere={() => {
                    const s = sessions.find((x) => x.session_id === t.sessionId)
                    // Replace IN PLACE: resume first — this pane is focused
                    // (the button click's pointerdown focused it), so showTab
                    // swaps THIS leaf to the new tab and addTab's session
                    // sweep removes the transcript; closeTab after is just
                    // cleanup. Close-first would collapse the pane and anchor
                    // the new tab on the SIBLING, evicting the wrong pane —
                    // and kill the find bar on the way through Home.
                    if (s) resume({ ...s, live_status: 'ended' }, { permanent: true })
                    // keepFind: closeTab judges "landed on Home" from stale
                    // render values — when resume ran, we know we didn't
                    closeTab(t.id, { keepFind: !!s })
                  }}
                />
              )}
              </div>
            )
          })}
          {/* Attention rings — one per lit pane, over the pane's own rect. They
              are SIBLINGS of the panes, not children: a pane sets
              overflow:hidden, which clips its descendants to the padding box,
              so a child (or ::before) could never paint on the 2px border ring.
              Out here there is no clipping ancestor, so the opacity fade stays
              on the compositor. Keyed by tab id, so a divider drag resizes a
              ring in place while leaving/re-entering the lit set remounts it
              and re-alerts. Painted above its own pane (later in DOM, and pane
              rects never overlap) and below the dividers / drop hint, which
              carry z-index. */}
          {geom?.panes
            .filter((p) => attnPanes.has(p.tabId))
            .map((p) => (
              <div
                key={p.tabId}
                className="dd-attnring"
                aria-hidden
                style={{ position: 'absolute', left: p.rect.x, top: p.rect.y, width: p.rect.w, height: p.rect.h }}
              />
            ))}
          {geom?.dividers.map((d) => (
            <div
              key={d.path}
              className="dd-divider"
              onPointerDown={(e) => beginDividerDrag(e, d)}
              onDoubleClick={() => {
                if (dividerDraggedRef.current) return // second release of a fine-tune drag, not a real dblclick
                setStage((st) => (st.layout !== null ? { ...st, layout: setRatio(st.layout, d.path, 0.5) } : st))
              }}
              title="Drag to resize — double-click to even out"
              style={{
                position: 'absolute', left: d.rect.x, top: d.rect.y, width: d.rect.w, height: d.rect.h,
                cursor: d.dir === 'row' ? 'col-resize' : 'row-resize', zIndex: 5,
              }}
            />
          ))}
          {chipDrag && stageHit && (
            <div
              data-hint="1"
              style={{
                position: 'absolute', left: stageHit.hint.x, top: stageHit.hint.y, width: stageHit.hint.w, height: stageHit.hint.h,
                background: 'rgba(127,176,255,0.14)', border: '1px solid rgba(127,176,255,0.55)', borderRadius: 4,
                zIndex: 6, pointerEvents: 'none',
              }}
            />
          )}
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
            review={activeTab.kind === 'pty' && !activeTab.exited ? reviewByTab[activeTab.id] ?? EMPTY_REVIEW : null}
            reviewAccent={activeTab.sessionId ? projectColor(s?.project_path) : 'var(--dd-warn-bright)'}
            onReviewQueue={(p) => reviewQueue(activeTab.id, p)}
            onReviewDiscard={(i) => reviewDiscard(activeTab.id, i)}
            onReviewSend={(m, end) => reviewSend(activeTab.id, m, end)}
            onToggleStar={
              s ? () => invoke('set_starred', { sessionId: s.session_id, starred: !s.starred }).then(refresh) : undefined
            }
            onRename={
              s ? (name) => invoke('set_session_name', { sessionId: s.session_id, name }).then(refresh).catch(console.error) : undefined
            }
            collapsed={briefingCollapsed}
            onSetCollapsed={setBriefingC}
            panelJump={panelJump}
          />
        )
      })()}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(s, transcript) => { setHomeOverlay(false); resume(s, { transcript }) }}
        onOverlay={() => { setPaletteOpen(false); setHomeOverlay(true) }}
      />
      <NewSessionDialog
        open={newDialog}
        recents={recentDirs}
        onLaunch={(p) => newSession(p)}
        onClose={() => setNewDialog(false)}
      />
      {homeOverlay && (
        // full-window, above panes/find (z<90 artifact-expand, <100 quit guard);
        // own compositing layer so it's clickable over a terminal's WebGL canvas
        <div
          ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus() } }}
          tabIndex={-1}
          style={{ position: 'fixed', inset: 0, zIndex: 85, background: 'var(--dd-bg0)', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dd-hairline)', fontFamily: 'system-ui' }}>
            <span style={{ flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13 }}>Usage & recap log</span>
            <button
              onClick={() => setHomeOverlay(false)}
              title="Close (Esc)"
              style={{ background: 'none', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-sm)', cursor: 'pointer', color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '2px 6px' }}
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
      {/* After the home overlay: same z, later in DOM — settings wins if both
          ever mount (the keydown guards make that unreachable today). */}
      <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {confirmClose !== null && (
        <ConfirmCloseDialog
          tab={tabs.find((x) => x.id === confirmClose)}
          session={(() => {
            const t = tabs.find((x) => x.id === confirmClose)
            return t?.sessionId ? sessions.find((x) => x.session_id === t.sessionId) : undefined
          })()}
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => { closeTab(confirmClose); setConfirmClose(null) }}
        />
      )}
      {quitGuard && (
        <QuitGuardDialog
          busyCount={tabs.filter((t) => interruptsWork([t], sessions)).length}
          onCancel={() => setQuitGuard(false)}
          onQuitAnyway={() => invoke('force_quit')}
        />
      )}
      {takeover && (
        <TakeoverDialog
          state={takeover}
          onCancel={() => setTakeover(null)}
          onConfirm={confirmTakeover}
        />
      )}
      {chipDrag && (
        // drag ghost: pointer-tracked chip label (no native drag image in Tauri)
        <div
          style={{
            position: 'fixed', left: dragXY.x + 10, top: dragXY.y + 12, zIndex: 95, pointerEvents: 'none',
            background: 'var(--dd-border)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '3px 8px',
            color: 'var(--dd-text1)', fontFamily: 'system-ui', fontSize: 12, whiteSpace: 'nowrap',
          }}
        >
          {clip(chipDrag.label, 30)}
        </div>
      )}
      {chipMenu && (() => {
        // Split items act on the FOCUSED pane. A pane can't split with its
        // own tab (a tab's content mounts exactly once) — so on the focused
        // tab's chip they split with the previously viewed tab instead, and
        // the label names it so the outcome is never a surprise.
        // Gate against the REAL tree: while zoomed, geom shows one full-stage
        // pane, but the split executes on the underlying layout — validating
        // the zoomed rect would wave through sub-minimum sliver panes.
        const focusedRect = layout !== null
          ? (stageBox ? layoutRects(layout, stageBox).panes.find((p) => p.tabId === activeId)?.rect : undefined)
          : stageBox
        const self = chipMenu.tabId === activeId
        const partnerId = self
          ? mruRef.current.find((x) => x !== activeId && tabs.some((t) => t.id === x))
            ?? tabs.find((t) => t.id !== activeId)?.id ?? null
          : chipMenu.tabId
        const partner = tabs.find((t) => t.id === partnerId)
        const partnerLabel = partner
          ? partner.terminal
            ? (shellDirs[partner.id] ? baseName(shellDirs[partner.id]) : 'shell')
            : (() => {
                const s = partner.sessionId ? sessions.find((x) => x.session_id === partner.sessionId) : undefined
                return s ? sessionLabel(s) : partner.title
              })()
          : null
        const usable = (edge: Edge) => activeId !== null && partnerId !== null && !!focusedRect && canSplit(focusedRect, edge)
        const splitTip = activeId === null
          ? 'nothing on stage to split against'
          : partnerId === null
            ? 'no other tab to place beside this one'
            : 'window too small to split'
        const splitLabel = (dir: string) => (self && partnerLabel ? `Split ${dir} with “${clip(partnerLabel, 18)}”` : `Split ${dir}`)
        const inSplit = layout !== null && staged.includes(chipMenu.tabId)
        const item = (label: string, enabled: boolean, run: () => void, tip?: string) => (
          <div
            key={label}
            onClick={enabled ? run : undefined}
            title={enabled ? undefined : tip}
            style={{
              padding: '5px 12px', fontSize: 12, borderRadius: 'var(--dd-r-sm)', whiteSpace: 'nowrap',
              color: enabled ? 'var(--dd-text1)' : 'var(--dd-dim)', cursor: enabled ? 'pointer' : 'default',
            }}
            onPointerEnter={(e) => { if (enabled) (e.currentTarget as HTMLElement).style.background = 'var(--dd-border)' }}
            onPointerLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {label}
          </div>
        )
        return (
          <div
            data-chipmenu="1"
            style={{
              position: 'fixed', left: chipMenu.x, top: chipMenu.y, zIndex: 95,
              background: 'var(--dd-surface2)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: 4,
              fontFamily: 'system-ui', boxShadow: '0 6px 20px rgba(0,0,0,.45)',
            }}
          >
            {item(splitLabel('right'), usable('right'), () => splitFromMenu(partnerId!, 'right'), splitTip)}
            {item(splitLabel('down'), usable('bottom'), () => splitFromMenu(partnerId!, 'bottom'), splitTip)}
            {inSplit && item(zoomOn && self ? 'Restore split (⇧⌘⏎)' : 'Zoom pane (⇧⌘⏎)', true, () => {
              setChipMenu(null)
              setStage((st) => showTab(st, chipMenu.tabId))
              toggleZoomRef.current(chipMenu.tabId)
            })}
            {inSplit && item('Remove from split', true, () => {
              // the pane leaves the stage; the TAB survives in the deck
              // (✕ / Close tab is the one that kills it)
              setChipMenu(null)
              setStage((st) => closeStaged(st, chipMenu.tabId).stage)
            })}
            {item('Close tab', true, () => { setChipMenu(null); requestCloseTab(chipMenu.tabId) })}
          </div>
        )
      })()}
    </div>
  )
}
