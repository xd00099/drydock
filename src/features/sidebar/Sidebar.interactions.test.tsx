import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { ComponentProps } from 'react'
import type { SessionView } from '@/lib/types'
import Sidebar from './Sidebar'

vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/Users/dev') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))
vi.mock('@/features/session/VersionFooter', () => ({ default: () => null }))
vi.mock('@/lib/windowDrag', () => ({ armWindowDrag: vi.fn() }))

let host: HTMLDivElement
let root: Root
let props: ComponentProps<typeof Sidebar>

const session = (id: string, project: string, over: Partial<SessionView> = {}): SessionView => ({
  session_id: id, project_path: `/Users/dev/${project}`, title: id, title_source: 'first-prompt',
  name: null, summary: null, latest_recap: null, last_message_at: 1000,
  starred: false, hidden: false, live_status: 'ended', attention: null,
  folder_id: null, hue: null, agent: 'codex', ...over,
})

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  props = {
    sessions: [1, 2, 3, 4, 5].map((n) => session(`Session ${n}`, 'local/drydock', { last_message_at: 6000 - n })),
    folders: [], hidden: [], activeSessionId: 'Session 5', collapsed: false,
    onHome: vi.fn(), onResume: vi.fn(), onTranscript: vi.fn(), onTakeover: vi.fn(),
    onNewSession: vi.fn(), onToggleStar: vi.fn(), onHide: vi.fn(), onDelete: vi.fn(),
    onRefresh: vi.fn(), onRestartForUpdate: vi.fn(), onSetCollapsed: vi.fn(), onOpenSettings: vi.fn(),
    updateBusyCount: 0,
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.clearAllMocks()
})

const render = () => act(async () => root.render(<Sidebar {...props} />))
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.dd-sessrow')]
const click = (element: HTMLElement) => act(async () => element.click())
const textButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const openSessionMenu = () => act(async () => {
  rows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
})
const contextMenu = (element: HTMLElement) => act(async () => {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
})

it('opens the current project, previews three including the selection, and shows all on demand', async () => {
  await render()
  expect(button('~/local workspace').getAttribute('aria-expanded')).toBe('true')
  expect(button('drydock project').getAttribute('aria-expanded')).toBe('true')
  expect(rows()).toHaveLength(3)
  expect(rows().some((row) => row.getAttribute('aria-current') === 'page')).toBe(true)
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all 5 sessions')!)
  expect(rows()).toHaveLength(5)
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show fewer')!)
  expect(rows()).toHaveLength(3)
  await click(button('New session in drydock'))
  expect(props.onNewSession).toHaveBeenCalledWith('/Users/dev/local/drydock')
  await click(rows()[0])
  expect(props.onResume).toHaveBeenCalledWith(props.sessions[0])
})

it('keeps collapsed branches closed across polls and remounts', async () => {
  await render()
  await click(button('drydock project'))
  props = { ...props, sessions: [...props.sessions] }
  await render()
  expect(button('drydock project').getAttribute('aria-expanded')).toBe('false')
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  expect(button('drydock project').getAttribute('aria-expanded')).toBe('false')
  await click(button('~/local workspace'))
  await render()
  expect(button('~/local workspace').getAttribute('aria-expanded')).toBe('false')
  expect(rows()).toHaveLength(0)
})

it('reveals another workspace when selecting its session and retains the new-session path', async () => {
  props.sessions.push(session('Other session', 'Desktop/harper/api'))
  await render()
  expect(button('~/Desktop/harper workspace').getAttribute('aria-expanded')).toBe('false')
  props = { ...props, activeSessionId: 'Other session' }
  await render()
  expect(button('~/Desktop/harper workspace').getAttribute('aria-expanded')).toBe('true')
  expect(button('api project').getAttribute('aria-expanded')).toBe('true')
  await click(button('New session in api'))
  expect(props.onNewSession).toHaveBeenCalledWith('/Users/dev/Desktop/harper/api')
})

it('keeps Active, Starred and custom folders above the workspace tree without duplicate sessions', async () => {
  props.sessions.push(
    session('Running', 'local/drydock', { live_status: 'busy' }),
    session('Pinned', 'local/drydock', { starred: true }),
    session('Filed', 'local/drydock', { folder_id: 'work' }),
  )
  props.folders = [{ id: 'work', name: 'My work' }]
  await render()
  const text = host.textContent!
  expect(text.indexOf('Active')).toBeLessThan(text.indexOf('Starred'))
  expect(text.indexOf('Starred')).toBeLessThan(text.indexOf('My work'))
  expect(text.indexOf('My work')).toBeLessThan(text.indexOf('Workspaces'))
  for (const title of ['Running', 'Pinned', 'Filed']) expect(rows().filter((r) => r.title.startsWith(`${title}\n`))).toHaveLength(1)
})

it('offers permanent deletion for Codex history and explains that descendants are deleted too', async () => {
  vi.mocked(props.onDelete).mockResolvedValueOnce()
  await render()
  await openSessionMenu()
  expect(textButton('Delete permanently…').disabled).toBe(false)
  await click(textButton('Delete permanently…'))
  expect(host.textContent).toContain('spawned subagent sessions')
  await click(textButton('Delete'))
  expect(props.onDelete).toHaveBeenCalledWith('Session 1')
  expect(props.onHide).not.toHaveBeenCalled()
})

