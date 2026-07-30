// Theme plumbing. The CSS tokens in index.css do the actual theming — this
// module just decides WHICH set applies (the html[data-theme] attribute) and
// mirrors each palette for the one consumer that can't read CSS variables:
// xterm's canvas/WebGL renderer.
import { getSetting, SETTINGS_EVENT } from './settings'

export type ThemeId =
  | 'dark' | 'light'
  | 'dracula' | 'nord' | 'one-dark' | 'solarized-dark' | 'solarized-light'
  | 'gruvbox' | 'tokyo-night' | 'catppuccin' | 'rose-pine' | 'vesper' | 'kanagawa'
  | 'gruvbox-light' | 'tokyo-day' | 'catppuccin-latte' | 'rose-pine-dawn' | 'one-light' | 'kanagawa-lotus'
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
  { id: 'gruvbox', label: 'Gruvbox', desc: 'Retro groove, warm and low-key.', dark: true,
    preview: { bg: '#282828', text: '#ebdbb2', dots: ['#83a598', '#b8bb26', '#fb4934'] } },
  { id: 'tokyo-night', label: 'Tokyo Night', desc: 'Neon blues on midnight indigo.', dark: true,
    preview: { bg: '#24283b', text: '#a9b1d6', dots: ['#7aa2f7', '#9ece6a', '#f7768e'] } },
  { id: 'catppuccin', label: 'Catppuccin', desc: 'Soft pastels on inky violet.', dark: true,
    preview: { bg: '#1e1e2e', text: '#cdd6f4', dots: ['#89b4fa', '#a6e3a1', '#f38ba8'] } },
  { id: 'rose-pine', label: 'Rosé Pine', desc: 'Muted pastels on inky plum.', dark: true,
    preview: { bg: '#191724', text: '#e0def4', dots: ['#c4a7e7', '#31748f', '#eb6f92'] } },
  { id: 'vesper', label: 'Vesper', desc: 'Austere near-black, one amber.', dark: true,
    preview: { bg: '#101010', text: '#e4e1dd', dots: ['#ffc799', '#99ffe4', '#ff8080'] } },
  { id: 'kanagawa', label: 'Kanagawa', desc: 'Ink-wash blues on sumi black.', dark: true,
    preview: { bg: '#1f1f28', text: '#dcd7ba', dots: ['#7e9cd8', '#98bb6c', '#e46876'] } },
  { id: 'gruvbox-light', label: 'Gruvbox Light', desc: 'Retro groove on warm cream.', dark: false,
    preview: { bg: '#fbf1c7', text: '#3c3836', dots: ['#458588', '#79740e', '#cc241d'] } },
  { id: 'tokyo-day', label: 'Tokyo Day', desc: 'Tokyo blues on daylight grey.', dark: false,
    preview: { bg: '#e1e2e7', text: '#2b5199', dots: ['#2e7de9', '#587539', '#f52a65'] } },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', desc: 'The pastel palette in daylight.', dark: false,
    preview: { bg: '#eff1f5', text: '#4c4f69', dots: ['#1e66f5', '#40a02b', '#d20f39'] } },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', desc: 'Soft pastels on warm paper.', dark: false,
    preview: { bg: '#faf4ed', text: '#575279', dots: ['#907aa9', '#286983', '#b4637a'] } },
  { id: 'one-light', label: 'One Light', desc: 'Atom’s staple, in daylight.', dark: false,
    preview: { bg: '#fafafa', text: '#383a42', dots: ['#4078f2', '#50a14f', '#e45649'] } },
  { id: 'kanagawa-lotus', label: 'Kanagawa Lotus', desc: 'Wave palette on lotus paper.', dark: false,
    preview: { bg: '#f2ecbc', text: '#545464', dots: ['#4d699b', '#6f894e', '#c84053'] } },
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
  'gruvbox': {
    background: '#282828', foreground: '#ebdbb2', cursor: '#83a598', cursorAccent: '#282828',
    selectionBackground: '#504945', selectionInactiveBackground: '#3c3836',
    black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921',
    blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
    brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
  'tokyo-night': {
    background: '#24283b', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#24283b',
    selectionBackground: '#2e3c64', selectionInactiveBackground: '#292e42',
    black: '#1d202f', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#565f89', brightRed: '#ff899d', brightGreen: '#9fe044', brightYellow: '#faba4a',
    brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#c0caf5',
  },
  'catppuccin': {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70', selectionInactiveBackground: '#45475a',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#6c7086', brightRed: '#eba0ac', brightGreen: '#b7e8b4', brightYellow: '#fae8bf',
    brightBlue: '#b4befe', brightMagenta: '#f7ceec', brightCyan: '#89dceb', brightWhite: '#cdd6f4',
  },
  'rose-pine': {
    background: '#191724', foreground: '#e0def4', cursor: '#c4a7e7', cursorAccent: '#191724',
    selectionBackground: '#403d52', selectionInactiveBackground: '#2d2a44',
    black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
    blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
    brightBlack: '#6e6a86', brightRed: '#f28ba8', brightGreen: '#4b9ab5', brightYellow: '#f9d49f',
    brightBlue: '#b5dde4', brightMagenta: '#d5bcf0', brightCyan: '#f2cfcd', brightWhite: '#f0eefc',
  },
  'vesper': {
    background: '#101010', foreground: '#ffffff', cursor: '#ffc799', cursorAccent: '#101010',
    selectionBackground: '#343434', selectionInactiveBackground: '#232323',
    black: '#1c1c1c', red: '#ff8080', green: '#99ffe4', yellow: '#ead290',
    blue: '#ffc799', magenta: '#c6a8dc', cyan: '#93cbd7', white: '#e4e1dd',
    brightBlack: '#7e7e7e', brightRed: '#ffa0a0', brightGreen: '#b8ffec', brightYellow: '#f1dda7',
    brightBlue: '#ffcfa8', brightMagenta: '#d5bde7', brightCyan: '#aadae3', brightWhite: '#ffffff',
  },
  'kanagawa': {
    background: '#1f1f28', foreground: '#dcd7ba', cursor: '#7e9cd8', cursorAccent: '#1f1f28',
    selectionBackground: '#2d4f67', selectionInactiveBackground: '#223249',
    black: '#16161d', red: '#c34043', green: '#76946a', yellow: '#c0a36e',
    blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
    brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384',
    brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
  },
  'gruvbox-light': {
    background: '#fbf1c7', foreground: '#3c3836', cursor: '#458588', cursorAccent: '#fbf1c7',
    selectionBackground: '#d5c4a1', selectionInactiveBackground: '#ebdbb2',
    black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921',
    blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
    brightBlack: '#665c54', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614',
    brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#282828',
  },
  'tokyo-day': {
    background: '#e1e2e7', foreground: '#3760bf', cursor: '#3760bf', cursorAccent: '#e1e2e7',
    selectionBackground: '#b7c1e3', selectionInactiveBackground: '#c4c8da',
    black: '#343b58', red: '#f52a65', green: '#587539', yellow: '#8c6c3e',
    blue: '#2e7de9', magenta: '#9854f1', cyan: '#007197', white: '#6172b0',
    brightBlack: '#68709a', brightRed: '#ff4774', brightGreen: '#5c8524', brightYellow: '#a27629',
    brightBlue: '#358aff', brightMagenta: '#a463ff', brightCyan: '#007ea8', brightWhite: '#3760bf',
  },
  'catppuccin-latte': {
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be', selectionInactiveBackground: '#ccd0da',
    black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#9ca0b0',
    brightBlack: '#7c7f93', brightRed: '#a30b2c', brightGreen: '#317c21', brightYellow: '#ad6e16',
    brightBlue: '#174fbf', brightMagenta: '#b65c9e', brightCyan: '#117177', brightWhite: '#4c4f69',
  },
  'rose-pine-dawn': {
    background: '#faf4ed', foreground: '#575279', cursor: '#907aa9', cursorAccent: '#faf4ed',
    selectionBackground: '#dfdad9', selectionInactiveBackground: '#e6ddd8',
    black: '#575279', red: '#b4637a', green: '#286983', yellow: '#c07d1a',
    blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#9893a5',
    brightBlack: '#797593', brightRed: '#a04f66', brightGreen: '#1f5670', brightYellow: '#b0741a',
    brightBlue: '#427c88', brightMagenta: '#7a6293', brightCyan: '#bd6a66', brightWhite: '#453f5f',
  },
  'one-light': {
    background: '#fafafa', foreground: '#383a42', cursor: '#4078f2', cursorAccent: '#fafafa',
    selectionBackground: '#e5e5e6', selectionInactiveBackground: '#ececed',
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
    blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
    brightBlack: '#696c77', brightRed: '#ca1243', brightGreen: '#3e7b3d', brightYellow: '#986801',
    brightBlue: '#2f61d6', brightMagenta: '#8d208c', brightCyan: '#016e9d', brightWhite: '#2b2d33',
  },
  'kanagawa-lotus': {
    background: '#f2ecbc', foreground: '#545464', cursor: '#4d699b', cursorAccent: '#f2ecbc',
    selectionBackground: '#c9cbd1', selectionInactiveBackground: '#dcdde2',
    black: '#1f1f28', red: '#c84053', green: '#6f894e', yellow: '#77713f',
    blue: '#4d699b', magenta: '#b35b79', cyan: '#597b75', white: '#545464',
    brightBlack: '#716e61', brightRed: '#d7474b', brightGreen: '#6e915f', brightYellow: '#836f4a',
    brightBlue: '#6693bf', brightMagenta: '#624c83', brightCyan: '#5e857a', brightWhite: '#43436c',
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
  'gruvbox': { match: '#504945', active: '#fabd2f' },
  'tokyo-night': { match: '#2e3c64', active: '#faba4a' },
  'catppuccin': { match: '#585b70', active: '#f9e2af' },
  'rose-pine': { match: '#403d52', active: '#f6c177' },
  'vesper': { match: '#343434', active: '#ffc799' },
  'kanagawa': { match: '#2d4f67', active: '#e6c384' },
  'gruvbox-light': { match: '#d5c4a1', active: '#fabd2f' },
  'tokyo-day': { match: '#b7c1e3', active: '#e6c168' },
  'catppuccin-latte': { match: '#acb0be', active: '#df8e1d' },
  'rose-pine-dawn': { match: '#dfdad9', active: '#ea9d34' },
  'one-light': { match: '#dbdbdc', active: '#f4b734' },
  'kanagawa-lotus': { match: '#b5cbd2', active: '#e9c46b' },
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
