import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { BriefingTab } from './BriefingTab'
import type { TasksView } from '@/lib/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/features/timemachine/TimeMachine', () => ({ default: () => null }))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); vi.mocked(invoke).mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!
async function mount(tasks: TasksView = { tasks: [], updated_at: null, transcript_available: true }) {
  await act(async () => root.render(<BriefingTab sourceAgent="codex" sessionId="codex-session" label="Build reader" starred={false} card={null} tasks={tasks} projectPath="/project" files={[{ path: '/project/reader.rs', resolved: '/project/reader.rs', edits: 1, writes: 0, adds: 4, dels: 2, created: false, last_ts: null }]} usage={{ rows: [{ model: 'codex-model', scope: 'main', input: 100, output: 20, cache_read: 40, cache_creation: 0 }], total_output: 20, total_tokens: 120, agent_output: 0 }} />))
}
it('renders Codex plan, usage, and changed files without Claude-only checkpoints', async () => {
  await mount({ tasks: [{ id: '1', subject: 'Verify reader', active_form: null, status: 'in_progress', blocked_by: [] }], updated_at: 1, transcript_available: true })
  expect(host.textContent).toContain('Verify reader')
  expect(host.textContent).toContain('Σ 120')
  expect(host.textContent).toContain('reader.rs')
  expect(host.querySelector('[title*="codex-model"]')).not.toBeNull()
  expect(host.querySelector('[title*="File time machine"]')).toBeNull()
})
it('waits for card refresh and shows CLI errors', async () => {
  await mount()
  let reject!: (e: Error) => void
  vi.mocked(invoke).mockReturnValue(new Promise((_, fail) => { reject = fail }))
  await act(async () => { Simulate.click(button('Refresh card')) })
  expect(button('Refreshing…').disabled).toBe(true)
  expect(invoke).toHaveBeenCalledWith('refresh_card', { sessionId: 'codex-session' })
  await act(async () => reject(new Error('Codex login required')))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Codex login required')
  expect(button('Refresh card').disabled).toBe(false)
})
it('explains missing rollout data for metadata-only threads', async () => {
  await mount({ tasks: [], updated_at: null, transcript_available: false })
  expect(host.textContent).toContain('no readable local rollout')
  expect(button('Refresh card').disabled).toBe(true)
})
