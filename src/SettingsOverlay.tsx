import { useEffect, useReducer, useState } from 'react'
import { useSetting } from './settings'
import {
  ACTIONS, KEYMAP_EVENT, actionLabel, chordFor, displayChord, findConflict,
  loadOverrides, saveOverride, serializeChord, useChord, validateChord,
} from './keymap'
import type { ActionId, Category } from './keymap'

// ⌘, — full-window settings overlay (same overlay pattern as Home/usage:
// fixed inset-0, z 85, below the takeover dialog's 100 and quit guard's 110).
// Sections rail on the left; Appearance stays a stub until the theming spec
// lands.

type Section = 'shortcuts' | 'general' | 'appearance'

const S = {
  wrap: { position: 'fixed', inset: 0, zIndex: 85, background: '#0b0e13', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none', fontFamily: 'system-ui' } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1d2530' } as React.CSSProperties,
  title: { flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13 } as React.CSSProperties,
  close: { background: 'none', border: '1px solid #2c3647', borderRadius: 4, cursor: 'pointer', color: '#9aa3af', fontSize: 12, lineHeight: 1, padding: '2px 6px' } as React.CSSProperties,
  body: { flex: 1, minHeight: 0, display: 'flex' } as React.CSSProperties,
  rail: { width: 160, borderRight: '1px solid #1d2530', padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 } as React.CSSProperties,
  railBtn: (on: boolean) => ({ textAlign: 'left', background: on ? '#141b26' : 'none', border: 'none', borderLeft: on ? '2px solid #9cc3ff' : '2px solid transparent', color: on ? '#e8edf4' : '#7d8794', fontSize: 12, padding: '7px 14px', cursor: 'pointer' }) as React.CSSProperties,
  panel: { flex: 1, overflowY: 'auto', padding: '18px 24px', maxWidth: 640 } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 0', borderBottom: '1px solid #141b26' } as React.CSSProperties,
  rowText: { flex: 1 } as React.CSSProperties,
  rowLabel: { color: '#e8edf4', fontSize: 13, marginBottom: 3 } as React.CSSProperties,
  rowDesc: { color: '#5b6675', fontSize: 11, lineHeight: 1.5 } as React.CSSProperties,
  stub: { color: '#5b6675', fontSize: 12, padding: '30px 0', textAlign: 'center' as const },
  shortcutRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #10151d' } as React.CSSProperties,
  catHead: { color: '#5b6675', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: 0.5, padding: '14px 0 4px' },
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} aria-pressed={on}
      style={{ width: 34, height: 19, borderRadius: 10, border: '1px solid ' + (on ? '#3d5a80' : '#2c3647'), background: on ? '#27405e' : '#141b26', position: 'relative', cursor: 'pointer', flexShrink: 0, marginTop: 2 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 17 : 2, width: 13, height: 13, borderRadius: '50%', background: on ? '#9cc3ff' : '#5b6675', transition: 'left 120ms' }} />
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
          style={{ background: '#141b26', border: '1px solid #2c3647', borderRadius: 5, color: '#e8edf4', fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '4px 8px', width: 200 }} />
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
      if (steal && e.key === 'Enter') {
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
                <span style={{ flex: 1, color: '#c6cede', fontSize: 12 }}>{a.label}</span>
                {customized && !rec && (
                  <button onClick={() => saveOverride(a.id, null)} title="Reset to default"
                    style={{ background: 'none', border: 'none', color: '#5b6675', cursor: 'pointer', fontSize: 12, padding: 0 }}>⟲</button>
                )}
                <button
                  onClick={() => { setRecording(rec ? null : a.id); setSteal(null); setNotice(null) }}
                  style={{ minWidth: 84, textAlign: 'center', background: rec ? '#27405e' : '#141b26', border: '1px solid ' + (rec ? '#3d5a80' : '#2c3647'), borderRadius: 5, color: rec ? '#9cc3ff' : chord ? '#c6cede' : '#5b6675', fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'system-ui' }}>
                  {rec ? 'press keys…' : chord ? displayChord(chord) : 'unbound'}
                </button>
              </div>
            )
          })}
        </div>
      ))}
      <div style={S.shortcutRow}>
        <span style={{ flex: 1, color: '#c6cede', fontSize: 12 }}>Switch to tab 1–9</span>
        <span title="Fixed — not rebindable" style={{ minWidth: 84, textAlign: 'center', color: '#5b6675', fontSize: 11, border: '1px solid #1d2530', borderRadius: 5, padding: '3px 8px' }}>⌘1–9 🔒</span>
      </div>
      {notice && <div style={{ color: '#e0b070', fontSize: 11, padding: '10px 0' }}>{notice}</div>}
      <button onClick={() => { localStorage.removeItem('dd.keymap'); window.dispatchEvent(new CustomEvent(KEYMAP_EVENT)) }}
        style={{ marginTop: 16, background: '#141b26', border: '1px solid #2c3647', borderRadius: 5, color: '#9aa3af', fontSize: 11, padding: '4px 10px', cursor: 'pointer' }}>
        Restore all defaults
      </button>
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
          {section === 'appearance' && <div style={S.stub}>Theming arrives with the appearance update — for now Drydock ships dark.</div>}
        </div>
      </div>
    </div>
  )
}
