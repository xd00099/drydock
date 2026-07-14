import { defineConfig } from 'vitest/config'

// jsdom: the keymap/settings helpers persist through localStorage and fire
// window events — the tests exercise that surface directly.
export default defineConfig({ test: { environment: 'jsdom' } })
