import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { SessionSummary, type SummaryView } from './SessionSummary'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
let host: HTMLDivElement
let root: Root
let data: SummaryView
const first = 'a'.repeat(40), second = 'b'.repeat(40), third = 'c'.repeat(40)
const render = (head: string | null = first) => act(async () => root.render(<SessionSummary sessionId="session" head={head} />))
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
const refreshButton = () => host.querySelector('button')!
const refreshCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'refresh_session_summary')
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  data = { available: true, limited: false, new_activity: false, refreshing: false, saved: {
    title: 'Session Recovery', summary: 'Restored missing sessions. Folder deletion is next.',
    generated_at: Date.now() - 8 * 60_000, source_version: 'v1', head: first, limited: false,
  } }
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(data) as ReturnType<typeof invoke>)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

it('reads saved summaries without generating on open, on polling, or on conversation activity', async () => {
  await render()
  expect(host.textContent).toContain('Updated 8m ago')
  expect(host.textContent).toContain('Restored missing sessions')
  data = { ...data, new_activity: true }
  await advance(8000)
  expect(host.textContent).toContain('New activity')
  expect(refreshCalls()).toHaveLength(0)
})

it('refreshes explicitly once, keeps previous text while pending, and displays the new result', async () => {
  await render()
  let finish!: (v: SummaryView) => void
  vi.mocked(invoke).mockImplementation((cmd) => cmd === 'refresh_session_summary'
    ? new Promise((resolve) => { finish = resolve }) as ReturnType<typeof invoke>
    : Promise.resolve(data) as ReturnType<typeof invoke>)
  await act(async () => { Simulate.click(refreshButton()); Simulate.click(refreshButton()) })
  expect(refreshCalls()).toEqual([['refresh_session_summary', { sessionId: 'session', previousHead: null, expectedHead: null }]])
  expect(refreshButton().disabled).toBe(true)
  expect(host.textContent).toContain('Restored missing sessions')
  data = { ...data, saved: { ...data.saved!, summary: 'Folder deletion is implemented.', generated_at: Date.now() } }
  await act(async () => finish(data))
  expect(refreshButton().disabled).toBe(false)
  expect(host.textContent).toContain('Folder deletion is implemented.')
  expect(host.textContent).toContain('Updated just now')
})

it('preserves the saved summary on failure and allows manual retry', async () => {
  await render()
  vi.mocked(invoke).mockImplementation((cmd) => cmd === 'refresh_session_summary'
    ? Promise.reject('CLI login required') : Promise.resolve(data) as ReturnType<typeof invoke>)
  await act(async () => Simulate.click(refreshButton()))
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('CLI login required')
  expect(host.textContent).toContain('Restored missing sessions')
  vi.mocked(invoke).mockResolvedValue(data)
  await act(async () => Simulate.click(refreshButton()))
  expect(refreshCalls()).toHaveLength(2)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

it('debounces rapid commits into one automatic refresh and does not retry a failed attempt', async () => {
  await render()
  vi.mocked(invoke).mockImplementation((cmd) => cmd === 'refresh_session_summary'
    ? Promise.reject('Unavailable') : Promise.resolve(data) as ReturnType<typeof invoke>)
  await render(second); await advance(3000)
  expect(refreshCalls()).toHaveLength(0)
  await render(third); await advance(4999)
  expect(refreshCalls()).toHaveLength(0)
  await advance(1)
  expect(refreshCalls()).toEqual([['refresh_session_summary', { sessionId: 'session', previousHead: first, expectedHead: third }]])
  await advance(30_000)
  expect(refreshCalls()).toHaveLength(1)
  expect(host.textContent).toContain('Restored missing sessions')
})

it('queues a new commit until an in-flight manual refresh finishes', async () => {
  await render()
  let finish!: (v: SummaryView) => void
  vi.mocked(invoke).mockImplementation((cmd) => cmd === 'refresh_session_summary'
    ? new Promise((resolve) => { finish = resolve }) as ReturnType<typeof invoke>
    : Promise.resolve(data) as ReturnType<typeof invoke>)
  await act(async () => Simulate.click(refreshButton()))
  await render(second); await advance(7000)
  expect(refreshCalls()).toHaveLength(1)
  await act(async () => finish(data))
  vi.mocked(invoke).mockResolvedValue(data)
  await advance(5000)
  expect(refreshCalls()).toHaveLength(2)
  expect(refreshCalls()[1][1]).toMatchObject({ previousHead: first, expectedHead: second })
})

it('keeps unavailable context quiet and labels summaries made from saved prompts', async () => {
  data = { ...data, saved: null, available: false, limited: true }
  await render(); await render(second); await advance(10_000)
  expect(refreshButton().disabled).toBe(true)
  expect(host.textContent).toContain('Conversation content isn’t available locally yet')
  expect(refreshCalls()).toHaveLength(0)
  data = { ...data, available: true, saved: { title: 'Recovery', summary: 'The goal is to recover sessions.',
    generated_at: Date.now(), head: second, limited: true, source_version: 'v1' } }
  await advance(4000)
  expect(host.textContent).toContain('Saved context only')
  expect(refreshCalls()).toHaveLength(0)
})

it('cancels a pending automatic trigger when the panel closes', async () => {
  await render(); await render(second)
  await act(async () => root.render(<div>Another tab</div>))
  await advance(10_000)
  expect(refreshCalls()).toHaveLength(0)
})
