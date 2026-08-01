import { useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

/** Zoom steps. Multiplicative rather than additive so each press feels like the
 *  same change at any level — +10% from 200% has to be twice the pixels of +10%
 *  from 100% to look equivalent. */
const STEP = 1.1
const MIN = 0.6
const MAX = 2.4
const KEY = 'dd.zoom'

const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z))

function load(): number {
  const v = Number(localStorage.getItem(KEY))
  return Number.isFinite(v) && v > 0 ? clamp(v) : 1
}

/** ⌘+ / ⌘- / ⌘⇧0 — scales the entire webview, xterm included.
 *
 *  Deliberately the webview's own zoom rather than a CSS transform: a transform
 *  would leave the terminal rendering at its original raster size and blur it,
 *  whereas webview zoom changes the layout viewport, so xterm's ResizeObserver
 *  fires, FitAddon recomputes cols/rows, and the PTY is told its new size. The
 *  terminal stays crisp and correctly sized at any zoom.
 *
 *  Persisted, because a zoom you have to re-apply every launch is worse than no
 *  zoom at all.
 */
export function useZoom() {
  const zoomRef = useRef(load())

  const apply = (z: number) => {
    zoomRef.current = clamp(z)
    localStorage.setItem(KEY, String(zoomRef.current))
    // A webview that refuses the zoom (missing capability) must not take the
    // keystroke down with it — the app is still usable at 100%.
    getCurrentWebview().setZoom(zoomRef.current).catch(console.error)
  }

  // Restore before first paint rather than after, so the window doesn't visibly
  // snap from 100% to the saved level on launch.
  useEffect(() => {
    if (zoomRef.current !== 1) apply(zoomRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    zoomIn: () => apply(zoomRef.current * STEP),
    zoomOut: () => apply(zoomRef.current / STEP),
    zoomReset: () => apply(1),
  }
}
