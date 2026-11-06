import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import SearchPalette from './SearchPalette'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const response = (title: string) => ({ semantic: 'ready', results: [{ snippet: '', session: {
  session_id: title, title, agent: 'codex', project_path: '/project', live_status: 'ended', last_message_at: null,
} }] })

let host: HTMLDivElement
let root: Root
let enrich: (value: ReturnType<typeof response>) => void

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  vi.mocked(invoke).mockImplementation((_cmd, args) => {
    const q = args as { query: string; semantic: boolean }
    if (!q.query) return Promise.resolve({ results: [], semantic: 'parked' }) as ReturnType<typeof invoke>
    if (!q.semantic) return Promise.resolve(response('keyword result')) as ReturnType<typeof invoke>
    return new Promise((resolve) => { enrich = resolve }) as ReturnType<typeof invoke>
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.useRealTimers(); vi.clearAllMocks()
})

async function mountAndSearch() {
  await act(async () => root.render(<SearchPalette open onClose={() => {}} onPick={() => {}} />))
  await act(async () => vi.advanceTimersByTime(120))
  await act(async () => Simulate.change(host.querySelector('input')!, { target: { value: 'needle' } } as never))
  await act(async () => vi.advanceTimersByTime(120))
}

describe('progressive session search', () => {
  it('shows keywords before semantic inference finishes, then enriches the results', async () => {
    await mountAndSearch()
    expect(host.textContent).toContain('keyword result')
    expect(invoke).toHaveBeenCalledWith('search', { query: 'needle', semantic: true })
    await act(async () => enrich(response('semantic result')))
    expect(host.textContent).toContain('semantic result')
  })

  it('ignores semantic results for a query that has changed', async () => {
    await mountAndSearch()
    await act(async () => Simulate.change(host.querySelector('input')!, { target: { value: 'other' } } as never))
    await act(async () => enrich(response('stale semantic result')))
    expect(host.textContent).not.toContain('stale semantic result')
  })

  it('ignores an in-flight semantic result after closing', async () => {
    await mountAndSearch()
    await act(async () => root.render(<SearchPalette open={false} onClose={() => {}} onPick={() => {}} />))
    await act(async () => enrich(response('closed semantic result')))
    expect(host.textContent).toBe('')
  })
})
