import { useState, type ReactNode } from 'react'
import { fmtTokens, type SessionUsage, type TasksView } from '@/lib/types'
import { Chip } from '@/components/ui'
import TimeMachine from '@/features/timemachine/TimeMachine'
import { RepositoryFiles } from './RepositoryFiles'
import { TasksSection } from './TasksSection'
import { SessionSummary } from './SessionSummary'
import css from './Briefing.module.css'

export function BriefingTab({ sourceAgent, sessionId, starred, tasks, usage, label, onToggleStar, onRename, collaborationActions, summaryActions }: { sourceAgent: string; sessionId: string | null; starred: boolean; tasks: TasksView | null; usage: SessionUsage | null; label?: string | null; onToggleStar?: () => void; onRename?: (name: string) => void; collaborationActions?: ReactNode; summaryActions?: ReactNode }) {
  // editing holds the label CAPTURED when the pencil was clicked (null = not
  // editing): the unchanged-commit guard must compare against what the user
  // saw when they started, not the live prop — a mid-edit refresh changing
  // `label` must neither freeze a stale auto title nor block a real commit.
  const [editing, setEditing] = useState<string | null>(null)
  const [head, setHead] = useState<string | null>(null)
  // Time machine opens the session's checkpoint history independently of Git.
  const [tm, setTm] = useState<string | null | false>(false)
  const commitRename = (value: string) => {
    const initial = editing
    setEditing(null)
    const name = value.trim()
    // An unchanged click-away blur must not create a permanent name override.
    if (initial === null || name === initial.trim()) return
    onRename?.(name)
  }
  if (!sessionId)
    return <div className={css.empty}>Session details appear once this conversation is saved.</div>
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className={css.content}>
        <div className={css.sessionHeading}>
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
              style={{ flex: 1, minWidth: 0, background: 'var(--dd-bg1)', border: '1px solid var(--dd-accent-strong)', borderRadius: 'var(--dd-r-sm)', color: 'var(--dd-text)', fontSize: 13, fontWeight: 600, fontFamily: 'var(--dd-font-ui)', padding: '2px 6px', outline: 'none' }}
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
            <div style={{ flex: 1, color: 'var(--dd-text)', fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{label || 'Session'}</div>
          )}
          {onRename && editing === null && (
            <button
              onClick={() => setEditing(label ?? '')}
              title="Rename session in Drydock"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-dim)', fontSize: 12, padding: 0, lineHeight: 1.3 }}
            >
              ✎
            </button>
          )}
          {usage && usage.total_tokens > 0 && (
            <Chip
              title={
                `${usage.total_tokens.toLocaleString('en-US')} tokens (input + output + cache writes; cache reads excluded)\n` +
                usage.rows.map((r) => `${r.model}${r.scope !== 'main' ? ' (agents)' : ''}: ${fmtTokens(r.input)} in · ${fmtTokens(r.output)} out`).join('\n') +
                (usage.agent_output > 0 ? `\nsubagents wrote ${fmtTokens(usage.agent_output)} of the output` : '') +
                '\nfrom transcript usage records — an estimate, not a bill'
              }
            >
              Σ {fmtTokens(usage.total_tokens)}
            </Chip>
          )}
        </div>
        <SessionSummary key={sessionId} sessionId={sessionId} head={head} actions={summaryActions} />
      </div>
      <TasksSection view={tasks} />
      <RepositoryFiles
        key={sessionId}
        sessionId={sessionId}
        onHeadChange={setHead}
        actions={collaborationActions}
        squeeze={!!tasks && tasks.tasks.length > 0}
        onTimeMachine={sourceAgent === 'claude' ? () => setTm(null) : undefined}
      />
      {tm !== false && <TimeMachine sessionId={sessionId} initialPath={tm} onClose={() => setTm(false)} />}
    </div>
  )
}