it('counts only existing user-hidden sessions and updates after external deletion', async () => {
  props.hidden = ['Session 1', 'Session 2', 'already-deleted']
  await render()
  expect(textButton('▸ 2 hidden')).toBeTruthy()
  await click(textButton('▸ 2 hidden'))
  expect(textButton('▾ 2 hidden')).toBeTruthy()
  props = { ...props, sessions: props.sessions.filter((s) => s.session_id !== 'Session 1') }
  await render()
  expect(textButton('▾ 1 hidden')).toBeTruthy()
  props = { ...props, sessions: props.sessions.filter((s) => s.session_id !== 'Session 2') }
  await render()
  expect([...host.querySelectorAll('button')].some((b) => /\d+ hidden$/.test(b.textContent ?? ''))).toBe(false)
})

it('waits for deletion, prevents repeat submits, shows failures and allows retry', async () => {
  let reject!: (error: Error) => void
  vi.mocked(props.onDelete).mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  await render()
  await openSessionMenu()
  await click(textButton('Delete permanently…'))
  await click(textButton('Delete'))
  expect(textButton('Deleting…').disabled).toBe(true)
  expect(textButton('Cancel').disabled).toBe(true)
  await click(textButton('Deleting…'))
  expect(props.onDelete).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('Could not delete rollout: permission denied')))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('permission denied')
  expect(host.textContent).toContain('Delete permanently?')
  expect(textButton('Delete').disabled).toBe(false)
  vi.mocked(props.onDelete).mockResolvedValueOnce()
  await click(textButton('Delete'))
  expect(props.onDelete).toHaveBeenCalledTimes(2)
  expect(host.textContent).not.toContain('Delete permanently?')
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

it('deletes every project conversation beyond the preview, including hidden, starred and filed sessions', async () => {
  props.sessions.push(
    session('Starred', 'local/drydock', { starred: true }),
    session('Hidden', 'local/drydock'),
    session('Filed', 'local/drydock', { folder_id: 'work' }),
    session('Another project', 'local/other'),
  )
  props.hidden = ['Hidden']
  props.folders = [{ id: 'work', name: 'Work' }]
  await render()
  await contextMenu(button('drydock project'))
  await click(textButton('Delete all sessions…'))
  expect(host.textContent).toContain('Project files and directories will be kept.')
  await click(textButton('Delete 8 sessions'))
  expect(vi.mocked(props.onDelete).mock.calls.map(([id]) => id)).toEqual([
    'Session 1', 'Session 2', 'Session 3', 'Session 4', 'Session 5', 'Starred', 'Hidden', 'Filed',
  ])
  expect(host.textContent).not.toContain('Delete sessions in “drydock”?')
})

it('limits workspace deletion to its directory and supports cancelling before any delete', async () => {
  props.sessions.push(session('Shop', 'local/shop'), session('Other workspace', 'local-other/shop'))
  await render()
  await contextMenu(button('~/local workspace'))
  await click(textButton('Delete all sessions…'))
  expect(textButton('Delete 6 sessions')).toBeTruthy()
  await click(textButton('Cancel'))
  expect(props.onDelete).not.toHaveBeenCalled()
  await contextMenu(button('~/local workspace'))
  await click(textButton('Delete all sessions…'))
  await click(textButton('Delete 6 sessions'))
  expect(vi.mocked(props.onDelete).mock.calls.map(([id]) => id)).not.toContain('Other workspace')
})

it('preserves a custom folder on partial failure and retries only remaining conversations', async () => {
  props.folders = [{ id: 'work', name: 'Work' }]
  for (const s of props.sessions.slice(0, 3)) s.folder_id = 'work'
  props.sessions[0].starred = true
  props.hidden = ['Session 2']
  vi.mocked(props.onDelete).mockResolvedValueOnce().mockRejectedValueOnce(new Error('session is running'))
  await render()
  await contextMenu(host.querySelector<HTMLElement>('[data-fhead]')!)
  expect(textButton('Remove folder only…')).toBeTruthy()
  await click(textButton('Delete folder and sessions…'))
  await click(textButton('Delete 3 sessions'))
  expect(host.querySelector('[role="status"]')?.textContent).toContain('1 of 3')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('session is running')
  expect(invoke).not.toHaveBeenCalledWith('delete_folder', expect.anything())
  vi.mocked(props.onDelete).mockResolvedValue(undefined)
  await click(textButton('Delete 2 sessions'))
  expect(vi.mocked(props.onDelete).mock.calls.map(([id]) => id)).toEqual(['Session 1', 'Session 2', 'Session 2', 'Session 3'])
  expect(invoke).toHaveBeenCalledWith('delete_folder', { folderId: 'work' })
  expect(props.onRefresh).toHaveBeenCalled()
})

it('keeps the confirmed selection fixed when a new conversation arrives during deletion', async () => {
  let finish!: () => void
  vi.mocked(props.onDelete).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  await render()
  await contextMenu(button('drydock project'))
  await click(textButton('Delete all sessions…'))
  await click(textButton('Delete 5 sessions'))
  expect(textButton('Deleting…').disabled).toBe(true)
  props = { ...props, sessions: [...props.sessions, session('Arrived later', 'local/drydock')] }
  await render()
  await act(async () => finish())
  expect(props.onDelete).toHaveBeenCalledTimes(5)
  expect(vi.mocked(props.onDelete).mock.calls.map(([id]) => id)).not.toContain('Arrived later')
})

it('retries a failed folder removal without deleting conversations a second time', async () => {
  props.folders = [{ id: 'work', name: 'Work' }]
  props.sessions[0].folder_id = 'work'
  vi.mocked(invoke).mockRejectedValueOnce(new Error('folder is locked'))
  await render()
  await contextMenu(host.querySelector<HTMLElement>('[data-fhead]')!)
  await click(textButton('Delete folder and sessions…'))
  await click(textButton('Delete 1 session'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('folder is locked')
  expect(host.textContent).toContain('The conversations have been deleted.')
  await click(textButton('Remove folder'))
  expect(props.onDelete).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledTimes(2)
})
