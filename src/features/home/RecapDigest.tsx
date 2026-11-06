import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { RecapEntry, SessionView } from '@/lib/types'
import { baseName, projectColor } from '@/lib/types'
import LiveIndicator from '@/features/session/LiveIndicator'
import { Button, IconButton } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import css from './RecapDigest.module.css'

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
    <section className={css.log} aria-label="Recent work">
      <h2 className={css.heading}>Recent work</h2>
      {rows.length === 0 && <div className={css.empty}>
        <Icon name="terminal" size={24} />
        <strong>{busy ? 'Loading your work…' : 'A little quiet here, for now.'}</strong>
        <p>{busy ? 'Gathering session recaps.' : "Your session summaries will appear here as you work. Start a session or open one from the sidebar."}</p>
      </div>}
      {groups.map((g) => (
        <div key={g.day}>
          <h3 className={css.day}>{g.day}</h3>
          {g.items.map((r) => {
            const session = bySid.get(r.session_id)
            const expired = sessionsReady && !session
            const open = expanded.has(r.session_id)
            const hasTimeline = r.timeline.length > 0
            return (
              <article key={r.session_id} className={css.entry} data-expired={expired}>
                <div className={css.entryHead}>
                  <span className={css.dot} style={{ background: projectColor(session?.project_path ?? r.project_path) }} />
                  <span className={css.project}>{baseName(r.project_path)}</span>
                  {session && session.live_status !== 'ended' && <LiveIndicator status={session.live_status} />}
                  <time className={css.time}>{fmtTime(r.last_message_at)}</time>
                  <IconButton label="Open this session" disabled={!session} title={expired ? 'Transcript no longer indexed' : 'Open this session'} onClick={() => onFocusSession(r.session_id)}><Icon name="arrow" size={14} /></IconButton>
                </div>
                {r.label && <div className={css.label}>{r.label}</div>}
                <p className={css.summary}>{r.summary}</p>
                {hasTimeline && <button className={css.disclosure} aria-expanded={open} onClick={() => toggle(r.session_id)}>
                  <span aria-hidden="true">{open ? '−' : '+'}</span> {open ? 'Hide milestones' : `${r.timeline.length} milestone${r.timeline.length === 1 ? '' : 's'}`}
                </button>}
                {open && <ul className={css.timeline}>
                  {r.timeline.map((t, i) => <li key={i}><span style={{ color: t.in_progress ? 'var(--dd-warn)' : 'var(--dd-ok)' }}>{t.in_progress ? '◐' : '✓'}</span><span>{t.text}</span></li>)}
                </ul>}
              </article>
            )
          })}
        </div>
      ))}
      {more && rows.length > 0 && <Button small onClick={() => {
        const tail = rows[rows.length - 1]
        if (!tail) return
        paged.current = true
        load({ ts: tail.last_message_at, sid: tail.session_id })
      }} disabled={busy}>{busy ? 'Loading…' : 'Show earlier'}</Button>}
    </section>
  )
}
