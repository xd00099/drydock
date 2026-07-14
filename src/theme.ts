// Theme plumbing. The CSS tokens in index.css do the actual theming — this
// module just decides WHICH set applies (the html[data-theme] attribute) and
// mirrors each palette for the one consumer that can't read CSS variables:
// xterm's canvas/WebGL renderer.
import { getSetting, SETTINGS_EVENT } from './settings'

export type ThemeId =
  | 'dark' | 'light'
  | 'dracula' | 'nord' | 'one-dark' | 'solarized-dark' | 'solarized-light'
export type ThemePref = ThemeId | 'system'

/** Fired after the data-theme attribute changes; TerminalPane re-themes on it. */
export const THEME_EVENT = 'dd-theme-applied'

// The pickable themes, in display order. `preview` carries concrete hexes for
// the Appearance cards — swatches must show THEIR theme's colors, not the
// active theme's tokens. 'dark' is the :root block in index.css; every other
// id has an html[data-theme] block there.
export const THEMES: {
  id: ThemeId
  label: string
  desc: string
  dark: boolean
  preview: { bg: string; text: string; dots: [string, string, string] }
}[] = [
  { id: 'dark', label: 'Dark', desc: 'The original Drydock palette.', dark: true,
    preview: { bg: '#10141a', text: '#c8cdd5', dots: ['#7fb0ff', '#7ec8a0', '#cf6b6b'] } },
  { id: 'light', label: 'Light', desc: 'Bright chrome, dark text.', dark: false,
    preview: { bg: '#ffffff', text: '#2d3949', dots: ['#2f6bd8', '#1f8a5a', '#c23f3f'] } },
  { id: 'dracula', label: 'Dracula', desc: 'Purple neon on charcoal.', dark: true,
    preview: { bg: '#282a36', text: '#f8f8f2', dots: ['#bd93f9', '#50fa7b', '#ff5555'] } },
  { id: 'nord', label: 'Nord', desc: 'Arctic blues, muted aurora.', dark: true,
    preview: { bg: '#2e3440', text: '#d8dee9', dots: ['#88c0d0', '#a3be8c', '#bf616a'] } },
  { id: 'one-dark', label: 'One Dark', desc: 'Atom’s editor staple.', dark: true,
    preview: { bg: '#282c34', text: '#abb2bf', dots: ['#61afef', '#98c379', '#e06c75'] } },
  { id: 'solarized-dark', label: 'Solarized Dark', desc: 'The deep-sea classic.', dark: true,
    preview: { bg: '#002b36', text: '#93a1a1', dots: ['#268bd2', '#859900', '#dc322f'] } },
  { id: 'solarized-light', label: 'Solarized Light', desc: 'The warm-paper classic.', dark: false,
    preview: { bg: '#fdf6e3', text: '#586e75', dots: ['#268bd2', '#859900', '#dc322f'] } },
]

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id))

export function themePref(): ThemePref {
  const v = getSetting('theme', 'dark')
  return v === 'system' || THEME_IDS.has(v) ? (v as ThemePref) : 'dark'
}

