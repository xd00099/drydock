import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, clip, fmtTokens, loadNum, relAge, baseName, type Artifact, type ArtifactKind, type CardView, type FileTouch, type McpServer, type ReviewPrompt, type ReviewState, type SavedArtifact, type SessionUsage, type Skill, type TasksView, type TimelineItem } from './types'
import ArtifactView from './ArtifactView'
import TimeMachine from './TimeMachine'
import ResizeHandle from './ResizeHandle'
import { useChord } from './keymap'

type RightTab = 'briefing' | 'project' | 'preview'

type Props = {
  sessionId: string | null // null for a brand-new claude tab with no session id yet
  projectPath?: string // active session's project, for per-project MCP lookup
  starred: boolean
  artifacts: Artifact[] // visual artifacts this tab's session has rendered
  // resolved display label (Drydock name > custom-title > summary > title);
  // null when the session isn't indexed yet
  label?: string | null
  onToggleStar?: () => void
  // rename the session in Drydock's index (blank clears); absent = unindexed
  onRename?: (name: string) => void
  // artifacts arrived while this tab was NOT focused (e.g. Home was showing):
  // open the Artifacts tab on mount so the badge's click actually lands there
  initialUnread?: boolean
  // Interactive artifact review (docs/artifact-review.md). null = this tab
  // can't review (plain transcript / exited pty) → annotation UI hidden.
  review?: ReviewState | null
  reviewAccent?: string // session color for the SDK highlights + panel chrome
  onReviewQueue?: (p: ReviewPrompt) => void
  onReviewDiscard?: (index: number) => void
  onReviewSend?: (message: string, endReview: boolean) => void
  collapsed: boolean // lifted to App so ⌘J can drive it
  onSetCollapsed: (c: boolean) => void
  previewNonce: number // ⌘⇧J: each bump jumps to the artifact preview sub-tab
}

const TABS: { id: RightTab; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'project', label: 'Project' }, // skills + MCP, merged: project/environment scope
  { id: 'preview', label: 'Artifacts' }, // id stays 'preview' so saved dd.rightTab keeps working
]

// Saved right-tab prefs from before the Skills/MCP merge name tabs that no
// longer exist; both fold into Project. Anything else unexpected → briefing.
function loadRightTab(): RightTab {
  const saved = localStorage.getItem('dd.rightTab')
  if (saved === 'skills' || saved === 'mcp') return 'project'
  return saved === 'briefing' || saved === 'project' || saved === 'preview' ? saved : 'briefing'
}

const loadStrSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[])
  } catch {
    return new Set()
  }
}

const S = {
  muted: { color: 'var(--dd-dim)' } as const,
  tabBtn: (active: boolean) =>
    ({
      flex: 1,
      // flex items default to min-width:auto — without minWidth: 0 the labels
      // set a floor and the strip overflows/clips at narrow panel widths
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      background: active ? 'var(--dd-surface2)' : 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid var(--dd-accent-muted)' : '2px solid var(--dd-border)',
      color: active ? 'var(--dd-text)' : 'var(--dd-text3)',
      cursor: 'pointer',
      fontSize: 11,
      padding: '5px 2px',
      fontFamily: 'system-ui',
    }) as const,
  groupBtn: { display: 'flex', alignItems: 'center', gap: 4, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontWeight: 600, fontSize: 11, padding: '3px 0', textAlign: 'left' } as const,
  name: { color: 'var(--dd-text1)' } as const,
  desc: {
    color: 'var(--dd-text3)',
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  } as const,
  chip: { fontSize: 9, color: 'var(--dd-text2)', background: 'var(--dd-row)', border: '1px solid var(--dd-border2)', borderRadius: 4, padding: '0 5px' } as const,
  secHead: { color: 'var(--dd-text3)', fontWeight: 700, fontSize: 10, letterSpacing: 0.8 } as const,
  iconBtn: { background: 'none', border: '1px solid var(--dd-border2)', borderRadius: 4, cursor: 'pointer', color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '2px 6px' } as const,
}

