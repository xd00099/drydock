import { useEffect, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '@/lib/settings'
import { Button } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import css from '@/components/ui/Palette.module.css'

// ⌘N — start a claude session in ANY folder, existing or not, without the
// mouse. Type a path (~ expands; a bare name resolves against the
// dd.newSessionParent setting); each segment autocompletes from list_dirs;
// Enter ensure_dir's (mkdir -p) and launches. Claude-only by design — shells
// stay on ⌘T.

/** Resolve what the user typed to the path we'd actually create/open. An
 *  empty/blank parent setting falls back to `~` — bare names must never
 *  resolve to filesystem-root children. */
export function resolveInput(raw: string, parent: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (v.startsWith('/') || v === '~' || v.startsWith('~/')) return v
  const base = parent.replace(/\/+$/, '') || '~'
  return `${base}/${v}`
}

/** dirname (with trailing slash) + final partial segment, for autocomplete. */
export function splitPath(resolved: string): { dir: string; partial: string } {
  const i = resolved.lastIndexOf('/')
  if (i < 0) return { dir: '', partial: resolved }
  return { dir: resolved.slice(0, i + 1), partial: resolved.slice(i + 1) }
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
  const listId = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const seqRef = useRef(0) // stale list_dirs guard
  const launchSeqRef = useRef(0) // Esc after Enter must cancel the pending launch

  const parent = getSetting('newSessionParent', '~')
  const resolved = resolveInput(value, parent)
  const { dir, partial } = splitPath(resolved)
  const matches = dirs.filter((d) => d.toLowerCase().startsWith(partial.toLowerCase()))
  const exists = partial === '' || matches.some((d) => d.toLowerCase() === partial.toLowerCase())
  const showRecents = value.trim() === ''
  const rows = showRecents ? recents : matches.map((m) => dir + m)

  useEffect(() => {
    if (open) { setValue(''); setErr(null); setSel(-1); setBusy(false) }
    else launchSeqRef.current++ // closing (Esc/scrim) invalidates any in-flight launch
  }, [open])
  // The suggestion list describes ONE dirname; the moment the dirname changes
  // the old children must vanish (rendering them prefixed with the NEW dir
  // offers phantom paths — and Enter would mkdir one).
  useEffect(() => setDirs([]), [dir])
  useEffect(() => {
    if (!open || !dir) { setDirs([]); return }
    const token = ++seqRef.current
    const t = window.setTimeout(() => {
      invoke<string[]>('list_dirs', { parent: dir })
        .then((names) => { if (seqRef.current === token) setDirs(names) })
        .catch(() => { if (seqRef.current === token) setDirs([]) })
    }, 80)
    return () => { window.clearTimeout(t); ++seqRef.current }
  }, [open, dir])
  useEffect(() => setSel(-1), [value])
  useEffect(() => {
    if (sel >= 0) listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  if (!open) return null

  const launch = (path: string) => {
    // refuse the trivial roots: `~/`, `~`, `/` — a claude session in $HOME or
    // filesystem root is never what a stray Enter meant
    const norm = path.replace(/\/+$/, '') || '/'
    if (!norm || norm === '~' || norm === '/' || busy) return
    setBusy(true)
    const token = launchSeqRef.current
    invoke<string>('ensure_dir', { path: norm })
      .then((canon) => {
        if (launchSeqRef.current !== token) return // user closed while mkdir ran
        onLaunch(canon)
        onClose()
      })
      .catch((e) => {
        if (launchSeqRef.current !== token) return
        setErr(String(e))
        setBusy(false)
      })
  }

  const complete = (i: number) => {
    const path = rows[i]
    if (!path) return
    setValue(showRecents ? path : path + '/')
    setErr(null)
    setSel(-1)
    inputRef.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return // IME composition owns these keys
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); return }
    if (!e.shiftKey && (e.key === 'Tab' || e.key === 'ArrowRight') && sel >= 0 && rows[sel]) { e.preventDefault(); complete(sel); return }
    if (e.key === 'Tab' && !e.shiftKey && rows.length === 1) { e.preventDefault(); complete(0); return }
    if (e.key === 'Enter') {
      e.preventDefault()
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
    <div className={css.scrim} onClick={onClose}>
      <div className={css.box} role="dialog" aria-modal="true" aria-labelledby={`${listId}-title`} onClick={(e) => e.stopPropagation()}>
        <div className={css.header}><h2 className={css.title} id={`${listId}-title`}>New session</h2><kbd>⌘N</kbd></div>
        <input
          ref={(el) => { inputRef.current = el; el?.focus() }}
          className={css.pathInput}
          value={value}
          placeholder="~/path/to/project"
          onChange={(e) => { setValue(e.target.value); setErr(null) }}
          onKeyDown={onKey}
          spellCheck={false}
          role="combobox"
          aria-label="Project folder"
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={sel >= 0 && rows[sel] ? `${listId}-${sel}` : undefined}
        />
        <div className={css.hint}>{hint}</div>
        {rows.length > 0 && (
          <div ref={listRef} className={css.list}>
            <div className={css.cap}>{showRecents ? 'Recent projects' : 'Folders'}</div>
            <div id={listId} role="listbox" aria-label={showRecents ? 'Recent projects' : 'Folders'}>
            {rows.map((r, i) => (
              <div key={r} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={i === sel} className={css.row} data-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => complete(i)}>
                <Icon name="folder" size={16} /><span className={css.path}>{r}{showRecents ? '' : '/'}</span>{i === sel && <kbd>Tab</kbd>}
              </div>
            ))}
            </div>
          </div>
        )}
        <div className={css.footer}>
          <span>{sel >= 0 ? 'Tab / → / Enter fills path — Enter again starts session' : '↑↓ choose a folder · Tab fills path · Enter starts session'}</span>
          <div className={css.buttons}><Button small variant="ghost" onClick={onClose}>Cancel</Button><Button small variant="primary" disabled={busy || !resolved || ['~', '/'].includes(resolved.replace(/\/+$/, '') || '/')} onClick={() => launch(resolved)}>{busy ? 'Starting…' : 'Continue'}</Button></div>
        </div>
      </div>
    </div>
  )
}
