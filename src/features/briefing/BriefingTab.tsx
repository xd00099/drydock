import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fmtTokens, relAge, type CardView, type FileTouch, type SessionUsage, type TasksView, type TimelineItem } from '@/lib/types'
import { Button, Chip } from '@/components/ui'
import TimeMachine from '@/features/timemachine/TimeMachine'
import { FilesChanged } from './FilesChanged'
import { TasksSection } from './TasksSection'
import { S } from './styles'

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

// Per-file status glyph, git-style: created / modified / gone from disk.

export function BriefingTab({ sessionId, card, starred, files, tasks, usage, projectPath, label, onToggleStar, onRename }: { sessionId: string | null; card: CardView | null; starred: boolean; files: FileTouch[]; tasks: TasksView | null; usage: SessionUsage | null; projectPath?: string; label?: string | null; onToggleStar?: () => void; onRename?: (name: string) => void }) {
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
        <Button
          style={{ marginTop: 12 }}
          onClick={() => invoke('refresh_card', { sessionId }).catch(console.error)}
        >
          Refresh card
        </Button>
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
