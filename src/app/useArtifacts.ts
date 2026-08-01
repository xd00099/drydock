import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { bytesToB64 } from '@/features/terminal/TerminalPane'
import { EMPTY_REVIEW, clip, type Artifact, type ArtifactKind, type ReviewPrompt, type ReviewState, type Tab } from '@/lib/types'

// Artifacts live only in memory (never written to disk). Bound that memory: a
// session that re-renders many times keeps only its most recent N (each up to
// the backend's 4 MB cap); older versions are dropped.
const MAX_ARTIFACTS_PER_TAB = 20

/** How long a 'working' presence survives without a newer event. The poll only
 *  runs while the model is in a turn, so a model that stops polling (turn
 *  ended, crash) would otherwise wedge the review composer shut forever. */
const WORKING_DECAY_MS = 60_000

type Deps = {
  /** Tabs currently on stage — an artifact for one of these counts as seen. */
  visibleRef: React.MutableRefObject<number[]>
  /** Live tabs, for dropping events aimed at a tab that has since closed. */
  tabsRef: React.MutableRefObject<Tab[]>
}

/** Visual artifacts a session rendered through the loopback MCP server, plus
 *  the interactive review loop layered on top of them (docs/artifact-review.md).
 *
 *  These are one unit rather than two: the rewind event has to prune artifacts
 *  and clear the review round together, and both are keyed by pty id with the
 *  same per-tab teardown.
 */
