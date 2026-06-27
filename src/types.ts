export type SessionView = {
  session_id: string
  project_path: string
  title: string
  summary: string | null // AI ~5-word title from the card; rendered over `title`
  latest_recap: string | null
  last_message_at: number | null
  starred: boolean
  hidden: boolean
  live_status: 'busy' | 'idle' | 'ended'
}

export type Snapshot = { sessions: SessionView[]; hidden: string[] }

// In-pane "find within session" (⌘F). Each pane (terminal/transcript) exposes
// this so the FindBar can drive it. `incremental` keeps the current match when
// the query only grew (live typing), vs explicitly advancing on next/prev.
export type FindDir = 'next' | 'prev'
export type PaneSearch = {
  find: (query: string, opts: { dir: FindDir; incremental?: boolean }) => void
  clear: () => void
}

export type TimelineItem = { text: string; detail: string[]; in_progress: boolean }
export type CardView = { summary: string; timeline: TimelineItem[]; generated_at: number }

// Read-only capability views for the right panel (from ~/.claude, secrets stripped)
export type Skill = { name: string; description: string; plugin: string }
export type McpServer = { name: string; kind: string; detail: string; scope: string }

// A visual artifact a session rendered via the loopback MCP server, shown in the
// right-panel "Preview" tab. `id` is server-assigned (stable React key).
export type ArtifactKind = 'html' | 'svg' | 'markdown'
export type Artifact = { id: string; title: string; kind: ArtifactKind; content: string }

/** Display label for a session: AI summary when present, else its raw title. */
export function sessionLabel(s: SessionView): string {
  return s.summary && s.summary.trim() ? s.summary : s.title
}

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
  // a plain shell (＋/⌘T), as opposed to a claude session; shown in its own
  // tab-bar lane and named after its working directory
  terminal?: boolean
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

/** Read a positive number from localStorage, falling back if absent/invalid. */
export function loadNum(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** Clamp a side-panel width to sensible drag bounds. */
export function clampPanelWidth(w: number): number {
  return Math.max(180, Math.min(560, w))
}

/** Last path segment ("/Users/x/Desktop" → "Desktop", "~" → "~", "/" → "/"). */
export function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

/** Stable per-session accent color (FNV-1a hash of the id → hue), so the same
 *  session reads as the same color in the sidebar and its tab. Pass an `alpha`
 *  below 1 for a translucent tint (e.g. a row background). */
export function sessionColor(sessionId: string, alpha = 1): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const hue = (h >>> 0) % 360
  return alpha >= 1 ? `hsl(${hue}, 60%, 62%)` : `hsla(${hue}, 60%, 62%, ${alpha})`
}