export function resolvedTheme(): ThemeId {
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
// is a standard light-terminal counterpart. The named themes use their
// canonical ANSI-16 palettes (as shipped in iTerm2/VS Code), with bright-black
// lifted where the canonical value would vanish into the background.
type XtermPalette = {
  background: string; foreground: string; cursor: string; cursorAccent: string
  selectionBackground: string; selectionInactiveBackground: string
  black: string; red: string; green: string; yellow: string
  blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}

export const XTERM: Record<ThemeId, XtermPalette> = {
  dark: {
    background: '#10141a', foreground: '#c8cdd5', cursor: '#7fb0ff', cursorAccent: '#10141a',
    selectionBackground: '#3d5878', selectionInactiveBackground: '#2c3647',
    black: '#1d2530', red: '#cf6b6b', green: '#7ec8a0', yellow: '#e8c35a',
    blue: '#7fb0ff', magenta: '#c792ea', cyan: '#7ecfc0', white: '#c8cdd5',
    brightBlack: '#7d8794', brightRed: '#e8907a', brightGreen: '#a3dcbd', brightYellow: '#f0d38a',
    brightBlue: '#9cc3ff', brightMagenta: '#dab6f4', brightCyan: '#a2e0d5', brightWhite: '#e8edf4',
  },
  light: {
    background: '#ffffff', foreground: '#1a2330', cursor: '#2f6bd8', cursorAccent: '#ffffff',
    selectionBackground: '#b9d0f0', selectionInactiveBackground: '#d8dee7',
    black: '#1a2330', red: '#b03030', green: '#1f7a4d', yellow: '#9a6d00',
    blue: '#2456b8', magenta: '#8a4bbf', cyan: '#177a6c', white: '#8391a2',
    brightBlack: '#4c5a6c', brightRed: '#c23f3f', brightGreen: '#22996a', brightYellow: '#a8820a',
    brightBlue: '#2f6bd8', brightMagenta: '#a86ad0', brightCyan: '#1d9484', brightWhite: '#0d1420',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
    selectionBackground: '#44475a', selectionInactiveBackground: '#363948',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
    brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', cursorAccent: '#2e3440',
    selectionBackground: '#434c5e', selectionInactiveBackground: '#3b4252',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#d1747d', brightGreen: '#b4cf9f', brightYellow: '#f0d8a3',
    brightBlue: '#94b2d1', brightMagenta: '#c49dbd', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  'one-dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#61afef', cursorAccent: '#282c34',
    selectionBackground: '#3e4451', selectionInactiveBackground: '#333842',
    black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#ef8189', brightGreen: '#a9d48d', brightYellow: '#ecd09b',
    brightBlue: '#85c4f4', brightMagenta: '#d7a1e7', brightCyan: '#7cc9d3', brightWhite: '#e6e6e6',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#93a1a1', cursor: '#268bd2', cursorAccent: '#002b36',
    selectionBackground: '#0e4a5a', selectionInactiveBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#e35d5b', brightGreen: '#a3b81a', brightYellow: '#d1a821',
    brightBlue: '#4ba3e3', brightMagenta: '#e05a9d', brightCyan: '#3cc4b8', brightWhite: '#fdf6e3',
  },
  'solarized-light': {
    background: '#fdf6e3', foreground: '#586e75', cursor: '#268bd2', cursorAccent: '#fdf6e3',
    selectionBackground: '#d5cba8', selectionInactiveBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
    brightBlack: '#657b83', brightRed: '#cb4b16', brightGreen: '#6f8500', brightYellow: '#8f6f04',
    brightBlue: '#1e6fa8', brightMagenta: '#b3286b', brightCyan: '#1f8a80', brightWhite: '#073642',
  },
}

export function getXtermTheme() {
  return XTERM[resolvedTheme()]
}

/** ⌘F match decoration colors. Also consumed by xterm's own color parser
 *  (NOT the DOM), so these must be concrete hexes, resolved per theme at
 *  call time. Dark values match the shipped ones. */
const SEARCH: Record<ThemeId, { match: string; active: string }> = {
  dark: { match: '#3a4656', active: '#e8c35a' },
  light: { match: '#c8d4e4', active: '#e6c74f' },
  dracula: { match: '#44475a', active: '#f1fa8c' },
  nord: { match: '#434c5e', active: '#ebcb8b' },
  'one-dark': { match: '#3e4451', active: '#e5c07b' },
  'solarized-dark': { match: '#155163', active: '#d1a821' },
  'solarized-light': { match: '#d5cba8', active: '#e3c04a' },
}

export function getSearchDecorations() {
  const s = SEARCH[resolvedTheme()]
  return {
    matchBackground: s.match,
    matchOverviewRuler: s.match,
    activeMatchBackground: s.active,
    activeMatchColorOverviewRuler: s.active,
  }
}
