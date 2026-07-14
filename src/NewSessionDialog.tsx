import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from './settings'

// ⌘N — start a claude session in ANY folder, existing or not, without the
// mouse. Type a path (~ expands; a bare name resolves against the
// dd.newSessionParent setting); each segment autocompletes from list_dirs;
// Enter ensure_dir's (mkdir -p) and launches. Claude-only by design — shells
// stay on ⌘T.

/** Resolve what the user typed to the path we'd actually create/open. */
export function resolveInput(raw: string, parent: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (v.startsWith('/') || v === '~' || v.startsWith('~/')) return v
  const base = parent.replace(/\/+$/, '')
  return `${base}/${v}`
}

/** dirname (with trailing slash) + final partial segment, for autocomplete. */
export function splitPath(resolved: string): { dir: string; partial: string } {
  const i = resolved.lastIndexOf('/')
  if (i < 0) return { dir: '', partial: resolved }
  return { dir: resolved.slice(0, i + 1), partial: resolved.slice(i + 1) }
}

const S = {
  scrim: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(4,6,10,0.55)', display: 'flex', justifyContent: 'center', paddingTop: '18vh' } as React.CSSProperties,
  box: { width: 560, maxHeight: '50vh', alignSelf: 'flex-start', background: 'var(--dd-surface)', border: '1px solid var(--dd-border2)', borderRadius: 10, boxShadow: '0 18px 50px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui' } as React.CSSProperties,
  input: { background: 'none', border: 'none', outline: 'none', color: 'var(--dd-text)', fontSize: 14, padding: '13px 14px', fontFamily: 'ui-monospace, monospace' } as React.CSSProperties,
  hint: { padding: '0 14px 9px', fontSize: 11, fontFamily: 'ui-monospace, monospace' } as React.CSSProperties,
  list: { overflowY: 'auto', borderTop: '1px solid var(--dd-border)', padding: '4px 0' } as React.CSSProperties,
  row: (sel: boolean) => ({ padding: '5px 14px', fontSize: 12, fontFamily: 'ui-monospace, monospace', cursor: 'pointer', color: sel ? 'var(--dd-text)' : 'var(--dd-text2)', background: sel ? 'var(--dd-row)' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) as React.CSSProperties,
  cap: { padding: '6px 14px 2px', fontSize: 10, color: 'var(--dd-dim)', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
}

export default function NewSessionDialog({ open, recents, onLaunch, onClose }: {
  open: boolean
  recents: string[] // most-recent distinct project paths, for the empty-input list
  onLaunch: (absPath: string) => void // receives ensure_dir's canonical result
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const [dirs, setDirs] = useState<string[]>([]) // subdirs of the current dirname
  const [sel, setSel] = useState(-1) // -1 = input; 0.. = list row
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const seqRef = useRef(0) // stale list_dirs guard

  const parent = getSetting('newSessionParent', '~')
  const resolved = resolveInput(value, parent)
  const { dir, partial } = splitPath(resolved)
  const matches = dirs.filter((d) => d.toLowerCase().startsWith(partial.toLowerCase()))
  const exists = partial === '' || matches.some((d) => d.toLowerCase() === partial.toLowerCase())
  const showRecents = value.trim() === ''
  const rows = showRecents ? recents : matches.map((m) => dir + m)

  useEffect(() => { if (open) { setValue(''); setErr(null); setSel(-1); setBusy(false) } }, [open])
  useEffect(() => {
    if (!open || !dir) { setDirs([]); return }
    const token = ++seqRef.current
    const t = window.setTimeout(() => {
      invoke<string[]>('list_dirs', { parent: dir })
        .then((names) => { if (seqRef.current === token) setDirs(names) })
        .catch(() => { if (seqRef.current === token) setDirs([]) })
    }, 80)
    return () => window.clearTimeout(t)
  }, [open, dir])
  useEffect(() => setSel(-1), [value])

  if (!open) return null

  const launch = (path: string) => {
    if (!path || path === '~' || busy) return
    setBusy(true)
    invoke<string>('ensure_dir', { path })
      .then((canon) => { onLaunch(canon); onClose() })
      .catch((e) => { setErr(String(e)); setBusy(false) })
  }

  const complete = (i: number) => {
    if (!showRecents && matches[i]) setValue(dir + matches[i] + '/')
    setSel(-1)
    inputRef.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return // IME composition owns these keys
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); return }
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && !showRecents && sel >= 0) { e.preventDefault(); complete(sel); return }
    if (e.key === 'Tab' && !showRecents && matches.length === 1) { e.preventDefault(); complete(0); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (sel >= 0 && showRecents) { launch(rows[sel]); return }
      if (sel >= 0) { complete(sel); return }
      launch(resolved)
    }
  }

  const hint = err
    ? <span style={{ color: 'var(--dd-err)' }}>{err}</span>
    : !resolved || resolved === '~'
      ? <span style={{ color: 'var(--dd-dim)' }}>type a folder — bare names go under {parent}</span>
      : exists
        ? <span style={{ color: 'var(--dd-dim)' }}>open {resolved}</span>
        : <span style={{ color: 'var(--dd-ok-bright)' }}>will create {resolved}</span>

  return (
    <div style={S.scrim} onClick={onClose}>
      <div style={S.box} onClick={(e) => e.stopPropagation()}>
        <input
          ref={(el) => { inputRef.current = el; el?.focus() }}
          style={S.input}
          value={value}
          placeholder="~/path/to/project — created if missing"
          onChange={(e) => { setValue(e.target.value); setErr(null) }}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div style={S.hint}>{hint}</div>
        {rows.length > 0 && (
          <div style={S.list}>
            <div style={S.cap}>{showRecents ? 'recent projects' : 'folders'}</div>
            {rows.map((r, i) => (
              <div key={r} style={S.row(i === sel)}
                onMouseEnter={() => setSel(i)}
                onClick={() => (showRecents ? launch(r) : complete(i))}>
                {r}{showRecents ? '' : '/'}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
