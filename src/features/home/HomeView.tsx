import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SessionView, UsageOverview } from '@/lib/types'
import { fmtTokens, projectColor, sessionLabel } from '@/lib/types'
import RecapDigest from './RecapDigest'
import { useChord } from '@/lib/keymap'
import { Button } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import s from './Home.module.css'

type Props = {
  sessions: SessionView[]
  sessionsReady: boolean
  onFocusSession: (sid: string) => void
  onNewSession: () => void
  onSearch: () => void
}

export default function HomeView({ sessions, sessionsReady, onFocusSession, onNewSession, onSearch }: Props) {
  const newChord = useChord('session.new')
  const [usage, setUsage] = useState<UsageOverview | null>(null)
  const bySid = new Map(sessions.map((session) => [session.session_id, session]))

  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    const refresh = () => invoke<UsageOverview>('usage_overview')
      .then((value) => { if (!cancelled) setUsage(value) })
      .catch(() => {})
    refresh()
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  const waiting = sessions.filter((session) => session.live_status === 'needs_input')
  const recent = (usage?.daily ?? []).slice(-14)
  const maxTokens = Math.max(1, ...recent.map((d) => d.tokens))
  const hasUsage = recent.length > 0 || (usage?.models.length ?? 0) > 0 || (usage?.top_sessions.length ?? 0) > 0

  return (
    <div className={s.viewport}>
      <main className={s.page}>
        <header className={s.header}>
          <div>
            <div className={s.eyebrow}>Your workspace</div>
            <h1 className={s.title}>Pick up where you left off.</h1>
            <p className={s.intro}>Sessions, progress, and the next thing to build.</p>
          </div>
          <div className={s.actions}>
            <Button onClick={onSearch}><Icon name="search" /> Find a session</Button>
            <Button variant="primary" onClick={onNewSession} title={`New session (${newChord})`}><Icon name="plus" /> New session</Button>
          </div>
        </header>

        {waiting.length > 0 && <section className={s.attention} aria-label="Sessions waiting for input">
          <div className={s.sectionHeading}><span className={s.statusDot} /> Waiting for you <span className={s.count}>{waiting.length}</span></div>
          <div className={s.waitingList}>{waiting.map((session) => (
            <button key={session.session_id} className={s.waitingRow} onClick={() => onFocusSession(session.session_id)}>
              <span className={s.waitingText}><strong>{sessionLabel(session)}</strong>{session.attention && <span>{session.attention}</span>}</span>
              <Icon name="arrow" />
            </button>
          ))}</div>
        </section>}

        <div className={s.columns} data-usage={hasUsage}>
          <RecapDigest sessions={sessions} sessionsReady={sessionsReady} onFocusSession={onFocusSession} />
          {hasUsage && <aside className={s.insights} aria-label="Usage insights">
            {recent.length > 0 && <section className={s.statSection}>
              <h2 className={s.sectionHeading}>Activity <span className={s.period}>{recent.length} days</span></h2>
              <div className={s.total}>{fmtTokens(recent.reduce((n, d) => n + d.tokens, 0))}<span>tokens</span></div>
              <div className={s.chart} role="img" aria-label={`Token activity over ${recent.length} days`}>
                {recent.map((d) => <span key={d.date} title={`${d.date} · ${fmtTokens(d.tokens)} tokens · ${d.messages} messages · ${d.sessions} sessions`} style={{ height: `${Math.max(4, Math.round((d.tokens / maxTokens) * 100))}%` }} />)}
              </div>
              {usage?.last_computed && <p className={s.caption}>Updated {usage.last_computed}</p>}
            </section>}
            {(usage?.models.length ?? 0) > 0 && <section className={s.statSection}>
              <h2 className={s.sectionHeading}>Models <span className={s.period}>All time</span></h2>
              {usage!.models.slice(0, 5).map((m) => <div key={m.model} className={s.metricRow}>
                <span className={s.metricLabel}>{m.model.replace(/^claude-/, '')}</span>
                <span className={s.number} title={`${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out`}>{fmtTokens(m.output)}</span>
                {m.cost_usd > 0 && <span className={s.cost}>${m.cost_usd.toFixed(2)}</span>}
              </div>)}
              <p className={s.caption}>Output tokens · Claude Code statistics</p>
            </section>}
            {(usage?.top_sessions.length ?? 0) > 0 && <section className={s.statSection}>
              <h2 className={s.sectionHeading}>Top sessions <span className={s.period}>Tokens</span></h2>
              {usage!.top_sessions.slice(0, 6).map((t) => {
                const session = bySid.get(t.session_id)
                return <button key={t.session_id} className={s.sessionRow} disabled={!session} onClick={() => session && onFocusSession(t.session_id)} title={`${t.label}\n${t.project}\n${fmtTokens(t.output_tokens)} out · ${fmtTokens(t.total_tokens)} total (cache reads excluded)`}>
                  <span className={s.projectDot} style={{ background: projectColor(session?.project_path ?? t.project) }} />
                  <span className={s.metricLabel}>{t.label}</span><span className={s.number}>{fmtTokens(t.output_tokens)}</span>
                </button>
              })}
            </section>}
          </aside>}
        </div>
      </main>
    </div>
  )
}