function Item({ it }: { it: TimelineItem }) {
  return (
    <li style={{ marginBottom: 6 }}>
      <span style={{ color: it.in_progress ? 'var(--dd-ok-bright)' : 'var(--dd-text1)' }}>
        {it.in_progress ? '◐ ' : ''}
        {it.text}
        {it.in_progress && <span style={{ color: 'var(--dd-dim)', fontStyle: 'italic' }}> — in progress</span>}
      </span>
      {it.detail.length > 0 && (
        <ul style={{ margin: '3px 0 0', paddingLeft: 16, listStyle: 'none' }}>
          {it.detail.map((d, i) => (
            <li key={i} style={{ color: 'var(--dd-text2)', marginBottom: 2 }}>
              <span style={{ color: 'var(--dd-dim2)' }}>– </span>
              {d}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

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
function FilesChanged({ files, projectPath, sessionId, squeeze, onTimeMachine }: { files: FileTouch[]; projectPath?: string; sessionId: string | null; squeeze?: boolean; onTimeMachine?: (path: string | null) => void }) {
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
function TasksSection({ view }: { view: TasksView | null }) {
  const [open, setOpen] = useState(() => localStorage.getItem('dd.tasksOpen') !== '0')
  const toggleOpen = () => setOpen((o) => { localStorage.setItem('dd.tasksOpen', o ? '0' : '1'); return !o })
  if (!view || view.tasks.length === 0) return null
  const total = view.tasks.length
  const done = view.tasks.filter((t) => t.status === 'completed').length
  const blocked = view.tasks.filter((t) => t.status !== 'completed' && t.blocked_by.length > 0)
  const active = view.tasks.find((t) => t.status === 'in_progress')
  const subjects = new Map(view.tasks.map((t) => [t.id, t.subject]))
  const glyph = (t: (typeof view.tasks)[number]): [string, string, string] =>
    t.status === 'completed'
      ? ['✓', 'var(--dd-dim2)', 'completed']
      : t.status === 'in_progress'
        ? ['◐', 'var(--dd-ok-bright)', 'in progress']
        : t.blocked_by.length > 0
          ? ['⊘', 'var(--dd-warn-muted)', `waiting on: ${t.blocked_by.map((b) => subjects.get(b) ?? `#${b}`).join(', ')}`]
          : ['○', 'var(--dd-text3)', 'pending']
  return (
    <div style={{ flex: open ? '0 1 auto' : 'none', maxHeight: open ? '40%' : undefined, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dd-hover)', background: 'var(--dd-well)' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px 6px' }}>
        <button onClick={toggleOpen} title={open ? 'Collapse' : 'Expand'} style={{ ...S.groupBtn, width: 'auto', flex: 'none', gap: 5, padding: 0 }}>
          <span style={{ width: 9, flex: 'none', color: 'var(--dd-dim2)' }}>{open ? '▾' : '▸'}</span>
          <span style={S.secHead}>TASKS</span>
        </button>
        <span style={{ flex: 'none', color: 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
          {done}/{total}{blocked.length > 0 ? ` · ${blocked.length} blocked` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {view.updated_at != null && (
          <span title={'the board\u2019s last change — a stale \u201cin progress\u201d is old news, not live'} style={{ color: 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
            {relAge(view.updated_at)}
          </span>
        )}
      </div>
      {open && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 10px' }}>
          {active?.active_form && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ color: 'var(--dd-ok-bright)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>◐ now: {active.active_form}</span>
              <span style={{ flex: 1, minWidth: 24, height: 3, borderRadius: 2, background: 'var(--dd-row)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.round((done / total) * 100)}%`, background: 'var(--dd-ok)' }} />
              </span>
            </div>
          )}
          {view.tasks.map((t) => {
            const [g, color, tip] = glyph(t)
            return (
              <div key={t.id} title={tip} style={{ display: 'flex', gap: 7, alignItems: 'baseline', padding: '2px 0', fontSize: 11.5 }}>
                <span style={{ width: 12, flex: 'none', textAlign: 'center', color }}>{g}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.status === 'completed' ? 'var(--dd-dim)' : t.status === 'in_progress' ? 'var(--dd-text)' : 'var(--dd-text2)' }}>
                  {t.subject}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Two clearly separated sections: the briefing card scrolls on top; "Files
// changed" is its own visually distinct region pinned below with its own
// scroll — a long timeline can't bury the file list and vice versa.
function BriefingTab({ sessionId, card, starred, files, tasks, usage, projectPath, label, onToggleStar, onRename }: { sessionId: string | null; card: CardView | null; starred: boolean; files: FileTouch[]; tasks: TasksView | null; usage: SessionUsage | null; projectPath?: string; label?: string | null; onToggleStar?: () => void; onRename?: (name: string) => void }) {
  // editing holds the label CAPTURED when the pencil was clicked (null = not
  // editing): the unchanged-commit guard must compare against what the user
  // saw when they started, not the live prop — a mid-edit refresh changing
  // `label` must neither freeze a stale auto title nor block a real commit.
  const [editing, setEditing] = useState<string | null>(null)
  // time machine overlay: false = closed, string = start at this file,
  // null = whole-session checkpoint view
  const [tm, setTm] = useState<string | null | false>(false)
  const commitRename = (value: string) => {
    const initial = editing
    setEditing(null)
    const name = value.trim()
    // unchanged = no-op: a click-away blur must not freeze an AUTO title
    // (card summary) into a permanent override
    if (initial === null || name === initial.trim()) return
    onRename?.(name)
  }
  if (!sessionId)
    return <div style={{ ...S.muted, padding: 12 }}>No indexed session yet — once this conversation is saved, its briefing card appears here.</div>
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <button
            onClick={onToggleStar}
            disabled={!onToggleStar}
            title={starred ? 'Unstar this session' : 'Star this session'}
            style={{ background: 'none', border: 'none', cursor: onToggleStar ? 'pointer' : 'default', color: starred ? 'var(--dd-warn-bright)' : 'var(--dd-border3)', fontSize: 16, padding: 0, lineHeight: 1 }}
          >
            ★
          </button>
          {editing !== null && onRename ? (
            <input
              autoFocus
              defaultValue={editing}
              maxLength={60}
              placeholder="Session name — empty clears"
              style={{ flex: 1, minWidth: 0, background: 'var(--dd-bg1)', border: '1px solid var(--dd-accent-strong)', borderRadius: 4, color: 'var(--dd-text)', fontSize: 13, fontWeight: 600, fontFamily: 'system-ui', padding: '2px 6px', outline: 'none' }}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                // an Enter/Esc confirming an IME composition (pinyin) is part
                // of typing the name, not a commit/cancel
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter') commitRename(e.currentTarget.value)
                else if (e.key === 'Escape') setEditing(null)
              }}
              onBlur={(e) => commitRename(e.currentTarget.value)}
            />
          ) : (
            <div style={{ flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{label || card?.summary || 'Session'}</div>
          )}
          {onRename && editing === null && (
            <button
              onClick={() => setEditing(label ?? '')}
              title="Rename session (a Drydock-only name — claude's own session is untouched)"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-dim)', fontSize: 12, padding: 0, lineHeight: 1.3 }}
            >
              ✎
            </button>
          )}
          {usage && usage.total_tokens > 0 && (
            <span
              style={{ ...S.chip, flex: 'none', fontFamily: 'Menlo, monospace', alignSelf: 'flex-start', lineHeight: '15px' }}
              title={
                `${usage.total_tokens.toLocaleString('en-US')} tokens (input + output + cache writes; cache reads excluded)\n` +
                usage.rows.map((r) => `${r.model}${r.scope !== 'main' ? ' (agents)' : ''}: ${fmtTokens(r.input)} in · ${fmtTokens(r.output)} out`).join('\n') +
                (usage.agent_output > 0 ? `\nsubagents wrote ${fmtTokens(usage.agent_output)} of the output` : '') +
                '\nfrom transcript usage records — an estimate, not a bill'
              }
            >
              Σ {fmtTokens(usage.total_tokens)}
            </span>
          )}
        </div>
        {card ? (
          <>
            {card.timeline.length > 0 ? (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {/* one source of "now doing": with a live task board below,
                    the AI card's own in-progress flags stand down */}
                {card.timeline.map((it, i) => (
                  <Item key={i} it={tasks && tasks.tasks.length > 0 ? { ...it, in_progress: false } : it} />
                ))}
              </ul>
            ) : (
              <div style={S.muted}>no timeline yet</div>
            )}
            <div style={{ color: 'var(--dd-dim)', fontSize: 10, marginTop: 12 }}>card from {relAge(card.generated_at)} ago</div>
          </>
        ) : (
          <div style={S.muted}>no briefing card yet</div>
        )}
        <button
          style={{ marginTop: 10, background: 'var(--dd-border)', color: 'var(--dd-text)', border: '1px solid var(--dd-border2)', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
          onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}
        >
          Refresh card
        </button>
      </div>
      <TasksSection view={tasks} />
      <FilesChanged
        files={files}
        projectPath={projectPath}
        sessionId={sessionId}
        squeeze={!!tasks && tasks.tasks.length > 0}
        onTimeMachine={(p) => setTm(p)}
      />
      {tm !== false && <TimeMachine sessionId={sessionId} initialPath={tm} onClose={() => setTm(false)} />}
    </div>
  )
}

function SkillsSection({ projectPath }: { projectPath?: string }) {
  // Fetched per-mount (~17 file reads) so it stays fresh when plugins change and
  // a transient failure isn't pinned by a module cache. Includes plugin +
  // personal (~/.claude) skills and this project's own (<project>/.claude/skills).
  const [state, setState] = useState<'loading' | 'error' | Skill[]>('loading')
  // Groups start collapsed (just a header + count); persisted so an expand
  // survives the panel's per-session remount.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadStrSet('dd.skillsExpanded'))
  useEffect(() => {
    let live = true
    setState('loading')
    invoke<Skill[]>('list_skills', { projectPath: projectPath ?? null })
      .then((s) => live && setState(s))
      .catch(() => live && setState('error'))
    return () => { live = false }
  }, [projectPath])

  const toggle = (plugin: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(plugin)) next.delete(plugin); else next.add(plugin)
      localStorage.setItem('dd.skillsExpanded', JSON.stringify([...next]))
      return next
    })

  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <span style={S.secHead}>SKILLS</span>
      {Array.isArray(state) && state.length > 0 && (
        <span style={{ color: 'var(--dd-dim)', fontSize: 10 }}>{state.length} · plugin, personal &amp; project</span>
      )}
    </div>
  )
  if (state === 'loading') return <div>{header}<div style={S.muted}>loading skills…</div></div>
  if (state === 'error') return <div>{header}<div style={S.muted}>couldn’t load skills</div></div>
  if (state.length === 0) return <div>{header}<div style={S.muted}>no plugin skills found</div></div>

  const groups = new Map<string, Skill[]>()
  for (const s of state) {
    if (!groups.has(s.plugin)) groups.set(s.plugin, [])
    groups.get(s.plugin)!.push(s)
  }
  return (
    <div>
      {header}
      {[...groups.entries()].map(([plugin, list]) => {
        const open = expanded.has(plugin)
        return (
          <div key={plugin} style={{ marginBottom: 4 }}>
            <button style={S.groupBtn} onClick={() => toggle(plugin)} title={open ? 'Collapse' : 'Expand'}>
              <span style={{ width: 10, color: 'var(--dd-dim)' }}>{open ? '▾' : '▸'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plugin}</span>
              <span style={{ color: 'var(--dd-dim)', fontWeight: 400 }}>{list.length}</span>
            </button>
            {open &&
              list.map((s) => (
                <div key={s.name} style={{ marginBottom: 7, paddingLeft: 14 }}>
                  <div style={S.name}>{s.name}</div>
                  <div style={S.desc} title={s.description}>{s.description}</div>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

// Connection-health dot color per status token from `claude mcp list`.
const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--dd-ok)',
  failed: 'var(--dd-err)',
  pending: 'var(--dd-warn-muted)',
  unknown: 'var(--dd-dim)',
  checking: 'var(--dd-border3)',
}

function StatusDot({ status, title }: { status: string; title: string }) {
  return <span title={title} style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: STATUS_COLOR[status] ?? 'var(--dd-dim)' }} />
}

// A small on/off switch. `on` = Drydock offers this server to the sessions it
// launches; off denies its tools to new sessions (the server config is untouched).
function Toggle({ on, busy, onClick, title }: { on: boolean; busy: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      style={{ flex: 'none', width: 26, height: 15, borderRadius: 8, border: '1px solid var(--dd-border2)', background: on ? 'var(--dd-ok-bg)' : 'var(--dd-hover)', position: 'relative', cursor: busy ? 'default' : 'pointer', padding: 0, opacity: busy ? 0.5 : 1 }}
    >
      <span style={{ position: 'absolute', top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: '50%', background: 'var(--dd-text1)', transition: 'left .12s' }} />
    </button>
  )
}

// `claude mcp list` spawns the CLI (seconds, not ms), and this whole panel
// remounts on every center-tab switch (key={activeTab.id} in App) — so the last
// health check is cached per project across remounts and only re-run once stale.
const MCP_RECHECK_MS = 60_000
const mcpStatusCache = new Map<string, { status: Record<string, { st: string; raw: string }>; checkedAt: number }>()
// The in-flight check, so concurrent remounts JOIN one `claude mcp list`
// spawn instead of racing several during the cold multi-second window.
const mcpCheckInFlight = new Map<string, Promise<unknown>>()
// Last server list per project: seeds the section on remount so the header
// (rollup dot, count) doesn't blink out while list_mcp_servers re-resolves.
const mcpServersCache = new Map<string, McpServer[]>()

// Worst-first, so the section header can report health even while collapsed.
const STATUS_RANK: Record<string, number> = { failed: 4, pending: 3, unknown: 2, checking: 1, connected: 0 }

function McpSection({ projectPath }: { projectPath?: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  // null = never checked (dots show "checking"); {} = checked, no statuses
  const [status, setStatus] = useState<Record<string, { st: string; raw: string }> | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // Collapsed still shows the rollup dot + age; the 60s re-check keeps running.
  const [secOpen, setSecOpen] = useState(() => localStorage.getItem('dd.mcpOpen') !== '0')
  // Result-application guard: bumped whenever projectPath changes, so a check
  // still in flight for the OLD project can't label the new one. Also the
  // "one check at a time" latch (state lags; a ref doesn't).
  const epochRef = useRef(0)
  const inFlightRef = useRef(false)
  const cacheKey = projectPath ?? ''

  const runCheck = useCallback((hasExternal: boolean) => {
    const epoch = epochRef.current
    if (!hasExternal) {
      setStatus({})
      setCheckedAt(Date.now())
      return
    }
    if (inFlightRef.current) return
    inFlightRef.current = true
    setChecking(true)
    // join the check another instance already started for this project — a
    // remount mid-check must not spawn a second concurrent CLI process
    let check = mcpCheckInFlight.get(cacheKey)
    if (!check) {
      check = invoke<[string, string, string][]>('mcp_status', { projectPath: projectPath ?? null })
        .then((triples) => {
          // single writer per spawn; joiners read the cache in their .then
          mcpStatusCache.set(cacheKey, {
            status: Object.fromEntries(triples.map(([n, st, raw]) => [n, { st, raw }])),
            checkedAt: Date.now(),
          })
        })
        .finally(() => mcpCheckInFlight.delete(cacheKey))
      mcpCheckInFlight.set(cacheKey, check)
    }
    check
      .then(() => {
        if (epochRef.current !== epoch) return
        const c = mcpStatusCache.get(cacheKey)
        if (c) { setStatus(c.status); setCheckedAt(c.checkedAt) }
        setCheckErr(null)
      })
      .catch((e) => {
        // keep the previous statuses on screen — but say the refresh failed
        if (epochRef.current === epoch) setCheckErr(String(e))
      })
      .finally(() => {
        inFlightRef.current = false
        if (epochRef.current === epoch) setChecking(false)
      })
  }, [projectPath, cacheKey])

  useEffect(() => {
    epochRef.current++
    const epoch = epochRef.current
    // a check still in flight for the OLD project must not block the new
    // project's first check for a whole interval (its result is epoch-discarded
    // anyway, and its finally() harmlessly re-clears this)
    inFlightRef.current = false
    setServers(null)
    setCheckErr(null)
    setChecking(false)
    // seed from the caches so a remount shows last-known health immediately
    const cached = mcpStatusCache.get(projectPath ?? '')
    setStatus(cached?.status ?? null)
    setCheckedAt(cached?.checkedAt ?? null)
    setServers(mcpServersCache.get(projectPath ?? '') ?? null)
    invoke<McpServer[]>('list_mcp_servers', { projectPath: projectPath ?? null })
      .then((list) => {
        if (epochRef.current !== epoch) return
        mcpServersCache.set(projectPath ?? '', list)
        setServers(list)
        // a cached check stands in for the mount-time one only while it's
        // fresh AND covers every external server — a just-added server must
        // trigger a real check, not wear "not in the output" for a minute
        const covered = !!cached && list.every((s) => s.builtin || cached.status[s.name] !== undefined)
        if (!cached || !covered || Date.now() - cached.checkedAt >= MCP_RECHECK_MS)
          runCheck(list.some((s) => !s.builtin))
      })
      .catch(() => {
        if (epochRef.current !== epoch) return
        setServers([])
        setStatus({})
      })
  }, [projectPath, runCheck])

  // A dot is only as honest as its age: re-check every minute while this tab
  // stays open (a dead server otherwise kept its green from panel-mount time).
  // The FIRST tick honors the cached check's age — a 59s-old seed re-checks in
  // ~1s, not 60 — so remounting can never stretch staleness past one TTL.
  const hasExternal = !!servers?.some((s) => !s.builtin)
  const checkedAtRef = useRef<number | null>(null)
  checkedAtRef.current = checkedAt
  useEffect(() => {
    if (!hasExternal) return
    const first = checkedAtRef.current == null
      ? MCP_RECHECK_MS
      : Math.max(0, checkedAtRef.current + MCP_RECHECK_MS - Date.now())
    let iv = 0
    const t = window.setTimeout(() => {
      runCheck(true)
      iv = window.setInterval(() => runCheck(true), MCP_RECHECK_MS)
    }, first)
    return () => { window.clearTimeout(t); if (iv) window.clearInterval(iv) }
  }, [hasExternal, runCheck])

  const toggleExpand = (name: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n })

  const toggle = async (s: McpServer) => {
    setBusy((prev) => new Set(prev).add(s.name))
    try {
      await invoke('set_mcp_enabled', { name: s.name, enabled: !s.enabled })
      setServers((prev) => {
        const next = prev && prev.map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x))
        if (next) mcpServersCache.set(cacheKey, next) // keep the remount seed honest
        return next
      })
    } catch (e) {
      console.error(e)
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(s.name); return n })
    }
  }

  const ageText = (ts: number) => {
    const w = relAge(ts)
    return w === 'now' ? 'just now' : `${w} ago`
  }

  // Health dot: the builtin loopback server is "connected" whenever enabled;
  // external servers reflect the last `claude mcp list` check. The tooltip
  // carries the CLI's raw words plus the check's age — the dot is a summary,
  // never the whole truth.
  const dotFor = (s: McpServer): { status: string; title: string } => {
    if (s.builtin)
      return s.enabled
        ? { status: 'connected', title: 'Listening · renders to the Artifacts tab' }
        : { status: 'unknown', title: 'Off — new sessions won’t get the render tool' }
    if (status === null) return { status: 'checking', title: 'Checking…' }
    const e = status[s.name]
    // not in the (possibly cache-seeded) map while a check runs: it's being
    // checked right now, not "missing from the output"
    if (!e && checking) return { status: 'checking', title: 'Checking…' }
    const st = e?.st ?? 'unknown'
    const what = e?.raw
      ? e.raw
      : st === 'connected' ? 'Connected' : st === 'failed' ? 'Failed to connect' : st === 'pending' ? 'Pending approval' : 'Not in the `claude mcp list` output'
    return { status: st, title: checkedAt ? `${what}\nchecked ${ageText(checkedAt)}` : what }
  }

  // Header rollup: the WORST status across enabled servers, so the collapsed
  // section still reports health at a glance — a red server can't be buried.
  // Disabled servers don't count: they're not offered to new sessions anyway.
  const dots = (servers ?? []).filter((s) => s.enabled).map((s) => dotFor(s).status)
  const failed = dots.filter((d) => d === 'failed').length
  const worst = dots.length
    ? dots.reduce((a, b) => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a))
    : null

  const toggleOpen = () =>
    setSecOpen((o) => { localStorage.setItem('dd.mcpOpen', o ? '0' : '1'); return !o })

  // Pinned-section layout, same recipe as FILES CHANGED: seam on top, darker
  // ground, own scroll, bounded height — skills can never bury a dead server.
  return (
    <div style={{ flex: secOpen ? '0 1 auto' : 'none', maxHeight: secOpen ? '55%' : undefined, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dd-hover)', background: 'var(--dd-well)' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px 6px' }}>
        {/* label and age SHRINK (ellipsize) at narrow widths; the dot, the
            count, and ↻ are flex:none so the signal + the cure never clip */}
        <button onClick={toggleOpen} title={secOpen ? 'Collapse' : 'Expand'} style={{ ...S.groupBtn, width: 'auto', flex: '0 1 auto', minWidth: 0, gap: 5, padding: 0 }}>
          <span style={{ width: 9, flex: 'none', color: 'var(--dd-dim2)' }}>{secOpen ? '▾' : '▸'}</span>
          <span style={{ ...S.secHead, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>MCP SERVERS</span>
        </button>
        {worst && (
          <StatusDot
            status={worst}
            title={`worst across enabled servers: ${worst}${checkedAt ? ` · checked ${ageText(checkedAt)}` : ''}\nhealth via \`claude mcp list\``}
          />
        )}
        {servers !== null && servers.length > 0 && (
          <span style={{ flex: 'none', color: 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
            {servers.length}{failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* compact age ('2m'), full wording in the tooltip; turns into a red
            'check failed' when the refresh errors — visible even collapsed,
            so the rollup dot can't silently advertise stale health */}
        <span
          title={
            checkErr
              ? `${checkErr}\nlast good check: ${checkedAt ? ageText(checkedAt) : 'never'}`
              : checkedAt ? `health checked ${ageText(checkedAt)}` : undefined
          }
          style={{ color: checkErr ? 'var(--dd-err)' : 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {checking ? 'checking…' : checkErr ? 'check failed' : hasExternal && checkedAt ? relAge(checkedAt) : ''}
        </span>
        {hasExternal && (
          <button
            onClick={() => runCheck(true)}
            disabled={checking}
            title="Re-check server health now"
            style={{ ...S.iconBtn, flex: 'none', fontSize: 10, padding: '1px 5px', opacity: checking ? 0.4 : 1, cursor: checking ? 'default' : 'pointer' }}
          >
            ↻
          </button>
        )}
      </div>
      {secOpen && (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 10px' }}>
      {checkErr && (
        <div title={checkErr} style={{ color: 'var(--dd-err)', fontSize: 10, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {checkErr}
        </div>
      )}
      <div style={{ color: 'var(--dd-dim)', fontSize: 10, marginBottom: 8, lineHeight: 1.4 }}>toggling applies to new sessions · secrets hidden</div>
      {servers === null ? (
        <div style={S.muted}>loading…</div>
      ) : servers.length === 0 ? (
        <div style={S.muted}>no MCP servers configured{projectPath ? ' for this project' : ''}</div>
      ) : (
        servers.map((s) => {
          const open = expanded.has(s.name)
          const hasTools = s.tools.length > 0
          const dot = dotFor(s)
          return (
            <div key={s.name} style={{ marginBottom: 9, opacity: s.enabled ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {hasTools ? (
                  <button onClick={() => toggleExpand(s.name)} title={open ? 'Hide tools' : 'Show tools'} style={{ ...S.groupBtn, width: 10, flex: 'none', padding: 0 }}>
                    <span style={{ color: 'var(--dd-dim)' }}>{open ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <span style={{ width: 10, flex: 'none' }} />
                )}
                <StatusDot status={dot.status} title={dot.title} />
                <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                <span style={S.chip}>{s.kind}</span>
                <span style={{ color: 'var(--dd-dim2)', fontSize: 9 }}>{s.scope}</span>
                <Toggle
                  on={s.enabled}
                  busy={busy.has(s.name)}
                  onClick={() => toggle(s)}
                  title={s.enabled ? 'Disable for new Drydock sessions' : 'Enable for new Drydock sessions'}
                />
              </div>
              {s.detail && (
                <div style={{ color: 'var(--dd-text3)', wordBreak: 'break-all', fontFamily: 'Menlo, monospace', fontSize: 11, marginTop: 1, paddingLeft: 16 }}>{s.detail}</div>
              )}
              {open &&
                s.tools.map((t) => (
                  <div key={t} style={{ paddingLeft: 24, marginTop: 4 }}>
                    <div style={S.name}>{t}</div>
                    {s.builtin && (
                      <div style={S.desc}>Renders a self-contained HTML / SVG / Markdown artifact into Drydock’s Artifacts tab.</div>
                    )}
                  </div>
                ))}
            </div>
          )
        })
      )}
      </div>
      )}
    </div>
  )
}

// The merged project/environment tab: what new sessions launched from this
// project get. Browse-y lists (skills) scroll on top; the short, actionable
// MCP section is pinned below with its own scroll — the same arrangement as
// briefing card over FILES CHANGED.
function ProjectTab({ projectPath }: { projectPath?: string }) {
  const proj = projectPath ? baseName(projectPath) : undefined
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* pinned above the scroll: the scope must stay visible however far the
          skills list is scrolled — both sections below answer to it */}
      {proj && (
        <div style={{ flex: 'none', padding: '12px 12px 0', color: 'var(--dd-text3)' }}>
          for project: <span style={{ color: 'var(--dd-text1)' }}>{proj}</span>
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: proj ? '8px 12px 12px' : 12 }}>
        <SkillsSection projectPath={projectPath} />
      </div>
      <McpSection projectPath={projectPath} />
    </div>
  )
}

// One entry in the Artifacts tab: a live render from this run, or a persisted
// one from the session's on-disk gallery.
type GalleryItem = { id: string; title: string; kind: ArtifactKind; saved?: SavedArtifact }

function PreviewTab({
  artifacts,
  sessionId,
  review,
  accent,
  onQueue,
  onDiscard,
  onSend,
}: {
  artifacts: Artifact[]
  sessionId: string | null
  review: ReviewState | null // null = tab can't review (annotation UI hidden)
  accent: string
  onQueue?: (p: ReviewPrompt) => void
  onDiscard?: (index: number) => void
  onSend?: (message: string, endReview: boolean) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [saved, setSaved] = useState<SavedArtifact[]>([])
  // fetched content of saved svg/markdown artifacts, keyed by file name
  const [contentCache, setContentCache] = useState<Record<string, string>>({})
  const overlayRef = useRef<HTMLDivElement>(null)
  // Transient confirmation/error line under the header (download/reveal results).
  // One timer, always restarted: two quick Downloads must not have the first
  // timer clear the second message early.
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const flashTimer = useRef(0)
  const flash = (text: string, error?: boolean) => {
    clearTimeout(flashTimer.current)
    setMsg({ text, error })
    flashTimer.current = window.setTimeout(() => setMsg(null), 3000)
  }
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // ---- interactive review (docs/artifact-review.md) ----
  const reviewable = review !== null
  const [reviewOn, setReviewOn] = useState(false) // annotate vs explore

  // ⌘I toggles annotate mode while the Artifacts tab is up. Capture-phase, and
  // the SDK forwards the same hotkey from inside the iframe (dd-artifact:toggleMode).
  // Focus-scoped: never steal the keystroke from the terminal or an editable
  // control (xterm's hidden textarea lives inside a .xterm container).
  useEffect(() => {
    if (!reviewable) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        const t = e.target as HTMLElement | null
        if (t && (t.closest?.('.xterm') || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        setReviewOn((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [reviewable])

  // Persisted gallery for this session; re-listed whenever a new render lands
  // (renders persist before the artifact event fires, so this stays fresh) and
  // after a rewind (items gain their "rewound" badge).
  const [savedNonce, setSavedNonce] = useState(0)
  useEffect(() => {
    if (!sessionId) { setSaved([]); return }
    let live = true
    invoke<SavedArtifact[]>('list_saved_artifacts', { sessionId })
      .then((s) => { if (live) setSaved(s) })
      .catch(() => { if (live) setSaved([]) })
    return () => { live = false }
  }, [sessionId, artifacts.length, savedNonce])
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string }>('artifact-rewound', (e) => {
      if (e.payload.session_id === sessionId) setSavedNonce((n) => n + 1)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [sessionId])

  // Gallery = persisted artifacts (older, deduped against the live list by
  // their render-time seq) followed by this run's live artifacts — so the
  // dropdown reads oldest → newest and the default stays "the newest".
  const liveIds = new Set(artifacts.map((a) => a.id))
  const items: GalleryItem[] = [
    ...(sessionId
      ? saved
          .filter((s) => !liveIds.has(String(s.seq)))
          .map((s): GalleryItem => ({
            id: `saved/${sessionId}/${s.file}`,
            title: s.title,
            kind: s.kind === 'svg' || s.kind === 'markdown' ? s.kind : 'html',
            saved: s,
          }))
      : []),
    ...artifacts.map((a): GalleryItem => ({ id: a.id, title: a.title, kind: a.kind })),
  ]
  // Default to the newest that ISN'T from a rewound-away timeline (after a
  // rewind the panel time-travels with the conversation); a manual pick —
  // including a rewound copy, for comparison — sticks until it's gone.
  const current =
    items.find((i) => i.id === selectedId) ??
    [...items].reverse().find((i) => !i.saved?.rewound) ??
    (items.length ? items[items.length - 1] : null)

  // Saved svg/markdown render through the sanitized srcdoc path and need their
  // content fetched once; saved html streams from artifact://saved/… directly.
  useEffect(() => {
    const s = current?.saved
    if (!s || current?.kind === 'html' || !sessionId) return
    if (contentCache[s.file] != null) return
    let live = true
    invoke<string>('read_saved_artifact', { sessionId, file: s.file })
      .then((c) => { if (live) setContentCache((m) => ({ ...m, [s.file]: c })) })
      .catch(() => { if (live) setContentCache((m) => ({ ...m, [s.file]: '' })) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, sessionId])

  // Esc closes the expanded overlay — even when the artifact iframe has focus.
  // A parent keydown listener never sees keys typed into an iframe, so: html
  // artifacts get a tiny Esc-forwarder script injected by the artifact:// server
  // (postMessage 'drydock-esc', since their scripts run anyway), and static
  // svg/markdown frames (scripts disabled, nothing to type into) just have
  // focus reclaimed by the overlay whenever they steal it.
  const currentKind = current?.kind
  useEffect(() => {
    if (!full) return
    overlayRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    const onMsg = (e: MessageEvent) => {
      if (e.data && (e.data as { type?: string }).type === 'drydock-esc') setFull(false)
    }
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) {
        if (currentKind !== 'html') setTimeout(() => overlayRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMsg)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMsg)
      window.removeEventListener('blur', onBlur)
    }
  }, [full, currentKind])

  // Resolve the selected item to a renderable Artifact. null = saved content
  // still fetching (a brief "loading…" shows instead of the frame).
  const shown: Artifact | null = !current
    ? null
    : !current.saved
      ? artifacts.find((a) => a.id === current.id) ?? null
      : current.kind === 'html'
        ? { id: current.id, title: current.title, kind: 'html', content: '', path: current.saved.path ?? undefined }
        : contentCache[current.saved.file] != null
          ? { id: current.id, title: current.title, kind: current.kind, content: contentCache[current.saved.file], path: current.saved.path ?? undefined }
          : null

  // ---- review wiring for the mounted artifact ----
  // Review is wired ONLY to the newest LIVE artifact: annotating an old
  // gallery/saved copy would feed stale selectors into the live session's loop.
  const latestLiveId = artifacts.length ? artifacts[artifacts.length - 1].id : null
  const reviewTarget = reviewable && !!current && !current.saved && current.id === latestLiveId && shown?.kind === 'html'

  // The iframe is UNTRUSTED (its scripts include the artifact's own): coerce
  // every field at this boundary so a malformed payload can neither crash the
  // React tree nor fail backend deserialization. Send/end are deliberately NOT
  // accepted from the frame — a page script calling window.dd.sendQueued()
  // must not deliver feedback to the model without a human gesture in the
  // trusted panel (prompt-injection guard). Queue only proposes visible pills.
  const asStr = (x: unknown) => (typeof x === 'string' ? x : '')
  const toReviewPrompt = (v: unknown): ReviewPrompt | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const prompt = asStr(o.prompt).trim()
    if (!prompt) return null
    return {
      uid: asStr(o.uid),
      prompt,
      selector: asStr(o.selector),
      tag: asStr(o.tag) || 'message',
      text: asStr(o.text),
      target: o.target,
      _ddQueueKey: typeof o._ddQueueKey === 'string' && o._ddQueueKey ? o._ddQueueKey : undefined,
    }
  }
  const onReviewMsg = (m: Record<string, unknown>) => {
    const t = m.type as string
    if (t === 'dd-artifact:queuePrompt') {
      const p = toReviewPrompt(m.prompt)
      if (p && onQueue) onQueue(p)
    } else if (t === 'dd-artifact:toggleMode') setReviewOn((v) => !v)
  }
  // "Send & end" also leaves annotate mode — ending the review should read as
  // an ending, not stay armed for more clicks.
  const sendFromPanel = (m: string, end: boolean) => {
    onSend?.(m, end)
    if (end) setReviewOn(false)
  }
  // Presence counts as activity: a session blocked in await_artifact_feedback
  // surfaces the panel even before the first annotation, so the user can see
  // "Claude is waiting" and reach Send & end.
  const reviewPanelUp =
    reviewable && !!review && (reviewOn || review.presence !== 'waiting' || review.prompts.length > 0 || review.chat.length > 0)

  // Download writes straight to ~/Downloads (backend) and reveals it; Open
  // shows the model's original source file in Finder (file-backed ones only).
  const download = (g: GalleryItem) => {
    const done = () => flash('Saved to Downloads — revealed in Finder')
    const fail = (e: unknown) => flash(String(e), true)
    if (g.saved && sessionId) invoke<string>('save_saved_artifact', { sessionId, file: g.saved.file }).then(done).catch(fail)
    else invoke<string>('save_artifact', { id: g.id }).then(done).catch(fail)
  }
  const actions = (g: GalleryItem) => (
    <>
      {shown?.path && (
        <button style={S.iconBtn} title={`Open in Finder\n${shown.path}`} onClick={() => invoke('open_path', { path: shown.path, reveal: true }).catch((e) => flash(String(e), true))}>Open</button>
      )}
      <button style={S.iconBtn} title="Download to your Downloads folder" onClick={() => download(g)}>Download</button>
    </>
  )

  if (!current)
    return <div style={{ ...S.muted, flex: 1, minHeight: 0, padding: 12 }}>No artifacts yet. When Claude renders an artifact (HTML, SVG, or Markdown) in this session, it shows up here.</div>

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 8px' }}>
        <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={current.title}>{current.title}</span>
        {current.saved && <span style={S.chip} title="Persisted from an earlier run of this session">saved</span>}
        <span style={S.chip}>{current.kind}</span>
        {actions(current)}
        {reviewTarget && (
          <button
            style={{ ...S.iconBtn, ...(reviewOn ? { background: accent, color: 'var(--dd-ink)', border: `1px solid ${accent}` } : {}) }}
            title={'Annotate mode (⌘I) — click elements or select text in the artifact to comment'}
            onClick={() => setReviewOn((v) => !v)}
          >
            ✎ Annotate
          </button>
        )}
        <button style={S.iconBtn} title="Expand to full window" onClick={() => setFull(true)}>⤢</button>
      </div>
      {/* always rendered at a constant height: the iframe below must not jump
          when a message appears/expires; long errors ellipsize (full text in title) */}
      <div
        title={msg?.text}
        style={{ padding: '0 12px 6px', fontSize: 10, lineHeight: '12px', height: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: msg?.error ? 'var(--dd-err)' : 'var(--dd-ok-bright)' }}
      >
        {msg?.text ?? ''}
      </div>
      {items.length > 1 && (
        <select
          value={current.id}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ margin: '0 12px 8px', background: 'var(--dd-surface2)', color: 'var(--dd-text1)', border: '1px solid var(--dd-border2)', borderRadius: 4, padding: '3px 4px', fontSize: 11 }}
        >
          {items.map((a, i) => (
            <option key={a.id} value={a.id}>{i + 1}. {a.title} ({a.kind}){a.saved?.rewound ? ' · rewound' : a.saved ? ' · saved' : ''}</option>
          ))}
        </select>
      )}
      {saved.length >= 50 && (
        <div style={{ ...S.muted, fontSize: 10, padding: '0 12px 6px' }}>gallery keeps the newest 50 per session</div>
      )}
      {/* Fill the rest of the panel edge-to-edge, no frame. Hidden while the
          full-window overlay is up — two mounted copies of an html artifact
          would each run its scripts (double execution). */}
      {!full && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {shown ? (
              <ArtifactView
                artifact={shown}
                style={{ border: 'none', borderRadius: 0 }}
                reviewMode={reviewTarget && reviewOn}
                accent={accent}
                onReviewMsg={reviewTarget ? onReviewMsg : undefined}
              />
            ) : (
              <div style={{ ...S.muted, padding: 12 }}>loading…</div>
            )}
          </div>
          {reviewPanelUp && review && (
            <ReviewPanel review={review} accent={accent} annotateOn={reviewOn} onDiscard={onDiscard} onSend={sendFromPanel} />
          )}
        </div>
      )}
      {full && (
        // Full-window overlay so UI artifacts get usable space. zIndex below the
        // quit guard (100); translateZ(0) gives it its own compositing layer so
        // it's clickable over a terminal's WebGL canvas in WKWebView. tabIndex
        // lets it hold focus so Esc lands here, not in a just-clicked iframe.
        <div ref={overlayRef} tabIndex={-1} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--dd-bg0)', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dd-border)' }}>
            <span style={{ flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.title}</span>
            {current.saved && <span style={S.chip}>saved</span>}
            <span style={S.chip}>{current.kind}</span>
            {actions(current)}
            {reviewTarget && (
              <button
                style={{ ...S.iconBtn, ...(reviewOn ? { background: accent, color: 'var(--dd-ink)', border: `1px solid ${accent}` } : {}) }}
                title={'Annotate mode (⌘I) — click elements or select text in the artifact to comment'}
                onClick={() => setReviewOn((v) => !v)}
              >
                ✎ Annotate
              </button>
            )}
            <button style={S.iconBtn} title="Close (Esc)" onClick={() => setFull(false)}>✕</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {shown ? (
                <ArtifactView
                  artifact={shown}
                  style={{ border: 'none' }}
                  reviewMode={reviewTarget && reviewOn}
                  accent={accent}
                  onReviewMsg={reviewTarget ? onReviewMsg : undefined}
                />
              ) : (
                <div style={{ ...S.muted, padding: 12 }}>loading…</div>
              )}
            </div>
            {reviewPanelUp && review && (
              <ReviewPanel review={review} accent={accent} annotateOn={reviewOn} onDiscard={onDiscard} onSend={sendFromPanel} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Queued-annotation pills + conversation log + sticky composer, accented in
 *  the session color. Sends are disabled while the model is `working` on
 *  already-delivered feedback (mirrors lavish-axi's presence gating). */
function ReviewPanel({
  review,
  accent,
  annotateOn,
  onDiscard,
  onSend,
}: {
  review: ReviewState
  accent: string
  annotateOn: boolean
  onDiscard?: (index: number) => void
  onSend?: (message: string, endReview: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const busy = review.presence === 'working'
  const canSend = !busy && (draft.trim().length > 0 || review.prompts.length > 0)
  const send = (end: boolean) => {
    if (busy) return
    onSend?.(draft, end)
    setDraft('')
  }
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [review.chat.length, review.prompts.length])
  const presenceLine = busy
    ? 'Claude is working on your feedback…'
    : review.presence === 'listening'
      ? 'Claude is waiting for your feedback'
      : 'Feedback queues here until Claude checks for it'
  return (
    <div style={{ flex: 'none', maxHeight: '45%', display: 'flex', flexDirection: 'column', borderTop: `2px solid ${accent}`, background: 'var(--dd-well)', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 0', fontSize: 10, color: 'var(--dd-text3)', flex: 'none' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: busy ? 'var(--dd-warn-bright)' : review.presence === 'listening' ? 'var(--dd-ok-bright)' : 'var(--dd-dim)', flex: 'none' }} />
        <span style={{ flex: 1 }}>{presenceLine}</span>
      </div>
      <div ref={logRef} style={{ overflowY: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 40 }}>
        {review.chat.map((c, i) => (
          <div key={i} style={{ fontSize: 11, lineHeight: 1.4, color: c.role === 'agent' ? 'var(--dd-accent-muted)' : 'var(--dd-text1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            <span style={{ color: 'var(--dd-dim)' }}>{c.role === 'agent' ? 'claude · ' : 'you · '}</span>
            {c.text}
          </div>
        ))}
        {review.prompts.map((p, i) => (
          <div key={`q${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, lineHeight: 1.4, background: 'var(--dd-surface2)', border: `1px solid ${accent}`, borderRadius: 6, padding: '4px 6px' }}>
            <span style={{ flex: 1, color: 'var(--dd-text1)', overflowWrap: 'anywhere' }}>
              {p.tag !== 'message' && (
                <span style={{ color: accent }}>{p.tag === 'text' ? `“${clip(p.text, 40)}” ` : `⟨${p.tag}⟩ `}</span>
              )}
              {p.prompt}
            </span>
            <button onClick={() => onDiscard?.(i)} title="Discard this annotation" style={{ background: 'none', border: 'none', color: 'var(--dd-dim)', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1.4 }}>
              ✕
            </button>
          </div>
        ))}
        {annotateOn && review.prompts.length === 0 && review.chat.length === 0 && (
          <div style={{ ...S.muted, fontSize: 10 }}>Click an element or select text in the artifact to annotate it, or type below.</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 10px 8px', alignItems: 'flex-end', flex: 'none' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSend) send(false)
            }
          }}
          placeholder={busy ? 'Claude is applying your feedback…' : 'Message Claude about this artifact…'}
          disabled={busy}
          rows={2}
          style={{ flex: 1, resize: 'none', background: 'var(--dd-bg1)', color: 'var(--dd-text)', border: '1px solid var(--dd-border2)', borderRadius: 6, padding: '6px 8px', fontSize: 11, fontFamily: 'system-ui' }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            onClick={() => send(false)}
            disabled={!canSend}
            title="Send queued annotations + message to Claude"
            style={{ background: canSend ? accent : 'var(--dd-hover)', color: canSend ? 'var(--dd-ink)' : 'var(--dd-dim)', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: canSend ? 'pointer' : 'default', whiteSpace: 'nowrap' }}
          >
            Send{review.prompts.length ? ` (${review.prompts.length})` : ''}
          </button>
          <button
            onClick={() => send(true)}
            disabled={busy}
            title="Send everything and end the review — Claude stops polling"
            style={{ background: 'none', color: busy ? 'var(--dd-dim2)' : 'var(--dd-text3)', border: '1px solid var(--dd-border2)', borderRadius: 6, padding: '3px 10px', fontSize: 10, cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
          >
            Send & end
          </button>
        </div>
      </div>
    </div>
  )
}

export default function BriefingPanel({ sessionId, projectPath, starred, artifacts, label, onToggleStar, onRename, initialUnread, review, reviewAccent, onReviewQueue, onReviewDiscard, onReviewSend, collapsed, onSetCollapsed, previewNonce }: Props) {
  const panelChord = useChord('briefing.toggle')
  const [card, setCard] = useState<CardView | null>(null)
  const [files, setFiles] = useState<FileTouch[]>([])
  const [tasks, setTasks] = useState<TasksView | null>(null)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  // clamp on load AND on window resize: a width persisted (or auto-widened) on a
  // big monitor must not overflow a smaller window later
  const [width, setWidth] = useState(() => clampPanelWidth(loadNum('dd.briefingWidth', 252)))
  const [tab, setTab] = useState<RightTab>(() => (initialUnread ? 'preview' : loadRightTab()))
  const widthRef = useRef(width)
  widthRef.current = width
  useEffect(() => {
    const reclamp = () => setWidth((w) => clampPanelWidth(w))
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [])

  const refresh = useCallback(() => {
    if (!sessionId) { setCard(null); setFiles([]); setTasks(null); setUsage(null); return } // a session-less new tab has no card
    invoke<CardView | null>('get_card', { sessionId }).then(setCard).catch(console.error)
    // no transcript file yet (radar stub / expired) → just no files section
    invoke<FileTouch[]>('session_files', { sessionId }).then(setFiles).catch(() => setFiles([]))
    // both refresh on the same index-updated tick that moves the transcript
    invoke<TasksView>('session_tasks', { sessionId }).then(setTasks).catch(() => setTasks(null))
    invoke<SessionUsage>('session_usage', { sessionId }).then(setUsage).catch(() => setUsage(null))
  }, [sessionId])
  useEffect(() => {
    refresh()
    let cancelled = false
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])

  // When a NEW artifact arrives for this tab, surface it: jump to the Preview
  // sub-tab, open the panel if collapsed, and give it room (~1/3 of the window,
  // never shrinking a panel the user already widened).
  const seenArtifacts = useRef(artifacts.length)
  useEffect(() => {
    if (artifacts.length > seenArtifacts.current) {
      setTab('preview'); localStorage.setItem('dd.rightTab', 'preview')
      onSetCollapsed(false)
      setWidth((w) => {
        const next = Math.max(w, clampPanelWidth(Math.round(window.innerWidth / 3)))
        localStorage.setItem('dd.briefingWidth', String(next))
        return next
      })
    }
    seenArtifacts.current = artifacts.length
  }, [artifacts.length])

  const selectTab = (t: RightTab) => { setTab(t); localStorage.setItem('dd.rightTab', t) }

  // ⌘⇧J: App bumps the nonce; jump to the artifact preview sub-tab.
  const nonceSeen = useRef(previewNonce)
  useEffect(() => {
    if (previewNonce !== nonceSeen.current) {
      nonceSeen.current = previewNonce
      selectTab('preview')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewNonce])

  // collapsed: a thin rail with an expand button, mirroring the left sidebar
  if (collapsed) {
    return (
      <div style={{ width: 30, minWidth: 30, height: '100%', background: 'var(--dd-bg0)', borderLeft: '1px solid var(--dd-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <button onClick={() => onSetCollapsed(false)} title={`Expand panel (${panelChord})`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontSize: 15, padding: 0 }}>«</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w - dx))}
        onEnd={() => localStorage.setItem('dd.briefingWidth', String(widthRef.current))}
      />
      <div style={{ width, minWidth: width, boxSizing: 'border-box', background: 'var(--dd-bg0)', fontFamily: 'system-ui', fontSize: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, padding: '12px 12px 0', flex: 'none' }}>
          <button onClick={() => onSetCollapsed(true)} title={`Collapse panel (${panelChord})`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontSize: 15, padding: 0, lineHeight: 1, alignSelf: 'flex-end', marginBottom: 4 }}>»</button>
          <div style={{ display: 'flex', flex: 1, gap: 2, minWidth: 0 }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => selectTab(t.id)} style={S.tabBtn(t.id === tab)}>
                {t.label}
                {t.id === 'preview' && artifacts.length > 0 ? ` (${artifacts.length})` : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Every tab manages its own layout: Preview edge-to-edge, Briefing and
            Project as scrolling-top / pinned-bottom section stacks. */}
        {tab === 'preview' ? (
          <PreviewTab
            artifacts={artifacts}
            sessionId={sessionId}
            review={review ?? null}
            accent={reviewAccent ?? 'var(--dd-warn-bright)'}
            onQueue={onReviewQueue}
            onDiscard={onReviewDiscard}
            onSend={onReviewSend}
          />
        ) : tab === 'briefing' ? (
          <BriefingTab sessionId={sessionId} card={card} starred={starred} files={files} tasks={tasks} usage={usage} projectPath={projectPath} label={label} onToggleStar={onToggleStar} onRename={onRename} />
        ) : (
          <ProjectTab projectPath={projectPath} />
        )}
      </div>
    </div>
  )
}
