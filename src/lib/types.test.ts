// The kill-confirmation predicate behind both the quit guard and the ⌘W
// close-tab guard. The bug being pinned: the old guards fired for ANY live
// tab, so a wall of idle sessions — the normal state of this app — nagged on
// every ⌘Q and most ⌘Ws, training the user to click through the one dialog
// that sometimes matters.
import { describe, expect, it } from 'vitest'
import { interruptsWork } from '@/lib/types'
import type { SessionView } from '@/lib/types'

const tab = (sessionId: string | null, over: { kind?: string; exited?: boolean } = {}) =>
  ({ kind: 'pty', exited: false, sessionId, ...over })
const sess = (id: string, live_status: SessionView['live_status']) =>
  ({ session_id: id, live_status }) as SessionView

describe('interruptsWork', () => {
  it('idle, waiting and finished sessions kill silently — they all resume', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const sessions = [sess('a', 'idle'), sess('b', 'needs_input'), sess('c', 'done')]
    expect(interruptsWork(tabs, sessions)).toBe(false)
  })

  it('a busy session in a live pty tab is the one case that confirms', () => {
    expect(interruptsWork([tab('a'), tab('b')], [sess('a', 'idle'), sess('b', 'busy')])).toBe(true)
    // and the same predicate answers for a single tab (the ⌘W path)
    expect(interruptsWork([tab('b')], [sess('b', 'busy')])).toBe(true)
    expect(interruptsWork([tab('a')], [sess('a', 'idle'), sess('b', 'busy')])).toBe(false)
  })

  it('a transcript tab never confirms — reading a busy session is not killing it', () => {
    expect(interruptsWork([tab('a', { kind: 'transcript' })], [sess('a', 'busy')])).toBe(false)
  })

  it('a busy session whose tab already exited has nothing left to interrupt', () => {
    expect(interruptsWork([tab('a', { exited: true })], [sess('a', 'busy')])).toBe(false)
  })

  it('a busy session NOT open in any tab is owned elsewhere — killing tabs spares it', () => {
    expect(interruptsWork([tab('a')], [sess('a', 'idle'), sess('other', 'busy')])).toBe(false)
  })

  it('shell tabs and empty tab lists never confirm', () => {
    expect(interruptsWork([tab(null)], [])).toBe(false)
    expect(interruptsWork([], [sess('a', 'busy')])).toBe(false)
  })

  it('a session the index has not seen yet kills silently (documented trade)', () => {
    expect(interruptsWork([tab('brand-new')], [])).toBe(false)
  })
})
