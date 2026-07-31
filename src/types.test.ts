// The quit-guard decision. The bug being pinned: the old guard fired for ANY
// live tab, so a wall of idle sessions — the normal state of this app — nagged
// on every ⌘Q and taught the user to click through the one dialog that
// sometimes matters.
import { describe, expect, it } from 'vitest'
import { quitInterruptsWork } from './types'
import type { SessionView } from './types'

const tab = (sessionId: string | null, exited = false) => ({ sessionId, exited })
const sess = (id: string, live_status: SessionView['live_status']) =>
  ({ session_id: id, live_status }) as SessionView

describe('quitInterruptsWork', () => {
  it('idle, waiting and finished sessions quit silently — they all resume', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const sessions = [sess('a', 'idle'), sess('b', 'needs_input'), sess('c', 'done')]
    expect(quitInterruptsWork(tabs, sessions)).toBe(false)
  })

  it('a busy session in a live tab is the one case that confirms', () => {
    expect(quitInterruptsWork([tab('a'), tab('b')], [sess('a', 'idle'), sess('b', 'busy')])).toBe(true)
  })

  it('a busy session whose tab already exited has nothing left to interrupt', () => {
    expect(quitInterruptsWork([tab('a', true)], [sess('a', 'busy')])).toBe(false)
  })

  it('a busy session NOT open in any tab is owned elsewhere — quitting spares it', () => {
    // takeover semantics: Drydock only kills its own PTYs on quit
    expect(quitInterruptsWork([tab('a')], [sess('a', 'idle'), sess('other', 'busy')])).toBe(false)
  })

  it('shell tabs and empty tab lists never confirm', () => {
    expect(quitInterruptsWork([tab(null)], [])).toBe(false)
    expect(quitInterruptsWork([], [sess('a', 'busy')])).toBe(false)
  })

  it('a session the index has not seen yet quits silently (documented trade)', () => {
    expect(quitInterruptsWork([tab('brand-new')], [])).toBe(false)
  })
})
