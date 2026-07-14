import { describe, it, expect, beforeEach } from 'vitest'
import { getSetting, setSetting } from './settings'

describe('settings', () => {
  beforeEach(() => localStorage.removeItem('dd.notifyEnabled'))
  it('returns the default when unset', () => {
    expect(getSetting('notifyEnabled', '1')).toBe('1')
  })
  it('round-trips a value', () => {
    setSetting('notifyEnabled', '0')
    expect(getSetting('notifyEnabled', '1')).toBe('0')
  })
})
