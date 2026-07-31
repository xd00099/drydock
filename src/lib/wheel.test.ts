import { describe, expect, it } from 'vitest'
import { MAX_WHEEL_ROWS, wheelRows } from '@/lib/wheel'

const CELL = 17 // a typical row height in CSS pixels

describe('wheelRows', () => {
  it('scales a mouse notch to the rows it actually asked for', () => {
    // THE BUG this fixes: xterm handed one wheel report to the program however
    // far the gesture reached, so a ~120px WKWebView notch — seven rows — moved
    // the view a single step.
    expect(wheelRows(120, CELL, 0).rows).toBe(7)
    expect(wheelRows(-120, CELL, 0).rows).toBe(-7)
  })

  it('banks sub-row deltas instead of dropping them', () => {
    // A trackpad sends a few pixels at a time. Truncating each event on its own
    // floors every one to zero and the view never moves.
    let carry = 0
    let moved = 0
    for (let i = 0; i < 10; i++) {
      const r = wheelRows(5, CELL, carry)
      carry = r.carry
      moved += r.rows
    }
    expect(moved).toBe(2) // 50px ≈ 2.9 rows → 2 whole ones, 0.9 still banked
    expect(carry).toBeGreaterThan(0.8)
  })

  it('caps a fling so one event cannot fire an unbounded burst', () => {
    expect(wheelRows(10_000, CELL, 0).rows).toBe(MAX_WHEEL_ROWS)
    expect(wheelRows(-10_000, CELL, 0).rows).toBe(-MAX_WHEEL_ROWS)
  })

  it('does not turn a reversal into travel the user never asked for', () => {
    // 0.9 rows banked downward, then a flick upward: the answer must be up, not
    // a down-row that the old remainder rounded into existence.
    const { rows } = wheelRows(-120, CELL, 0.9)
    expect(rows).toBeLessThan(0)
  })

  it('survives being asked before layout settles', () => {
    // host.clientHeight / term.rows is 0 or NaN for a frame on mount; dividing by
    // it would send a garbage burst.
    expect(wheelRows(120, 0, 0)).toEqual({ rows: 0, carry: 0 })
    expect(wheelRows(120, NaN, 0)).toEqual({ rows: 0, carry: 0 })
  })

  it('keeps direction attached to the sign of the delta', () => {
    expect(wheelRows(CELL * 3, CELL, 0).rows).toBe(3)
    expect(wheelRows(-CELL * 3, CELL, 0).rows).toBe(-3)
  })
})
