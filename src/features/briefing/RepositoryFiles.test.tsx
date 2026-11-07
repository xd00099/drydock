import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { RepositoryFiles, type RepositoryChanges } from './RepositoryFiles'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
let host: HTMLDivElement
let root: Root
let data: RepositoryChanges
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!
const mount = () => act(async () => root.render(<RepositoryFiles sessionId="session" actions={<button>Review with…</button>} />))
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers(); localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  data = { root: '/repo', head: 'abc123456', scope: 'Working changes', files: [
    { path: 'src/live.ts', resolved: '/repo/src/live.ts', status: 'M', adds: 3, dels: 1 },
    { path: 'gone.ts', resolved: null, status: 'D', adds: 0, dels: 4 },
    { path: 'new.txt', resolved: '/repo/new.txt', status: '?', adds: 2, dels: 0 },
  ] }
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(data) as ReturnType<typeof invoke>)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

it('opens working paths and keeps deleted files disabled, with review inside the section', async () => {
  await mount()
  expect(host.textContent).toContain('Repository-wide · staged, unstaged and new files')
  expect(button('gone.ts').disabled).toBe(true)
  expect(host.querySelector('[title="Untracked"]')).not.toBeNull()
  await act(async () => Simulate.click(button('live.ts')))
  expect(invoke).toHaveBeenCalledWith('open_path', { path: '/repo/src/live.ts', reveal: false })
  expect(host.querySelector('section')!.contains(button('Review with…'))).toBe(true)
})

it('refreshes outside transcript events and switches to last commit after committing', async () => {
  await mount()
  expect(host.textContent).toContain('UNCOMMITTED FILES')
  data = { ...data, scope: 'Last commit', head: 'def789012', files: [{ path: 'committed.rs', resolved: '/repo/committed.rs', status: 'A', adds: 1, dels: 0 }] }
  await act(async () => vi.advanceTimersByTimeAsync(4000))
  expect(host.textContent).toContain('LAST COMMIT FILES')
  expect(host.textContent).toContain('latest commit def7890')
  expect(host.textContent).toContain('committed.rs')
  expect(host.textContent).not.toContain('live.ts')
  await act(async () => root.unmount())
  root = createRoot(host)
  const before = vi.mocked(invoke).mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(8000))
  expect(vi.mocked(invoke).mock.calls.length).toBe(before)
})

it('keeps review reachable when the list is collapsed or empty', async () => {
  data = { ...data, files: [] }
  await mount()
  expect(host.textContent).toContain('No file changes in this scope')
  await act(async () => Simulate.click(host.querySelector('button[aria-expanded]')!))
  expect(host.textContent).not.toContain('No file changes in this scope')
  expect(button('Review with…')).toBeDefined()
})

it('shows Git errors instead of displaying stale session file history', async () => {
  await mount()
  vi.mocked(invoke).mockRejectedValue('File changes require a Git repository')
  await act(async () => vi.advanceTimersByTimeAsync(4000))
  expect(host.textContent).toContain('File changes require a Git repository')
  expect(host.textContent).not.toContain('live.ts')
  expect(button('Review with…')).toBeDefined()
})
