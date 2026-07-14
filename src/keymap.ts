// Keyboard shortcut registry — the single source of truth for every app-level
// chord. The window dispatcher (App.tsx), the Settings → Shortcuts tab, and
// hint strings all read from here. Normalized chord form: modifiers in
// meta+ctrl+alt+shift order, then the key; letters lowercased; shifted
// punctuation mapped back to its base key (the browser reports '{' for ⇧[,
// which must match a registry entry that says 'meta+shift+['). ⌘1–9 tab
// switching is a fixed family handled directly by the dispatcher, not listed
// here — rebinding a 9-chord family is complexity with no payoff.
import { useEffect, useReducer } from 'react'

export type ActionId =
  | 'palette.toggle' | 'home.show' | 'find.open' | 'shell.new' | 'transcript.toggle'
  | 'tab.close' | 'session.star' | 'pane.zoom'
  | 'pane.focus.left' | 'pane.focus.right' | 'pane.focus.up' | 'pane.focus.down'
  | 'session.new' | 'sidebar.toggle' | 'briefing.toggle' | 'briefing.preview'
  | 'settings.toggle' | 'tab.prev' | 'tab.next'

export type Category = 'General' | 'Tabs' | 'Panels' | 'Panes'
export type ActionDef = { id: ActionId; label: string; category: Category; default: string }
export type ChordEvent = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export const KEYMAP_EVENT = 'dd-keymap-changed'

export const ACTIONS: ActionDef[] = [
  { id: 'palette.toggle', label: 'Search sessions', category: 'General', default: 'meta+k' },
  { id: 'home.show', label: 'Go Home', category: 'General', default: 'meta+0' },
  { id: 'find.open', label: 'Find in pane', category: 'General', default: 'meta+f' },
  { id: 'settings.toggle', label: 'Settings', category: 'General', default: 'meta+,' },
  { id: 'session.new', label: 'New claude session…', category: 'General', default: 'meta+n' },
  { id: 'shell.new', label: 'New shell tab', category: 'Tabs', default: 'meta+t' },
  { id: 'tab.close', label: 'Close tab', category: 'Tabs', default: 'meta+w' },
  { id: 'transcript.toggle', label: 'Terminal ⇄ transcript', category: 'Tabs', default: 'meta+shift+t' },
  { id: 'session.star', label: 'Star session', category: 'Tabs', default: 'meta+d' },
  { id: 'tab.prev', label: 'Previous tab', category: 'Tabs', default: 'meta+shift+[' },
  { id: 'tab.next', label: 'Next tab', category: 'Tabs', default: 'meta+shift+]' },
  { id: 'sidebar.toggle', label: 'Toggle sidebar', category: 'Panels', default: 'meta+b' },
  { id: 'briefing.toggle', label: 'Toggle briefing panel', category: 'Panels', default: 'meta+j' },
  { id: 'briefing.preview', label: 'Go to artifact preview', category: 'Panels', default: 'meta+shift+j' },
  { id: 'pane.zoom', label: 'Zoom pane', category: 'Panes', default: 'meta+shift+enter' },
  { id: 'pane.focus.left', label: 'Focus pane left', category: 'Panes', default: 'meta+alt+arrowleft' },
  { id: 'pane.focus.right', label: 'Focus pane right', category: 'Panes', default: 'meta+alt+arrowright' },
  { id: 'pane.focus.up', label: 'Focus pane above', category: 'Panes', default: 'meta+alt+arrowup' },
  { id: 'pane.focus.down', label: 'Focus pane below', category: 'Panes', default: 'meta+alt+arrowdown' },
]

// With ⇧ held the browser reports the shifted character; chords store the base
// key so what the user pressed matches what the registry says. US layout.
const SHIFTED: Record<string, string> = {
  '{': '[', '}': ']', '<': ',', '>': '.', '?': '/', ':': ';', '"': "'",
  '|': '\\', '+': '=', '_': '-', '~': '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

export function serializeChord(e: ChordEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = e.key.length === 1 ? (SHIFTED[e.key] ?? e.key.toLowerCase()) : e.key.toLowerCase()
  const mods = [e.metaKey && 'meta', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean)
  return [...mods, key].join('+')
}

const GLYPH: Record<string, string> = {
  enter: '⏎', escape: '⎋', backspace: '⌫', delete: '⌦', tab: '⇥', ' ': '␣',
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
}

export function displayChord(chord: string): string {
  if (!chord) return '—'
  const parts = chord.split('+')
  const key = parts[parts.length - 1]
  const has = (m: string) => parts.includes(m)
  // mac convention renders ⌃⌥⇧⌘ regardless of the storage order
  return (
    (has('ctrl') ? '⌃' : '') + (has('alt') ? '⌥' : '') + (has('shift') ? '⇧' : '') + (has('meta') ? '⌘' : '') +
    (GLYPH[key] ?? key.toUpperCase())
  )
}

export function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem('dd.keymap')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

export function saveOverride(id: ActionId, chord: string | null) {
  const overrides = loadOverrides()
  if (chord === null) delete overrides[id]
  else overrides[id] = chord
  localStorage.setItem('dd.keymap', JSON.stringify(overrides))
  window.dispatchEvent(new CustomEvent(KEYMAP_EVENT))
}

/** chord → action, defaults overlaid with user overrides ('' = unbound). */
export function effectiveKeymap(overrides: Record<string, string>): Map<string, ActionId> {
  const m = new Map<string, ActionId>()
  for (const a of ACTIONS) {
    const chord = overrides[a.id] ?? a.default
    if (chord) m.set(chord, a.id)
  }
  return m
}

export function chordFor(id: ActionId): string {
  const overrides = loadOverrides()
  return overrides[id] ?? ACTIONS.find((a) => a.id === id)!.default
}

export function findConflict(chord: string, overrides: Record<string, string>, exceptId: ActionId): ActionId | null {
  for (const a of ACTIONS) {
    if (a.id === exceptId) continue
    if ((overrides[a.id] ?? a.default) === chord) return a.id
  }
  return null
}

// Terminal/system essentials that rebinding must never take.
const RESERVED = new Set(['meta+q', 'meta+c', 'meta+v', 'meta+x', 'meta+a', 'meta+z'])

export function validateChord(chord: string): string | null {
  if (RESERVED.has(chord)) return `${displayChord(chord)} is reserved`
  const parts = chord.split('+')
  if (!parts.includes('meta') && !parts.includes('ctrl') && !parts.includes('alt'))
    return 'needs a modifier (⌘, ⌃, or ⌥)'
  return null
}

export function actionLabel(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)!.label
}

/** Live display string for tooltips/hints — re-renders on rebind. */
export function useChord(id: ActionId): string {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener(KEYMAP_EVENT, force)
    return () => window.removeEventListener(KEYMAP_EVENT, force)
  }, [])
  return displayChord(chordFor(id))
}
