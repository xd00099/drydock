// Agent profiles: the coding agents Drydock can launch in a tab. Claude Code
// is the first-class integration (hooks, transcripts, radar); every other
// profile is launch-tier — `exec <command>` in a login shell, with a monogram
// + tint for identity. Builtin DEFINITIONS live here; the user's choices
// (default agent, disabled builtins, custom profiles) persist in the backend
// settings.json (settings.rs) so they survive a localStorage wipe.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type AgentSpec = {
  id: string
  name: string
  /** Shell line launched via `$SHELL -l -c` (see shellLine) — the tab ends
   *  when the command exits. Needs env? `env FOO=1 codex`, `FOO=1 codex` and
   *  `export FOO=1 && codex` all work. In a compound command keep the agent
   *  LAST: resume/session ids are appended to the end of the line. */
  command: string
  /** Brand-adjacent accent for the monogram + window tint. Deliberately NOT a
   *  vendor logo: names/logos carry trademark weight, two letters don't. */
  tint: string
  builtin: boolean
}

export type ResolvedAgent = AgentSpec & { enabled: boolean; available: boolean }

/** Mirrors backend `AgentsConfig` (main.rs agents_get/agents_set). Enablement
 *  is strictly OPT-IN: `enabled` defaults to just claude, so nothing changes
 *  on upgrade. `commands` holds per-builtin startup overrides (id → command,
 *  e.g. claude → "claude --dangerously-skip-permissions"). */
export type AgentsConfig = {
  enabled: string[]
  commands: Record<string, string>
  custom: { id: string; name: string; command: string; tint: string }[]
}

// Ordered as the picker shows them: claude first (the flagship), then the
// field roughly by traction (research: docs/multi-agent-support-research).
export const BUILTIN_AGENTS: AgentSpec[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', tint: '#D97757', builtin: true },
  { id: 'codex', name: 'Codex', command: 'codex', tint: '#10A37F', builtin: true },
  { id: 'pi', name: 'pi', command: 'pi', tint: '#D9A13F', builtin: true },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', tint: '#46B8B0', builtin: true },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', tint: '#8957E5', builtin: true },
  { id: 'cursor', name: 'Cursor CLI', command: 'cursor-agent', tint: '#9AA0AE', builtin: true },
  { id: 'droid', name: 'Factory droid', command: 'droid', tint: '#EF6C35', builtin: true },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', tint: '#4796E3', builtin: true },
]

const MONOGRAMS: Record<string, string> = {
  claude: 'CL', codex: 'CX', pi: 'π', opencode: 'OC',
  copilot: 'CP', cursor: 'CU', droid: 'DR', gemini: 'GM',
}

/** Monogram TEXT color: the tint blended toward the theme's text color, so
 *  chips stay legible on light themes (raw brand hexes sit at ~2.5:1 on a
 *  near-white bar) and keep their hue on dark ones. */
export function monoInk(tint: string): string {
  return `color-mix(in srgb, ${tint} 70%, var(--dd-text))`
}

/** 1–2 char chip label; customs take their name's first two alphanumerics. */
export function monogram(a: { id: string; name: string }): string {
  const m = MONOGRAMS[a.id]
  if (m) return m
  const alnum = a.name.replace(/[^\p{L}\p{N}]/gu, '')
  return (alnum.slice(0, 2) || '?').toUpperCase()
}

/** The `-c` line for a spawn. Simple commands are exec'd so the agent
 *  replaces the shell; a compound line (`export FOO=1 && codex`, pipes,
 *  subshells) must NOT be — zsh treats `exec export …` as "run the builtin,
 *  then exit the shell", so the tab dies instantly with exit 0 before the
 *  agent ever starts. Un-exec'd, the -c shell exits when the line finishes:
 *  same tab lifecycle, just a wrapper shell around the agent. */
export function shellLine(command: string): string {
  // metachars OR a leading VAR=value assignment: `exec FOO=1 codex` makes the
  // shell exec the assignment word itself (exit 127) — same dead tab
  return /[;&|()`\n]/.test(command) || /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command)
    ? command
    : `exec ${command}`
}

/** PTY args for an agent tab — the exact shape claude tabs use, minus the
 *  claude-only splices. */
export function agentArgs(command: string): string[] {
  return ['-l', '-c', shellLine(command)]
}

/** Merge builtins + user config + availability probe. Enablement is the
 *  user's explicit opt-in list (customs count as enabled by existing — delete
 *  to remove); if the list somehow enables nothing, claude is forced back on
 *  so a launch can never dead-end. `available` is ADVISORY (the settings
 *  page's "not found" hint) — it never gates an enabled agent: the user chose
 *  it, and a missing binary surfaces as the shell's own error in the tab. */
export function resolveAgents(
  cfg: AgentsConfig | null,
  avail: Record<string, boolean>,
): ResolvedAgent[] {
  const enabled = new Set(cfg?.enabled ?? ['claude'])
  const out: ResolvedAgent[] = BUILTIN_AGENTS.map((a) => {
    const command = cfg?.commands?.[a.id]?.trim() || a.command
    return {
      ...a,
      command,
      enabled: enabled.has(a.id),
      available: a.id === 'claude' ? true : avail[command] ?? false,
    }
  })
  for (const c of cfg?.custom ?? []) {
    if (!c.id || !c.command.trim()) continue
    out.push({
      id: c.id,
      name: c.name || c.command,
      command: c.command,
      tint: c.tint || 'var(--dd-accent-muted)',
      builtin: false,
      enabled: true,
      available: avail[c.command] ?? true,
    })
  }
  if (!out.some((a) => a.enabled)) out[0].enabled = true // claude, always first
  return out
}

/** The agents a new session can launch. One entry → launch it directly;
 *  two or more → every new session pops the picker. */
export function enabledAgents(resolved: ResolvedAgent[]): ResolvedAgent[] {
  return resolved.filter((a) => a.enabled)
}

/** Claude's (possibly user-overridden) startup command — every claude spawn
 *  (new, resume, restore) goes through this so "claude --option xxx" sticks. */
export function claudeCommand(resolved: ResolvedAgent[]): string {
  return resolved.find((a) => a.id === 'claude')?.command || 'claude'
}

export const AGENTS_EVENT = 'dd-agents-changed'

/** Config + availability, refetched whenever Settings → Agents saves. */
export function useAgents(): { cfg: AgentsConfig | null; avail: Record<string, boolean> } {
  const [cfg, setCfg] = useState<AgentsConfig | null>(null)
  const [avail, setAvail] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    const load = () =>
      invoke<AgentsConfig>('agents_get')
        .then((c) => {
          if (!alive) return
          setCfg(c)
          // builtins only, with the user's command overrides applied (the
          // probe map is keyed by effective command). Customs are trusted as
          // written — a typo surfaces as the shell's own error in the tab.
          const commands = BUILTIN_AGENTS.filter((a) => a.id !== 'claude')
            .map((a) => c.commands?.[a.id]?.trim() || a.command)
          invoke<Record<string, boolean>>('agents_probe', { commands })
            .then((m) => { if (alive) setAvail((p) => ({ ...p, ...m })) })
            .catch(() => {})
        })
        .catch(() => {})
    load()
    window.addEventListener(AGENTS_EVENT, load)
    return () => { alive = false; window.removeEventListener(AGENTS_EVENT, load) }
  }, [])
  return { cfg, avail }
}
