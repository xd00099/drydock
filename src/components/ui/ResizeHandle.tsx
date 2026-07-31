import { useState } from 'react'

type Props = {
  // reports incremental horizontal mouse movement while dragging; the consumer
  // decides the sign (left sidebar adds dx, right panel subtracts it)
  onDelta: (dx: number) => void
  onEnd?: () => void // called on mouse up — a good time to persist the new width
}

// A thin draggable separator that doubles as the border between a side panel
// and the main area. Drag it to resize the adjacent panel.
export default function ResizeHandle({ onDelta, onEnd }: Props) {
  const [hover, setHover] = useState(false)
  const start = (e: React.MouseEvent) => {
    // Only a left-button drag: a right/middle press never delivers the matching
    // left-button mouseup, which would leave the shield up and freeze the UI.
    if (e.button !== 0) return
    e.preventDefault()
    let lastX = e.clientX
    let pending = 0
    let raf = 0
    // Apply the accumulated delta at most once per frame: high-frequency
    // mousemove (trackpads/120Hz) would otherwise trigger a layout + an artifact
    // iframe reflow on every event.
    const flush = () => { raf = 0; if (pending !== 0) { onDelta(pending); pending = 0 } }
    const move = (ev: MouseEvent) => {
      pending += ev.clientX - lastX
      lastX = ev.clientX
      if (!raf) raf = requestAnimationFrame(flush)
    }
    // A transparent full-viewport shield placed ABOVE everything during the drag.
    // The Artifacts panel renders a sandboxed iframe, which is a separate
    // document that captures mouse events whenever the cursor is over it — so
    // without the shield the drag freezes the instant the cursor crosses the
    // iframe (the parent window stops receiving mousemove). The shield keeps
    // every event on the parent document.
    const shield = document.createElement('div')
    shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:col-resize'
    document.body.appendChild(shield)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('blur', up)
      if (raf) cancelAnimationFrame(raf)
      if (pending !== 0) { onDelta(pending); pending = 0 } // apply the final delta
      shield.remove()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // persist after the final width commits next frame, so onEnd reads it fresh
      requestAnimationFrame(() => onEnd?.())
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // losing the window mid-drag (⌘Tab, screenshot) swallows the mouseup — end
    // the drag on blur so the shield can never stick
    window.addEventListener('blur', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={start}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Drag to resize"
      style={{ flexShrink: 0, width: 5, minWidth: 5, height: '100%', cursor: 'col-resize', background: hover ? 'var(--dd-border2)' : 'var(--dd-border)' }}
    />
  )
}
