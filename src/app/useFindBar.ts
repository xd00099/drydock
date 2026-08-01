import { useEffect, useRef, useState } from 'react'
import type { PaneSearch } from '@/lib/types'

/** ⌘F within the active pane — the terminal's own scrollback for live claude
 *  sessions and shells, or an open transcript tab's text. (Searching a claude
 *  session's *full* indexed history is a different thing: open its transcript
 *  from the sidebar or ⌘K.)
 *
 *  Every pane registers a PaneSearch handle here as it mounts, so the bar can
 *  drive whichever pane is focused without knowing what kind of pane it is.
 */
export function useFindBar({ activeId, tabCount }: { activeId: number | null; tabCount: number }) {
  /** Per-pane search handles, registered by TerminalPane / TranscriptView refs. */
  const paneSearch = useRef<Record<number, PaneSearch | null>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatches, setFindMatches] = useState({ index: -1, count: 0 })
  /** Bumped to re-focus the input when ⌘F is pressed while the bar is already open. */
  const [findNonce, setFindNonce] = useState(0)

  const activeSearch = () => (activeId != null ? paneSearch.current[activeId] : null)
  const findStep = (dir: 'next' | 'prev') => activeSearch()?.find(findQuery, { dir })

  /** Closing hands focus back to the pane so typing resumes immediately. */
  const closeFind = () => {
    setFindOpen(false)
    Object.values(paneSearch.current).forEach((p) => p?.clear())
    setFindMatches({ index: -1, count: 0 })
    activeSearch()?.focus?.()
  }

  /** No active pane on Home — a find bar there would search nothing. */
  const openFind = () => {
    if (!tabCount || activeId == null) return
    setFindOpen(true)
    setFindNonce((n) => n + 1)
  }

  /** Drop a closed tab's handle so it can't be searched or cleared later. */
  const forgetPane = (id: number) => {
    delete paneSearch.current[id]
  }

  // Live (incremental) find as the query changes, the bar opens, or the tab switches.
  const lastFindPaneRef = useRef<number | null>(null)
  useEffect(() => {
    if (!findOpen || activeId == null) return
    // retargeting to another pane: wipe the departing pane's marks first — in
    // a split it stays VISIBLE, and two panes must not both show an "active"
    // match while the counter describes only one of them
    if (lastFindPaneRef.current !== null && lastFindPaneRef.current !== activeId) {
      paneSearch.current[lastFindPaneRef.current]?.clear()
    }
    lastFindPaneRef.current = activeId
    activeSearch()?.find(findQuery, { dir: 'next', incremental: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, activeId])

  return {
    paneSearch, forgetPane,
    findOpen, findQuery, setFindQuery,
    findMatches, setFindMatches, findNonce,
    findStep, openFind, closeFind,
  }
}
