import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clampPanelWidth, loadNum, type Artifact, type CardView, type FileTouch, type ReviewPrompt, type ReviewState, type SessionUsage, type TasksView } from '@/lib/types'
import ResizeHandle from '@/components/ui/ResizeHandle'
import { useChord } from '@/lib/keymap'
import { BriefingTab } from './BriefingTab'
import { ProjectTab } from './ProjectTab'
import { PreviewTab } from './PreviewTab'
import { S } from './styles'

type RightTab = 'briefing' | 'project' | 'preview'

type Props = {
  sessionId: string | null // null for a brand-new claude tab with no session id yet
  projectPath?: string // active session's project, for per-project MCP lookup
  starred: boolean
  artifacts: Artifact[] // visual artifacts this tab's session has rendered
  // resolved display label (Drydock name > custom-title > summary > title);
  // null when the session isn't indexed yet
  label?: string | null
  onToggleStar?: () => void
  // rename the session in Drydock's index (blank clears); absent = unindexed
  onRename?: (name: string) => void
  // artifacts arrived while this tab was NOT focused (e.g. Home was showing):
  // open the Artifacts tab on mount so the badge's click actually lands there
  initialUnread?: boolean
  // Interactive artifact review (docs/artifact-review.md). null = this tab
  // can't review (plain transcript / exited pty) → annotation UI hidden.
  review?: ReviewState | null
  reviewAccent?: string // session color for the SDK highlights + panel chrome
  onReviewQueue?: (p: ReviewPrompt) => void
  onReviewDiscard?: (index: number) => void
  onReviewSend?: (message: string, endReview: boolean) => void
  collapsed: boolean // lifted to App so ⌘J can drive it
  onSetCollapsed: (c: boolean) => void
  // ⌘⇧B/P/J: each bump lands on the named sub-tab (App expands the panel)
  panelJump: { tab: RightTab; n: number }
}

// Floor on how often an open panel re-reads the session from disk. Chosen
// against the watcher's 400ms debounce: slow enough that a busy session can't
// pin a core re-parsing its transcript, fast enough that the panel still tracks
// a turn as it happens.
const REFRESH_MS = 1200

const TABS: { id: RightTab; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'project', label: 'Project' }, // skills + MCP, merged: project/environment scope
  { id: 'preview', label: 'Artifacts' }, // id stays 'preview' so saved dd.rightTab keeps working
]

// Saved right-tab prefs from before the Skills/MCP merge name tabs that no
// longer exist; both fold into Project. Anything else unexpected → briefing.
function loadRightTab(): RightTab {
  const saved = localStorage.getItem('dd.rightTab')
  if (saved === 'skills' || saved === 'mcp') return 'project'
  return saved === 'briefing' || saved === 'project' || saved === 'preview' ? saved : 'briefing'
}


