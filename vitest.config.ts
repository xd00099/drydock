import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// jsdom: the keymap/settings helpers persist through localStorage and fire
// window events — the tests exercise that surface directly.
// The `@` alias repeats vite.config.ts so tests resolve imports the same way
// the app does (tests are colocated with their subject, under src/**).
export default defineConfig({
  test: { environment: 'jsdom' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
