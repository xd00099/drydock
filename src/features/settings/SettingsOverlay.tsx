import { useEffect, useReducer, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSetting } from '@/lib/settings'
import { AGENTS_EVENT, BUILTIN_AGENTS } from '@/lib/agents'
import AgentLogo from '@/components/AgentLogo'
import type { AgentsConfig } from '@/lib/agents'
import { THEMES } from '@/lib/theme'
import {
  ACTIONS, KEYMAP_EVENT, actionLabel, chordFor, displayChord, findConflict,
  loadOverrides, saveOverride, serializeChord, useChord, validateChord,
} from '@/lib/keymap'
import type { ActionId, Category } from '@/lib/keymap'
import { Button, IconButton } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import css from './Settings.module.css'

// ⌘, — full-window settings overlay (same overlay pattern as Home/usage:
// fixed inset-0, z 85, below the takeover dialog's 100 and quit guard's 110).
// Sections rail on the left.

type Section = 'shortcuts' | 'general' | 'agents' | 'appearance'


function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className={css.toggle} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label}><span /></button>
}

function GeneralPanel() {
  const [notify, setNotify] = useSetting('notifyEnabled', '1')
  const [parent, setParent] = useSetting('newSessionParent', '~')
  const [guard, setGuard] = useSetting('closeGuard', '1')
  const newChord = useChord('session.new')
  return (
    <div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>Notifications</div>
          <div className={css.rowDesc}>macOS notifications when a session needs input or finishes a turn.</div>
        </div>
        <Toggle label="Notifications" on={notify !== '0'} onChange={(v) => setNotify(v ? '1' : '0')} />
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>Default parent folder</div>
          <div className={css.rowDesc}>Where bare names in the “New session” dialog ({newChord}) land: “newthing” becomes {parent.replace(/\/+$/, '')}/newthing.</div>
        </div>
        <input value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false}
          className={css.input} style={{ width: 200 }} aria-label="Default parent folder" />
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>Confirm closing live sessions</div>
          <div className={css.rowDesc}>Ask before ⌘W or ✕ closes a tab with a running Claude session.</div>
        </div>
        <Toggle label="Confirm closing live sessions" on={guard !== '0'} onChange={(v) => setGuard(v ? '1' : '0')} />
      </div>
    </div>
  )
}

