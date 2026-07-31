import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { FileTouch } from '@/lib/types'
import { S } from './styles'

/// Path shown project-relative when it lives under the session's project.
function relPath(p: string, root?: string): string {
  return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p
}

// Per-file status glyph, git-style: created / modified / gone from disk.

function FileBadge({ f }: { f: FileTouch }) {
  const [glyph, color, label] = !f.resolved
    ? ['−', 'var(--dd-err)', 'not on disk anymore (moved or deleted since)']
    : f.created
      ? ['+', 'var(--dd-ok)', 'created by this session']
      : ['•', 'var(--dd-warn-muted)', 'modified by this session']
  return (
    <span
      title={label}
      style={{ flex: 'none', width: 13, height: 13, borderRadius: 3, border: `1px solid ${color}`, color, fontSize: 10, lineHeight: '12px', textAlign: 'center', fontFamily: 'Menlo, monospace' }}
    >
      {glyph}
    </span>
  )
}

/// +adds/−dels column; falls back to a dim call count when a session's records
/// carried no measurable diff at all.
function DiffStat({ f }: { f: FileTouch }) {
  if (f.adds === 0 && f.dels === 0)
    return <span style={{ flex: 'none', color: 'var(--dd-dim2)', fontSize: 10, fontFamily: 'Menlo, monospace' }}>×{f.edits + f.writes}</span>
  return (
    <span style={{ flex: 'none', display: 'flex', gap: 6, fontFamily: 'Menlo, monospace', fontSize: 10 }}>
      {f.adds > 0 && <span style={{ color: 'var(--dd-ok)' }}>+{f.adds.toLocaleString('en-US')}</span>}
      {f.dels > 0 && <span style={{ color: 'var(--dd-err)' }}>−{f.dels.toLocaleString('en-US')}</span>}
    </span>
  )
}