export default function BriefingPanel({ sessionId, projectPath, starred, artifacts, label, onToggleStar, onRename, initialUnread, review, reviewAccent, onReviewQueue, onReviewDiscard, onReviewSend, collapsed, onSetCollapsed, panelJump }: Props) {
  const panelChord = useChord('briefing.toggle')
  const tabChords: Record<RightTab, string> = {
    briefing: useChord('briefing.tab.briefing'),
    project: useChord('briefing.tab.project'),
    preview: useChord('briefing.preview'),
  }
  const [card, setCard] = useState<CardView | null>(null)
  const [files, setFiles] = useState<FileTouch[]>([])
  const [tasks, setTasks] = useState<TasksView | null>(null)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  // clamp on load AND on window resize: a width persisted (or auto-widened) on a
  // big monitor must not overflow a smaller window later
  const [width, setWidth] = useState(() => clampPanelWidth(loadNum('dd.briefingWidth', 252)))
  const [tab, setTab] = useState<RightTab>(() => (initialUnread ? 'preview' : loadRightTab()))
  const widthRef = useRef(width)
  widthRef.current = width
  useEffect(() => {
    const reclamp = () => setWidth((w) => clampPanelWidth(w))
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [])

  const refresh = useCallback(() => {
    if (!sessionId) { setCard(null); setFiles([]); setTasks(null); setUsage(null); return } // a session-less new tab has no card
    invoke<CardView | null>('get_card', { sessionId }).then(setCard).catch(console.error)
    // no transcript file yet (radar stub / expired) → just no files section
    invoke<FileTouch[]>('session_files', { sessionId }).then(setFiles).catch(() => setFiles([]))
    // both refresh on the same index-updated tick that moves the transcript
    invoke<TasksView>('session_tasks', { sessionId }).then(setTasks).catch(() => setTasks(null))
    invoke<SessionUsage>('session_usage', { sessionId }).then(setUsage).catch(() => setUsage(null))
  }, [sessionId])
  // `index-updated` fires on a 400ms watcher debounce, so a session that is
  // actively working ticks it up to ~2.5x/second — and every tick costs four
  // commands, two of which read the session's entire transcript off disk. On a
  // long session that file is tens of megabytes, which is enough to saturate a
  // core and thrash the allocator. Two guards:
  //   - a COLLAPSED panel is a 30px rail with nothing on it, so it subscribes to
  //     nothing at all and refreshes once when you open it;
  //   - an open panel coalesces bursts: the first tick lands immediately, then
  //     at most one refresh per REFRESH_MS.
  const throttle = useRef<{ last: number; timer: number | undefined }>({ last: 0, timer: undefined })
  useEffect(() => {
    if (collapsed) return
    const t = throttle.current
    const run = () => { t.last = Date.now(); refresh() }
    const onTick = () => {
      if (t.timer !== undefined) return // one already queued; it will pick this up
      const wait = REFRESH_MS - (Date.now() - t.last)
      if (wait <= 0) return run()
      t.timer = window.setTimeout(() => { t.timer = undefined; run() }, wait)
    }
    run()
    let cancelled = false
    let un: UnlistenFn | null = null
    // if cleanup beat the listen() promise, unlisten immediately instead of leaking
    listen('index-updated', onTick).then((u) => { if (cancelled) u(); else un = u })
    return () => {
      cancelled = true
      un?.()
      if (t.timer !== undefined) { clearTimeout(t.timer); t.timer = undefined }
    }
  }, [refresh, collapsed])

  // When a NEW artifact arrives for this tab, surface it: jump to the Preview
  // sub-tab, open the panel if collapsed, and give it room (~1/3 of the window,
  // never shrinking a panel the user already widened).
  const seenArtifacts = useRef(artifacts.length)
  useEffect(() => {
    if (artifacts.length > seenArtifacts.current) {
      setTab('preview'); localStorage.setItem('dd.rightTab', 'preview')
      onSetCollapsed(false)
      setWidth((w) => {
        const next = Math.max(w, clampPanelWidth(Math.round(window.innerWidth / 3)))
        localStorage.setItem('dd.briefingWidth', String(next))
        return next
      })
    }
    seenArtifacts.current = artifacts.length
  }, [artifacts.length])

  const selectTab = (t: RightTab) => { setTab(t); localStorage.setItem('dd.rightTab', t) }

  // ⌘⇧B/P/J: App bumps the nonce; jump to the named sub-tab.
  const nonceSeen = useRef(panelJump.n)
  useEffect(() => {
    if (panelJump.n !== nonceSeen.current) {
      nonceSeen.current = panelJump.n
      selectTab(panelJump.tab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelJump])

  // collapsed: a thin rail with an expand button, mirroring the left sidebar
  if (collapsed) {
    return (
      <div style={{ width: 30, minWidth: 30, height: '100%', background: 'var(--dd-bg0)', borderLeft: '1px solid var(--dd-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <button onClick={() => onSetCollapsed(false)} title={`Expand panel (${panelChord})`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontSize: 15, padding: 0 }}>«</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ResizeHandle
        onDelta={(dx) => setWidth((w) => clampPanelWidth(w - dx))}
        onEnd={() => localStorage.setItem('dd.briefingWidth', String(widthRef.current))}
      />
      <div style={{ width, minWidth: width, boxSizing: 'border-box', background: 'var(--dd-bg0)', fontFamily: 'system-ui', fontSize: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, padding: '12px 12px 0', flex: 'none' }}>
          <button onClick={() => onSetCollapsed(true)} title={`Collapse panel (${panelChord})`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontSize: 15, padding: 0, lineHeight: 1, alignSelf: 'flex-end', marginBottom: 4 }}>»</button>
          <div style={{ display: 'flex', flex: 1, gap: 2, minWidth: 0 }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => selectTab(t.id)} title={`${t.label} (${tabChords[t.id]})`} style={S.tabBtn(t.id === tab)}>
                {t.label}
                {t.id === 'preview' && artifacts.length > 0 ? ` (${artifacts.length})` : ''}
                {/* chord hint only when the panel is wide enough to keep the
                    three labels on one uncramped row */}
                {width >= 330 && (
                  <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--dd-dim)' }}>{tabChords[t.id]}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Every tab manages its own layout: Preview edge-to-edge, Briefing and
            Project as scrolling-top / pinned-bottom section stacks. */}
        {tab === 'preview' ? (
          <PreviewTab
            artifacts={artifacts}
            sessionId={sessionId}
            review={review ?? null}
            accent={reviewAccent ?? 'var(--dd-warn-bright)'}
            onQueue={onReviewQueue}
            onDiscard={onReviewDiscard}
            onSend={onReviewSend}
          />
        ) : tab === 'briefing' ? (
          <BriefingTab sessionId={sessionId} card={card} starred={starred} files={files} tasks={tasks} usage={usage} projectPath={projectPath} label={label} onToggleStar={onToggleStar} onRename={onRename} />
        ) : (
          <ProjectTab projectPath={projectPath} />
        )}
      </div>
    </div>
  )
}
