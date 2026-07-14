// Theme plumbing. The CSS tokens in index.css do the actual theming — this
// module just decides WHICH set applies (the html[data-theme] attribute) and
// mirrors the palette for the one consumer that can't read CSS variables:
// xterm's canvas/WebGL renderer.
import { getSetting, SETTINGS_EVENT } from './settings'

export type ThemePref = 'dark' | 'light' | 'system'

/** Fired after the data-theme attribute changes; TerminalPane re-themes on it. */
export const THEME_EVENT = 'dd-theme-applied'

export function themePref(): ThemePref {
  const v = getSetting('theme', 'dark')
  return v === 'light' || v === 'system' ? v : 'dark'
}

export function resolvedTheme(): 'dark' | 'light' {
  const pref = themePref()
  if (pref !== 'system') return pref
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme() {
  const t = resolvedTheme()
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t
    window.dispatchEvent(new CustomEvent(THEME_EVENT))
  }
}

/** Call once before the first render (main.tsx): sets the attribute and keeps
 *  it in sync with both the Appearance setting and macOS appearance flips. */
export function initTheme() {
  applyTheme()
  window.addEventListener(SETTINGS_EVENT, applyTheme)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme)
}

// xterm palettes. Dark is the exact palette TerminalPane shipped with; light
// is a standard light-terminal counterpart (dark text, white page, ANSI hues
// darkened enough to read on white).
const XTERM_DARK = {
  background: '#10141a',
  foreground: '#c8cdd5',
  cursor: '#7fb0ff',
  cursorAccent: '#10141a',
  selectionBackground: '#3d5878',
  selectionInactiveBackground: '#2c3647',
  black: '#1d2530',
  red: '#cf6b6b',
  green: '#7ec8a0',
  yellow: '#e8c35a',
  blue: '#7fb0ff',
  magenta: '#c792ea',
  cyan: '#7ecfc0',
  white: '#c8cdd5',
  brightBlack: '#5b6675',
  brightRed: '#e8907a',
  brightGreen: '#a3dcbd',
  brightYellow: '#f0d38a',
  brightBlue: '#9cc3ff',
  brightMagenta: '#dab6f4',
  brightCyan: '#a2e0d5',
  brightWhite: '#e8edf4',
}

const XTERM_LIGHT = {
  background: '#ffffff',
  foreground: '#1a2330',
  cursor: '#2f6bd8',
  cursorAccent: '#ffffff',
  selectionBackground: '#b9d0f0',
  selectionInactiveBackground: '#d8dee7',
  black: '#1a2330',
  red: '#b03030',
  green: '#1f7a4d',
  yellow: '#9a6d00',
  blue: '#2456b8',
  magenta: '#8a4bbf',
  cyan: '#177a6c',
  white: '#8391a2',
  brightBlack: '#4c5a6c',
  brightRed: '#c23f3f',
  brightGreen: '#22996a',
  brightYellow: '#a8820a',
  brightBlue: '#2f6bd8',
  brightMagenta: '#a86ad0',
  brightCyan: '#1d9484',
  brightWhite: '#0d1420',
}

export function getXtermTheme() {
  return resolvedTheme() === 'light' ? XTERM_LIGHT : XTERM_DARK
}
