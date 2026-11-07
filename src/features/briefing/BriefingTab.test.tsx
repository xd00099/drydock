import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { BriefingTab } from './BriefingTab'
import type { TasksView } from '@/lib/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@/features/timemachine/TimeMachine', () => ({ default: () => null }))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); vi.mocked(invoke).mockReset()
  vi.mocked(invoke).mockImplementation((cmd) => Promise.resolve(cmd === 'get_session_summary'
    ? { saved: null, available: false, limited: true, refreshing: false, new_activity: false }
    : { root: '/project', head: 'abc123456', scope: 'Working changes', files: [{ path: 'reader.rs', resolved: '/project/reader.rs', status: 'M', adds: 4, dels: 2 }] }) as ReturnType<typeof invoke>)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!
async function mount(tasks: TasksView = { tasks: [], updated_at: null, transcript_available: true }) {
  await act(async () => root.render(<BriefingTab sourceAgent="codex" sessionId="codex-session" label="Build reader" starred={false} tasks={tasks} collaborationActions={<button>Review with…</button>} summaryActions={<button>Handoff…</button>} usage={{ rows: [{ model: 'codex-model', scope: 'main', input: 100, output: 20, cache_read: 40, cache_creation: 0 }], total_output: 20, total_tokens: 120, agent_output: 0 }} />))
}
it('renders Codex plan, usage, and changed files without Claude-only checkpoints', async () => {
  await mount({ tasks: [{ id: '1', subject: 'Verify reader', active_form: null, status: 'in_progress', blocked_by: [] }], updated_at: 1, transcript_available: true })
  expect(host.textContent).toContain('Verify reader')
  expect(host.textContent).toContain('Σ 120')
  expect(host.textContent).toContain('reader.rs')
  const section = host.querySelector('[aria-label="Repository file changes"]')!
  expect(section.textContent).toContain('UNCOMMITTED FILES')
  expect(section.contains(button('Review with…'))).toBe(true)
  expect(section.contains(button('Handoff…'))).toBe(false)
  expect(host.querySelector('[aria-label="Session summary"]')!.contains(button('Handoff…'))).toBe(true)
  expect(invoke).toHaveBeenCalledWith('collaboration_changes', { sessionId: 'codex-session' })
  expect(host.querySelector('[title*="codex-model"]')).not.toBeNull()
  expect(host.querySelector('[title*="File time machine"]')).toBeNull()
})
it('shows repository changes for metadata-only threads without a broken briefing card', async () => {
  await mount({ tasks: [], updated_at: null, transcript_available: false })
  expect(host.textContent).toContain('Build reader')
  expect(host.textContent).toContain('reader.rs')
  expect(host.textContent).not.toContain('no readable local rollout')
  expect(host.textContent).not.toContain('no briefing card')
  expect(button('Refresh card')).toBeUndefined()
  expect(invoke).not.toHaveBeenCalledWith('refresh_card', expect.anything())
  expect(invoke).not.toHaveBeenCalledWith('get_card', expect.anything())
})
