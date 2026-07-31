import { useState } from 'react'
import { relAge, type TasksView } from '@/lib/types'
import { S } from './styles'

export function TasksSection({ view }: { view: TasksView | null }) {
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
