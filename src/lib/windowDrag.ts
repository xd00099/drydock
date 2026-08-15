import { getCurrentWindow } from '@tauri-apps/api/window'

/** Arm a window drag from a chrome strip (title-bar stand-ins: the sidebar
 *  header, the collapsed rail). Nothing happens for a plain click — the native
 *  drag only starts once the pointer travels 4px, so clickable children (the
 *  DRYDOCK/Home label, the ＋ buttons) keep working. `data-tauri-drag-region`
 *  can't cover these strips: it matches only the exact event target, and the
 *  strips are covered edge-to-edge by their own children.
 *
 *  Once the native drag starts, macOS owns the mouse session — the DOM sees
 *  neither the pointerup nor a click, so the child the press started on never
 *  fires. The armed listeners self-remove on the next pointerup anywhere. */
export function armWindowDrag(e: React.PointerEvent) {
  if (e.button !== 0) return
  const sx = e.clientX
  const sy = e.clientY
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 4) return
    stop()
    void getCurrentWindow().startDragging()
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}