// Settings → Agents: strictly OPT-IN enablement (only claude out of the box —
// upgrades change nothing), an editable startup command per agent (claude's
// included: "claude --some-option"), and fully custom commands. Persisted in
// the backend settings.json (never any vendor's config); AGENTS_EVENT tells
// App's copy to refetch after the debounced save.
function AgentsPanel() {
  const [cfg, setCfg] = useState<AgentsConfig | null>(null)
  const [avail, setAvail] = useState<Record<string, boolean>>({})
  const [windowTint, setWindowTint] = useSetting('windowTint', '1')
  // Persistence is debounced: local state tracks every keystroke, but the
  // settings.json write + AGENTS_EVENT (which makes App refetch AND re-probe
  // with a fresh login shell) fire once typing settles. Pending edits flush
  // on unmount so closing Settings mid-word never loses the edit.
  const pendingRef = useRef<AgentsConfig | null>(null)
  const timerRef = useRef(0)
  const persist = () => {
    const next = pendingRef.current
    if (!next) return
    pendingRef.current = null
    invoke('agents_set', { enabled: next.enabled, commands: next.commands, custom: next.custom })
      .then(() => window.dispatchEvent(new CustomEvent(AGENTS_EVENT)))
      .catch(() => {})
  }
  useEffect(() => {
    invoke<AgentsConfig>('agents_get')
      .then((c) => {
        setCfg(c)
        invoke<Record<string, boolean>>('agents_probe', {
          commands: BUILTIN_AGENTS.filter((a) => a.id !== 'claude')
            .map((a) => c.commands?.[a.id]?.trim() || a.command),
        }).then(setAvail).catch(() => {})
      })
      .catch(() => {})
    return () => { window.clearTimeout(timerRef.current); persist() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!cfg) return <div className={css.stub}>loading…</div>

  const save = (next: AgentsConfig) => {
    setCfg(next)
    pendingRef.current = next
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(persist, 400)
  }
  const setCustom = (i: number, patch: Partial<AgentsConfig['custom'][number]>) =>
    save({ ...cfg, custom: cfg.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const enabledCount = cfg.enabled.length + cfg.custom.filter((c) => c.command.trim()).length

  const mono = (id: string, name: string, tint: string) => (
    <AgentLogo id={id} name={name} tint={tint} size={20} />
  )


  return (
    <div>
      <div className={css.rowDesc}>
        Enable the agents you use. With one enabled, new sessions (⌘N, Home, sidebar ＋) launch it
        directly; with more than one, every new session asks which agent to start. Claude Code keeps
        the full integration (badges, search, resume); other agents open as plain terminal tabs for now.
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.rowLabel}>Window tint</div>
          <div className={css.rowDesc}>Tint the tab strip in the active agent’s color — claude’s clay, codex’s green — so the window always reads as its agent. Shell tabs stay neutral.</div>
        </div>
        <Toggle label="Window tint" on={windowTint !== '0'} onChange={(v) => setWindowTint(v ? '1' : '0')} />
      </div>

      <div className={css.catHead}>built-in agents — enable what you use, and set each one’s startup command</div>
      {BUILTIN_AGENTS.map((a) => {
        const on = cfg.enabled.includes(a.id)
        const cmd = cfg.commands?.[a.id] ?? ''
        const effective = cmd.trim() || a.command
        const found = avail[effective]
        // the last enabled agent can't be disabled — a new session must
        // always have something to launch
        const locked = on && enabledCount === 1
        return (
          <div key={a.id} className={css.shortcutRow}>
            {mono(a.id, a.name, a.tint)}
            <span style={{ color: 'var(--dd-text1)', fontSize: 13, width: 110, flex: 'none' }}>{a.name}</span>
            <input
              value={cmd}
              placeholder={a.command}
              title={`startup command — e.g. ${a.command} --some-option, or export FOO=1 && ${a.command} (empty = default)`}
              spellCheck={false}
              className={css.input} style={{ flex: 1, opacity: on ? 1 : 0.5 }}
              onChange={(e) => {
                const commands = { ...cfg.commands }
                if (e.target.value.trim()) commands[a.id] = e.target.value
                else delete commands[a.id]
                save({ ...cfg, commands })
              }}
            />
            {a.id !== 'claude' && (
              <span title={found ? 'found in your login shell' : 'not found in your login shell'}
                style={{ fontSize: 11, flex: 'none', color: found ? 'var(--dd-ok-bright)' : 'var(--dd-dim)' }}>
                {found ? '● installed' : '○ not found'}
              </span>
            )}
            <span title={locked ? 'at least one agent must stay enabled' : undefined}>
              <Toggle label={`Enable ${a.name}`} on={on} onChange={(v) => {
                if (locked) return
                save({ ...cfg, enabled: v ? [...cfg.enabled, a.id] : cfg.enabled.filter((x) => x !== a.id) })
              }} />
            </span>
          </div>
        )
      })}

      <div className={css.catHead}>custom agents — always offered once they have a command; delete to remove</div>
      {cfg.custom.map((c, i) => (
        <div key={c.id} className={css.shortcutRow}>
          {mono(c.id, c.name || c.command, c.tint || 'var(--dd-accent-muted)')}
          <input value={c.name} placeholder="name" spellCheck={false} className={css.input} style={{ width: 100 }}
            onChange={(e) => setCustom(i, { name: e.target.value })} />
          <input value={c.command} placeholder="command — e.g. codex --profile work, or export FOO=1 && codex" spellCheck={false} className={css.input} style={{ flex: 1 }}
            onChange={(e) => setCustom(i, { command: e.target.value })} />
          <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(c.tint) ? c.tint : '#8a63d2'} title="tint"
            style={{ width: 26, height: 24, padding: 0, border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-sm)', background: 'none', cursor: 'pointer' }}
            onChange={(e) => setCustom(i, { tint: e.target.value })} />
          <button onClick={() => save({ ...cfg, custom: cfg.custom.filter((_, j) => j !== i) })}
            title="remove" style={{ background: 'none', border: 'none', color: 'var(--dd-dim)', cursor: 'pointer', fontSize: 12 }}>✕</button>
        </div>
      ))}
      <Button
        onClick={() => save({ ...cfg, custom: [...cfg.custom, { id: `c${Date.now().toString(36)}`, name: '', command: '', tint: '#8a63d2' }] })}
        style={{ marginTop: 16 }}
      ><Icon name="plus" /> Add custom agent</Button>
      <div className={css.rowDesc} style={{ paddingTop: 16 }}>
        Commands run in your login shell — the tab ends when the command exits. Env setups like
        “export FOO=1 &amp;&amp; codex” work; in a compound command, keep the agent last.
        Agent names belong to their vendors; Drydock isn’t affiliated with or endorsed by any of them.
      </div>
    </div>
  )
}

function ShortcutsPanel() {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener(KEYMAP_EVENT, force)
    return () => window.removeEventListener(KEYMAP_EVENT, force)
  }, [])
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [notice, setNotice] = useState<string | null>(null) // inline error/conflict text
  const [steal, setSteal] = useState<{ chord: string; from: ActionId } | null>(null)

  // While recording, capture EVERY key at the capture phase so App's
  // dispatcher (and the browser) never see it. Esc cancels; a conflicting
  // chord needs a confirming Enter to steal.
  useEffect(() => {
    if (!recording) return
    const h = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); setSteal(null); setNotice(null); return }
      // BARE Enter confirms a pending steal; a MODIFIED Enter (⇧⌘⏎ etc.) is
      // the user recording an Enter-chord instead — fall through to record it.
      if (steal && e.key === 'Enter' && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        saveOverride(steal.from, '') // loser: explicitly unbound
        saveOverride(recording, steal.chord)
        setRecording(null); setSteal(null); setNotice(null)
        return
      }
      const chord = serializeChord(e)
      if (!chord) return // modifier-only: keep waiting
      const err = validateChord(chord)
      if (err) { setNotice(err); setSteal(null); return }
      const other = findConflict(chord, loadOverrides(), recording)
      if (other) {
        setSteal({ chord, from: other })
        setNotice(`${displayChord(chord)} is bound to “${actionLabel(other)}” — ⏎ to take it`)
        return
      }
      const def = ACTIONS.find((a) => a.id === recording)!.default
      saveOverride(recording, chord === def ? null : chord)
      setRecording(null); setNotice(null)
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [recording, steal])

  const overrides = loadOverrides()
  const cats: Category[] = ['General', 'Tabs', 'Panels', 'Panes']
  return (
    <div>
      {cats.map((c) => (
        <div key={c}>
          <div className={css.catHead}>{c}</div>
          {ACTIONS.filter((a) => a.category === c).map((a) => {
            const chord = chordFor(a.id)
            const customized = a.id in overrides
            const rec = recording === a.id
            return (
              <div key={a.id} className={css.shortcutRow}>
                <span style={{ flex: 1, color: 'var(--dd-text1)', fontSize: 12 }}>{a.label}</span>
                {customized && !rec && (
                  <button
                    onClick={() => {
                      // restoring this action's default can collide with an
                      // override another action took over the same chord —
                      // apply steal semantics (the chord follows the reset,
                      // the other action shows "unbound") instead of leaving
                      // two rows displaying one chord with a silent loser.
                      const rest = loadOverrides()
                      delete rest[a.id]
                      const other = findConflict(a.default, rest, a.id)
                      if (other) saveOverride(other, '')
                      saveOverride(a.id, null)
                    }}
                    title="Reset to default"
                    style={{ background: 'none', border: 'none', color: 'var(--dd-dim)', cursor: 'pointer', fontSize: 12, padding: 0 }}>⟲</button>
                )}
                <button
                  onClick={() => { setRecording(rec ? null : a.id); setSteal(null); setNotice(null) }}
                  style={{ minWidth: 84, textAlign: 'center', background: rec ? 'var(--dd-accent-bg)' : 'var(--dd-btn)', border: '1px solid ' + (rec ? 'var(--dd-accent-border)' : 'var(--dd-border2)'), borderRadius: 'var(--dd-r-md)', color: rec ? 'var(--dd-accent-text)' : chord ? 'var(--dd-text1)' : 'var(--dd-dim)', fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'var(--dd-font-ui)' }}>
                  {rec ? 'press keys…' : chord ? displayChord(chord) : 'unbound'}
                </button>
              </div>
            )
          })}
        </div>
      ))}
      <div className={css.shortcutRow}>
        <span style={{ flex: 1, color: 'var(--dd-text1)', fontSize: 12 }}>Switch to tab 1–9</span>
        <span title="Fixed — not rebindable" style={{ minWidth: 84, textAlign: 'center', color: 'var(--dd-dim)', fontSize: 11, border: '1px solid var(--dd-hairline)', borderRadius: 'var(--dd-r-md)', padding: '3px 8px' }}>⌘1–9 🔒</span>
      </div>
      {notice && <div style={{ color: 'var(--dd-warn-muted)', fontSize: 11, padding: '10px 0' }}>{notice}</div>}
      <Button onClick={() => {
        // also abandon any in-flight recording/steal: a stale pending steal
        // confirmed AFTER the wipe would re-unbind a just-restored action
        setRecording(null); setSteal(null); setNotice(null)
        localStorage.removeItem('dd.keymap'); window.dispatchEvent(new CustomEvent(KEYMAP_EVENT))
      }}
        style={{ marginTop: 16 }}>
        Restore all defaults
      </Button>
    </div>
  )
}

