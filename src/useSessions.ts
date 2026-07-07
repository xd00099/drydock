import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Snapshot } from './types'

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
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', refresh).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [refresh])
  return { ...snap, ready, refresh }
}
