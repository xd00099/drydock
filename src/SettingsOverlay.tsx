import { useEffect, useReducer, useState } from 'react'
import { useSetting } from './settings'
import { THEMES } from './theme'
import {
  ACTIONS, KEYMAP_EVENT, actionLabel, chordFor, displayChord, findConflict,
  loadOverrides, saveOverride, serializeChord, useChord, validateChord,
} from './keymap'
import type { ActionId, Category } from './keymap'

// ⌘, — full-window settings overlay (same overlay pattern as Home/usage:
// fixed inset-0, z 85, below the takeover dialog's 100 and quit guard's 110).
// Sections rail on the left.

type Section = 'shortcuts' | 'general' | 'appearance'

const S = {
  wrap: { position: 'fixed', inset: 0, zIndex: 85, background: 'var(--dd-bg0)', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none', fontFamily: 'system-ui' } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dd-border)' } as React.CSSProperties,
  title: { flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13 } as React.CSSProperties,
  close: { background: 'none', border: '1px solid var(--dd-border2)', borderRadius: 4, cursor: 'pointer', color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '2px 6px' } as React.CSSProperties,
  body: { flex: 1, minHeight: 0, display: 'flex' } as React.CSSProperties,
  rail: { width: 160, borderRight: '1px solid var(--dd-border)', padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 } as React.CSSProperties,
  railBtn: (on: boolean) => ({ textAlign: 'left', background: on ? 'var(--dd-btn)' : 'none', border: 'none', borderLeft: on ? '2px solid var(--dd-accent-text)' : '2px solid transparent', color: on ? 'var(--dd-text)' : 'var(--dd-text3)', fontSize: 12, padding: '7px 14px', cursor: 'pointer' }) as React.CSSProperties,
  panel: { flex: 1, overflowY: 'auto', padding: '18px 24px', maxWidth: 640 } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--dd-btn)' } as React.CSSProperties,
  rowText: { flex: 1 } as React.CSSProperties,
  rowLabel: { color: 'var(--dd-text)', fontSize: 13, marginBottom: 3 } as React.CSSProperties,
  rowDesc: { color: 'var(--dd-dim)', fontSize: 11, lineHeight: 1.5 } as React.CSSProperties,
  stub: { color: 'var(--dd-dim)', fontSize: 12, padding: '30px 0', textAlign: 'center' as const },
  shortcutRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--dd-border-faint)' } as React.CSSProperties,
  catHead: { color: 'var(--dd-dim)', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: 0.5, padding: '14px 0 4px' },
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} aria-pressed={on}
      style={{ width: 34, height: 19, borderRadius: 10, border: '1px solid ' + (on ? 'var(--dd-accent-border)' : 'var(--dd-border2)'), background: on ? 'var(--dd-accent-bg)' : 'var(--dd-btn)', position: 'relative', cursor: 'pointer', flexShrink: 0, marginTop: 2 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 17 : 2, width: 13, height: 13, borderRadius: '50%', background: on ? 'var(--dd-accent-text)' : 'var(--dd-dim)', transition: 'left 120ms' }} />
    </button>
  )
}

