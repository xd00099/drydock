// Theme registry ⇄ index.css contract. A theme that misses a token silently
// falls through to the :root (dark) value — invisible in code review, glaring
// on screen — so completeness is enforced here instead.
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEMES, XTERM, getSearchDecorations, getXtermTheme, themePref } from './theme'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')

const tokenNames = (block: string) => new Set([...block.matchAll(/--dd-[\w-]+(?=\s*:)/g)].map((m) => m[0]))

const rootBlock = css.match(/:root\s*\{([^}]*)\}/)![1]
const cssBlocks: Record<string, string> = {}
for (const m of css.matchAll(/html\[data-theme='([\w-]+)'\]\s*\{([^}]*)\}/g)) cssBlocks[m[1]] = m[2]

describe('theme CSS blocks', () => {
  it('every registered theme except dark has a data-theme block, and no orphan blocks exist', () => {
    const expected = THEMES.filter((t) => t.id !== 'dark').map((t) => t.id).sort()
    expect(Object.keys(cssBlocks).sort()).toEqual(expected)
  })

  it('every theme block defines exactly the :root token set', () => {
    const root = tokenNames(rootBlock)
    expect(root.size).toBeGreaterThan(40)
    for (const [id, block] of Object.entries(cssBlocks)) {
      const own = tokenNames(block)
      const missing = [...root].filter((t) => !own.has(t))
      const extra = [...own].filter((t) => !root.has(t))
      expect({ id, missing, extra }).toEqual({ id, missing: [], extra: [] })
    }
  })

  it('color-scheme matches each theme’s dark flag', () => {
    for (const t of THEMES) {
      if (t.id === 'dark') continue
      expect({ id: t.id, scheme: cssBlocks[t.id].match(/color-scheme:\s*(\w+)/)?.[1] })
        .toEqual({ id: t.id, scheme: t.dark ? 'dark' : 'light' })
    }
  })
})

describe('xterm palettes', () => {
  it('every theme has a full palette of concrete hexes', () => {
    const keys = Object.keys(XTERM.dark).sort()
    for (const t of THEMES) {
      const p = XTERM[t.id] as Record<string, string>
      expect(Object.keys(p).sort()).toEqual(keys)
      for (const [k, v] of Object.entries(p)) {
        expect(v, `${t.id}.${k}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('background matches the theme’s dark flag', () => {
    for (const t of THEMES) {
      // crude luminance split: dark themes stay under 50% red channel
      const r = parseInt(XTERM[t.id].background.slice(1, 3), 16)
      expect(r < 128, `${t.id} background ${XTERM[t.id].background}`).toBe(t.dark)
    }
  })
})

describe('theme selection', () => {
  beforeEach(() => localStorage.clear())

  it('falls back to dark on an unknown stored value', () => {
    localStorage.setItem('dd.theme', 'hotdog-stand')
    expect(themePref()).toBe('dark')
  })

  it('accepts every registered theme id and system', () => {
    for (const t of THEMES) {
      localStorage.setItem('dd.theme', t.id)
      expect(themePref()).toBe(t.id)
    }
    localStorage.setItem('dd.theme', 'system')
    expect(themePref()).toBe('system')
  })

  it('resolves the xterm palette and search decorations for the picked theme', () => {
    localStorage.setItem('dd.theme', 'dracula')
    expect(getXtermTheme().background).toBe('#282a36')
    expect(getSearchDecorations().activeMatchBackground).toBe('#f1fa8c')
    localStorage.setItem('dd.theme', 'solarized-light')
    expect(getXtermTheme().background).toBe('#fdf6e3')
    expect(getSearchDecorations().matchBackground).toBe('#d5cba8')
  })
})
