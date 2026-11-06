import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
