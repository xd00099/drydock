import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { FolderView, SessionView } from './types'
import { clampPanelWidth, clip, loadNum, relAge, sessionColor, sessionLabel, shortPath, uuidv4 } from './types'
import ResizeHandle from './ResizeHandle'
import LiveIndicator from './LiveIndicator'

type Props = {
  sessions: SessionView[]
  folders: FolderView[] // user folders, in band order
  hidden: string[] // session ids the user hid from Drydock
  activeSessionId: string | null // session shown in the active tab — highlighted in the list
  onResume: (s: SessionView) => void
  onTranscript: (s: SessionView) => void // open the read-only transcript (never spawns claude)
  onNewSession: (projectPath: string) => void
  onToggleStar: (s: SessionView) => void
  onHide: (sessionId: string, hide: boolean) => void
  onDelete: (sessionId: string) => void
  onRefresh: () => void // re-pull the snapshot after a folder mutation
}

type Group = { path: string; sessions: SessionView[]; latest: number }

const STARRED_KEY = '__starred__'
// Folder collapse keys share dd.closedGroups with project paths; the prefix
// can't collide because project paths start with '/'.
const folderKey = (id: string) => `folder:${id}`

// Visible = not an auto-hidden ghost and (not user-hidden unless revealing hidden).
function isVisible(s: SessionView, hiddenSet: Set<string>, showHidden: boolean): boolean {
  if (s.hidden) return false
  if (hiddenSet.has(s.session_id) && !showHidden) return false
  return true
}

const byRecency = (a: SessionView, b: SessionView) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0)

// Project groups. Starred sessions and filed sessions (in an existing user
// folder) are excluded — they render in their own sections above. One rule:
// a visible session appears in exactly one place (Starred > folder > project).
function groupSessions(sessions: SessionView[], hiddenSet: Set<string>, showHidden: boolean, folderIds: Set<string>): Group[] {
  const byPath = new Map<string, SessionView[]>()
  for (const s of sessions) {
    if (s.starred) continue
    if (s.folder_id && folderIds.has(s.folder_id)) continue
    if (!isVisible(s, hiddenSet, showHidden)) continue
    const list = byPath.get(s.project_path) ?? []
    list.push(s)
    byPath.set(s.project_path, list)
  }
  const groups: Group[] = [...byPath.entries()].map(([path, list]) => {
    list.sort(byRecency)
    return { path, sessions: list, latest: Math.max(...list.map((s) => s.last_message_at ?? 0)) }
  })
  groups.sort((a, b) => b.latest - a.latest)
  return groups
}

const S = {
  // userSelect none: a pointer drag across rows must never smear a text
  // selection (nothing in the sidebar is copy-worthy prose anyway)
  side: { width: 300, minWidth: 300, height: '100%', overflowY: 'auto', background: '#0b0e13', color: '#c8cdd5', fontFamily: 'system-ui', fontSize: 12, borderRight: '1px solid #1d2530', userSelect: 'none', WebkitUserSelect: 'none' } as const,
  rail: { width: 30, minWidth: 30, height: '100%', background: '#0b0e13', borderRight: '1px solid #1d2530', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 } as const,
  bar: { display: 'flex', alignItems: 'center', padding: '10px 8px 4px' } as const,
  head: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px 4px', color: '#7d8794', fontWeight: 600 } as const,
  row: { display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left', background: 'none', border: 'none', borderLeft: '3px solid transparent', color: '#c8cdd5', padding: '5px 10px', cursor: 'pointer', fontSize: 12 } as const,
  btn: { background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 12, padding: 0 } as const,
  chev: { background: 'none', border: 'none', cursor: 'pointer', color: '#7d8794', fontSize: 10, padding: 0, width: 14 } as const,
  menu: { position: 'fixed', background: '#1b2230', border: '1px solid #2c3647', borderRadius: 6, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,.4)', zIndex: 60, fontFamily: 'system-ui', fontSize: 12, minWidth: 180 } as const,
  menuItem: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#d6dbe3', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 } as const,
  nameInput: { flex: 1, minWidth: 0, background: '#10141a', border: '1px solid #4f7fd9', borderRadius: 4, color: '#e8edf4', fontSize: 12, fontFamily: 'system-ui', padding: '2px 6px', outline: 'none' } as const,
  confirmBox: { background: '#161c25', color: '#e8edf4', padding: 20, borderRadius: 8, fontFamily: 'system-ui', fontSize: 13, maxWidth: 380 } as const,
  confirmBtn: { background: '#1d2530', color: '#e8edf4', border: '1px solid #2c3647', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12 } as const,
} as const

function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]) } catch { return new Set() }
}

