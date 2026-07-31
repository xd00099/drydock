import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { FolderView, SessionView } from '@/lib/types'
import { ageTone, clampPanelWidth, clip, loadNum, projectColor, relAge, sessionAutoLabel, sessionLabel, shortPath, uuidv4 } from '@/lib/types'
import ResizeHandle from '@/components/ui/ResizeHandle'
import { IconButton } from '@/components/ui'
import { Button } from '@/components/ui'
import Modal, { ModalActions, ModalBody, ModalTitle } from '@/app/dialogs/Modal'
import cls from './Sidebar.module.css'
import LiveIndicator from '@/features/session/LiveIndicator'
import VersionFooter from '@/features/session/VersionFooter'
import { useChord } from '@/lib/keymap'
import { STARRED_KEY, byRecency, capGroup, folderKey, groupSessions, isVisible, loadSet, triage } from './grouping'

type Props = {
  onHome: () => void // show the Home view (recap log + usage) in the center
  sessions: SessionView[]
  folders: FolderView[] // user folders, in band order
  hidden: string[] // session ids the user hid from Drydock
  activeSessionId: string | null // session shown in the active tab — highlighted in the list
  onResume: (s: SessionView) => void
  onTranscript: (s: SessionView) => void // open the read-only transcript (never spawns claude)
  onTakeover: (s: SessionView) => void // stop a live-elsewhere session's process + resume it here
  onNewSession: (projectPath: string) => void
  onToggleStar: (s: SessionView) => void
  onHide: (sessionId: string, hide: boolean) => void
  onDelete: (sessionId: string) => void
  onRefresh: () => void // re-pull the snapshot after a folder mutation
  updateBusyCount: number // claude tabs mid-turn — gates the update restart
  onRestartForUpdate: () => Promise<void> // stash tabs + relaunch (App owns tabs)
  collapsed: boolean // lifted to App so ⌘B can drive it
  onSetCollapsed: (c: boolean) => void
  onOpenSettings: () => void // footer gear — same surface as ⌘,
}


// The strongest live status across a (collapsed) group's sessions. Ordered by
// how much it wants the user, not by how active it is: 'done' outranks 'busy'
// because a finished turn is something to go look at and a running one isn't.
// (A session is never both — 'done' only ever replaces 'idle'.)
//
// Since triage lifts every needs_input/busy/done session into its own section
// at the top, groups now only ever contain idle and ended sessions, so in
// practice this returns 'idle' or null. The first three arms are kept because
// the function should stay total: it answers "what is the strongest status in
// this list", and it is the caller's business which lists it gets asked about.
function groupStatus(list: SessionView[]): SessionView['live_status'] | null {
  if (list.some((s) => s.live_status === 'needs_input')) return 'needs_input'
  if (list.some((s) => s.live_status === 'done')) return 'done'
  if (list.some((s) => s.live_status === 'busy')) return 'busy'
  if (list.some((s) => s.live_status === 'idle')) return 'idle'
  return null
}

// The one crisp glyph distinguishing user folders from auto project groups.
const FolderGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" style={{ flex: 'none' }} aria-hidden>
    <path d="M1.5 3.5h4.2l1.6 2h7.2v7h-13z" fill="none" stroke="var(--dd-accent)" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)

// Same folder, with a plus: the always-visible "New folder" affordance.
const NewFolderGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <path d="M1.5 3.5h4.2l1.6 2h7.2v7h-13z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M8 7.9v4.2M5.9 10h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

// A live drag: a session heading for a folder, or a folder being reordered.
type Drag =
  | { kind: 'session'; sid: string; label: string; fromFolder: string | null }
  | { kind: 'folder'; id: string; name: string }

// Inline name editor state: creating a folder (optionally filing a dragged
// session into it on commit), renaming a folder, or renaming a session
// (a Drydock-side override — the ~/.claude transcript is never written).
type Naming =
  | { kind: 'create'; sid: string | null }
  | { kind: 'rename'; id: string }
  // `initial` = the label shown when editing began: an unchanged commit (e.g.
  // click-away blur) must be a no-op, not freeze an AUTO title into an override
  | { kind: 'rename-session'; sid: string; initial: string }

