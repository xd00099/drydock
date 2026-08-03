import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { bytesToB64 } from '@/features/terminal/TerminalPane'
import type { Stage } from '@/lib/split'
import type { Tab } from '@/lib/types'

/** Shell-safe single-quoting: wrap in ', and close/escape/reopen for any ' in
 *  the path. Paths reach the session as text typed into its prompt, so a name
 *  with a space or an apostrophe must not split into two arguments. */
function quotePath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

type Deps = {
  tabsRef: React.MutableRefObject<Tab[]>
  stageRef: React.MutableRefObject<Stage>
}

/**
 * Dropping files onto a session types their paths into its prompt.
 *
 * Claude Code reads an image (or any file) from a path in the prompt, so the
 * useful thing to hand it is the path — exactly what dragging a file into a
 * normal terminal does. We deliberately do NOT press Enter: the point of
 * dropping a screenshot is usually to say something about it, so the path lands
 * in the composer with a trailing space and the turn is still yours to send.
 *
 * The paths have to come from Tauri's own drag-drop event rather than HTML5
 * drop: with dragDrop enabled (the default) the webview never sees a file drop,
 * and even if it did, the browser hands over File objects without a filesystem
 * path — which is the one thing we need.
 */
export function useFileDrop({ tabsRef, stageRef }: Deps) {
  /** Tab the pointer is currently over, for the drop hint. */
  const [dropTabId, setDropTabId] = useState<number | null>(null)
  const scaleRef = useRef(1)

  useEffect(() => {
    getCurrentWindow().scaleFactor().then((s) => { scaleRef.current = s }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    let un: (() => void) | null = null

    /** Which tab is under the cursor. Physical → CSS pixels via the window's
     *  scale factor; if that lands on nothing (a zoomed webview shifts the
     *  mapping), fall back to the focused pane so a drop is never simply lost. */
    const tabAt = (pos: { x: number; y: number }): number | null => {
      const s = scaleRef.current || 1
      const el = document.elementFromPoint(pos.x / s, pos.y / s)
      const pane = el?.closest('[data-pane]')
      const id = pane ? Number(pane.getAttribute('data-pane')) : NaN
      if (Number.isFinite(id)) return id
      return stageRef.current.active
    }

    /** Only a live process can be typed into. */
    const writable = (id: number | null): number | null => {
      if (id === null) return null
      const t = tabsRef.current.find((x) => x.id === id)
      return t && t.kind === 'pty' && !t.exited ? t.id : null
    }

    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload
        if (p.type === 'over') { setDropTabId(writable(tabAt(p.position))); return }
        if (p.type === 'leave') { setDropTabId(null); return }
        if (p.type !== 'drop') return
        setDropTabId(null)
        const id = writable(tabAt(p.position))
        if (id === null || !p.paths.length) return
        const text = p.paths.map(quotePath).join(' ') + ' '
        invoke('pty_write', { id, data: bytesToB64(new TextEncoder().encode(text)) }).catch(console.error)
      })
      .then((u) => { if (cancelled) u(); else un = u })

    return () => { cancelled = true; un?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { dropTabId }
}
