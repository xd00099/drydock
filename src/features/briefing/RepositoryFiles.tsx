import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { S } from './styles'
import css from './RepositoryFiles.module.css'

export type ChangedFile = { path: string; previous_path?: string | null; resolved: string | null; status: string; adds: number | null; dels: number | null }
export type RepositoryChanges = { root: string; head: string; scope: string; files: ChangedFile[] }

const statuses: Record<string, [string, string]> = {
  A: ['Added', 'var(--dd-ok)'], D: ['Deleted', 'var(--dd-err)'],
  M: ['Modified', 'var(--dd-warn-muted)'], '?': ['Untracked', 'var(--dd-ok)'],
  T: ['Type changed', 'var(--dd-warn-muted)'],
  R: ['Renamed', 'var(--dd-warn-muted)'], C: ['Copied', 'var(--dd-ok)'],
}

export function RepositoryFiles({ sessionId, actions, squeeze, onTimeMachine, onHeadChange }: { sessionId: string; actions?: ReactNode; squeeze?: boolean; onTimeMachine?: () => void; onHeadChange?: (head: string) => void }) {
  const [changes, setChanges] = useState<RepositoryChanges | null>(null)
  const [error, setError] = useState('')
  const [openError, setOpenError] = useState('')
  const [secOpen, setSecOpen] = useState(() => localStorage.getItem('dd.filesOpen') !== '0')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const errTimer = useRef(0)
  const headCallback = useRef(onHeadChange)
  headCallback.current = onHeadChange
  useEffect(() => () => clearTimeout(errTimer.current), [])
  useEffect(() => {
    let dead = false
    let pending = false
    let last = 0
    setChanges(null); setError(''); setOpenError(''); setCollapsed(new Set())
    const refresh = async () => {
      if (pending || Date.now() - last < 1200) return
      pending = true; last = Date.now()
      try {
        const next = await invoke<RepositoryChanges>('collaboration_changes', { sessionId })
        if (!dead) { setChanges(next); setError(''); headCallback.current?.(next.head) }
      } catch (e) { if (!dead) { setChanges(null); setError(String(e)) } }
      finally { pending = false }
    }
    void refresh()
    // Git edits/commits can happen outside a transcript, so index events alone
    // do not keep this section current. Poll only while Briefing is visible.
    const timer = window.setInterval(refresh, 4000)
    const un = listen('index-updated', refresh)
    window.addEventListener('focus', refresh)
    return () => { dead = true; clearInterval(timer); un.then((u) => u()); window.removeEventListener('focus', refresh) }
  }, [sessionId])

  const files = changes?.files ?? []
  const lastCommit = changes?.scope === 'Last commit'
  const heading = lastCommit ? 'LAST COMMIT FILES' : 'UNCOMMITTED FILES'
  const groups = new Map<string, ChangedFile[]>()
  for (const file of files) {
    const cut = file.path.lastIndexOf('/')
    const dir = cut < 0 ? '' : file.path.slice(0, cut)
    const list = groups.get(dir) ?? []
    list.push(file); groups.set(dir, list)
  }
  const toggleOpen = () => setSecOpen((o) => { localStorage.setItem('dd.filesOpen', o ? '0' : '1'); return !o })
  const toggle = (dir: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(dir)) next.delete(dir); else next.add(dir)
    return next
  })
  const open = (file: ChangedFile, reveal: boolean) => {
    if (!file.resolved) return
    invoke('open_path', { path: file.resolved, reveal }).catch((e) => {
      clearTimeout(errTimer.current); setOpenError(String(e))
      errTimer.current = window.setTimeout(() => setOpenError(''), 4000)
    })
  }
  const adds = files.reduce((n, f) => n + (f.adds ?? 0), 0)
  const dels = files.reduce((n, f) => n + (f.dels ?? 0), 0)
  return <section aria-label="Repository file changes" className={css.section} style={{ flex: secOpen ? '0 1 auto' : 'none', maxHeight: secOpen ? (squeeze ? '45%' : '60%') : undefined }}>
    <div className={css.header}>
      <button onClick={toggleOpen} aria-expanded={secOpen} style={{ ...S.groupBtn, width: 'auto', padding: 0, gap: 5 }}>
        <span style={{ color: 'var(--dd-dim2)' }}>{secOpen ? '▾' : '▸'}</span><span style={S.secHead}>{heading}</span>
      </button>
      {changes && <span className={css.totals}><span style={{ color: 'var(--dd-ok)' }}>+{adds}</span><span style={{ color: 'var(--dd-err)' }}>−{dels}</span><span>{files.length} file{files.length === 1 ? '' : 's'}</span></span>}
      {onTimeMachine && <button onClick={onTimeMachine} title="File time machine — checkpoint history of everything this session edited" style={{ ...S.iconBtn, marginLeft: 'auto' }}>⏱</button>}
    </div>
    {changes && <p className={css.scope} title={changes.root}>{lastCommit ? `Clean checkout · latest commit ${changes.head.slice(0, 7)}` : 'Repository-wide · staged, unstaged and new files'}</p>}
    {actions}
    {secOpen && <div className={css.tree}>
      {error ? <p role="status" className={css.message}>{error}</p> : !changes ? <p role="status" className={css.message}>Loading Git changes…</p> : files.length === 0 ? <p className={css.message}>No file changes in this scope.</p> : Array.from(groups, ([dir, items]) => <div key={dir}>
        <button onClick={() => toggle(dir)} aria-expanded={!collapsed.has(dir)} title={dir || 'repository root'} className={css.directory}>
          <span>{collapsed.has(dir) ? '▸' : '▾'}</span><span className={css.directoryName}>{dir || './'}</span><span>{items.length}</span>
        </button>
        {!collapsed.has(dir) && items.map((file) => {
          const [label, color] = statuses[file.status] ?? [file.status, 'var(--dd-text3)']
          return <div key={file.path} className={`dd-filerow ${css.row}`}>
            <span title={label} className={css.badge} style={{ color, borderColor: color }}>{file.status}</span>
            <button disabled={!file.resolved} onClick={() => open(file, false)} className={css.file} title={`${file.path}\n${label}${file.previous_path ? ` from ${file.previous_path}` : ''}${file.resolved ? ' · Open in editor' : ' · Not present in the working tree'}`}>{file.path.slice(file.path.lastIndexOf('/') + 1)}</button>
            {file.resolved && <button className="dd-reveal" style={S.iconBtn} title="Reveal in Finder" onClick={() => open(file, true)}>⊙</button>}
            <span className={css.stats}>{file.adds === null || file.dels === null ? <span title="Line counts unavailable">—</span> : <><span style={{ color: 'var(--dd-ok)' }}>+{file.adds}</span><span style={{ color: 'var(--dd-err)' }}>−{file.dels}</span></>}</span>
          </div>
        })}
      </div>)}
      {openError && <p role="alert" className={css.error}>{openError}</p>}
    </div>}
  </section>
}
