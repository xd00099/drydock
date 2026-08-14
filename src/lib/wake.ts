// Wake-from-sleep display recovery.
//
// After a long lid-close, macOS purges the GPU surfaces behind the webview.
// The WebKit processes all survive (verified: two-week-old helpers), so no
// crash/termination handler ever fires — the window just wakes up compositing
// stale tiles, and every xterm WebGL context comes back dead or with a stale
// glyph atlas. Until now the only fix was closing and reopening the app,
// which "worked" by forcing a fresh layer tree.
//
// Two wake signals funnel into one throttled sweep:
//   - `system-woke`, emitted by the Rust side from NSWorkspace's
//     didWake/screensDidWake notifications (the authoritative signal);
//   - a clock-jump heartbeat: the page's timers freeze during sleep, so a
//     tick arriving with a large gap since the previous one means "we slept".
//     Belt-and-suspenders for anything the native path misses.
//
// The sweep itself:
//   1. drops and restores `display` on <body> — WebKit tears down and
//      re-rasterizes the whole layer tree (fresh surfaces), which is exactly
//      what the close-and-reopen ritual achieved, minus losing anything;
//   2. runs every mounted terminal's repair pass (re-arm a dead WebGL
//      renderer, rebuild the glyph atlas, refit, repaint) one frame later,
//      once the rebuilt layout has committed.

import { listen } from '@tauri-apps/api/event'

/** Terminal panes register a repair pass on mount; the sweep runs them all. */
export const repairers = new Set<() => void>()

/** Ignore duplicate wake signals (native + heartbeat both fire on one wake). */
const SWEEP_COOLDOWN_MS = 5_000
const TICK_MS = 30_000
/** Two missed ticks. A busy main thread or a paused debugger stays under
 * this; real sleep (minutes to hours) sails past it. */
const GAP_MS = 90_000

let lastSweep = 0

/** Rebuild the layer tree and repair terminals. Returns false when coalesced
 * into a sweep that just ran. `now` is injectable for tests. */
export function sweep(now = Date.now()): boolean {
  if (now - lastSweep < SWEEP_COOLDOWN_MS) return false
  lastSweep = now
  const body = document.body
  body.style.display = 'none'
  void body.offsetHeight // commit the teardown before restoring
  body.style.display = ''
  requestAnimationFrame(() =>
    repairers.forEach((r) => {
      try {
        r()
      } catch {
        /* one broken pane must not block healing the rest */
      }
    }),
  )
  return true
}

/** Arm both wake signals. Returns a stop function. */
export function watchWake(): () => void {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - last > GAP_MS) sweep(now)
    last = now
  }, TICK_MS)
  const un = listen('system-woke', () => sweep())
  return () => {
    clearInterval(timer)
    un.then((f) => f())
  }
}
