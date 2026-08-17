import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENTS, agentArgs, claudeCommand, enabledAgents, monogram, resolveAgents, shellLine,
} from './agents'
import type { AgentsConfig } from './agents'

const cfg = (over: Partial<AgentsConfig> = {}): AgentsConfig => ({
  enabled: ['claude'],
  commands: {},
  custom: [],
  ...over,
})

describe('resolveAgents', () => {
  it('enablement is strictly opt-in: only claude out of the box', () => {
    // null config = upgrade path (backend not answering yet / fresh file)
    for (const r of [resolveAgents(null, {}), resolveAgents(cfg(), {})]) {
      expect(enabledAgents(r).map((a) => a.id)).toEqual(['claude'])
    }
  })

  it('builtins enable only via the explicit list; customs count by existing', () => {
    const r = resolveAgents(
      cfg({ enabled: ['claude', 'codex'], custom: [{ id: 'c1', name: 'Goose', command: 'goose session', tint: '' }] }),
      {}
    )
    expect(enabledAgents(r).map((a) => a.id)).toEqual(['claude', 'codex', 'c1'])
    // enabled beats availability: the user chose it — a missing binary
    // surfaces as the shell's own error in the tab, never a silent drop
    expect(r.find((a) => a.id === 'codex')!.enabled).toBe(true)
  })

  it('an empty enabled list forces claude back on — a launch can never dead-end', () => {
    const r = resolveAgents(cfg({ enabled: [] }), {})
    expect(enabledAgents(r).map((a) => a.id)).toEqual(['claude'])
  })

  it('per-builtin command overrides replace the default and key the probe', () => {
    const r = resolveAgents(
      cfg({ commands: { claude: 'claude --dangerously-skip-permissions', codex: 'codex --profile work' } }),
      { 'codex --profile work': true }
    )
    expect(claudeCommand(r)).toBe('claude --dangerously-skip-permissions')
    const codex = r.find((a) => a.id === 'codex')!
    expect(codex.command).toBe('codex --profile work')
    expect(codex.available).toBe(true) // probe map keyed by the EFFECTIVE command
    // blank override falls back to the registry default
    expect(resolveAgents(cfg({ commands: { codex: '  ' } }), {}).find((a) => a.id === 'codex')!.command).toBe('codex')
  })

  it('customs: blank commands are dropped, names fall back to the command, tint to neutral', () => {
    const r = resolveAgents(
      cfg({
        custom: [
          { id: 'c1', name: '', command: 'goose session', tint: '' },
          { id: 'c2', name: 'blank', command: '  ', tint: '#111111' },
        ],
      }),
      {}
    )
    const c1 = r.find((a) => a.id === 'c1')!
    expect(c1.name).toBe('goose session')
    expect(c1.enabled).toBe(true)
    expect(c1.tint).toBe('var(--dd-accent-muted)')
    expect(r.find((a) => a.id === 'c2')).toBeUndefined()
  })
})

describe('claudeCommand / agentArgs / monogram', () => {
  it('claudeCommand defaults to plain claude', () => {
    expect(claudeCommand(resolveAgents(null, {}))).toBe('claude')
    expect(claudeCommand([])).toBe('claude')
  })

  it('builds the exact login-shell shape claude tabs use', () => {
    expect(agentArgs('codex --profile work')).toEqual(['-l', '-c', 'exec codex --profile work'])
  })

  it('shellLine execs simple commands but never compound ones', () => {
    expect(shellLine('codex --profile work')).toBe('exec codex --profile work')
    // `exec export …` makes zsh run the builtin and exit 0 before the agent
    // starts — compound lines must run un-exec'd
    expect(shellLine("export FOO=1 && codex")).toBe("export FOO=1 && codex")
    expect(shellLine('cd /x; codex')).toBe('cd /x; codex')
    expect(shellLine('codex 2>&1 | tee log')).toBe('codex 2>&1 | tee log')
    expect(shellLine('(codex)')).toBe('(codex)')
    // env-prefix stays exec'd: env is an external command, exec handles it
    expect(shellLine('env FOO=1 codex')).toBe('exec env FOO=1 codex')
    // a BARE assignment prefix must not be exec'd either — `exec FOO=1 codex`
    // makes the shell exec the assignment word itself (exit 127)
    expect(shellLine('FOO=1 codex')).toBe('FOO=1 codex')
    expect(shellLine('API_KEY=x claude --resume')).toBe('API_KEY=x claude --resume')
    expect(agentArgs('export FOO=1 && codex')).toEqual(['-l', '-c', 'export FOO=1 && codex'])
  })

  it('monograms: builtins fixed, customs from the name, junk degrades to ?', () => {
    expect(BUILTIN_AGENTS[0].id).toBe('claude') // Sidebar's AgentMark leans on this
    expect(monogram({ id: 'pi', name: 'pi' })).toBe('π')
    expect(monogram({ id: 'codex', name: 'Codex' })).toBe('CX')
    expect(monogram({ id: 'c1', name: 'Goose' })).toBe('GO')
    expect(monogram({ id: 'c2', name: '@!' })).toBe('?')
  })
})
