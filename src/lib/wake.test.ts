// The wake sweep pins the overnight-corruption fix: after a long lid-close,
// the live webview composites stale GPU surfaces and every terminal's WebGL
// context is dead, and NOTHING crashes — so recovery must be triggered by us,
// not by a termination handler. The bug being pinned: before this, the only
// way back to a working UI was closing and reopening the whole app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { tauriListeners } = vi.hoisted(() => ({
  tauriListeners: [] as Array<() => void>,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_evt: string, cb: () => void) => {
    tauriListeners.push(cb)
    return Promise.resolve(() => {})
  },
}))

import { repairers, sweep, watchWake } from './wake'

// Run rAF callbacks synchronously: repairs are observable the moment sweep returns.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  repairers.clear()
  tauriListeners.length = 0
})

// Each test uses its own decade of fake time so the module-level sweep
// throttle never bleeds between tests.
const at = (base: number, offset = 0) => base + offset

describe('sweep', () => {
  it('rebuilds the layer tree (display drop + restore) and then repairs every terminal', () => {
    const order: string[] = []
    repairers.add(() => order.push(`repair:${document.body.style.display}`))
    expect(sweep(at(1e12))).toBe(true)
    // display was restored before the repair pass ran, and it ran exactly once
    expect(order).toEqual(['repair:'])
    expect(document.body.style.display).toBe('')
  })

  it('coalesces the duplicate signals one wake produces (native + heartbeat)', () => {
    const repair = vi.fn()
    repairers.add(repair)
    expect(sweep(at(2e12))).toBe(true)
    expect(sweep(at(2e12, 1_000))).toBe(false) // heartbeat echo, 1s later
    expect(repair).toHaveBeenCalledTimes(1)
    expect(sweep(at(2e12, 60_000))).toBe(true) // a later, separate wake
  })

  it('an unregistered pane (closed tab) is not repaired', () => {
    const gone = vi.fn()
    repairers.add(gone)
    repairers.delete(gone)
    sweep(at(3e12))
    expect(gone).not.toHaveBeenCalled()
  })
})

describe('watchWake', () => {
  it('a large gap between heartbeats means the machine slept — sweep fires', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) // leave the rAF stub alone
    vi.setSystemTime(4e12)
    const repair = vi.fn()
    repairers.add(repair)
    const stop = watchWake()

    vi.advanceTimersByTime(30_000) // normal tick, no gap
    expect(repair).not.toHaveBeenCalled()

    vi.setSystemTime(4e12 + 30_000 + 8 * 60 * 60 * 1000) // lid closed overnight
    vi.advanceTimersByTime(30_000) // first tick after wake sees the 8h gap
    expect(repair).toHaveBeenCalledTimes(1)
    stop()
  })

  it('ordinary ticking never sweeps', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) // leave the rAF stub alone
    vi.setSystemTime(5e12)
    const repair = vi.fn()
    repairers.add(repair)
    const stop = watchWake()
    vi.advanceTimersByTime(30 * 60_000) // half an hour awake
    expect(repair).not.toHaveBeenCalled()
    stop()
  })

  it('the native system-woke event sweeps immediately', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) // leave the rAF stub alone
    vi.setSystemTime(6e12)
    const repair = vi.fn()
    repairers.add(repair)
    const stop = watchWake()
    await Promise.resolve() // let listen() register
    expect(tauriListeners.length).toBe(1)
    tauriListeners[0]()
    expect(repair).toHaveBeenCalledTimes(1)
    stop()
  })
})
