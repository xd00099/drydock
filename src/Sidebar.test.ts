// Sidebar placement and the colour contract behind it.
//
// The rules under test are the ones that would fail silently: a session shown
// in two places at once, a group that hides rows it shouldn't, a palette that
// grows past what the eye can separate. Each is invisible in review and obvious
// on screen — which is exactly the kind of thing that belongs here.
import { describe, expect, it } from 'vitest'
import { capGroup, triage } from './Sidebar'
import { ageTone, projectColor } from './types'
import type { SessionView } from './types'

const DAY = 86_400_000

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    session_id: over.session_id ?? Math.random().toString(36).slice(2),
    project_path: '/Users/dev/thing',
    title: 'a session',
    name: null,
    ai_title: null,
    first_prompt: null,
    latest_recap: null,
    last_message_at: Date.now(),
    message_count: 3,
    git_branch: null,
    starred: false,
    hidden: false,
    live_status: 'ended',
    attention: null,
    folder_id: null,
    hue: null,
    ...over,
  } as SessionView
}

describe('triage', () => {
  it('puts every session in exactly one bucket', () => {
    const all = [
      session({ live_status: 'needs_input' }),
      session({ live_status: 'busy' }),
      session({ live_status: 'done' }),
      session({ live_status: 'idle' }),
      session({ live_status: 'ended' }),
    ]
    const { needs, active, rest } = triage(all)
    expect(needs.length + active.length + rest.length).toBe(all.length)
    const ids = [...needs, ...active, ...rest].map((s) => s.session_id)
    expect(new Set(ids).size).toBe(all.length)
  })

  it('floats a blocked session out even when it is starred or filed', () => {
    const blocked = session({ live_status: 'needs_input', starred: true, folder_id: 'f1' })
    const { needs, rest } = triage([blocked, session({ live_status: 'idle' })])
    expect(needs).toHaveLength(1)
    // the whole point: it must NOT also be left behind for Starred to render
    expect(rest.some((s) => s.session_id === blocked.session_id)).toBe(false)
  })

  it('keeps idle and ended sessions in their usual home', () => {
    const { needs, active, rest } = triage([
      session({ live_status: 'idle' }),
      session({ live_status: 'ended' }),
    ])
    expect(needs).toHaveLength(0)
    expect(active).toHaveLength(0)
    expect(rest).toHaveLength(2)
  })

  it('orders each section newest first', () => {
    const older = session({ live_status: 'needs_input', last_message_at: 1000 })
    const newer = session({ live_status: 'needs_input', last_message_at: 9000 })
    expect(triage([older, newer]).needs.map((s) => s.last_message_at)).toEqual([9000, 1000])
  })
})

describe('capGroup', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('shows everything up to six — hiding one row costs more than it saves', () => {
    for (const n of [0, 1, 5, 6]) {
      expect(capGroup(list(n), false)).toEqual({ shown: list(n), hidden: 0 })
    }
  })

  it('caps at five once there are seven or more', () => {
    expect(capGroup(list(7), false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 2 })
    expect(capGroup(list(40), false).hidden).toBe(35)
  })

  it('shows the whole group once expanded', () => {
    expect(capGroup(list(40), true)).toEqual({ shown: list(40), hidden: 0 })
  })

  it('never drops a row: shown + hidden always accounts for the group', () => {
    for (const n of [0, 3, 6, 7, 23, 100]) {
      const { shown, hidden } = capGroup(list(n), false)
      expect(shown.length + hidden).toBe(n)
    }
  })
})

describe('projectColor', () => {
  it('is stable for a path and identical across surfaces', () => {
    expect(projectColor('/Users/dev/alpha')).toBe(projectColor('/Users/dev/alpha'))
  })

  it('only ever emits the six measured anchors', () => {
    // six because at 30% saturation the minimum CIEDE2000 between six evenly
    // spaced hues is 15.8; eight collapses to 8.6, below naming resolution
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(projectColor(`/Users/dev/p${i}`))
    expect(seen.size).toBeLessThanOrEqual(6)
    for (const c of seen) expect(c).toMatch(/^hsl\((15|75|135|195|255|315), 30%, 52%\)$/)
  })

  it('stays low chroma — the loud end of the range belongs to state', () => {
    for (let i = 0; i < 50; i++) {
      expect(projectColor(`/Users/dev/p${i}`)).toContain('30%')
    }
  })

  it('degrades to a neutral rather than inventing a colour', () => {
    expect(projectColor(null)).toBe('var(--dd-accent-muted)')
    expect(projectColor(undefined, 0.3)).toBe('transparent')
    expect(projectColor('')).toBe('var(--dd-accent-muted)')
  })

  it('passes alpha through for tints', () => {
    expect(projectColor('/Users/dev/alpha', 0.12)).toMatch(/^hsla\(\d+, 30%, 52%, 0\.12\)$/)
  })
})

describe('ageTone', () => {
  const now = 1_700_000_000_000
  it('steps down exactly three times as a session ages', () => {
    expect(ageTone(now - 60_000, now)).toBe('var(--dd-text)')
    expect(ageTone(now - 2 * DAY, now)).toBe('var(--dd-text1)')
    expect(ageTone(now - 30 * DAY, now)).toBe('var(--dd-text2)')
  })

  it('treats a session with no timestamp as ancient, not as brand new', () => {
    expect(ageTone(null, now)).toBe('var(--dd-text2)')
  })

  it('is monotonic: older never reads brighter', () => {
    const rank = ['var(--dd-text)', 'var(--dd-text1)', 'var(--dd-text2)']
    let prev = 0
    for (const days of [0, 0.5, 1, 3, 7, 30, 400]) {
      const i = rank.indexOf(ageTone(now - days * DAY, now))
      expect(i).toBeGreaterThanOrEqual(prev)
      prev = i
    }
  })
})