// A theme card's swatch shows THAT theme's colors (concrete hexes from the
// registry), not the live tokens — otherwise every card previews the active
// theme. The System card's swatch is a dark/light split.
function Swatch({ p }: { p: { bg: string; text: string; dots: [string, string, string] } }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, background: p.bg, border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '5px 7px', flexShrink: 0 }}>
      <span style={{ width: 16, height: 3, borderRadius: 2, background: p.text }} />
      {p.dots.map((c, i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
      ))}
    </span>
  )
}

function AppearancePanel() {
  const [theme, setTheme] = useSetting('theme', 'dark')
  const radio = (on: boolean): React.CSSProperties => ({
    width: 13, height: 13, borderRadius: '50%', flexShrink: 0,
    border: '1px solid ' + (on ? 'var(--dd-accent)' : 'var(--dd-border3)'),
    background: on ? 'var(--dd-accent)' : 'none',
    boxShadow: on ? 'inset 0 0 0 3px var(--dd-btn)' : 'none',
  })
  const text = (label: string, desc: string) => (
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', color: 'var(--dd-text)', fontSize: 13 }}>{label}</span>
      <span style={{ display: 'block', color: 'var(--dd-dim)', fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{desc}</span>
    </span>
  )
  const sysOn = theme === 'system'
  return (
    <div>
      <div className={css.rowDesc}>
        Applies instantly — terminals recolor in place.
      </div>
      <button onClick={() => setTheme('system')} className={css.themeCard} aria-pressed={sysOn} style={{ marginBottom: 8 }}>
        <span style={radio(sysOn)} />
        {text('System', 'Follow the macOS appearance (Dark / Light).')}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'linear-gradient(90deg, #10141a 50%, #ffffff 50%)', border: '1px solid var(--dd-hairline-strong)', borderRadius: 'var(--dd-r-md)', padding: '5px 7px', flexShrink: 0 }}>
          <span style={{ width: 16, height: 3, borderRadius: 2, background: '#c8cdd5' }} />
          <span style={{ width: 16, height: 3, borderRadius: 2, background: '#2d3949' }} />
        </span>
      </button>
      {/* Split by dark/light. Flat, this grid is long enough that you scan the
          whole thing to find the light themes. */}
      {([true, false] as const).map((dark) => (
        <div key={String(dark)}>
          <div className={css.themeGroup}>{dark ? 'Dark' : 'Light'}</div>
          <div className={css.themeGrid}>
            {THEMES.filter((t) => t.dark === dark).map((t) => {
              const on = theme === t.id
              return (
                <button key={t.id} onClick={() => setTheme(t.id)} className={css.themeCard} aria-pressed={on}>
                  <span style={radio(on)} />
                  {text(t.label, t.desc)}
                  <Swatch p={t.preview} />
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function SettingsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<Section>('shortcuts')
  if (!open) return null
  return (
    <div className={css.wrap} ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus() } }} tabIndex={-1}>
      <div className={css.head} data-tauri-drag-region>
        <span className={css.title}>Settings</span>
        <IconButton label="Close settings" title="Close (Esc)" onClick={onClose}><Icon name="close" /></IconButton>
      </div>
      <div className={css.body}>
        <div className={css.rail}>
          {(['shortcuts', 'general', 'agents', 'appearance'] as Section[]).map((s) => (
            <button key={s} className={css.railBtn} aria-current={section === s ? 'page' : undefined} onClick={() => setSection(s)}>
              {s === 'shortcuts' ? 'Shortcuts' : s === 'general' ? 'General' : s === 'agents' ? 'Agents' : 'Appearance'}
            </button>
          ))}
        </div>
        <div className={css.panel}>
          <div className={css.panelContent}>
          <h1 className={css.sectionTitle}>{{ general: 'General', shortcuts: 'Keyboard shortcuts', agents: 'Agents', appearance: 'Appearance' }[section]}</h1>
          <p className={css.sectionDesc}>{{ general: 'Make Drydock fit the way you work.', shortcuts: 'Move through your workspace without leaving the keyboard.', agents: 'Choose your tools and how they start.', appearance: 'A workspace that feels like yours.' }[section]}</p>
          {section === 'general' && <GeneralPanel />}
          {section === 'shortcuts' && <ShortcutsPanel />}
          {section === 'agents' && <AgentsPanel />}
          {section === 'appearance' && <AppearancePanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
