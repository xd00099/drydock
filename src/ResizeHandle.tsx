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
    e.preventDefault()
    let lastX = e.clientX
    const move = (ev: MouseEvent) => { onDelta(ev.clientX - lastX); lastX = ev.clientX }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onEnd?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={start}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Drag to resize"
      style={{ flexShrink: 0, width: 5, minWidth: 5, height: '100%', cursor: 'col-resize', background: hover ? '#2c3647' : '#1d2530' }}
    />
  )
}
