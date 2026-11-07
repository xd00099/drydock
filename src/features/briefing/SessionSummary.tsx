import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import { relAge } from '@/lib/types'
import css from './SessionSummary.module.css'

export type SavedSummary = {
  title: string; summary: string; generated_at: number; source_version: string
  head: string | null; limited: boolean
}
export type SummaryView = {
  saved: SavedSummary | null; new_activity: boolean; available: boolean; limited: boolean; refreshing: boolean
}
type Commit = { previous: string; expected: string }

export function SessionSummary({ sessionId, head, actions }: { sessionId: string; head: string | null; actions?: ReactNode }) {
  const [view, setView] = useState<SummaryView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [commit, setCommit] = useState<Commit | null>(null)
  const [, setTick] = useState(0)
  const alive = useRef(true)
  const requesting = useRef(false)
  const revision = useRef(0)
  const observedHead = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    let loading = false
    let last = 0
    const load = async () => {
      if (loading || requesting.current || Date.now() - last < 1200) return
      loading = true; last = Date.now()
      const token = revision.current
      try {
        const next = await invoke<SummaryView>('get_session_summary', { sessionId })
        if (alive.current && token === revision.current && !requesting.current) { setView(next); setLoadError('') }
      } catch (e) { if (alive.current && token === revision.current) setLoadError(String(e)) }
      finally { loading = false }
    }
    void load()
    const timer = window.setInterval(load, 4000)
    const ageTimer = window.setInterval(() => setTick((n) => n + 1), 30_000)
    const un = listen('index-updated', load)
    return () => { alive.current = false; ++revision.current; clearInterval(timer); clearInterval(ageTimer); un.then((u) => u()) }
  }, [sessionId])

  const refresh = useCallback(async (trigger?: Commit) => {
    if (requesting.current) return
    requesting.current = true; ++revision.current
    setBusy(true); setError('')
    try {
      const next = await invoke<SummaryView>('refresh_session_summary', {
        sessionId, previousHead: trigger?.previous ?? null, expectedHead: trigger?.expected ?? null,
      })
      if (alive.current) { setView(next); setLoadError('') }
    } catch (e) { if (alive.current) setError(String(e)) }
    finally {
      requesting.current = false; ++revision.current
      if (alive.current) setBusy(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!head) return
    const previous = observedHead.current
    observedHead.current = head
    // Establish a baseline on opening; never bill a refresh merely for opening
    // an old session. Only changes observed while Briefing is visible count.
    if (previous && previous !== head) setCommit((pending) => ({ previous: pending?.previous ?? previous, expected: head }))
  }, [head])
  useEffect(() => {
    if (!commit || !view?.available || view.refreshing || busy) return
    if (view.saved?.head === commit.expected) { setCommit(null); return }
    const timer = window.setTimeout(() => {
      setCommit(null)
      void refresh(commit)
    }, 5000)
    return () => clearTimeout(timer)
  }, [commit, view?.available, view?.refreshing, view?.saved?.head, busy, refresh])

  const saved = view?.saved
  const refreshing = busy || !!view?.refreshing
  const newActivity = !!saved && (view?.new_activity || (!!head && saved.head !== head))
  const updated = saved ? relAge(saved.generated_at) : null
  const unavailable = view && !view.available
  return <section className={css.section} aria-label="Session summary" aria-busy={refreshing}>
    <div className={css.header}>
      <span className={css.heading}>SUMMARY</span>
      <Button small variant="ghost" disabled={!view?.available || refreshing} onClick={() => void refresh()}
        title={unavailable ? 'Conversation content is not available locally yet' : 'Refresh title and summary with AI'}>
        <Icon name="refresh" size={12} className={refreshing ? css.spinning : undefined} />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
    </div>
    {saved ? <div className={css.body}>{saved.summary.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph}</p>)}</div>
      : <p className={css.empty}>{unavailable ? 'Conversation content isn’t available locally yet.' : refreshing ? 'Writing a short title and summary…' : 'A few sentences to pick up where you left off.'}</p>}
    {saved && <div className={css.meta}>
      <time dateTime={new Date(saved.generated_at).toISOString()} title={`Updated ${new Date(saved.generated_at).toLocaleString()}${saved.head ? ` · commit ${saved.head.slice(0, 7)}` : ''}`}>
        {updated === 'now' ? 'Updated just now' : `Updated ${updated} ago`}
      </time>
      {unavailable ? <span>Context unavailable</span> : newActivity ? <span className={css.activity}><span className={css.dot} />New activity</span> : null}
      {saved.limited && <span title="This summary used saved prompts and recaps; a readable conversation transcript was not available.">Saved context only</span>}
    </div>}
    {(error || loadError) && <p className={css.error} role="alert">{error || loadError}</p>}
    {actions && <div className={css.actions}>{actions}</div>}
  </section>
}