function GeneralPanel() {
  const [notify, setNotify] = useSetting('notifyEnabled', '1')
  const [parent, setParent] = useSetting('newSessionParent', '~')
  const [guard, setGuard] = useSetting('closeGuard', '1')
  const newChord = useChord('session.new')
  return (
    <div>
      <div style={S.row}>
        <div style={S.rowText}>
          <div style={S.rowLabel}>Notifications</div>
          <div style={S.rowDesc}>macOS notifications when a session needs input or finishes a turn.</div>
        </div>
        <Toggle on={notify !== '0'} onChange={(v) => setNotify(v ? '1' : '0')} />
      </div>
      <div style={S.row}>
        <div style={S.rowText}>
          <div style={S.rowLabel}>Default parent folder</div>
          <div style={S.rowDesc}>Where bare names in the “New claude session” dialog ({newChord}) land: “newthing” becomes {parent.replace(/\/+$/, '')}/newthing.</div>
        </div>
        <input value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false}
          style={{ background: 'var(--dd-btn)', border: '1px solid var(--dd-border2)', borderRadius: 5, color: 'var(--dd-text)', fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '4px 8px', width: 200 }} />
      </div>
      <div style={S.row}>
        <div style={S.rowText}>
          <div style={S.rowLabel}>Confirm closing live sessions</div>
          <div style={S.rowDesc}>Ask before ⌘W or ✕ closes a tab with a running claude session.</div>
        </div>
        <Toggle on={guard !== '0'} onChange={(v) => setGuard(v ? '1' : '0')} />
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
          <div style={S.catHead}>{c}</div>
          {ACTIONS.filter((a) => a.category === c).map((a) => {
            const chord = chordFor(a.id)
            const customized = a.id in overrides
            const rec = recording === a.id
            return (
              <div key={a.id} style={S.shortcutRow}>
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
                  style={{ minWidth: 84, textAlign: 'center', background: rec ? 'var(--dd-accent-bg)' : 'var(--dd-btn)', border: '1px solid ' + (rec ? 'var(--dd-accent-border)' : 'var(--dd-border2)'), borderRadius: 5, color: rec ? 'var(--dd-accent-text)' : chord ? 'var(--dd-text1)' : 'var(--dd-dim)', fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'system-ui' }}>
                  {rec ? 'press keys…' : chord ? displayChord(chord) : 'unbound'}
                </button>
              </div>
            )
          })}
        </div>
      ))}
      <div style={S.shortcutRow}>
        <span style={{ flex: 1, color: 'var(--dd-text1)', fontSize: 12 }}>Switch to tab 1–9</span>
        <span title="Fixed — not rebindable" style={{ minWidth: 84, textAlign: 'center', color: 'var(--dd-dim)', fontSize: 11, border: '1px solid var(--dd-border)', borderRadius: 5, padding: '3px 8px' }}>⌘1–9 🔒</span>
      </div>
      {notice && <div style={{ color: 'var(--dd-warn-muted)', fontSize: 11, padding: '10px 0' }}>{notice}</div>}
      <button onClick={() => {
        // also abandon any in-flight recording/steal: a stale pending steal
        // confirmed AFTER the wipe would re-unbind a just-restored action
        setRecording(null); setSteal(null); setNotice(null)
        localStorage.removeItem('dd.keymap'); window.dispatchEvent(new CustomEvent(KEYMAP_EVENT))
      }}
        style={{ marginTop: 16, background: 'var(--dd-btn)', border: '1px solid var(--dd-border2)', borderRadius: 5, color: 'var(--dd-text2)', fontSize: 11, padding: '4px 10px', cursor: 'pointer' }}>
        Restore all defaults
      </button>
    </div>
  )
}

// A theme card's swatch shows THAT theme's colors (concrete hexes from the
// registry), not the live tokens — otherwise every card previews the active
// theme. The System card's swatch is a dark/light split.
function Swatch({ p }: { p: { bg: string; text: string; dots: [string, string, string] } }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, background: p.bg, border: '1px solid var(--dd-border2)', borderRadius: 5, padding: '5px 7px', flexShrink: 0 }}>
      <span style={{ width: 16, height: 3, borderRadius: 2, background: p.text }} />
      {p.dots.map((c, i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
      ))}
    </span>
  )
}

function AppearancePanel() {
  const [theme, setTheme] = useSetting('theme', 'dark')
  const card = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    background: on ? 'var(--dd-btn)' : 'none',
    border: '1px solid ' + (on ? 'var(--dd-accent-border)' : 'var(--dd-border)'),
    borderRadius: 8, padding: '9px 12px', cursor: 'pointer',
  })
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
      <div style={{ ...S.rowDesc, padding: '4px 0 10px' }}>
        Applies instantly — terminals recolor in place.
      </div>
      <button onClick={() => setTheme('system')} style={{ ...card(sysOn), marginBottom: 8 }}>
        <span style={radio(sysOn)} />
        {text('System', 'Follow the macOS appearance (Dark / Light).')}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'linear-gradient(90deg, #10141a 50%, #ffffff 50%)', border: '1px solid var(--dd-border2)', borderRadius: 5, padding: '5px 7px', flexShrink: 0 }}>
          <span style={{ width: 16, height: 3, borderRadius: 2, background: '#c8cdd5' }} />
          <span style={{ width: 16, height: 3, borderRadius: 2, background: '#2d3949' }} />
        </span>
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {THEMES.map((t) => {
          const on = theme === t.id
          return (
            <button key={t.id} onClick={() => setTheme(t.id)} style={card(on)}>
              <span style={radio(on)} />
              {text(t.label, t.desc)}
              <Swatch p={t.preview} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function SettingsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<Section>('shortcuts')
  if (!open) return null
  return (
    <div style={S.wrap} ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus() } }} tabIndex={-1}>
      <div style={S.head}>
        <span style={S.title}>Settings</span>
        <button onClick={onClose} title="Close (Esc)" style={S.close}>✕</button>
      </div>
      <div style={S.body}>
        <div style={S.rail}>
          {(['shortcuts', 'general', 'appearance'] as Section[]).map((s) => (
            <button key={s} style={S.railBtn(section === s)} onClick={() => setSection(s)}>
              {s === 'shortcuts' ? 'Shortcuts' : s === 'general' ? 'General' : 'Appearance'}
            </button>
          ))}
        </div>
        <div style={S.panel}>
          {section === 'general' && <GeneralPanel />}
          {section === 'shortcuts' && <ShortcutsPanel />}
          {section === 'appearance' && <AppearancePanel />}
        </div>
      </div>
    </div>
  )
}
