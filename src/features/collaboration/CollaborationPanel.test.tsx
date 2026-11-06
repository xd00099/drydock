import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import CollaborationPanel from './CollaborationPanel'
import { findingsPacket, shellQuote, type CollaborationRecord } from './types'
import type { ResolvedAgent } from '@/lib/agents'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
const profiles: ResolvedAgent[] = ['claude', 'codex'].map((id) => ({ id, name: id, command: id, tint: '', builtin: true, enabled: true, available: true }))
const fixture = (over: Partial<CollaborationRecord> = {}): CollaborationRecord => ({
  id: 'a'.repeat(32), source_session_id: 'source', source_agent: 'claude', project_path: '/project', working_directory: '/project/subfolder',
  title: 'Fix reconnect', created_at: 1, snapshot_id: 'snapshot', head: 'head', scope: 'Working changes', files: ['retry.ts'], omitted: [],
  diff: '+ fixed', packet: '# Original goal\nFix reconnect', status: 'draft', target_agent: null, destination_session_id: null,
  result: null, error: null, criteria: '', model: '', ...over,
})
let host: HTMLDivElement
let root: Root
let history: CollaborationRecord[]
let stale: boolean
const launch = vi.fn()
const openSession = vi.fn()
const clipboard = vi.fn((_text: string) => Promise.resolve())
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)!
async function click(text: string) { await act(async () => Simulate.click(button(text))) }
async function mount() {
  await act(async () => root.render(<CollaborationPanel sessionId="source" sourceAgent="claude" agents={profiles} onHandoff={launch} onOpenSession={openSession} />))
}
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  history = []; stale = false
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  vi.mocked(invoke).mockImplementation((cmd, raw) => {
    const args = raw as Record<string, string>
    let value: unknown
    if (cmd === 'collaboration_list') value = history
    else if (cmd === 'collaboration_stale') value = stale
    else if (cmd === 'collaboration_prepare') value = fixture({ scope: args.kind === 'handoff' ? 'Handoff context' : 'Working changes' })
    else if (cmd === 'collaboration_review') { history = [fixture({ status: 'running', target_agent: args.agent })] }
    else if (cmd === 'collaboration_handoff') value = { id: args.id, agent: args.agent, project_path: '/project/subfolder', prompt: 'Read saved handoff packet' }
    return Promise.resolve(value) as ReturnType<typeof invoke>
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.clearAllMocks()
})

describe('cross-agent review and handoff', () => {
  it('previews a review and only starts it after explicit submission', async () => {
    await mount(); await click('Review with…')
    expect(invoke).toHaveBeenCalledWith('collaboration_prepare', { sessionId: 'source', kind: 'review' })
    expect(invoke).not.toHaveBeenCalledWith('collaboration_review', expect.anything())
    expect(host.querySelector('select')!.value).toBe('codex')
    await act(async () => Simulate.change(host.querySelector('textarea')!, { target: { value: 'Retries must be bounded' } } as never))
    await click('Start review')
    expect(invoke).toHaveBeenCalledWith('collaboration_review', { id: 'a'.repeat(32), agent: 'codex', criteria: 'Retries must be bounded', model: '' })
    expect(host.textContent).toContain('reviewing the snapshot')
    expect(launch).not.toHaveBeenCalled()
  })

  it('launches a new session with the edited packet and original working directory', async () => {
    await mount(); await click('Handoff…')
    expect(host.querySelector('textarea')!.value).toContain('Original goal')
    expect(launch).not.toHaveBeenCalled()
    await act(async () => Simulate.change(host.querySelector('textarea')!, { target: { value: 'Edited goal and verified tests' } } as never))
    await click('Open new agent session')
    expect(invoke).toHaveBeenCalledWith('collaboration_handoff', { id: 'a'.repeat(32), agent: 'codex', packet: 'Edited goal and verified tests' })
    expect(launch).toHaveBeenCalledWith({ id: 'a'.repeat(32), agent: 'codex', project_path: '/project/subfolder', prompt: 'Read saved handoff packet' })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps failures visible without launching anything', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => cmd === 'collaboration_prepare' ? Promise.reject('Project is unavailable') : Promise.resolve([]) as ReturnType<typeof invoke>)
    await mount(); await click('Review with…')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Project is unavailable')
    expect(launch).not.toHaveBeenCalled()
  })

  it('copies only selected findings and keeps stale reviews from preparing fixes', async () => {
    history = [fixture({ status: 'completed', target_agent: 'codex', result: { summary: 'Two findings', findings: [
      { severity: 'high', file: 'retry.ts', line: 2, title: 'Selected issue', explanation: 'Can hang forever', reproduction: 'Disconnect network' },
      { severity: 'low', file: 'retry.ts', line: 3, title: 'Other issue', explanation: 'Other cause', reproduction: 'Other test' },
    ] } })]
    stale = true
    await mount()
    await click('Review · codex · completed')
    expect(host.textContent).toContain('project has changed')
    await act(async () => Simulate.change(host.querySelector('input[type="checkbox"]')!, { target: { checked: true } } as never))
    await click('Copy selected findings')
    expect(clipboard.mock.calls[0][0]).toContain('Selected issue')
    expect(clipboard.mock.calls[0][0]).not.toContain('Other issue')
    expect(button('Prepare fixes in a new session').disabled).toBe(true)
  })

  it('cancels a running job without needing to keep the dialog open', async () => {
    history = [fixture({ status: 'running', target_agent: 'codex' })]
    await mount(); await click('Review · codex · running'); await click('Cancel review')
    expect(invoke).toHaveBeenCalledWith('collaboration_cancel', { id: 'a'.repeat(32) })
    await click('Close')
    expect(host.textContent).toContain('Review · codex · running')
  })

  it('does not reopen a dialog when a closed preparation finishes late', async () => {
    let finish!: (record: CollaborationRecord) => void
    vi.mocked(invoke).mockImplementation((cmd) => cmd === 'collaboration_prepare'
      ? new Promise((resolve) => { finish = resolve }) as ReturnType<typeof invoke>
      : Promise.resolve([]) as ReturnType<typeof invoke>)
    await mount(); await click('Review with…')
    // Busy preparation deliberately keeps the normal Close disabled; unmount
    // is equivalent to switching to another session while a read is in flight.
    await act(async () => root.render(<div>Another session</div>))
    await act(async () => finish(fixture()))
    expect(host.textContent).toBe('Another session')
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('handoff text', () => {
  it('quotes arbitrary packet instructions without shell interpolation', () => {
    expect(shellQuote("$(touch /tmp/nope) 'quoted' `cmd`")).toBe("'$(touch /tmp/nope) '\\''quoted'\\'' `cmd`'")
  })
  it('retains review provenance in copied findings', () => {
    expect(findingsPacket(fixture(), [])).toContain('Reviewed snapshot: snapshot')
  })
})
