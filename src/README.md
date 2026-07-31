# Frontend layout

```
src/
  main.tsx              entry: theme init before first paint, then mount
  app/                  the shell — App owns tabs/stage/panels; ErrorBoundary wraps it
  components/ui/        shared primitives (Button, Chip, IconButton, Tab, ResizeHandle)
  features/<name>/      one folder per surface; owns its components + *.module.css
  hooks/                cross-feature React hooks (useSessions)
  lib/                  no-React logic: types, theme, keymap, settings, split, wheel
  styles/               global cascade (see below)
```

## Import convention

`@/` resolves to `src/` (tsconfig `paths`, mirrored in vite + vitest configs).
Import shared modules by role, never by relative hops:

```ts
import { Button, Chip } from '@/components/ui'
import type { SessionView } from '@/lib/types'
```

Moving a file between features then costs zero import rewrites.

## Styling

Three layers, in order of preference:

1. **Tokens** (`styles/`) — every color, radius, shadow and duration is a
   `--dd-*` custom property. Never hardcode a hex or a `ms`.
2. **CSS modules** — `Feature.module.css` beside the component. This is where
   component styling belongs: shape, spacing, hover, transitions.
3. **Inline `style`** — only for values *computed at runtime* (a session's
   project color, a dragged pane's width). If a value is constant, it is a
   class, not a style object.

The cascade, assembled by `styles/index.css`:

| file             | owns                                                            |
| ---------------- | --------------------------------------------------------------- |
| `themes.css`     | semantic **color** tokens: `:root` (dark) + one block per theme  |
| `foundation.css` | theme-**invariant** shape/motion + scheme-aware elevation        |
| `base.css`       | the document shell (`html/body/#root`) and terminal inset        |
| `utilities.css`  | namespaced cross-feature helpers (`.md`, animations, hovers)     |

Two constraints worth knowing before editing styles:

- **`theme.test.ts` reads `themes.css`** and asserts every `html[data-theme]`
  block defines *exactly* the `:root` token set. Add a color token and all 19
  themes need it. Shape/motion tokens live in `foundation.css` precisely so they
  don't pay that tax.
- **No inline `<style>` tag, ever.** Tauri nonces inline `<style>`, and a nonce
  in `style-src` voids `'unsafe-inline'` — which would kill React's runtime
  inline styles and xterm's injected CSS. Keep styles in linked stylesheets.

## Window chrome

The native titlebar is off (`tauri.conf.json` → `titleBarStyle: "Overlay"`,
`hiddenTitle: true`), so macOS draws the traffic lights directly onto the app.
The sidebar's header row clears them via `--dd-lights-inset` and carries
`data-tauri-drag-region` to stay draggable. Any layout change to that row must
preserve both, or the lights will overlap content and the window won't drag.

## Tests

Colocated with their subject (`lib/keymap.test.ts`, `features/sidebar/Sidebar.test.ts`).
`npm test` runs vitest in jsdom.
