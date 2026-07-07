import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { RecapEntry, SessionView } from './types'
import { baseName, sessionColor } from './types'
import LiveIndicator from './LiveIndicator'

// The Home "what happened" work log: each visible session's distilled recap,
// day-grouped, expandable to its milestone timeline. Everything shown here was
// already generated (cards + recaps in Drydock's index) — this is a read, not
// an enrichment pass. Replaces the raw prompt timeline: a prompt is the
// question, a recap is what actually happened.

type Props = {
  sessions: SessionView[]
  // false until the first snapshot lands: until then a missing session id
  // means "not loaded yet", not "expired" — no dimming, no scary tooltip
  sessionsReady: boolean
  onFocusSession: (sid: string) => void
}

const PAGE = 30

// keyset cursor: the exact (last_message_at, session_id) of the last row shown.
// A bare timestamp cursor can wedge when a full page ties on one millisecond
// (bulk imports); the pair matches the backend's ORDER BY, so paging always
// advances past the boundary row no matter how large the tie group is.
type Cursor = { ts: number; sid: string }

const S = {
  h: { fontSize: 10, letterSpacing: 1, color: '#5b6675', fontWeight: 700, margin: '0 0 8px' } as const,
  day: { fontSize: 9.5, letterSpacing: 1, color: '#4a5462', fontWeight: 700, margin: '12px 0 4px' } as const,
  dim: { color: '#5b6675' } as const,
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  // calendar arithmetic, not now-86400000ms: a fixed day length lands two
  // days back during the first hour after a spring-forward DST transition
  const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'TODAY'
  if (same(d, yest)) return 'YESTERDAY'
  // year included once it differs — "JUL 1" must not mean two different years
  return d
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
    .toUpperCase()
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

export default function RecapDigest({ sessions, sessionsReady, onFocusSession }: Props) {
  const [rows, setRows] = useState<RecapEntry[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // ticks just past local midnight so TODAY/YESTERDAY relabel without needing
  // an index event; reschedules itself for the next midnight after each fire
  const [dayTick, setDayTick] = useState(0)
  useEffect(() => {
    const next = new Date()
    next.setHours(24, 0, 0, 100)
    const t = setTimeout(() => setDayTick((n) => n + 1), next.getTime() - Date.now())
    return () => clearTimeout(t)
  }, [dayTick])

  const bySid = new Map(sessions.map((s) => [s.session_id, s]))

  const paged = useRef(false)
  const load = useCallback((before: Cursor | null) => {
    setBusy(true)
    invoke<RecapEntry[]>('recap_digest', { limit: PAGE, before: before?.ts ?? null, beforeSid: before?.sid ?? null })
      .then((page) => {
        setMore(page.length === PAGE)
        setRows((prev) => {
          if (before == null) return page
          // the keyset cursor is strictly-after, so pages can't overlap; the
          // dedupe is belt-and-braces against reordering between requests
          const seen = new Set(prev.map((r) => r.session_id))
          return [...prev, ...page.filter((r) => !seen.has(r.session_id))]
        })
      })
      .catch(() => setMore(false))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => {
    load(null)
    let cancelled = false
    let un: UnlistenFn | null = null
    listen('index-updated', () => {
      // fresh recaps as sessions progress — but never yank the list out from
      // under a reader who has paged back in time
      if (!cancelled && !paged.current) load(null)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [load])

  const toggle = (sid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return next
    })

  // rows grouped by day, in the order received (newest first)
  const groups: { day: string; items: RecapEntry[] }[] = []
  for (const r of rows) {
    const day = dayLabel(r.last_message_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(r)
    else groups.push({ day, items: [r] })
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={S.h}>WHAT HAPPENED</div>
      {rows.length === 0 && !busy && (
        <div style={{ ...S.dim, fontSize: 11.5 }}>
          No recaps yet — sessions appear here once they've been summarized.
        </div>
      )}
      {groups.map((g) => (
        <div key={g.day}>
          <div style={S.day}>{g.day}</div>
          {g.items.map((r) => {
            const s = bySid.get(r.session_id)
            // absent from a LOADED snapshot = transcript expired/deleted; while
            // the snapshot is still in flight, absence means nothing
            const expired = sessionsReady && !s
            const open = expanded.has(r.session_id)
            const hasTimeline = r.timeline.length > 0
            return (
              <div key={r.session_id} style={{ padding: '4px 0', opacity: expired ? 0.55 : 1 }}>
                <div
                  onClick={() => hasTimeline && toggle(r.session_id)}
                  role={hasTimeline ? 'button' : undefined}
                  title={hasTimeline ? (open ? 'Collapse milestones' : 'Show milestones') : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: hasTimeline ? 'pointer' : 'default' }}
                >
                  <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: sessionColor(r.session_id, 1, s?.hue ?? null) }} />
                  {s && s.live_status !== 'ended' && (
                    <span style={{ flex: 'none', display: 'flex' }}>
                      <LiveIndicator status={s.live_status} />
                    </span>
                  )}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#e8edf4' }}>
                    {baseName(r.project_path)}
                    {r.label && <span style={{ color: '#9aa3af' }}> · {r.label}</span>}
                  </span>
                  <span style={{ marginLeft: 'auto', flex: 'none', color: '#4a5462', fontFamily: 'Menlo, monospace', fontSize: 10 }}>{fmtTime(r.last_message_at)}</span>
                  {hasTimeline && (
                    <span style={{ flex: 'none', color: '#5b6675', fontSize: 10, width: 10, textAlign: 'center' }}>{open ? '▾' : '▸'}</span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onFocusSession(r.session_id) }}
                    disabled={!s}
                    title={expired ? 'transcript no longer indexed — expired or deleted' : 'Open this session'}
                    style={{ flex: 'none', background: 'none', border: 'none', color: s ? '#5a7fb0' : '#3a4250', cursor: s ? 'pointer' : 'default', fontSize: 12, padding: '0 2px' }}
                  >
                    ↗
                  </button>
                </div>
                <div
                  onClick={() => hasTimeline && toggle(r.session_id)}
                  style={{ margin: '2px 0 0 15px', fontSize: 11.5, color: '#8d97a5', cursor: hasTimeline ? 'pointer' : 'default', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                >
                  {r.summary}
                </div>
                {open && (
                  <div style={{ margin: '4px 0 2px 15px' }}>
                    {r.timeline.map((t, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, padding: '1px 0', fontSize: 11.5 }}>
                        <span style={{ flex: 'none', color: t.in_progress ? '#e8a33d' : '#5f9e7d' }}>{t.in_progress ? '◐' : '✓'}</span>
                        <span style={{ minWidth: 0, color: t.in_progress ? '#c8cdd5' : '#7d8794' }}>{t.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {more && rows.length > 0 && (
        <button
          onClick={() => {
            const tail = rows[rows.length - 1]
            if (!tail) return
            paged.current = true
            load({ ts: tail.last_message_at, sid: tail.session_id })
          }}
          disabled={busy}
          style={{ marginTop: 10, background: '#141b26', border: '1px solid #2c3647', borderRadius: 5, color: '#9aa3af', fontSize: 11, padding: '3px 10px', cursor: busy ? 'default' : 'pointer' }}
        >
          {busy ? 'loading…' : 'show earlier'}
        </button>
      )}
    </div>
  )
}
