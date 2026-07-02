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
  // hand keyboard focus back to the pane (e.g. when the FindBar closes, so a
  // terminal session can be typed into immediately)
  focus?: () => void
}

// Full-fidelity transcript entry (backend transcript::read_page). 'plain' is
// frontend-only: the fallback rendering of indexed chunks when the session's
// .jsonl is gone (radar stubs, expired transcripts).
export type TEntryKind = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'recap' | 'compact' | 'plain'
export type TEntry = {
  kind: TEntryKind
  text: string
  tool: string | null
  tool_use_id: string | null
  meta: boolean // caveat/command noise — rendered dimmed
  error: boolean // tool_result with is_error
  ts: number | null
}
export type TranscriptPage = { entries: TEntry[]; next_offset: number; reset: boolean }

// One file a session changed (backend transcript::files_touched).
export type FileTouch = { path: string; edits: number; writes: number; last_ts: number | null }

export type TimelineItem = { text: string; detail: string[]; in_progress: boolean }
export type CardView = { summary: string; timeline: TimelineItem[]; generated_at: number }

// Read-only capability views for the right panel (from ~/.claude, secrets stripped)
export type Skill = { name: string; description: string; plugin: string }
// `builtin` = Drydock's own drydock-artifacts server; `enabled` = whether Drydock
// offers it to the sessions it launches (false → its tools are denied for new
// sessions); `tools` is only populated for the builtin server.
export type McpServer = {
  name: string
  kind: string
  detail: string
  scope: string
  builtin: boolean
  enabled: boolean
  tools: string[]
}
// Live connection status from `claude mcp list`, per server name.
export type McpStatus = 'connected' | 'failed' | 'pending' | 'unknown'

// A visual artifact a session rendered via the loopback MCP server, shown in the
// right-panel "Artifacts" tab. `id` is server-assigned (stable React key).
// `path` is the on-disk source when rendered from a file (enables "Reveal in
// Finder"); undefined for inline content.
export type ArtifactKind = 'html' | 'svg' | 'markdown'
export type Artifact = { id: string; title: string; kind: ArtifactKind; content: string; path?: string }

/** Display label for a session: AI summary when present, else its raw title. */
export function sessionLabel(s: SessionView): string {
  return s.summary && s.summary.trim() ? s.summary : s.title
}

/** RFC-4122 v4 UUID via WebCrypto. Used to pin a *new* claude session's id at
 *  launch (`claude --session-id`), so its tab can be matched back to the sidebar
 *  entry immediately — exactly like a resumed session. Uses getRandomValues
 *  (always available) rather than crypto.randomUUID (secure-context only). */
export function uuidv4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 1
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
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

/** Clamp a side-panel width to drag bounds that respect the live window: the cap
 *  is roomy (≥900px, and ~1/3 of the window on very wide monitors so the
 *  Artifacts panel's auto-size keeps its promise) but never lets the two side
 *  panels jointly starve the main column below ~240px — persisted widths from a
 *  big monitor would otherwise overflow a smaller window (the main column is the
 *  only flex child that can shrink, so it collapses to 0 and the chrome spills
 *  past the viewport). Callers re-clamp on window resize. */
export function clampPanelWidth(w: number): number {
  const iw = window.innerWidth
  const cap = Math.max(180, Math.min(Math.max(900, Math.round(iw / 3)), Math.floor((iw - 240) / 2)))
  return Math.max(180, Math.min(cap, w))
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
