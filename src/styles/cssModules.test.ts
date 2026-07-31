// CSS-module reference contract.
//
// A missing CSS-module class fails SILENTLY: `s.typo` is `undefined`, React
// renders `class=""`, and TypeScript can't help because a module's default
// export is typed as an index signature. The element just loses every style.
// This bit during the Sidebar conversion — `cls.confirmBtn` survived in the JSX
// after its rule was dropped, and nothing complained.
//
// So: every `<import>.<name>` reference in a component must exist in the
// *.module.css beside it, and every class in that file must be referenced.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const files = walk(SRC)
const modules = files.filter((f) => f.endsWith('.module.css'))

/** Class names a stylesheet defines. Only top-level `.name` selectors count —
 *  a nested/compound selector can't be addressed from JS anyway. */
function definedClasses(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of css.matchAll(/^\.([A-Za-z_][\w-]*)/gm)) names.add(m[1])
  // `composes:` targets are real references from inside the stylesheet
  return names
}

/** The identifier a component binds a given CSS module to (`s`, `cls`, …).
 *
 *  The specifier must END at that exact basename — matching it as a bare
 *  substring makes IconButton.tsx look like a consumer of Button.module.css,
 *  which is how the first version of this test reported a false failure. */
function importAlias(tsx: string, moduleFile: string): string | null {
  const esc = basename(moduleFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return tsx.match(new RegExp(`import\\s+(\\w+)\\s+from\\s+['"](?:[^'"]*/)?${esc}['"]`))?.[1] ?? null
}

/** True when a consumer indexes the module dynamically (`s[variant]`), which no
 *  static scan can enumerate — so its class set can't be proven unused. */
function hasComputedAccess(tsx: string, alias: string): boolean {
  return new RegExp(`\\b${alias}\\[`).test(tsx)
}

describe('CSS modules', () => {
  it('has at least one module to check', () => {
    expect(modules.length).toBeGreaterThan(0)
  })

  for (const mod of modules) {
    const stem = basename(mod).replace(/\.module\.css$/, '')
    const consumers = files.filter(
      (f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && importAlias(readFileSync(f, 'utf8'), mod) !== null
    )

    it(`${stem}.module.css: every referenced class exists`, () => {
      const defined = definedClasses(readFileSync(mod, 'utf8'))
      const missing: string[] = []
      for (const c of consumers) {
        const tsx = readFileSync(c, 'utf8')
        const alias = importAlias(tsx, mod)
        if (!alias) continue
        for (const m of tsx.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) {
          if (!defined.has(m[1])) missing.push(`${basename(c)} → ${alias}.${m[1]}`)
        }
      }
      expect(missing).toEqual([])
    })

    it(`${stem}.module.css: defines no unused class`, () => {
      const css = readFileSync(mod, 'utf8')
      const defined = definedClasses(css)
      const referenced = new Set<string>()
      // `composes: x` counts as a use, so a shared base class isn't flagged
      for (const m of css.matchAll(/composes:\s*([\w\s]+);/g)) {
        for (const n of m[1].trim().split(/\s+/)) referenced.add(n)
      }
      let dynamic = false
      for (const c of consumers) {
        const tsx = readFileSync(c, 'utf8')
        const alias = importAlias(tsx, mod)
        if (!alias) continue
        if (hasComputedAccess(tsx, alias)) dynamic = true
        for (const m of tsx.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) referenced.add(m[1])
      }
      // a variant map (`s[variant]`) is addressed at runtime — unprovable here
      if (dynamic) return
      expect([...defined].filter((d) => !referenced.has(d))).toEqual([])
    })
  }
})
