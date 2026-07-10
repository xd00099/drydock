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
import type { Artifact, ArtifactKind, PaneSearch, RestoreTab, SessionView, Tab, TakeoverInfo } from './types'
import { baseName, clip, sessionColor, sessionLabel, uuidv4 } from './types'
import {
  GUTTER, canSplit, clampRatio, closeStaged, dropOnStage, focusNeighbor, hitTest,
  layoutRects, pruneStage, setRatio, showTab, stagedIds,
} from './split'
import type { DividerRect, DropTarget, Edge, Rect, Stage } from './split'

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
  const homeOverlayRef = useRef(homeOverlay)
  homeOverlayRef.current = homeOverlay
  const newShellRef = useRef(() => {})
  const closeActiveRef = useRef(() => {})
  const starActiveRef = useRef(() => {})
  const openFindRef = useRef(() => {})
  const goHomeRef = useRef(() => {})
  const toggleTranscriptRef = useRef(() => {})
  const focusNavRef = useRef((_key: string) => {}) // ⌘⌥ arrows: move pane focus

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
  }, [stagedKey])

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

  // Chip drag (pointer events — HTML5 DnD is swallowed by Tauri's webview,
  // same as the sidebar's drag). Within the tab bar it reorders; over the
  // stage it shows a hint frame and drops into a split.
  type ChipDrop = { kind: 'bar'; beforeId: number | null } | { kind: 'stage'; target: DropTarget }
  const [chipDrag, setChipDrag] = useState<{ tabId: number; label: string } | null>(null)
  const [dragXY, setDragXY] = useState({ x: 0, y: 0 })
  const [stageHit, setStageHit] = useState<{ target: DropTarget; hint: Rect } | null>(null)
  const [insertMark, setInsertMark] = useState<{ beforeId: number | null } | null>(null)
  const dropRef = useRef<ChipDrop | null>(null) // current target — read at pointerup
  const suppressClickRef = useRef(false) // a completed drag must not fire the chip's click

  const updateDragTarget = (tabId: number, x: number, y: number) => {
    // over the tab bar → reorder within the tab's own lane
    const laneEl = document.elementFromPoint(x, y)?.closest('[data-lane]')
    if (laneEl) {
      const dragged = tabsRef.current.find((t) => t.id === tabId)
      if (laneEl.getAttribute('data-lane') === (dragged?.terminal ? 't' : 's')) {
        let before: number | null = null
        for (const c of laneEl.querySelectorAll('[data-tabchip]')) {
          const r = c.getBoundingClientRect()
          if (x < r.left + r.width / 2) { before = Number(c.getAttribute('data-tabchip')); break }
        }
        setInsertMark({ beforeId: before })
        setStageHit(null)
        dropRef.current = { kind: 'bar', beforeId: before }
        return
      }
      setInsertMark(null); setStageHit(null); dropRef.current = null
      return
    }
    // over the stage → split/replace target with a hint frame
    const c = contentRef.current
    const cr = c?.getBoundingClientRect()
    if (c && cr) {
      const box: Rect = { x: 8, y: 8, w: Math.max(0, cr.width - 16), h: Math.max(0, cr.height - 16) }
      const st = stageRef.current
      const panes = st.layout !== null
        ? layoutRects(st.layout, box).panes
        : st.active !== null ? [{ tabId: st.active, rect: box }] : []
      const hit = hitTest(box, panes, x - cr.left, y - cr.top, tabId)
      setStageHit(hit)
      setInsertMark(null)
      dropRef.current = hit ? { kind: 'stage', target: hit.target } : null
      return
    }
    setInsertMark(null); setStageHit(null); dropRef.current = null
  }

  const performChipDrop = (tabId: number, drop: ChipDrop) => {
    if (drop.kind === 'bar') {
      if (drop.beforeId === tabId) return
      setTabs((p) => {
        const moved = p.find((t) => t.id === tabId)
        if (!moved) return p
        const rest = p.filter((t) => t.id !== tabId)
        let idx = drop.beforeId === null ? rest.length : rest.findIndex((t) => t.id === drop.beforeId)
        if (idx < 0) idx = rest.length
        rest.splice(idx, 0, moved)
        return rest
      })
      return
    }
    // the tab may have died mid-gesture (⌘W closes the dragged tab; the drag
    // survives) — dropping a dead id would plant a leaf no pane renders into
    if (!tabsRef.current.some((t) => t.id === tabId)) return
    promote(tabId) // landing on stage is deliberate — a preview tab becomes permanent
    setStage((st) => dropOnStage(st, tabId, drop.target))
  }

  /** Arm a chip drag. A plain click stays a click — the drag only starts once
   *  the pointer travels 5px. Esc or window blur cancels. */
  const beginChipDrag = (e: React.PointerEvent, tabId: number, label: string) => {
    if (e.button !== 0) return
    // Cancel the pointerdown default: otherwise WebKit anchors a text
    // selection at the chip and paints it across the whole app as the drag
    // travels (the chip's own userSelect:none only covers its label).
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let live = false
    const move = (ev: PointerEvent) => {
      if (!live && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) {
        live = true
        chipDragLiveRef.current = true
        setChipDrag({ tabId, label })
        setZoomTab(null) // drops target the real split — reveal it first
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      if (!live) return
      setDragXY({ x: ev.clientX, y: ev.clientY })
      updateDragTarget(tabId, ev.clientX, ev.clientY)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', cancel)
      if (!live) return
      chipDragLiveRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const drop = dropRef.current
      dropRef.current = null
      setChipDrag(null)
      setStageHit(null)
      setInsertMark(null)
      if (commit) {
        // the chip's click dispatches right after this pointerup, before any
        // timer — flag-now, clear-on-next-task suppresses exactly that click
        suppressClickRef.current = true
        window.setTimeout(() => { suppressClickRef.current = false }, 0)
        if (drop) performChipDrop(tabId, drop)
        return
      }
      // Cancelled (Esc/blur) with the button still DOWN: the release — and its
      // click — haven't happened yet, so arm a one-shot suppressor for that
      // release. A new pointerdown disarms it first (the old release must have
      // landed outside the window), so it can't eat a later legitimate click.
      const onUp = () => {
        suppressClickRef.current = true
        window.setTimeout(() => { suppressClickRef.current = false }, 0)
        disarm()
      }
      const onDown = () => disarm()
      const disarm = () => {
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointerdown', onDown, true)
      }
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointerdown', onDown, true)
    }
    const up = () => finish(true)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false) }
    const cancel = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', cancel)
  }

  /** Divider drag: live ratio updates, clamped so both sides stay usable. */
  // Two quick fine-tune nudges land inside the OS double-click slop, and the
  // second release synthesizes a dblclick on the divider — which would snap
  // the just-set ratio back to 50/50. A drag release suppresses dblclick for
  // one slop window; a clean double-CLICK (no movement) still evens out.
  const dividerDraggedRef = useRef(false)
  const beginDividerDrag = (e: React.PointerEvent, d: DividerRect) => {
    if (e.button !== 0) return
    e.preventDefault()
    const cr = contentRef.current?.getBoundingClientRect()
    if (!cr) return
    const horiz = d.dir === 'row'
    const start = horiz ? d.box.x : d.box.y
    const avail = (horiz ? d.box.w : d.box.h) - GUTTER
    if (avail <= 0) return
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true
      const pos = (horiz ? ev.clientX - cr.left : ev.clientY - cr.top) - start - GUTTER / 2
      const ratio = clampRatio(pos / avail, avail, d.dir)
      setStage((st) => (st.layout !== null ? { ...st, layout: setRatio(st.layout, d.path, ratio) } : st))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (moved) {
        dividerDraggedRef.current = true
        window.setTimeout(() => { dividerDraggedRef.current = false }, 500)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // window deactivation mid-drag would strand the cursor/user-select
    // overrides (same rationale as the chip drag's blur cancel)
    window.addEventListener('blur', up)
  }

  // Right-click a chip: split without the drag (drag-only gestures are
  // invisible until discovered). "Split right/down" puts THAT tab beside the
  // focused pane.
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; tabId: number } | null>(null)
  // Keyboard shortcuts (⌘W, ⌘0, ⇧⌘⏎, ⌘⌥ arrows) can reshape the stage under
  // an open menu — its items would shift or change meaning beneath a click
  // already in flight. A reshaped stage closes the menu.
  useEffect(() => { setChipMenu(null) }, [layout, activeId, zoomTab])
  useEffect(() => {
    if (!chipMenu) return
    const close = () => setChipMenu(null)
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-chipmenu]')) close()
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onEsc)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [chipMenu])

  const splitFromMenu = (tabId: number, edge: Edge) => {
    setChipMenu(null)
    // the menu's tab can die under it (⌘W while it's open) — same dead-id
    // hazard as performChipDrop
    if (!tabsRef.current.some((t) => t.id === tabId)) return
    promote(tabId)
    setStage((st) => {
      if (st.active === null) return showTab(st, tabId)
      return dropOnStage(st, tabId, { kind: 'pane', tabId: st.active, zone: edge })
    })
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
      // Take-over dialog: same modal contract as the quit guard (Esc cancels
      // unless the kill is already in flight; shortcuts must not act behind it)
      if (takeoverRef.current) {
        if (e.key === 'Escape' && !takeoverRef.current.killing) setTakeover(null)
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
      // ⇧⌘Return: zoom toggle — the focused pane fills the stage, the split
      // waits beneath (the palette owns Enter while it's open)
      if (!paletteOpenRef.current && e.metaKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        const a = stageRef.current.active
        if (a !== null) toggleZoomRef.current(a)
      }
      // ⌘⌥ arrows: move focus between split panes. The palette guard above
      // only swallows its listed keys, so re-check here — arrows while the
      // palette is open belong to the palette.
      if (
        !paletteOpenRef.current &&
        e.metaKey && e.altKey &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        e.preventDefault()
        focusNavRef.current(e.key)
      }
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
        // staged, not just active: any pane the user can SEE (split screen)
        if (document.hasFocus() && visibleRef.current.includes(p.pty_id)) return
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
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#10141a' }}>
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
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* In-flow (not fixed at a guessed sidebar offset): it always spans
            exactly the main column at any sidebar width or collapse state. */}
        {claudeVersion === null && (
          <div style={{ background: '#5a3030', color: '#f0d0d0', padding: '4px 12px', fontFamily: 'system-ui', fontSize: 12 }}>
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
          onClose={closeTab}
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
            // session is blocked on you. Single-pane mode keeps today's
            // frameless inset exactly.
            const attn = t.id !== activeId && sess?.live_status === 'needs_input'
            // Zoomed: staged panes without a rect stay mounted but hidden —
            // same display:none contract as unstaged tabs.
            const shown = onStage && (layout === null || r !== undefined)
            return (
              <div
                key={t.id}
                data-pane={t.id}
                data-staged={onStage ? '1' : '0'}
                data-focused={t.id === activeId ? '1' : undefined}
                className={r && attn ? 'dd-attnpane' : undefined}
                onPointerDownCapture={
                  r ? () => setStage((st) => (st.active !== t.id && stagedIds(st).includes(t.id) ? { ...st, active: t.id } : st)) : undefined
                }
                style={
                  r
                    ? {
                        position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h,
                        boxSizing: 'border-box', display: 'block', overflow: 'hidden', borderRadius: 4,
                        // Session-color chrome: the frame plus a thin tinted
                        // mat wear the session's color so panes read as THEIR
                        // session at a glance; shells keep the neutral steel.
                        // Focus = full-strength border; the attn pulse
                        // overrides border-color via the dd-attnpane animation.
                        padding: 3,
                        border: `2px solid ${
                          t.sessionId
                            ? sessionColor(t.sessionId, t.id === activeId ? 1 : 0.45, sess?.hue)
                            : t.id === activeId ? '#3d5878' : '#232c3a'
                        }`,
                        background: t.sessionId
                          ? sessionColor(t.sessionId, t.id === activeId ? 0.12 : 0.06, sess?.hue)
                          : '#10141a',
                      }
                    : { position: 'absolute', inset: 8, display: shown ? 'block' : 'none' }
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
        // z-110 (above the takeover dialog's 100): a quit requested mid-takeover
        // must sit on top, matching the keydown handler's quit-guard-first order.
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110, transform: 'translateZ(0)' }}>
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
      {takeover && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, transform: 'translateZ(0)' }}>
          <div style={{ background: '#161c25', color: '#e8edf4', padding: 20, borderRadius: 8, fontFamily: 'system-ui', fontSize: 13, maxWidth: 440 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Take over this session?</div>
            {!takeover.located ? (
              <div style={{ color: '#9aa3af', marginBottom: 12 }}>locating the process…</div>
            ) : takeover.info ? (
              <div style={{ marginBottom: 12, lineHeight: 1.6 }}>
                <div>
                  Stops <span style={{ fontFamily: 'Menlo, monospace', fontSize: 12 }}>claude</span> (pid {takeover.info.pid}) in{' '}
                  <b>{takeover.info.app ?? 'another terminal'}</b>
                  {takeover.info.tty ? <span style={{ color: '#9aa3af' }}> · {takeover.info.tty}</span> : null}
                  {takeover.info.cwd ? <span style={{ color: '#9aa3af' }}> — {clip(takeover.info.cwd, 44)}</span> : null}
                  , then resumes the session here.
                </div>
                {takeover.info.status === 'busy' && (
                  <div style={{ color: '#e8a33d', marginTop: 6 }}>
                    Mid-task right now — the in-flight turn will be lost. Everything already in the transcript survives.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: '#9aa3af', marginBottom: 12 }}>
                The process is already gone — the session just hasn't settled to "ended" yet. Resume it directly.
              </div>
            )}
            {takeover.err && <div style={{ color: '#cf6b6b', marginBottom: 10 }}>{takeover.err}</div>}
            <button
              style={{ background: takeover.info ? '#7a2e2e' : '#2e4a7a', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 5, cursor: takeover.located && !takeover.killing ? 'pointer' : 'default', fontSize: 12, marginRight: 8, opacity: takeover.located && !takeover.killing ? 1 : 0.6 }}
              disabled={!takeover.located || takeover.killing}
              onClick={confirmTakeover}
            >
              {takeover.killing ? 'Taking over…' : takeover.info ? 'Take over' : 'Resume here'}
            </button>
            <button
              style={{ background: '#1d2530', color: '#e8edf4', border: '1px solid #2c3647', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
              disabled={takeover.killing}
              onClick={() => setTakeover(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {chipDrag && (
        // drag ghost: pointer-tracked chip label (no native drag image in Tauri)
        <div
          style={{
            position: 'fixed', left: dragXY.x + 10, top: dragXY.y + 12, zIndex: 95, pointerEvents: 'none',
            background: '#1d2530', border: '1px solid #2c3647', borderRadius: 5, padding: '3px 8px',
            color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 12, whiteSpace: 'nowrap',
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
              padding: '5px 12px', fontSize: 12, borderRadius: 4, whiteSpace: 'nowrap',
              color: enabled ? '#c8cdd5' : '#5b6675', cursor: enabled ? 'pointer' : 'default',
            }}
            onPointerEnter={(e) => { if (enabled) (e.currentTarget as HTMLElement).style.background = '#1d2530' }}
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
              background: '#161c25', border: '1px solid #2c3647', borderRadius: 6, padding: 4,
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
            {item('Close tab', true, () => { setChipMenu(null); closeTab(chipMenu.tabId) })}
          </div>
        )
      })()}
    </div>
  )
}