export default function Sidebar({ onHome, sessions, folders, hidden, activeSessionId, onResume, onTranscript, onTakeover, onNewSession, onToggleStar, onHide, onDelete, onRefresh, updateBusyCount, onRestartForUpdate, collapsed, onSetCollapsed, onOpenSettings }: Props) {
  const sidebarChord = useChord('sidebar.toggle')
  const homeChord = useChord('home.show')
  const transcriptChord = useChord('transcript.toggle')
  const searchChord = useChord('palette.toggle')
  // clamp on load AND on window resize: a width persisted on a big monitor must
  // not overflow a smaller window later
  const [width, setWidth] = useState(() => clampPanelWidth(loadNum('dd.sidebarWidth', 300)))
  const widthRef = useRef(width)
  widthRef.current = width
  useEffect(() => {
    const reclamp = () => setWidth((w) => clampPanelWidth(w))
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [])
  const [closed, setClosed] = useState<Set<string>>(() => loadSet('dd.closedGroups'))
  // project groups the user opened past the five-row cap (separate key from
  // dd.closedGroups: "expanded" and "collapsed" are independent states — a
  // group can be collapsed while still remembering it was expanded)
  const [expanded, setExpanded] = useState<Set<string>>(() => loadSet('dd.expandedGroups'))
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionView; view: 'main' | 'folders' } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; f: FolderView; index: number } | null>(null)
  const [confirmDel, setConfirmDel] = useState<SessionView | null>(null)
  const [confirmDelFolder, setConfirmDelFolder] = useState<{ f: FolderView; count: number } | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)
  // Controlled editor text: the sidebar re-sorts on every index tick, and a
  // moved/remounted <input defaultValue> would lose what the user typed —
  // state survives the move (autoFocus re-fires on remount).
  const [draft, setDraft] = useState('')

  // ---- drag state (pointer events; HTML5 DnD is swallowed by Tauri's
  // webview drag-drop handling, and its native drag image can't be styled) ----
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dragXY, setDragXY] = useState({ x: 0, y: 0 })
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [flashSid, setFlashSid] = useState<string | null>(null)
  const xyRef = useRef({ x: 0, y: 0 })
  const dragRef = useRef<Drag | null>(null) // the live drag, for handlers outside beginPress's closure
  const dropRef = useRef<string | null>(null) // current drop target — read at pointerup
  const suppressClickRef = useRef(false) // a completed drag must not fire the row's click
  const scrollerRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef(0)
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  /** Recompute the drop target from the pointer position. DOM-driven (data
   *  attributes + elementFromPoint), so both the pointermove handler and the
   *  auto-scroll tick — which moves rows under a PARKED pointer — share it. */
  const updateTarget = (d: Drag, x: number, y: number) => {
    let target: string | null = null
    if (d.kind === 'session') {
      const el = document.elementFromPoint(x, y)
      target = el?.closest('[data-drop]')?.getAttribute('data-drop') ?? null
    } else {
      // reorder: insertion index from folder-header midpoints
      const heads = scrollerRef.current?.querySelectorAll('[data-fhead]') ?? []
      let gap = heads.length
      for (let i = 0; i < heads.length; i++) {
        const r = heads[i].getBoundingClientRect()
        if (y < r.top + r.height / 2) { gap = i; break }
      }
      target = `gap:${gap}`
    }
    dropRef.current = target
    setDropTarget(target)
  }

  useEffect(() => {
    if (!menu && !folderMenu) return
    const close = () => { setMenu(null); setFolderMenu(null) }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onEsc)
    window.addEventListener('resize', close)
    // capture-phase: the menu is position:fixed, so any scroll underneath (the
    // sidebar list is an inner scroller) would visually detach it from its row
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu, folderMenu])

  // Edge auto-scroll while a drag is live (pointermove stops firing when the
  // pointer parks at the edge, so this needs its own clock). Only while the
  // pointer is horizontally over the sidebar, and rows moving under a parked
  // pointer re-run the hit test so the drop lands where the eye says it will.
  useEffect(() => {
    if (!drag) return
    let raf = 0
    const tick = () => {
      const sc = scrollerRef.current
      if (sc) {
        const r = sc.getBoundingClientRect()
        const { x, y } = xyRef.current
        if (x >= r.left && x <= r.right + 40) {
          const before = sc.scrollTop
          if (y < r.top + 28) sc.scrollTop -= Math.min(14, (r.top + 28 - y) / 2)
          else if (y > r.bottom - 28) sc.scrollTop += Math.min(14, (y - (r.bottom - 28)) / 2)
          if (sc.scrollTop !== before && dragRef.current) updateTarget(dragRef.current, x, y)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [drag])

  const toggleGroup = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      localStorage.setItem('dd.closedGroups', JSON.stringify([...next]))
      return next
    })

  const toggleExpanded = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      localStorage.setItem('dd.expandedGroups', JSON.stringify([...next]))
      return next
    })

  const landFlash = (sid: string) => {
    clearTimeout(flashTimer.current)
    setFlashSid(sid)
    flashTimer.current = window.setTimeout(() => setFlashSid(null), 700)
  }

  const fileSession = (sid: string, folderId: string | null) =>
    invoke('set_session_folder', { sessionId: sid, folderId })
      .then(() => {
        if (folderId) {
          landFlash(sid)
          // make the landing visible: a collapsed target opens on drop
          if (closed.has(folderKey(folderId))) toggleGroup(folderKey(folderId))
        }
        onRefresh()
      })
      .catch(console.error)

  const reorder = (ids: string[]) => invoke('reorder_folders', { ids }).then(onRefresh).catch(console.error)

  const performDrop = (d: Drag, target: string | null) => {
    if (!target) return
    if (d.kind === 'session') {
      if (target === 'newfolder') { setDraft(''); setNaming({ kind: 'create', sid: d.sid }); return }
      if (target.startsWith('folder:')) fileSession(d.sid, target.slice('folder:'.length))
      return
    }
    // folder reorder: target is 'gap:<insertion index>'
    const gap = Number(target.slice('gap:'.length))
    const from = folders.findIndex((f) => f.id === d.id)
    if (from < 0 || Number.isNaN(gap)) return
    const ids = folders.map((f) => f.id)
    ids.splice(from, 1)
    ids.splice(gap > from ? gap - 1 : gap, 0, d.id)
    reorder(ids)
  }

  /** Arm a potential drag. Nothing happens for a plain click — the drag only
   *  starts once the pointer travels 5px, so click-to-resume and click-to-
   *  collapse stay untouched. Esc, window blur, or dropping on nothing cancel. */
  const beginPress = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let live = false
    const move = (ev: PointerEvent) => {
      if (!live && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        live = true
        dragRef.current = d
        setDrag(d)
        document.body.style.cursor = 'grabbing'
      }
      if (!live) return
      xyRef.current = { x: ev.clientX, y: ev.clientY }
      setDragXY({ x: ev.clientX, y: ev.clientY })
      updateTarget(d, ev.clientX, ev.clientY)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', cancel)
      if (!live) return
      // Swallow only the click this drag synthesizes: if the pointer released
      // over a different element, no click fires on the origin row — the flag
      // must not lie in wait for the user's NEXT legitimate click.
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
      document.body.style.cursor = ''
      const target = dropRef.current
      dragRef.current = null
      dropRef.current = null
      setDrag(null)
      setDropTarget(null)
      if (commit) performDrop(d, target)
    }
    const up = () => finish(true)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false) }
    const cancel = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', cancel)
  }

  /** Swallows the click that follows a completed drag. */
  const dragSafe = (fn: () => void) => () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    fn()
  }

  if (collapsed) {
    return (
      <div className={cls.rail}>
        <button className={cls.btn} style={{ fontSize: 15 }} title={`Expand sidebar (${sidebarChord})`} onClick={() => onSetCollapsed(false)}>»</button>
      </div>
    )
  }

  const hiddenSet = new Set(hidden)
  const folderIds = new Set(folders.map((f) => f.id))
  // Triage runs FIRST, so everything downstream sees only the sessions that
  // aren't already accounted for at the top. That keeps the invariant the
  // placement rule has always had: a visible session appears in exactly once.
  const { needs, active, rest } = triage(sessions.filter((s) => isVisible(s, hiddenSet, showHidden)))
  const starred = rest.filter((s) => s.starred).sort(byRecency)
  // Folder members. Starred wins placement (same rule as project groups —
  // membership is kept invisibly and the session returns here on unstar).
  const filed = new Map<string, SessionView[]>()
  for (const s of rest) {
    if (!s.folder_id || !folderIds.has(s.folder_id) || s.starred) continue
    const list = filed.get(s.folder_id) ?? []
    list.push(s)
    filed.set(s.folder_id, list)
  }
  filed.forEach((list) => list.sort(byRecency))
  const groups = groupSessions(rest, hiddenSet, showHidden, folderIds)

  // One session row, shared by Starred, folders and project groups.
  const sessionRow = (s: SessionView, showProject: boolean) => {
    const isHidden = hiddenSet.has(s.session_id)
    const isActive = s.session_id === activeSessionId // session shown in the active tab
    const isDragging = drag?.kind === 'session' && drag.sid === s.session_id
    const wants = s.live_status === 'needs_input' || s.live_status === 'busy' || s.live_status === 'done'
    const sub = showProject ? shortPath(s.project_path) : s.latest_recap
    const inFolder = s.folder_id && folderIds.has(s.folder_id) ? folders.find((f) => f.id === s.folder_id)?.name : null
    // Renaming: swap the row for the inline editor (a div, not the row button
    // — an input nested in a button fights it for focus and clicks).
    if (naming?.kind === 'rename-session' && naming.sid === s.session_id) {
      return (
        <div
          key={s.session_id}
          className={cls.row} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'default', boxShadow: `inset 3px 0 0 ${projectColor(s.project_path)}`, background: 'var(--dd-tint-active)' }}
        >
          <LiveIndicator status={s.live_status} />
          {nameEditor('Session name — empty clears')}
        </div>
      )
    }
    // Tooltip discloses a Drydock rename so a divergent claude-side /rename
    // later reads as deliberate, not as an index bug. The disclosed title is
    // exactly what "Clear name" would restore.
    const renamed = s.name && s.name.trim()
      ? `\nrenamed in Drydock — auto title: ${sessionAutoLabel(s)}`
      : ''
    return (
      <button
        key={s.session_id}
        className={`${cls.row} dd-sessrow${flashSid === s.session_id ? ' dd-landed' : ''}`}
        // marks the selected row so the hover rule keeps its stronger fill
        data-active={isActive ? '1' : undefined}
        // No per-row tint. The old 10%-alpha wash was ~100x the stripe's area
        // carrying a difference of CIEDE2000 2.60 between adjacent rows — below
        // the 2.3 just-noticeable difference for 7 of 15 neighbouring pairs, so
        // it cost the whole background of the list and told you nothing. The
        // selected row gets a neutral fill instead, which is a distinction you
        // can actually see.
        style={{ opacity: isDragging ? 0.4 : isHidden ? 0.45 : 1, boxShadow: `inset 3px 0 0 ${projectColor(s.project_path)}`, background: isActive ? 'var(--dd-tint-active)' : 'transparent' }}
        onClick={dragSafe(() => onResume(s))}
        onPointerDown={(e) => beginPress(e, { kind: 'session', sid: s.session_id, label: sessionLabel(s), fromFolder: s.folder_id })}
        onContextMenu={(e) => { e.preventDefault(); if (dragRef.current) return; setMenu({ x: e.clientX, y: e.clientY, s, view: 'main' }) }}
        title={`${s.attention ? `⚠ ${s.attention}\n` : ''}${s.title}${renamed}${s.starred && inFolder ? `\nin folder “${inFolder}”` : ''}\n${s.session_id}\n(right-click for options · drag into a folder)`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <LiveIndicator status={s.live_status} />
          {/* age dims a row, but state overrules age: a session blocked on you
              reads at full strength even if it has been waiting a month — the
              reason it is on screen has nothing to do with when it last ran */}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: wants ? 'var(--dd-text)' : ageTone(s.last_message_at) }}>
            {sessionLabel(s)}
          </span>
          {/* hover-only: read without resuming (a plain click SPAWNS claude for
              ended sessions — this is the safe browse path). span, not button:
              a button can't nest inside the row button. */}
          <span
            className="dd-rowbtn"
            role="button"
            title={`Read transcript (read-only) — never resumes\n${transcriptChord} toggles it for the active session`}
            onClick={(e) => { e.stopPropagation(); dragSafe(() => onTranscript(s))() }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ flexShrink: 0, color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '0 2px' }}
          >
            ≣
          </span>
          <span style={{ flexShrink: 0, marginLeft: 2, color: 'var(--dd-dim)' }}>{relAge(s.last_message_at)}</span>
        </div>
        {sub && (
          <div style={{ color: 'var(--dd-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {sub}
          </div>
        )}
      </button>
    )
  }

  // Inline name editor (folder create/rename, session rename).
  const nameEditor = (placeholder = 'Folder name') => (
    <input
      className={cls.nameInput}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      maxLength={60}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        // an Enter/Esc that confirms an IME composition (e.g. pinyin) is part
        // of TYPING the name, not a commit/cancel of the editor
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') commitName(e.currentTarget.value)
        else if (e.key === 'Escape') setNaming(null)
      }}
      onBlur={(e) => commitName(e.currentTarget.value)}
    />
  )

  const commitName = (value: string) => {
    if (!naming) return
    const name = value.trim()
    const n = naming
    setNaming(null)
    if (n.kind === 'rename-session') {
      // unchanged = no-op; EMPTY is meaningful here (clears the override)
      if (name === n.initial.trim()) return
      invoke('set_session_name', { sessionId: n.sid, name }).then(onRefresh).catch(console.error)
      return
    }
    if (!name) return // empty commit = cancel (matches Esc)
    if (n.kind === 'create') {
      invoke('create_folder', { folderId: uuidv4(), name, sessionId: n.sid })
        .then(() => { if (n.sid) landFlash(n.sid); onRefresh() })
        .catch(console.error)
    } else {
      invoke('rename_folder', { folderId: n.id, name }).then(onRefresh).catch(console.error)
    }
  }

  const deleteFolder = (f: FolderView) =>
    invoke('delete_folder', { folderId: f.id }).then(onRefresh).catch(console.error)

  // A folder block: header (chevron · glyph · name · count · rollup) + rows.
  // The wrapper carries data-drop so header, rows and the empty hint are all
  // one generous drop target; the session's current folder opts out.
  const folderBlock = (f: FolderView, i: number) => {
    const key = folderKey(f.id)
    const isClosed = closed.has(key)
    const members = filed.get(f.id) ?? []
    const droppable = drag?.kind === 'session' && drag.fromFolder !== f.id
    const targeted = dropTarget === `folder:${f.id}`
    const gapBefore = drag?.kind === 'folder' && dropTarget === `gap:${i}`
    const gapAfter = i === folders.length - 1 && drag?.kind === 'folder' && dropTarget === `gap:${folders.length}`
    const renaming = naming?.kind === 'rename' && naming.id === f.id
    return (
      <div key={f.id}>
        {gapBefore && <div style={{ height: 2, background: 'var(--dd-accent-strong)', margin: '0 8px', borderRadius: 1 }} />}
        <div
          data-drop={droppable ? `folder:${f.id}` : undefined}
          style={targeted ? { outline: '1px solid var(--dd-accent-strong)', outlineOffset: -1, background: 'var(--dd-well)', borderRadius: 4 } : undefined}
        >
          <div
            className={cls.head} style={{ opacity: drag?.kind === 'folder' && drag.id === f.id ? 0.4 : 1 }}
            data-fhead
            title={`${f.name}\n(right-click for options · drag to reorder)`}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input')) return
              beginPress(e, { kind: 'folder', id: f.id, name: f.name })
            }}
            onContextMenu={(e) => { e.preventDefault(); if (dragRef.current) return; setFolderMenu({ x: e.clientX, y: e.clientY, f, index: i }) }}
          >
            <button className={cls.chev} title={isClosed ? 'Expand folder' : 'Collapse folder'} onClick={() => toggleGroup(key)}>
              {isClosed ? '▸' : '▾'}
            </button>
            <FolderGlyph />
            {renaming ? (
              nameEditor()
            ) : (
              <span
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', color: 'var(--dd-text1)' }}
                onClick={dragSafe(() => toggleGroup(key))}
              >
                {f.name}
              </span>
            )}
            <span style={{ color: 'var(--dd-dim)' }}>{members.length}</span>
            {isClosed && <LiveIndicator status={groupStatus(members)} />}
          </div>
          {!isClosed && members.map((s) => sessionRow(s, true))}
          {!isClosed && members.length === 0 && (
            <div style={{ margin: '1px 10px 6px 26px', padding: '5px 8px', border: '1px dashed var(--dd-hover)', borderRadius: 'var(--dd-r-sm)', color: 'var(--dd-dim2)', fontSize: 11 }}>
              Drop sessions here
            </div>
          )}
        </div>
        {gapAfter && <div style={{ height: 2, background: 'var(--dd-accent-strong)', margin: '0 8px', borderRadius: 1 }} />}
      </div>
    )
  }

  const starredClosed = closed.has(STARRED_KEY)
  const showFolderBand = folders.length > 0 || naming?.kind === 'create' || drag?.kind === 'session'
  return (
    <div style={{ display: 'flex', height: '100%' }}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width, minWidth: width, background: 'var(--dd-bg0)' }}>
    <div ref={scrollerRef} className={cls.side} style={{ width: '100%', minWidth: 0, height: 'auto', flex: 1, borderRight: 'none' }}>
      <div className={cls.bar} data-tauri-drag-region>
        <span
          onClick={onHome}
          title={`Home — recap log & usage (${homeChord})`}
          style={{
            flex: 1,
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: '0.09em',
            color: 'var(--dd-text2)',
            cursor: 'pointer',
          }}
        >
          DRYDOCK
        </span>
        <IconButton
          label="New folder"
          title={'New folder…\nOrganize sessions into working groups — drag them in,\nor right-click a session → Move to folder'}
          onClick={() => {
            setDraft('')
            setNaming({ kind: 'create', sid: null })
            // the name input appears at the top of the folders band — make sure
            // it's on screen even when the list is scrolled deep
            if (scrollerRef.current) scrollerRef.current.scrollTop = 0
          }}
        >
          <NewFolderGlyph />
        </IconButton>
        <IconButton
          label="Collapse sidebar"
          title={`Collapse sidebar (${sidebarChord})`}
          onClick={() => onSetCollapsed(true)}
        >
          «
        </IconButton>
      </div>

      {/* Triage. Both sections only exist while they have something in them —
          empty chrome at the top of the list would cost exactly what the cap
          below is trying to buy back. */}
      {needs.length > 0 && (
        <div>
          <div className={cls.head} style={{ color: 'var(--dd-warn)' }} title="Blocked on you — a permission prompt or a question">
            <span style={{ flex: 1, letterSpacing: 0.3 }}>NEEDS YOU</span>
            <span style={{ color: 'var(--dd-warn)' }}>{needs.length}</span>
          </div>
          {needs.map((s) => sessionRow(s, true))}
        </div>
      )}
      {active.length > 0 && (
        <div>
          <div className={cls.head} title="Running now, or finished since you last looked">
            <span style={{ flex: 1 }}>Active</span>
            <span style={{ color: 'var(--dd-dim)' }}>{active.length}</span>
          </div>
          {active.map((s) => sessionRow(s, true))}
        </div>
      )}

      {starred.length > 0 && (
        <div>
          <div className={cls.head}>
            <button className={cls.chev} title={starredClosed ? 'Expand' : 'Collapse'} onClick={() => toggleGroup(STARRED_KEY)}>
              {starredClosed ? '▸' : '▾'}
            </button>
            <span style={{ flex: 1, cursor: 'pointer', color: 'var(--dd-warn-bright)' }} onClick={() => toggleGroup(STARRED_KEY)}>
              ★ Starred
            </span>
            <span style={{ color: 'var(--dd-dim)' }}>{starred.length}</span>
          </div>
          {!starredClosed && starred.map((s) => sessionRow(s, true))}
        </div>
      )}

      {/* user folders: the curated band between Starred and the auto groups.
          Zero folders = zero chrome; the "＋ New folder" zone only materializes
          while a session drag is live. */}
      {showFolderBand && (
        <div style={{ borderBottom: '1px solid var(--dd-border-faint)', paddingBottom: 2 }}>
          {drag?.kind === 'session' && (
            <div
              data-drop="newfolder"
              style={{
                margin: '4px 8px 2px',
                padding: '6px 8px',
                border: `1px dashed ${dropTarget === 'newfolder' ? 'var(--dd-accent-strong)' : 'var(--dd-border2)'}`,
                borderRadius: 5,
                color: dropTarget === 'newfolder' ? 'var(--dd-accent-text)' : 'var(--dd-dim)',
                background: dropTarget === 'newfolder' ? 'var(--dd-btn)' : 'transparent',
                fontSize: 11,
                textAlign: 'center',
              }}
            >
              ＋ New folder
            </div>
          )}
          {naming?.kind === 'create' && (
            <div className={cls.head} style={{ gap: 6 }}>
              <FolderGlyph />
              {nameEditor()}
            </div>
          )}
          {folders.map((f, i) => folderBlock(f, i))}
        </div>
      )}

      {groups.map((g) => {
        const isClosed = closed.has(g.path)
        const { shown, hidden: tail } = capGroup(g.sessions, expanded.has(g.path))
        return (
          <div key={g.path}>
            <div className={cls.head} title={g.path}>
              <button className={cls.chev} title={isClosed ? 'Expand project' : 'Collapse project'} onClick={() => toggleGroup(g.path)}>
                {isClosed ? '▸' : '▾'}
              </button>
              <span
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={() => toggleGroup(g.path)}
              >
                {/* the group's own color, so a row's stripe resolves to a header
                    two rows up rather than to a claim about its contents */}
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, marginRight: 6, background: projectColor(g.path), verticalAlign: 'baseline' }} />
                {shortPath(g.path)}
              </span>
              <span style={{ color: 'var(--dd-dim)' }}>{g.sessions.length}</span>
              {isClosed && <LiveIndicator status={groupStatus(g.sessions)} />}
              <button className={cls.btn} title="New claude session here" onClick={() => onNewSession(g.path)}>＋</button>
            </div>
            {!isClosed && shown.map((s) => sessionRow(s, false))}
            {!isClosed && (tail > 0 || expanded.has(g.path)) && (
              <button
                className={cls.btn} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '2px 10px 5px 26px', color: 'var(--dd-dim2)' }}
                title={tail > 0 ? `Show all ${g.sessions.length} — or ${searchChord} to search every session` : 'Back to the five most recent'}
                onClick={() => toggleExpanded(g.path)}
              >
                {tail > 0 ? `▸ ${tail} older` : '▾ show fewer'}
              </button>
            )}
          </div>
        )
      })}
      {groups.length === 0 && starred.length === 0 && folders.length === 0 && (
        <div style={{ padding: 16, color: 'var(--dd-dim)' }}>indexing ~/.claude…</div>
      )}
      {hidden.length > 0 && (
        <button
          className={cls.btn} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginTop: 4, color: 'var(--dd-dim)' }}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? '▾' : '▸'} {hidden.length} hidden
        </button>
      )}

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div
            className={cls.menu} style={{ left: Math.min(menu.x, window.innerWidth - 220),
              top: Math.min(menu.y, window.innerHeight - 300),
              // the folder list can outgrow the window — scroll it, never clip it
              maxHeight: Math.min(300, window.innerHeight - 40),
              overflowY: 'auto' }}
          >
            {menu.view === 'main' ? (
              <>
                <button className={cls.menuItem} onClick={() => { onToggleStar(menu.s); setMenu(null) }}>
                  {menu.s.starred ? 'Unstar' : 'Star'}
                </button>
                <button
                  className={cls.menuItem}
                 
                  title="Drydock-only name — the claude session itself is untouched"
                  onClick={() => { setDraft(sessionLabel(menu.s)); setNaming({ kind: 'rename-session', sid: menu.s.session_id, initial: sessionLabel(menu.s) }); setMenu(null) }}
                >
                  Rename session…
                </button>
                {menu.s.name && menu.s.name.trim() && (
                  <button
                    className={cls.menuItem}
                   
                    title="Back to the automatic title (card summary / claude's own name)"
                    onClick={() => { invoke('set_session_name', { sessionId: menu.s.session_id, name: '' }).then(onRefresh).catch(console.error); setMenu(null) }}
                  >
                    Clear name
                  </button>
                )}
                <button className={cls.menuItem} onClick={() => { onTranscript(menu.s); setMenu(null) }}>
                  View transcript
                </button>
                {menu.s.live_status !== 'ended' && (
                  <button
                    className={cls.menuItem}
                   
                    title="Stop the terminal that owns this session and resume it in Drydock (asks first)"
                    onClick={() => { onTakeover(menu.s); setMenu(null) }}
                  >
                    Take over here…
                  </button>
                )}
                <button className={cls.menuItem} onClick={() => setMenu({ ...menu, view: 'folders' })}>
                  Move to folder&nbsp;&nbsp;▸
                </button>
                {menu.s.folder_id && folderIds.has(menu.s.folder_id) && (
                  <button className={cls.menuItem} onClick={() => { fileSession(menu.s.session_id, null); setMenu(null) }}>
                    Remove from folder
                  </button>
                )}
                <button className={cls.menuItem} onClick={() => { onNewSession(menu.s.project_path); setMenu(null) }}>
                  New session in this project
                </button>
                {hiddenSet.has(menu.s.session_id) ? (
                  <button className={cls.menuItem} onClick={() => { onHide(menu.s.session_id, false); setMenu(null) }}>Unhide</button>
                ) : (
                  <button className={cls.menuItem} onClick={() => { onHide(menu.s.session_id, true); setMenu(null) }}>Hide from Drydock</button>
                )}
                <button className={cls.menuItem} style={{ color: 'var(--dd-err-bright)' }} onClick={() => { setConfirmDel(menu.s); setMenu(null) }}>
                  Delete permanently…
                </button>
              </>
            ) : (
              <>
                <button className={cls.menuItem} style={{ color: 'var(--dd-text3)' }} onClick={() => setMenu({ ...menu, view: 'main' })}>
                  ‹ Back
                </button>
                {folders.map((f) => {
                  const current = menu.s.folder_id === f.id
                  return (
                    <button
                      key={f.id}
                      className={cls.menuItem} style={{ color: current ? 'var(--dd-dim)' : 'var(--dd-text1)', cursor: current ? 'default' : 'pointer' }}
                      disabled={current}
                      onClick={() => { fileSession(menu.s.session_id, f.id); setMenu(null) }}
                    >
                      {current ? '✓ ' : ''}{clip(f.name, 26)}
                    </button>
                  )
                })}
                <button
                  className={cls.menuItem} style={{ borderTop: folders.length ? '1px solid var(--dd-hairline-strong)' : 'none', borderRadius: 0 }}
                 
                  onClick={() => { setDraft(''); setNaming({ kind: 'create', sid: menu.s.session_id }); setMenu(null) }}
                >
                  New folder…
                </button>
              </>
            )}
          </div>
        </>
      )}

      {folderMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null) }} />
          <div className={cls.menu} style={{ left: Math.min(folderMenu.x, window.innerWidth - 200), top: Math.min(folderMenu.y, window.innerHeight - 170) }}>
            <button className={cls.menuItem} onClick={() => { setDraft(folderMenu.f.name); setNaming({ kind: 'rename', id: folderMenu.f.id }); setFolderMenu(null) }}>
              Rename
            </button>
            <button
              className={cls.menuItem} style={{ opacity: folderMenu.index === 0 ? 0.4 : 1 }}
             
              disabled={folderMenu.index === 0}
              onClick={() => {
                const ids = folders.map((f) => f.id)
                ;[ids[folderMenu.index - 1], ids[folderMenu.index]] = [ids[folderMenu.index], ids[folderMenu.index - 1]]
                reorder(ids)
                setFolderMenu(null)
              }}
            >
              Move up
            </button>
            <button
              className={cls.menuItem} style={{ opacity: folderMenu.index === folders.length - 1 ? 0.4 : 1 }}
             
              disabled={folderMenu.index === folders.length - 1}
              onClick={() => {
                const ids = folders.map((f) => f.id)
                ;[ids[folderMenu.index], ids[folderMenu.index + 1]] = [ids[folderMenu.index + 1], ids[folderMenu.index]]
                reorder(ids)
                setFolderMenu(null)
              }}
            >
              Move down
            </button>
            <button
              className={cls.menuItem} style={{ color: 'var(--dd-err-bright)' }}
             
              onClick={() => {
                // full membership count (incl. starred/hidden members the band
                // isn't currently showing) — deleting unfiles all of them
                const count = sessions.filter((s) => s.folder_id === folderMenu.f.id).length
                if (count === 0) deleteFolder(folderMenu.f)
                else setConfirmDelFolder({ f: folderMenu.f, count })
                setFolderMenu(null)
              }}
            >
              Delete folder…
            </button>
          </div>
        </>
      )}

      {confirmDel && (
        <Modal z={70} width={380}>
          <ModalTitle>Delete permanently?</ModalTitle>
          <ModalBody>
            “{clip(sessionLabel(confirmDel), 48)}” — this deletes the transcript from <code>~/.claude</code>. It will no longer be resumable in Claude Code, and this can’t be undone.
          </ModalBody>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { onDelete(confirmDel.session_id); setConfirmDel(null) }}>Delete</Button>
          </ModalActions>
        </Modal>
      )}

      {confirmDelFolder && (
        <Modal z={70} width={380}>
          <ModalTitle>Delete folder “{clip(confirmDelFolder.f.name, 32)}”?</ModalTitle>
          <ModalBody>
            Its {confirmDelFolder.count} session{confirmDelFolder.count === 1 ? '' : 's'} return to their project groups. No sessions are deleted.
          </ModalBody>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirmDelFolder(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { deleteFolder(confirmDelFolder.f); setConfirmDelFolder(null) }}>Delete folder</Button>
          </ModalActions>
        </Modal>
      )}

      {/* drag ghost: follows the pointer, never intercepts it */}
      {drag && (
        <div
          style={{ position: 'fixed', left: dragXY.x + 10, top: dragXY.y + 8, zIndex: 80, pointerEvents: 'none', background: 'var(--dd-row)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '3px 8px', fontSize: 11, fontFamily: 'system-ui', color: 'var(--dd-text1)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,.4)' }}
        >
          {drag.kind === 'session' ? drag.label : drag.name}
        </div>
      )}
    </div>
      <VersionFooter busyCount={updateBusyCount} onRestartForUpdate={onRestartForUpdate} onOpenSettings={onOpenSettings} />
    </div>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w + dx))}
        onEnd={() => localStorage.setItem('dd.sidebarWidth', String(widthRef.current))}
      />
    </div>
  )
}
