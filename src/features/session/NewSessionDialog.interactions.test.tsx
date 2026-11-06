import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import NewSessionDialog from './NewSessionDialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

let host: HTMLDivElement
let root: Root
const launch = vi.fn()
const close = vi.fn()
const recents = ['/projects/alpha', '/projects/beta']

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  vi.mocked(invoke).mockImplementation((cmd, args) => Promise.resolve(
    cmd === 'ensure_dir' ? (args as { path: string }).path : ['child'],
  ) as ReturnType<typeof invoke>)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.useRealTimers(); vi.clearAllMocks()
})
const input = () => host.querySelector('input')!
async function mount() {
  await act(async () => root.render(<NewSessionDialog open recents={recents} onLaunch={launch} onClose={close} />))
}
async function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  await act(async () => { input().dispatchEvent(event) })
  return event
}

describe('new session folder selection', () => {
  it('Tab fills the highlighted recent path and only a later Enter launches', async () => {
    await mount()
    await key('ArrowDown'); await key('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(host.querySelectorAll('[role="option"]')[1].id)
    expect((await key('Tab')).defaultPrevented).toBe(true)
    expect(input().value).toBe('/projects/beta')
    expect(document.activeElement).toBe(input())
    expect(invoke).not.toHaveBeenCalledWith('ensure_dir', expect.anything())
    expect(launch).not.toHaveBeenCalled()
    await key('Enter')
    expect(invoke).toHaveBeenCalledWith('ensure_dir', { path: '/projects/beta' })
    expect(launch).toHaveBeenCalledWith('/projects/beta')
  })

  it('Enter on a recent suggestion fills it for editing', async () => {
    await mount()
    await key('ArrowDown'); await key('Enter')
    expect(input().value).toBe('/projects/alpha')
    expect(launch).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('ensure_dir', expect.anything())
  })

  it('clicking a recent project fills the input without creating a session', async () => {
    await mount()
    await act(async () => Simulate.click(host.querySelector('[role="option"]')!))
    expect(input().value).toBe('/projects/alpha')
    expect(launch).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('ensure_dir', expect.anything())
  })

  it('preserves folder autocomplete and leaves Shift-Tab available for navigation', async () => {
    await mount()
    await act(async () => Simulate.change(input(), { target: { value: '/projects/ch' } } as never))
    await act(async () => vi.advanceTimersByTime(80))
    await key('ArrowDown')
    expect((await key('Tab', true)).defaultPrevented).toBe(false)
    await key('Tab')
    expect(input().value).toBe('/projects/child/')
    expect(launch).not.toHaveBeenCalled()
  })
})