/// The Briefing tab's bottom section: what this session touched, grouped by
/// directory like a review tool's file tree — status badge, basename, +/- line
/// stats — in its own scroll region under a sticky totals header. Rows open the
/// file's CURRENT location (the resolver's work); files that are gone render
/// struck-through and explain themselves instead of erroring.
export function FilesChanged({ files, projectPath, sessionId, squeeze, onTimeMachine }: { files: FileTouch[]; projectPath?: string; sessionId: string | null; squeeze?: boolean; onTimeMachine?: (path: string | null) => void }) {
  // collapsible pinned section (same grammar as TASKS and MCP SERVERS);
  // named secOpen: `open` is already this component's file-opening handler
  const [secOpen, setSecOpen] = useState(() => localStorage.getItem('dd.filesOpen') !== '0')
  const toggleOpen = () => setSecOpen((o) => { localStorage.setItem('dd.filesOpen', o ? '0' : '1'); return !o })
  // Transient error line (editor_cmd broken, file vanished mid-click, …).
  const [err, setErr] = useState<string | null>(null)
  const errTimer = useRef(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => setCollapsed(new Set()), [sessionId]) // fresh session, fresh tree
  const flashErr = (text: string) => {
    clearTimeout(errTimer.current)
    setErr(text)
    errTimer.current = window.setTimeout(() => setErr(null), 4000)
  }
  useEffect(() => () => clearTimeout(errTimer.current), [])
  if (files.length === 0) return null

  const open = (f: FileTouch, reveal: boolean) => {
    if (!f.resolved) {
      flashErr('not on disk anymore — moved or deleted since this session')
      return
    }
    invoke('open_path', { path: f.resolved, reveal }).catch((e) => flashErr(String(e)))
  }

  // group by the display path's directory, in first-touched order
  const groups: { dir: string; items: { f: FileTouch; name: string }[] }[] = []
  const byDir = new Map<string, { f: FileTouch; name: string }[]>()
  for (const f of files) {
    const rel = relPath(f.path, projectPath)
    const cut = rel.lastIndexOf('/')
    const dir = cut < 0 ? '' : rel.slice(0, cut)
    let list = byDir.get(dir)
    if (!list) {
      list = []
      byDir.set(dir, list)
      groups.push({ dir, items: list })
    }
    list.push({ f, name: cut < 0 ? rel : rel.slice(cut + 1) })
  }
  const totAdds = files.reduce((n, f) => n + f.adds, 0)
  const totDels = files.reduce((n, f) => n + f.dels, 0)
  const gone = files.filter((f) => !f.resolved).length

  const toggle = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir); else next.add(dir)
      return next
    })

  return (
    <div style={{ flex: secOpen ? '0 1 auto' : 'none', maxHeight: secOpen ? (squeeze ? '40%' : '55%') : undefined, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dd-hover)', background: 'var(--dd-well)' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 12px 6px' }}>
        <button onClick={toggleOpen} title={secOpen ? 'Collapse' : 'Expand'} style={{ ...S.groupBtn, width: 'auto', flex: 'none', gap: 5, padding: 0 }}>
          <span style={{ width: 9, flex: 'none', color: 'var(--dd-dim2)' }}>{secOpen ? '▾' : '▸'}</span>
          <span style={S.secHead}>FILES CHANGED</span>
        </button>
        <span style={{ display: 'flex', gap: 6, fontFamily: 'Menlo, monospace', fontSize: 11 }}>
          <span style={{ color: 'var(--dd-ok)' }}>+{totAdds.toLocaleString('en-US')}</span>
          <span style={{ color: 'var(--dd-err)' }}>−{totDels.toLocaleString('en-US')}</span>
        </span>
        <span style={{ color: 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
          · {files.length} file{files.length === 1 ? '' : 's'}{gone > 0 ? ` · ${gone} gone` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {onTimeMachine && (
          <button
            onClick={() => onTimeMachine(null)}
            title="File time machine — checkpoint history of everything this session edited"
            style={{ ...S.iconBtn, flex: 'none', fontSize: 10, padding: '1px 5px' }}
          >
            ⏱
          </button>
        )}
      </div>
      {secOpen && (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 10px' }}>
        {groups.map((g) => {
          const isOpen = !collapsed.has(g.dir)
          return (
            <div key={g.dir || '.'} style={{ marginBottom: 2 }}>
              <button
                onClick={() => toggle(g.dir)}
                title={g.dir || 'project root'}
                style={{ ...S.groupBtn, gap: 5, color: 'var(--dd-dim)', fontSize: 9.5, letterSpacing: 0.5, padding: '4px 0 2px', textTransform: 'uppercase', fontFamily: 'Menlo, monospace' }}
              >
                <span style={{ width: 9, flex: 'none', color: 'var(--dd-dim2)' }}>{isOpen ? '▾' : '▸'}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl' }}>
                  <span style={{ unicodeBidi: 'plaintext' }}>{g.dir || './'}</span>
                </span>
                {!isOpen && <span style={{ flex: 'none', fontWeight: 400 }}>{g.items.length}</span>}
              </button>
              {isOpen &&
                g.items.map(({ f, name }) => {
                  const moved = !!f.resolved && f.resolved !== f.path
                  const hint = !f.resolved
                    ? `${f.path}\nNot on disk anymore — moved or deleted since this session.`
                    : moved
                      ? `${f.path}\n→ now at: ${f.resolved}\nClick to open in your editor (settings "editor_cmd", else the default app)`
                      : `${f.path}\nOpen in your editor (settings "editor_cmd", else the default app)`
                  return (
                    <div key={f.path} className="dd-filerow" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 2px 2px 14px', minWidth: 0, borderRadius: 4 }}>
                      <FileBadge f={f} />
                      <button
                        onClick={() => open(f, false)}
                        title={hint}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          cursor: f.resolved ? 'pointer' : 'default',
                          color: f.resolved ? 'var(--dd-text1)' : 'var(--dd-dim)',
                          textDecoration: f.resolved ? 'none' : 'line-through',
                          fontFamily: 'Menlo, monospace',
                          fontSize: 11,
                          padding: '1px 0',
                        }}
                      >
                        {name}
                        {moved && <span style={{ color: 'var(--dd-accent)', marginLeft: 5 }} title={`moved — now at ${f.resolved}`}>↷</span>}
                      </button>
                      {onTimeMachine && (
                        <button
                          className="dd-reveal"
                          style={{ ...S.iconBtn, border: 'none', fontSize: 10, padding: '1px 3px' }}
                          title="History of this file (time machine)"
                          onClick={() => onTimeMachine(f.path)}
                        >
                          ↺
                        </button>
                      )}
                      {f.resolved && (
                        <button
                          className="dd-reveal"
                          style={{ ...S.iconBtn, border: 'none', fontSize: 10, padding: '1px 3px' }}
                          title="Reveal in Finder"
                          onClick={() => open(f, true)}
                        >
                          ⊙
                        </button>
                      )}
                      <DiffStat f={f} />
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      )}
      {secOpen && err && <div style={{ flex: 'none', color: 'var(--dd-err)', fontSize: 10, padding: '4px 12px 8px' }}>{err}</div>}
    </div>
  )
}

/// Live task board (~/.claude/tasks/<sid>/) as a pinned section between the
/// card and FILES CHANGED. Renders NOTHING when the session has no board; the
/// header carries the board's age so a stale "in progress" reads as stale.