// Hover highlight for context-menu items (inline styles can't express :hover).
const menuHover = {
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = '#2c3647' },
  onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'none' },
}

// The strongest live status across a (collapsed) group's sessions.
function groupStatus(list: SessionView[]): SessionView['live_status'] | null {
  if (list.some((s) => s.live_status === 'needs_input')) return 'needs_input'
  if (list.some((s) => s.live_status === 'busy')) return 'busy'
  if (list.some((s) => s.live_status === 'idle')) return 'idle'
  return null
}

// The one crisp glyph distinguishing user folders from auto project groups.
const FolderGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" style={{ flex: 'none' }} aria-hidden>
    <path d="M1.5 3.5h4.2l1.6 2h7.2v7h-13z" fill="none" stroke="#7fb0ff" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)

// A live drag: a session heading for a folder, or a folder being reordered.
type Drag =
  | { kind: 'session'; sid: string; label: string; fromFolder: string | null }
  | { kind: 'folder'; id: string; name: string }

// Inline name editor state: creating a folder (optionally filing a dragged
// session into it on commit) or renaming an existing one.
type Naming = { kind: 'create'; sid: string | null } | { kind: 'rename'; id: string }

export default function Sidebar({ sessions, folders, hidden, activeSessionId, onResume, onTranscript, onNewSession, onToggleStar, onHide, onDelete, onRefresh }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dd.sidebarCollapsed') === '1')
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
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionView; view: 'main' | 'folders' } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; f: FolderView; index: number } | null>(null)
  const [confirmDel, setConfirmDel] = useState<SessionView | null>(null)
  const [confirmDelFolder, setConfirmDelFolder] = useState<{ f: FolderView; count: number } | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)

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

  const toggleSidebar = () =>
    setCollapsed((c) => { const n = !c; localStorage.setItem('dd.sidebarCollapsed', n ? '1' : '0'); return n })

  const toggleGroup = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      localStorage.setItem('dd.closedGroups', JSON.stringify([...next]))
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
      if (target === 'newfolder') { setNaming({ kind: 'create', sid: d.sid }); return }
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
      <div style={S.rail}>
        <button style={{ ...S.btn, fontSize: 15 }} title="Expand sidebar" onClick={toggleSidebar}>»</button>
      </div>
    )
  }

  const hiddenSet = new Set(hidden)
  const folderIds = new Set(folders.map((f) => f.id))
  const starred = sessions
    .filter((s) => s.starred && isVisible(s, hiddenSet, showHidden))
    .sort(byRecency)
  // Folder members. Starred wins placement (same rule as project groups —
  // membership is kept invisibly and the session returns here on unstar).
  const filed = new Map<string, SessionView[]>()
  for (const s of sessions) {
    if (!s.folder_id || !folderIds.has(s.folder_id) || s.starred) continue
    if (!isVisible(s, hiddenSet, showHidden)) continue
    const list = filed.get(s.folder_id) ?? []
    list.push(s)
    filed.set(s.folder_id, list)
  }
  filed.forEach((list) => list.sort(byRecency))
  const groups = groupSessions(sessions, hiddenSet, showHidden, folderIds)

  // One session row, shared by Starred, folders and project groups.
  const sessionRow = (s: SessionView, showProject: boolean) => {
    const isHidden = hiddenSet.has(s.session_id)
    const isActive = s.session_id === activeSessionId // session shown in the active tab
    const isDragging = drag?.kind === 'session' && drag.sid === s.session_id
    const sub = showProject ? shortPath(s.project_path) : s.latest_recap
    const inFolder = s.folder_id && folderIds.has(s.folder_id) ? folders.find((f) => f.id === s.folder_id)?.name : null
    return (
      <button
        key={s.session_id}
        className={`dd-sessrow${flashSid === s.session_id ? ' dd-landed' : ''}`}
        style={{ ...S.row, opacity: isDragging ? 0.4 : isHidden ? 0.45 : 1, borderLeftColor: sessionColor(s.session_id), background: sessionColor(s.session_id, isActive ? 0.3 : 0.1) }}
        onClick={dragSafe(() => onResume(s))}
        onPointerDown={(e) => beginPress(e, { kind: 'session', sid: s.session_id, label: sessionLabel(s), fromFolder: s.folder_id })}
        onContextMenu={(e) => { e.preventDefault(); if (dragRef.current) return; setMenu({ x: e.clientX, y: e.clientY, s, view: 'main' }) }}
        title={`${s.attention ? `⚠ ${s.attention}\n` : ''}${s.title}${s.starred && inFolder ? `\nin folder “${inFolder}”` : ''}\n${s.session_id}\n(right-click for options · drag into a folder)`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <LiveIndicator status={s.live_status} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e8edf4' }}>
            {sessionLabel(s)}
          </span>
          {/* hover-only: read without resuming (a plain click SPAWNS claude for
              ended sessions — this is the safe browse path). span, not button:
              a button can't nest inside the row button. */}
          <span
            className="dd-rowbtn"
            role="button"
            title={'Read transcript (read-only) — never resumes\n⌘⇧T toggles it for the active session'}
            onClick={(e) => { e.stopPropagation(); dragSafe(() => onTranscript(s))() }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ flexShrink: 0, color: '#8ea0b5', fontSize: 12, lineHeight: 1, padding: '0 2px' }}
          >
            ≣
          </span>
          <span style={{ flexShrink: 0, marginLeft: 2, color: '#5b6675' }}>{relAge(s.last_message_at)}</span>
        </div>
        {sub && (
          <div style={{ color: '#5b6675', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {sub}
          </div>
        )}
      </button>
    )
  }

  // Inline folder-name editor (create at the band top / rename in a header).
  const nameEditor = (defaultValue: string) => (
    <input
      style={S.nameInput}
      autoFocus
      defaultValue={defaultValue}
      maxLength={60}
      placeholder="Folder name"
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
        {gapBefore && <div style={{ height: 2, background: '#4f7fd9', margin: '0 8px', borderRadius: 1 }} />}
        <div
          data-drop={droppable ? `folder:${f.id}` : undefined}
          style={targeted ? { outline: '1px solid #4f7fd9', outlineOffset: -1, background: '#121926', borderRadius: 4 } : undefined}
        >
          <div
            style={{ ...S.head, opacity: drag?.kind === 'folder' && drag.id === f.id ? 0.4 : 1 }}
            data-fhead
            title={`${f.name}\n(right-click for options · drag to reorder)`}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input')) return
              beginPress(e, { kind: 'folder', id: f.id, name: f.name })
            }}
            onContextMenu={(e) => { e.preventDefault(); if (dragRef.current) return; setFolderMenu({ x: e.clientX, y: e.clientY, f, index: i }) }}
          >
            <button style={S.chev} title={isClosed ? 'Expand folder' : 'Collapse folder'} onClick={() => toggleGroup(key)}>
              {isClosed ? '▸' : '▾'}
            </button>
            <FolderGlyph />
            {renaming ? (
              nameEditor(f.name)
            ) : (
              <span
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', color: '#dfe5ee' }}
                onClick={dragSafe(() => toggleGroup(key))}
              >
                {f.name}
              </span>
            )}
            <span style={{ color: '#5b6675' }}>{members.length}</span>
            {isClosed && <LiveIndicator status={groupStatus(members)} />}
          </div>
          {!isClosed && members.map((s) => sessionRow(s, true))}
          {!isClosed && members.length === 0 && (
            <div style={{ margin: '1px 10px 6px 26px', padding: '5px 8px', border: '1px dashed #232c3a', borderRadius: 4, color: '#4a5462', fontSize: 11 }}>
              Drop sessions here
            </div>
          )}
        </div>
        {gapAfter && <div style={{ height: 2, background: '#4f7fd9', margin: '0 8px', borderRadius: 1 }} />}
      </div>
    )
  }

  const starredClosed = closed.has(STARRED_KEY)
  const showFolderBand = folders.length > 0 || naming?.kind === 'create' || drag?.kind === 'session'
  return (
    <div style={{ display: 'flex', height: '100%' }}>
    <div ref={scrollerRef} style={{ ...S.side, width, minWidth: width, borderRight: 'none' }}>
      <div style={S.bar}>
        <span style={{ flex: 1, fontWeight: 700, color: '#e8edf4' }}>DRYDOCK</span>
        <button style={{ ...S.btn, fontSize: 15 }} title="Collapse sidebar" onClick={toggleSidebar}>«</button>
      </div>

      {starred.length > 0 && (
        <div>
          <div style={S.head}>
            <button style={S.chev} title={starredClosed ? 'Expand' : 'Collapse'} onClick={() => toggleGroup(STARRED_KEY)}>
              {starredClosed ? '▸' : '▾'}
            </button>
            <span style={{ flex: 1, cursor: 'pointer', color: '#e8c35a' }} onClick={() => toggleGroup(STARRED_KEY)}>
              ★ Starred
            </span>
            <span style={{ color: '#5b6675' }}>{starred.length}</span>
          </div>
          {!starredClosed && starred.map((s) => sessionRow(s, true))}
        </div>
      )}

      {/* user folders: the curated band between Starred and the auto groups.
          Zero folders = zero chrome; the "＋ New folder" zone only materializes
          while a session drag is live. */}
      {showFolderBand && (
        <div style={{ borderBottom: '1px solid #161d28', paddingBottom: 2 }}>
          {drag?.kind === 'session' && (
            <div
              data-drop="newfolder"
              style={{
                margin: '4px 8px 2px',
                padding: '6px 8px',
                border: `1px dashed ${dropTarget === 'newfolder' ? '#4f7fd9' : '#2c3647'}`,
                borderRadius: 5,
                color: dropTarget === 'newfolder' ? '#9cc3ff' : '#5b6675',
                background: dropTarget === 'newfolder' ? '#141b26' : 'transparent',
                fontSize: 11,
                textAlign: 'center',
              }}
            >
              ＋ New folder
            </div>
          )}
          {naming?.kind === 'create' && (
            <div style={{ ...S.head, gap: 6 }}>
              <FolderGlyph />
              {nameEditor('')}
            </div>
          )}
          {folders.map((f, i) => folderBlock(f, i))}
        </div>
      )}

      {groups.map((g) => {
        const isClosed = closed.has(g.path)
        return (
          <div key={g.path}>
            <div style={S.head} title={g.path}>
              <button style={S.chev} title={isClosed ? 'Expand project' : 'Collapse project'} onClick={() => toggleGroup(g.path)}>
                {isClosed ? '▸' : '▾'}
              </button>
              <span
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={() => toggleGroup(g.path)}
              >
                {shortPath(g.path)}
              </span>
              <span style={{ color: '#5b6675' }}>{g.sessions.length}</span>
              {isClosed && <LiveIndicator status={groupStatus(g.sessions)} />}
              <button style={S.btn} title="New claude session here" onClick={() => onNewSession(g.path)}>＋</button>
            </div>
            {!isClosed && g.sessions.map((s) => sessionRow(s, false))}
          </div>
        )
      })}
      {groups.length === 0 && starred.length === 0 && folders.length === 0 && (
        <div style={{ padding: 16, color: '#5b6675' }}>indexing ~/.claude…</div>
      )}
      {hidden.length > 0 && (
        <button
          style={{ ...S.btn, display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginTop: 4, color: '#5b6675' }}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? '▾' : '▸'} {hidden.length} hidden
        </button>
      )}

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div
            style={{
              ...S.menu,
              left: Math.min(menu.x, window.innerWidth - 220),
              top: Math.min(menu.y, window.innerHeight - 300),
              // the folder list can outgrow the window — scroll it, never clip it
              maxHeight: Math.min(300, window.innerHeight - 40),
              overflowY: 'auto',
            }}
          >
            {menu.view === 'main' ? (
              <>
                <button style={S.menuItem} {...menuHover} onClick={() => { onToggleStar(menu.s); setMenu(null) }}>
                  {menu.s.starred ? 'Unstar' : 'Star'}
                </button>
                <button style={S.menuItem} {...menuHover} onClick={() => { onTranscript(menu.s); setMenu(null) }}>
                  View transcript
                </button>
                <button style={S.menuItem} {...menuHover} onClick={() => setMenu({ ...menu, view: 'folders' })}>
                  Move to folder&nbsp;&nbsp;▸
                </button>
                {menu.s.folder_id && folderIds.has(menu.s.folder_id) && (
                  <button style={S.menuItem} {...menuHover} onClick={() => { fileSession(menu.s.session_id, null); setMenu(null) }}>
                    Remove from folder
                  </button>
                )}
                <button style={S.menuItem} {...menuHover} onClick={() => { onNewSession(menu.s.project_path); setMenu(null) }}>
                  New session in this project
                </button>
                {hiddenSet.has(menu.s.session_id) ? (
                  <button style={S.menuItem} {...menuHover} onClick={() => { onHide(menu.s.session_id, false); setMenu(null) }}>Unhide</button>
                ) : (
                  <button style={S.menuItem} {...menuHover} onClick={() => { onHide(menu.s.session_id, true); setMenu(null) }}>Hide from Drydock</button>
                )}
                <button style={{ ...S.menuItem, color: '#e8907a' }} {...menuHover} onClick={() => { setConfirmDel(menu.s); setMenu(null) }}>
                  Delete permanently…
                </button>
              </>
            ) : (
              <>
                <button style={{ ...S.menuItem, color: '#7d8794' }} {...menuHover} onClick={() => setMenu({ ...menu, view: 'main' })}>
                  ‹ Back
                </button>
                {folders.map((f) => {
                  const current = menu.s.folder_id === f.id
                  return (
                    <button
                      key={f.id}
                      style={{ ...S.menuItem, color: current ? '#5b6675' : '#d6dbe3', cursor: current ? 'default' : 'pointer' }}
                      {...(current ? {} : menuHover)}
                      disabled={current}
                      onClick={() => { fileSession(menu.s.session_id, f.id); setMenu(null) }}
                    >
                      {current ? '✓ ' : ''}{clip(f.name, 26)}
                    </button>
                  )
                })}
                <button
                  style={{ ...S.menuItem, borderTop: folders.length ? '1px solid #2c3647' : 'none', borderRadius: 0 }}
                  {...menuHover}
                  onClick={() => { setNaming({ kind: 'create', sid: menu.s.session_id }); setMenu(null) }}
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
          <div style={{ ...S.menu, left: Math.min(folderMenu.x, window.innerWidth - 200), top: Math.min(folderMenu.y, window.innerHeight - 170) }}>
            <button style={S.menuItem} {...menuHover} onClick={() => { setNaming({ kind: 'rename', id: folderMenu.f.id }); setFolderMenu(null) }}>
              Rename
            </button>
            <button
              style={{ ...S.menuItem, opacity: folderMenu.index === 0 ? 0.4 : 1 }}
              {...menuHover}
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
              style={{ ...S.menuItem, opacity: folderMenu.index === folders.length - 1 ? 0.4 : 1 }}
              {...menuHover}
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
              style={{ ...S.menuItem, color: '#e8907a' }}
              {...menuHover}
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }}>
          <div style={S.confirmBox}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Delete permanently?</div>
            <div style={{ color: '#b3bcc8', marginBottom: 14, lineHeight: 1.45 }}>
              “{clip(sessionLabel(confirmDel), 48)}” — this deletes the transcript from <code>~/.claude</code>. It will no longer be resumable in Claude Code, and this can’t be undone.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={S.confirmBtn} onClick={() => setConfirmDel(null)}>
                Cancel
              </button>
              <button
                style={{ background: '#7a2e2e', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 5, cursor: 'pointer' }}
                onClick={() => { onDelete(confirmDel.session_id); setConfirmDel(null) }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelFolder && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }}>
          <div style={S.confirmBox}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Delete folder “{clip(confirmDelFolder.f.name, 32)}”?</div>
            <div style={{ color: '#b3bcc8', marginBottom: 14, lineHeight: 1.45 }}>
              Its {confirmDelFolder.count} session{confirmDelFolder.count === 1 ? '' : 's'} return to their project groups. No sessions are deleted.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={S.confirmBtn} onClick={() => setConfirmDelFolder(null)}>
                Cancel
              </button>
              <button
                style={{ background: '#7a2e2e', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 5, cursor: 'pointer' }}
                onClick={() => { deleteFolder(confirmDelFolder.f); setConfirmDelFolder(null) }}
              >
                Delete folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* drag ghost: follows the pointer, never intercepts it */}
      {drag && (
        <div
          style={{ position: 'fixed', left: dragXY.x + 10, top: dragXY.y + 8, zIndex: 80, pointerEvents: 'none', background: '#1b2230', border: '1px solid #2c3647', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontFamily: 'system-ui', color: '#d6dbe3', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,.4)' }}
        >
          {drag.kind === 'session' ? drag.label : drag.name}
        </div>
      )}
    </div>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w + dx))}
        onEnd={() => localStorage.setItem('dd.sidebarWidth', String(widthRef.current))}
      />
    </div>
  )
}
