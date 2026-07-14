import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SessionView, UsageOverview } from './types'
import { fmtTokens, sessionColor, sessionLabel } from './types'
import RecapDigest from './RecapDigest'
import { useChord } from './keymap'

// Home: the global surface, shown in the center pane whenever no tab is
// active (⌘0 / the DRYDOCK wordmark bring it back). Also mounted inside the
// ⌘K full-window overlay — same component, two mounts, zero tab-system
// surgery. Everything here is read-only: Drydock's own index (recaps, token
// usage) and stats-cache.json.

type Props = {
  sessions: SessionView[]
  // false until the first snapshot lands — gates "expired session" treatments
  sessionsReady: boolean
  onFocusSession: (sid: string) => void
}

const S = {
  h: { fontSize: 10, letterSpacing: 1, color: 'var(--dd-dim)', fontWeight: 700, margin: '0 0 8px' } as const,
  card: { background: 'var(--dd-bg0)', border: '1px solid var(--dd-border)', borderRadius: 8, padding: '10px 12px' } as const,
  dim: { color: 'var(--dd-dim)' } as const,
}

export default function HomeView({ sessions, sessionsReady, onFocusSession }: Props) {
  const homeChord = useChord('home.show')
  const newChord = useChord('session.new')
  const [usage, setUsage] = useState<UsageOverview | null>(null)

  const bySid = new Map(sessions.map((s) => [s.session_id, s]))

  useEffect(() => {
    invoke<UsageOverview>('usage_overview').then(setUsage).catch(() => setUsage(null))
    // keep top-sessions/token totals fresh while Home is visible
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('index-updated', () => {
      invoke<UsageOverview>('usage_overview').then((u) => { if (!cancelled) setUsage(u) }).catch(() => {})
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  const waiting = sessions.filter((s) => s.live_status === 'needs_input')
  const daily = usage?.daily ?? []
  const recent = daily.slice(-14)
  const maxTokens = Math.max(1, ...recent.map((d) => d.tokens))

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '18px 22px', fontFamily: 'system-ui', fontSize: 12, color: 'var(--dd-text1)', boxSizing: 'border-box' }}>
      <div style={{ ...S.dim, fontSize: 12, marginBottom: 14 }}>
        Pick a session on the left, {newChord} starts one in any folder, or ＋ for a shell — {homeChord} returns here anytime.
      </div>

      {waiting.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {waiting.map((s) => (
            <button
              key={s.session_id}
              onClick={() => onFocusSession(s.session_id)}
              title={s.attention ?? 'waiting for your input'}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(232,163,61,.07)', border: '1px solid var(--dd-warn-bg)', borderLeft: '3px solid var(--dd-warn)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', textAlign: 'left', color: 'var(--dd-text1)', fontSize: 12, maxWidth: 320 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--dd-warn)', flex: 'none' }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionLabel(s)}</span>
                {s.attention && (
                  <span style={{ display: 'block', color: 'var(--dd-dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.attention}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
        {/* ── the work log: every session's recap, across every project ── */}
        <RecapDigest sessions={sessions} sessionsReady={sessionsReady} onFocusSession={onFocusSession} />

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
                    style={{ flex: 1, height: `${Math.max(4, Math.round((d.tokens / maxTokens) * 100))}%`, background: 'var(--dd-accent-bg)', borderRadius: '1px 1px 0 0' }}
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
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dd-text1)' }}>{m.model.replace(/^claude-/, '')}</span>
                  <span title={`${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out`} style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: 'var(--dd-ok-bright)' }}>
                    {fmtTokens(m.output)}
                  </span>
                  {m.cost_usd > 0 && <span style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: 'var(--dd-text2)' }}>${m.cost_usd.toFixed(2)}</span>}
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
                    style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', background: 'none', border: 'none', padding: '2px 0', cursor: s ? 'pointer' : 'default', textAlign: 'left', fontSize: 11.5, color: 'var(--dd-text1)', opacity: s ? 1 : 0.5 }}
                  >
                    <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', alignSelf: 'center', background: sessionColor(t.session_id, 1, s?.hue ?? null) }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                    <span style={{ flex: 'none', fontFamily: 'Menlo, monospace', fontSize: 10.5, color: 'var(--dd-ok-bright)' }}>{fmtTokens(t.output_tokens)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