export function useArtifacts({ visibleRef, tabsRef }: Deps) {
  const [artifactsByTab, setArtifactsByTab] = useState<Record<number, Artifact[]>>({})
  /** Artifacts that arrived for a tab the user couldn't see — a badge count. */
  const [unread, setUnread] = useState<Record<number, number>>({})

  // ALL review writes go through mutateReview: it updates the ref mirror
  // SYNCHRONOUSLY before the state set, so reviewSend can read the queue it is
  // about to submit without waiting for a render.
  const [reviewByTab, setReviewByTab] = useState<Record<number, ReviewState>>({})
  const reviewRef = useRef(reviewByTab)
  const mutateReview = (fn: (prev: Record<number, ReviewState>) => Record<number, ReviewState>) => {
    reviewRef.current = fn(reviewRef.current)
    setReviewByTab(reviewRef.current)
  }
  const reviewDecayTimers = useRef<Record<number, number>>({})

  /** Forget a tab that closed or exited: its artifacts (in-memory only, so an
   *  ended session shouldn't keep holding them), badge, review round, and any
   *  pending presence decay. */
  const forgetTab = (id: number) => {
    setArtifactsByTab((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    setUnread((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
    window.clearTimeout(reviewDecayTimers.current[id])
    mutateReview((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n })
  }

  // A session rendered an artifact: file it under its tab id for the Preview
  // panel, and badge the tab if it's not in focus.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ pty_id: number; id: string; title: string; kind: string; content: string; path: string | null }>('artifact', (e) => {
      const p = e.payload
      const kind: ArtifactKind = p.kind === 'svg' || p.kind === 'markdown' ? p.kind : 'html'
      const art: Artifact = { id: p.id, title: p.title || 'Untitled', kind, content: p.content, path: p.path ?? undefined }
      setArtifactsByTab((prev) => {
        const next = [...(prev[p.pty_id] ?? []), art]
        if (next.length > MAX_ARTIFACTS_PER_TAB) next.splice(0, next.length - MAX_ARTIFACTS_PER_TAB)
        return { ...prev, [p.pty_id]: next }
      })
      // visible on stage = already seen; only badge tabs the user can't see
      if (!visibleRef.current.includes(p.pty_id)) setUnread((u) => ({ ...u, [p.pty_id]: (u[p.pty_id] ?? 0) + 1 }))
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The session's transcript rewound (Claude Code Esc-Esc): artifacts rendered
  // after the rewound-to point show a discarded future — the backend pruned
  // them; drop them here too, and clear the review round's pills (they
  // annotated that discarded timeline).
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ session_id: string; pty_id: number | null; removed_ids: string[] }>('artifact-rewound', (e) => {
      const p = e.payload
      if (p.pty_id == null) return
      const pty = p.pty_id
      if (p.removed_ids.length) {
        const gone = new Set(p.removed_ids)
        setArtifactsByTab((prev) => {
          const cur = prev[pty]
          if (!cur?.length) return prev
          const kept = cur.filter((a) => !gone.has(a.id))
          return kept.length === cur.length ? prev : { ...prev, [pty]: kept }
        })
      }
      mutateReview((prev) => {
        const cur = prev[pty]
        if (!cur || cur.prompts.length === 0) return prev
        return { ...prev, [pty]: { ...cur, prompts: [] } }
      })
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Review-loop signals from the backend poll tool: presence transitions
  // (listening/working/waiting around await_artifact_feedback) and optional
  // agent replies for the conversation panel.
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ pty_id: number; presence?: string; reply?: string }>('artifact-review', (e) => {
      const p = e.payload
      // Drop events for tabs that closed/exited — a straggler poll finishing
      // after teardown must not resurrect an orphaned review entry.
      const t = tabsRef.current.find((x) => x.id === p.pty_id)
      if (!t || t.kind !== 'pty' || t.exited) return
      mutateReview((prev) => {
        const cur = prev[p.pty_id] ?? EMPTY_REVIEW
        const presence =
          p.presence === 'listening' || p.presence === 'working' || p.presence === 'waiting' ? p.presence : cur.presence
        const chat = p.reply ? [...cur.chat, { role: 'agent' as const, text: p.reply }] : cur.chat
        return { ...prev, [p.pty_id]: { ...cur, presence, chat } }
      })
      // 'working' means "feedback delivered, model revising" — decay it so a
      // model that stops polling can't wedge the composer shut.
      window.clearTimeout(reviewDecayTimers.current[p.pty_id])
      if (p.presence === 'working') {
        reviewDecayTimers.current[p.pty_id] = window.setTimeout(() => {
          mutateReview((prev) => {
            const cur = prev[p.pty_id]
            if (!cur || cur.presence !== 'working') return prev
            return { ...prev, [p.pty_id]: { ...cur, presence: 'waiting' } }
          })
        }, WORKING_DECAY_MS)
      }
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- interactive review handlers (bound per tab at the BriefingPanel) ----

  /** Queue one annotation from the SDK. A repeat `_ddQueueKey` replaces the
   *  unsent prior update for the same input (radio/checkbox/field). */
  const reviewQueue = (tabId: number, prompt: ReviewPrompt) => {
    mutateReview((prev) => {
      const cur = prev[tabId] ?? EMPTY_REVIEW
      const key = prompt._ddQueueKey
      const kept = key ? cur.prompts.filter((p) => p._ddQueueKey !== key) : cur.prompts
      return { ...prev, [tabId]: { ...cur, prompts: [...kept, prompt] } }
    })
  }

  const reviewDiscard = (tabId: number, index: number) => {
    mutateReview((prev) => {
      const cur = prev[tabId] ?? EMPTY_REVIEW
      return { ...prev, [tabId]: { ...cur, prompts: cur.prompts.filter((_, i) => i !== index) } }
    })
  }

  /** Send everything queued (plus an optional composer message) to the session's
   *  feedback queue; `endReview` marks the review finished. Reads the ref (kept
   *  fresh by mutateReview) so the invoke happens exactly once. */
  const reviewSend = (tabId: number, message: string, endReview: boolean) => {
    const cur = reviewRef.current[tabId] ?? EMPTY_REVIEW
    if (cur.presence === 'working') return // model is mid-revision; panel shows why
    const all = [...cur.prompts]
    const msg = message.trim()
    if (msg) all.push({ uid: '', prompt: msg, selector: '', tag: 'message', text: '' })
    if (!all.length && !endReview) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const stripped = all.map(({ _ddQueueKey, ...rest }) => rest)
    invoke('submit_artifact_feedback', { ptyId: tabId, prompts: stripped, endReview }).catch(console.error)
    const chat = [
      ...cur.chat,
      ...all.map((p) => ({
        role: 'user' as const,
        text: p.tag === 'message' ? p.prompt : `⟨${p.tag}⟩${p.text ? ` “${clip(p.text, 60)}”` : ''} — ${p.prompt}`,
      })),
    ]
    mutateReview((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? EMPTY_REVIEW), prompts: [], chat } }))
    // presence 'waiting' means nobody is listening (the turn ended — e.g. the
    // model hit the empty-poll limit), so the queued feedback would sit silently
    // until the user typed something. Nudge the session ourselves: type a prompt
    // into its PTY exactly as the user would, starting a turn that collects it.
    if (cur.presence === 'waiting') {
      const nudge = endReview
        ? 'I finished reviewing the artifact — call await_artifact_feedback to collect my final feedback if you have not already, apply it, and continue with the work.'
        : 'I left review feedback on the artifact — call await_artifact_feedback to collect and apply it.'
      // pty_write takes base64 bytes. The Enter must be a separate write after a
      // beat: text+\r in one chunk trips the TUI's paste detection, which turns
      // the \r into a composer newline instead of a submit (verified against a
      // live claude PTY — single chunk parks the text unsent, split submits).
      const enc = new TextEncoder()
      invoke('pty_write', { id: tabId, data: bytesToB64(enc.encode(nudge)) })
        .then(() => new Promise((r) => setTimeout(r, 200)))
        .then(() => invoke('pty_write', { id: tabId, data: bytesToB64(enc.encode('\r')) }))
        .catch(console.error)
    }
  }

  return {
    artifactsByTab, unread, setUnread,
    reviewByTab, reviewQueue, reviewDiscard, reviewSend,
    forgetTab,
  }
}
