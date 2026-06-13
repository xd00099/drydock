export type SessionView = {
  session_id: string
  project_path: string
  title: string
  latest_recap: string | null
  last_message_at: number | null
  starred: boolean
  hidden: boolean
  live_status: 'busy' | 'idle' | 'ended'
}

export type Snapshot = { sessions: SessionView[]; pinned: string[]; hidden: string[] }

export type Tab = {
  id: number
  title: string
  kind: 'pty' | 'transcript'
  // pty fields
  program: string | null // null → $SHELL
  args: string[]
  cwd: string | null
  exited: boolean
  // transcript fields
  sessionId?: string
  // preview tabs (opened by browsing the sidebar/palette) are replaced by the
  // next preview; interacting with the pane promotes them to permanent
  preview?: boolean
}

export function relAge(ms: number | null): string {
  if (!ms) return '-'
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}
