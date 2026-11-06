import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: 'safari15',
    rollupOptions: {
      output: {
        // Keep the terminal engine and its addons together, separately from
        // the app UI. UI changes then leave this large vendor chunk cached.
        manualChunks(id) {
          if (id.includes('/node_modules/@xterm/')) return 'terminal'
        },
      },
    },
  },
  // `@/…` → src/. Mirrors tsconfig's `paths` so the bundler and the type
  // checker agree; vitest.config.ts repeats it for the test runner.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
