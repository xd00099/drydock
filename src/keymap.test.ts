import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACTIONS, serializeChord, displayChord, effectiveKeymap, findConflict,
  validateChord, chordFor, loadOverrides, saveOverride,
} from './keymap'

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
})

describe('serializeChord', () => {
  it('lowercases letters and orders modifiers meta+ctrl+alt+shift', () => {
    expect(serializeChord(ev('T', { meta: true, shift: true }))).toBe('meta+shift+t')
    expect(serializeChord(ev('k', { meta: true }))).toBe('meta+k')
  })
  it('maps shifted punctuation back to the base key', () => {
    expect(serializeChord(ev('{', { meta: true, shift: true }))).toBe('meta+shift+[')
    expect(serializeChord(ev('}', { meta: true, shift: true }))).toBe('meta+shift+]')
  })
  it('normalizes named keys to lowercase', () => {
    expect(serializeChord(ev('Enter', { meta: true, shift: true }))).toBe('meta+shift+enter')
    expect(serializeChord(ev('ArrowLeft', { meta: true, alt: true }))).toBe('meta+alt+arrowleft')
  })
  it('returns null for modifier-only presses', () => {
    expect(serializeChord(ev('Meta', { meta: true }))).toBeNull()
    expect(serializeChord(ev('Shift', { shift: true }))).toBeNull()
  })
})

describe('displayChord', () => {
  it('renders mac glyphs in ⌃⌥⇧⌘ order', () => {
    expect(displayChord('meta+shift+j')).toBe('⇧⌘J')
    expect(displayChord('meta+alt+arrowleft')).toBe('⌥⌘←')
    expect(displayChord('meta+,')).toBe('⌘,')
    expect(displayChord('meta+shift+enter')).toBe('⇧⌘⏎')
  })
  it('renders unbound as em dash', () => {
    expect(displayChord('')).toBe('—')
  })
})

describe('effectiveKeymap', () => {
  it('maps every default chord to its action', () => {
    const m = effectiveKeymap({})
    expect(m.get('meta+k')).toBe('palette.toggle')
    expect(m.get('meta+b')).toBe('sidebar.toggle')
    expect(m.size).toBe(ACTIONS.length)
  })
  it('an override replaces the default chord entirely', () => {
    const m = effectiveKeymap({ 'sidebar.toggle': 'meta+e' })
    expect(m.get('meta+e')).toBe('sidebar.toggle')
    expect(m.get('meta+b')).toBeUndefined()
  })
  it('an unbound action ("") has no chord', () => {
    const m = effectiveKeymap({ 'sidebar.toggle': '' })
    expect(m.get('meta+b')).toBeUndefined()
    expect([...m.values()]).not.toContain('sidebar.toggle')
  })
})

describe('validateChord', () => {
  it('refuses reserved system chords', () => {
    expect(validateChord('meta+q')).toMatch(/reserved/)
    expect(validateChord('meta+c')).toMatch(/reserved/)
  })
  it('requires a non-shift modifier', () => {
    expect(validateChord('j')).toMatch(/modifier/)
    expect(validateChord('shift+j')).toMatch(/modifier/)
  })
  it('accepts a normal chord', () => {
    expect(validateChord('meta+shift+p')).toBeNull()
  })
})

describe('findConflict', () => {
  it('reports the action holding a chord', () => {
    expect(findConflict('meta+b', {}, 'briefing.toggle')).toBe('sidebar.toggle')
  })
  it('ignores the excepted action itself', () => {
    expect(findConflict('meta+b', {}, 'sidebar.toggle')).toBeNull()
  })
  it('sees overrides, not shadowed defaults', () => {
    expect(findConflict('meta+b', { 'sidebar.toggle': 'meta+e' }, 'briefing.toggle')).toBeNull()
    expect(findConflict('meta+e', { 'sidebar.toggle': 'meta+e' }, 'briefing.toggle')).toBe('sidebar.toggle')
  })
})

describe('persistence', () => {
  beforeEach(() => localStorage.removeItem('dd.keymap'))
  it('round-trips overrides and exposes chordFor', () => {
    expect(chordFor('sidebar.toggle')).toBe('meta+b')
    saveOverride('sidebar.toggle', 'meta+e')
    expect(loadOverrides()).toEqual({ 'sidebar.toggle': 'meta+e' })
    expect(chordFor('sidebar.toggle')).toBe('meta+e')
    saveOverride('sidebar.toggle', null)
    expect(loadOverrides()).toEqual({})
  })
  it('ignores corrupt JSON', () => {
    localStorage.setItem('dd.keymap', '{oops')
    expect(loadOverrides()).toEqual({})
  })
})
