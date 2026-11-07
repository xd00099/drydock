import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { ProjectTab } from './ProjectTab'
import type { McpServer } from '@/lib/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
let host: HTMLDivElement, root: Root
let sequence = 0
const native: McpServer = { name: 'drydock-artifacts', kind: 'http', detail: 'Local artifacts', scope: 'drydock', builtin: true, enabled: true, tools: ['render_artifact', 'await_artifact_feedback'] }
const external = (name: string): McpServer => ({ name, kind: 'stdio', detail: 'node server.js', scope: 'user', builtin: false, enabled: true, tools: [] })
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  vi.mocked(invoke).mockReset()
  vi.mocked(invoke).mockImplementation((cmd, args) => {
    const agent = (args as { agent?: string })?.agent
    if (cmd === 'list_skills') return Promise.resolve([{ name: `${agent}-skill`, description: 'Local skill', plugin: 'project' }]) as ReturnType<typeof invoke>
    if (cmd === 'list_mcp_servers') return Promise.resolve([native, external(`${agent}-server`)]) as ReturnType<typeof invoke>
    if (cmd === 'mcp_status') return Promise.resolve([['claude-server', 'connected', 'Connected']]) as ReturnType<typeof invoke>
    return Promise.resolve() as ReturnType<typeof invoke>
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const mount = async (agent: string) => {
  const path = `/project-${++sequence}`
  await act(async () => root.render(<ProjectTab agent={agent} projectPath={path} />))
  return path
}
it('shows Codex capabilities and shared native tools without running Claude health checks', async () => {
  const path = await mount('codex')
  expect(invoke).toHaveBeenCalledWith('list_skills', { agent: 'codex', projectPath: path })
  expect(invoke).toHaveBeenCalledWith('list_mcp_servers', { agent: 'codex', projectPath: path })
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'mcp_status')).toBe(false)
  expect(host.textContent).toContain('Codex')
  expect(host.textContent).toContain('codex-server')
  expect(host.textContent).not.toContain('claude-server')
  expect(host.querySelector('[title*="Configured in Codex"]')).not.toBeNull()
  expect(host.querySelector('[title*="Drydock native"]')).not.toBeNull()
})
it('isolates capability caches when switching harnesses in the same project', async () => {
  const path = await mount('claude')
  expect(host.textContent).toContain('claude-server')
  await act(async () => root.render(<ProjectTab agent="codex" projectPath={path} />))
  expect(host.textContent).toContain('codex-server')
  expect(host.textContent).not.toContain('claude-server')
  const healthCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'mcp_status')
  expect(healthCalls).toHaveLength(1)
  expect(healthCalls[0][1]).toEqual({ agent: 'claude', projectPath: path })
})
it('does not offer an enable switch for servers disabled in native Codex configuration', async () => {
  vi.mocked(invoke).mockImplementation((cmd) => Promise.resolve(cmd === 'list_mcp_servers'
    ? [native, { ...external('disabled-server'), enabled: false, configured_enabled: false }]
    : []) as ReturnType<typeof invoke>)
  await mount('codex')
  const toggle = host.querySelector<HTMLButtonElement>('button[title*="Disabled in Codex"]')!
  expect(toggle.disabled).toBe(true)
})
it('surfaces configuration failures rather than claiming no servers are configured', async () => {
  vi.mocked(invoke).mockImplementation((cmd) => cmd === 'list_mcp_servers'
    ? Promise.reject('Codex configuration could not be read') : Promise.resolve([]) as ReturnType<typeof invoke>)
  await mount('codex')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Codex configuration could not be read')
})
it('shows only the active harness without source pickers or import controls', async () => {
  const path = await mount('codex')
  expect(host.querySelector('[aria-label="Project tool source"]')).toBeNull()
  expect(Array.from(host.querySelectorAll('button')).some((b) => ['Shared', 'Claude Code', 'Codex', 'Add', 'Remove'].includes(b.textContent?.trim() ?? ''))).toBe(false)
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'list_skills' || cmd === 'list_mcp_servers').every(([, args]) => (args as { agent: string }).agent === 'codex')).toBe(true)
  expect(invoke).toHaveBeenCalledWith('list_skills', { agent: 'codex', projectPath: path })
})
it('includes shared connections supplied to the session without checking them through Claude', async () => {
  vi.mocked(invoke).mockImplementation((cmd) => Promise.resolve(cmd === 'list_mcp_servers'
    ? [native, { ...external('project-notes'), scope: 'shared' }] : []) as ReturnType<typeof invoke>)
  await mount('claude')
  expect(host.textContent).toContain('project-notes')
  expect(host.querySelector('[title*="Shared by Drydock"]')).not.toBeNull()
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'mcp_status')).toBe(false)
})
it('keeps shared connection toggles scoped to the project', async () => {
  vi.mocked(invoke).mockImplementation((cmd) => Promise.resolve(cmd === 'list_mcp_servers'
    ? [native, { ...external('project-notes'), scope: 'shared' }] : []) as ReturnType<typeof invoke>)
  const path = await mount('codex')
  const server = host.querySelector('[title="project-notes"]')!.parentElement!
  await act(async () => server.querySelector<HTMLButtonElement>('button[title="Disable for new Drydock sessions"]')!.click())
  expect(invoke).toHaveBeenCalledWith('project_set_mcp_enabled', { projectPath: path, name: 'project-notes', enabled: false })
})
