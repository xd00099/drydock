import { useEffect, useRef, useState } from 'react'
import {
  GUTTER, clampRatio, dropOnStage, hitTest, layoutRects, setRatio, showTab,
} from '@/lib/split'
import type { DividerRect, DropTarget, Edge, Rect, Stage } from '@/lib/split'
import type { Tab } from '@/lib/types'

/** Where a released chip lands: a slot in its own tab-bar lane, or a pane on
 *  the stage. Resolved continuously during the drag and read once at pointerup. */
type ChipDrop = { kind: 'bar'; beforeId: number | null } | { kind: 'stage'; target: DropTarget }

type Deps = {
  /** Live tabs — read through a ref because a drag outlives a render. */
  tabsRef: React.MutableRefObject<Tab[]>
  stageRef: React.MutableRefObject<Stage>
  /** The stage's own element, for translating page coords into stage coords. */
  contentRef: React.RefObject<HTMLDivElement | null>
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>
  setStage: React.Dispatch<React.SetStateAction<Stage>>
  setZoomTab: (id: number | null) => void
  /** Landing a preview tab on the stage is deliberate — make it permanent. */
  promote: (id: number) => void
  /** Set for the duration of a live chip drag; other handlers check it to stand down. */
  chipDragLiveRef: React.MutableRefObject<boolean>
  /** Reshaping the stage closes an open chip menu — see the effect below. */
  layout: Stage['layout']
  activeId: number | null
  zoomTab: number | null
}

/** All pointer-driven stage manipulation: dragging a tab chip to reorder or
 *  split, dragging a divider to re-ratio, and the right-click split menu.
 *
 *  Extracted wholesale from App because it is one coherent gesture layer with a
 *  narrow contract — it reads live tabs/stage through refs and writes back
 *  through setters — and because ~220 lines of pointer bookkeeping made the
 *  component's actual data flow hard to follow.
 *
 *  Everything here uses pointer events rather than HTML5 drag-and-drop, which
 *  Tauri's webview swallows (the sidebar's drag has the same constraint).
 */
export function useStageDrag({
  tabsRef, stageRef, contentRef, setTabs, setStage, setZoomTab, promote,
  chipDragLiveRef, layout, activeId, zoomTab,
}: Deps) {
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

  return {
    chipDrag, dragXY, stageHit, insertMark,
    chipMenu, setChipMenu,
    suppressClickRef, dividerDraggedRef,
    beginChipDrag, beginDividerDrag, splitFromMenu,
  }
}
