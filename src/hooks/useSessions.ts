import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Snapshot } from '@/lib/types'

export function useSessions() {
  const [snap, setSnap] = useState<Snapshot>({ sessions: [], hidden: [], folders: [] })
  // false until the first snapshot lands: "session not in the list" means
  // "expired/deleted" only once there IS a list — consumers must not render
  // missing-session treatments off the initial empty state
  const [ready, setReady] = useState(false)
  const refresh = useCallback(() => {
    invoke<Snapshot>('sessions_snapshot').then((s) => { setSnap(s); setReady(true) }).catch(console.error)
  }, [])
  useEffect(() => {
    refresh()
    let cancelled = false
    const uns: UnlistenFn[] = []
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    const sub = (ev: string) =>
      listen(ev, refresh).then((u) => { if (cancelled) u(); else uns.push(u) })
    // index-updated = the transcripts on disk moved. sessions-changed = only a
    // session's live state did; it exists so the end of every turn can refresh
    // this list without making the transcript-reading panels re-parse the file.
    sub('index-updated')
    sub('sessions-changed')
    return () => { cancelled = true; for (const u of uns) u() }
  }, [refresh])
  return { ...snap, ready, refresh }
}
