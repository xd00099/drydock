import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { PromptView, SessionView, UsageOverview } from './types'
import { baseName, fmtTokens, sessionColor, sessionLabel } from './types'

// Home: the global surface, shown in the center pane whenever no tab is
// active (⌘0 / the DRYDOCK wordmark bring it back). Also mounted inside the
// ⌘K full-window overlay — same component, two mounts, zero tab-system
// surgery. Everything here is read-only: history.jsonl, stats-cache.json and
// Drydock's own usage index.

type Props = {
  sessions: SessionView[]
  onFocusSession: (sid: string) => void
}

const S = {
  h: { fontSize: 10, letterSpacing: 1, color: '#5b6675', fontWeight: 700, margin: '0 0 8px' } as const,
  day: { fontSize: 9.5, letterSpacing: 1, color: '#4a5462', fontWeight: 700, margin: '12px 0 4px' } as const,
  card: { background: '#0b0e13', border: '1px solid #1d2530', borderRadius: 8, padding: '10px 12px' } as const,
  dim: { color: '#5b6675' } as const,
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yest = new Date(today.getTime() - 86_400_000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'TODAY'
  if (same(d, yest)) return 'YESTERDAY'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

export default function HomeView({ sessions, onFocusSession }: Props) {
  const [prompts, setPrompts] = useState<PromptView[]>([])
  const [more, setMore] = useState(true)
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<UsageOverview | null>(null)

  const bySid = new Map(sessions.map((s) => [s.session_id, s]))

  const loadPrompts = useCallback((before: number | null) => {
    setBusy(true)
    invoke<PromptView[]>('recent_prompts', { limit: 30, before })
      .then((page) => {
        setMore(page.length === 30)
        setPrompts((prev) => (before == null ? page : [...prev, ...page]))
      })
      .catch(() => setMore(false))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => {
    loadPrompts(null)
    invoke<UsageOverview>('usage_overview').then(setUsage).catch(() => setUsage(null))
    // keep top-sessions/token totals fresh while Home is visible
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('index-updated', () => {
      invoke<UsageOverview>('usage_overview').then((u) => { if (!cancelled) setUsage(u) }).catch(() => {})
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [loadPrompts])

  const waiting = sessions.filter((s) => s.live_status === 'needs_input')
  const daily = usage?.daily ?? []
  const recent = daily.slice(-14)
  const maxTokens = Math.max(1, ...recent.map((d) => d.tokens))
  const hasAnything = prompts.length > 0 || (usage && (usage.daily.length > 0 || usage.top_sessions.length > 0))

  // prompt rows grouped by day, in the order received (newest first)
  const groups: { day: string; items: PromptView[] }[] = []
  for (const p of prompts) {
    const day = dayLabel(p.ts)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(p)
    else groups.push({ day, items: [p] })
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '18px 22px', fontFamily: 'system-ui', fontSize: 12, color: '#c8cdd5', boxSizing: 'border-box' }}>
      <div style={{ ...S.dim, fontSize: 12, marginBottom: 14 }}>
        Pick a session on the left, or ＋ for a shell — ⌘0 returns here anytime.
      </div>

      {waiting.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {waiting.map((s) => (
            <button
              key={s.session_id}
              onClick={() => onFocusSession(s.session_id)}
              title={s.attention ?? 'waiting for your input'}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(232,163,61,.07)', border: '1px solid #3a3122', borderLeft: '3px solid #e8a33d', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', textAlign: 'left', color: '#c8cdd5', fontSize: 12, maxWidth: 320 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e8a33d', flex: 'none' }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionLabel(s)}</span>
                {s.attention && (
                  <span style={{ display: 'block', color: '#5b6675', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.attention}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {!hasAnything ? null : (
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
          {/* ── recent prompts, across every project ── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.h}>RECENT PROMPTS</div>
            {groups.map((g) => (
              <div key={g.day + g.items[0]?.ts}>
                <div style={S.day}>{g.day}</div>
                {g.items.map((p, i) => {
                  const s = bySid.get(p.session_id)
                  return (
                    <button
                      key={p.ts + ':' + i}
                      onClick={() => s && onFocusSession(p.session_id)}
                      disabled={!s}
                      title={s ? `${p.display}\n${p.project}` : `${p.display}\n${p.project}\n(transcript no longer indexed — expired or deleted)`}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', background: 'none', border: 'none', padding: '3px 0', cursor: s ? 'pointer' : 'default', textAlign: 'left', fontSize: 12, color: '#c8cdd5', opacity: s ? 1 : 0.45 }}
                    >
                      <span style={{ flex: 'none', width: 38, color: '#4a5462', fontFamily: 'Menlo, monospace', fontSize: 10 }}>{fmtTime(p.ts)}</span>
                      <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', alignSelf: 'center', background: sessionColor(p.session_id, 1, s?.hue ?? null) }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.display}</span>
                      <span style={{ flex: 'none', color: '#4a5462', fontSize: 10 }}>{baseName(p.project)}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {more && prompts.length > 0 && (
              <button
                onClick={() => loadPrompts(prompts[prompts.length - 1]?.ts ?? null)}
                disabled={busy}
                style={{ marginTop: 10, background: '#141b26', border: '1px solid #2c3647', borderRadius: 5, color: '#9aa3af', fontSize: 11, padding: '3px 10px', cursor: busy ? 'default' : 'pointer' }}
              >
                {busy ? 'loading…' : 'show earlier'}
              </button>
            )}
          </div>

          {/* ── usage column (tokens, never invented dollars) ── */}
          <div style={{ width: 260, flex: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {recent.length > 0 && (
              <div style={S.card}>
                <div style={S.h}>ACTIVITY · LAST {recent.length} DAYS</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 36 }}>
                  {recent.map((d) => (
                    <span
                      key={d.date}
                      title={`${d.date} · ${fmtTokens(d.tokens)} tokens · ${d.messages} messages · ${d.sessions} sessions`}
                      style={{ flex: 1, height: `${Math.max(4, Math.round((d.tokens / maxTokens) * 100))}%`, background: '#24405e', borderRadius: '1px 1px 0 0' }}
                    />
                  ))}
                </div>
                <div style={{ ...S.dim, fontSize: 10, marginTop: 6 }}>
                  {fmtTokens(recent.reduce((n, d) => n + d.tokens, 0))} tokens
                  {usage?.last_computed ? ` · stats as of ${usage.last_computed}` : ''}
                </div>
              </div>
            )}
            {(usage?.models.length ?? 0) > 0 && (
              <div style={S.card}>
                <div style={S.h}>MODELS · ALL TIME</div>
                {usage!.models.slice(0, 5).map((m) => (
                  <div key={m.model} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 11.5 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#c8cdd5' }}>{m.model.replace(/^claude-/, '')}</span>
                    <span title={`${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out`} style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: '#7ec8a0' }}>
                      {fmtTokens(m.output)}
                    </span>
                    {m.cost_usd > 0 && <span style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: '#9aa3af' }}>${m.cost_usd.toFixed(2)}</span>}
                  </div>
                ))}
                <div style={{ ...S.dim, fontSize: 9.5, marginTop: 4 }}>output tokens · from Claude Code's own stats</div>
              </div>
            )}
            {(usage?.top_sessions.length ?? 0) > 0 && (
              <div style={S.card}>
                <div style={S.h}>TOP SESSIONS · TOKENS</div>
                {usage!.top_sessions.slice(0, 6).map((t) => {
                  const s = bySid.get(t.session_id)
                  return (
                    <button
                      key={t.session_id}
                      onClick={() => s && onFocusSession(t.session_id)}
                      disabled={!s}
                      title={`${t.label}\n${t.project}\n${fmtTokens(t.output_tokens)} out · ${fmtTokens(t.total_tokens)} total (cache reads excluded)`}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', background: 'none', border: 'none', padding: '2px 0', cursor: s ? 'pointer' : 'default', textAlign: 'left', fontSize: 11.5, color: '#c8cdd5', opacity: s ? 1 : 0.5 }}
                    >
                      <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', alignSelf: 'center', background: sessionColor(t.session_id, 1, s?.hue ?? null) }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                      <span style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: '#7ec8a0' }}>{fmtTokens(t.output_tokens)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
