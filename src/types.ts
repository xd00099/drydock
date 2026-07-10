// Where a live-elsewhere session is running (backend session_process_info) —
// named in the take-over confirm dialog before anything is signalled.
export type TakeoverInfo = {
  pid: number
  status: string // 'busy' | 'idle' (pid-file granularity)
  cwd: string | null
  tty: string | null
  app: string | null
}

export type SessionView = {
  session_id: string
  project_path: string
  title: string
  // where `title` came from; 'custom-title' means the USER named the session
  // (claude -n / /rename) and that name outranks even the card summary
  title_source: string
  // rename made in Drydock's own UI (stored in Drydock's index, never in
  // ~/.claude) — outranks every other source, including claude's custom-title
  name: string | null
  summary: string | null // AI ~5-word title from the card; rendered over `title`
  latest_recap: string | null
  last_message_at: number | null
  starred: boolean
  hidden: boolean
  live_status: 'busy' | 'idle' | 'needs_input' | 'ended'
  // what the session asked for while waiting (hook message); only set when
  // live_status === 'needs_input'
  attention: string | null
  // the user sidebar folder this session is filed in (move semantics: at most
  // one); null = unfiled, shown in its auto project group
  folder_id: string | null
  // semantic hue in degrees — sessions about similar things wear similar
  // colors; null until embeddings exist (sessionColor falls back to the hash)
  hue: number | null
}

// A user-created sidebar folder ("working group"), in band order.
export type FolderView = { id: string; name: string }

export type Snapshot = { sessions: SessionView[]; hidden: string[]; folders: FolderView[] }

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
  // full output on disk for spilled (>50K) tool results — offer to open it
  persisted_path: string | null
  ts: number | null
}
export type TranscriptPage = { entries: TEntry[]; next_offset: number; reset: boolean }

// One file a session changed (backend files::session_files). `path` is the
// location recorded in the transcript (stable display key); `resolved` is where
// the file lives NOW — equal to `path` when still in place, elsewhere when the
// project was renamed/moved since, null when it's genuinely gone.
export type FileTouch = {
  path: string
  resolved: string | null
  edits: number
  writes: number
  adds: number // lines added / removed, from the calls' structured diffs
  dels: number
  created: boolean // this session created the file
  last_ts: number | null
}

export type TimelineItem = { text: string; detail: string[]; in_progress: boolean }
export type CardView = { summary: string; timeline: TimelineItem[]; generated_at: number }

// Live task board from ~/.claude/tasks/<sid>/ (backend cc_data::session_tasks)
export type TaskView = { id: string; subject: string; active_form: string | null; status: string; blocked_by: string[] }
export type TasksView = { tasks: TaskView[]; updated_at: number | null }

// Indexed token usage for one session (backend cc_data::session_usage)
export type ModelUsage = { model: string; scope: string; input: number; output: number; cache_read: number; cache_creation: number }
export type SessionUsage = { rows: ModelUsage[]; total_output: number; total_tokens: number; agent_output: number }

/** Compact token count: 950, 62k, 3.5M. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 10e3 ? 0 : 1) + 'k'
  return String(n)
}

// One session's entry in the Home "what happened" digest (backend
// cc_data::recap_digest). `label` is a genuine short name or null — never the
// recap, so it can't echo `summary`. `timeline` arrives parsed.
export type RecapEntry = {
  session_id: string
  project_path: string
  label: string | null
  summary: string
  timeline: TimelineItem[]
  last_message_at: number
}

// Global usage overview (backend cc_data::usage_overview)
export type DailyActivity = { date: string; messages: number; sessions: number; tools: number; tokens: number }
export type ModelTotals = { model: string; input: number; output: number; cache_read: number; cache_creation: number; cost_usd: number }
export type TopSession = { session_id: string; label: string; project: string; output_tokens: number; total_tokens: number }
export type UsageOverview = {
  last_computed: string | null
  total_sessions: number | null
  daily: DailyActivity[]
  models: ModelTotals[]
  top_sessions: TopSession[]
}

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

// One artifact persisted to the on-disk per-session gallery (survives the
// session and the app). `file` keys read/serve/download; `seq` was its live id
// at render time, so the gallery dedups against the in-memory list.
export type SavedArtifact = { file: string; title: string; kind: string; created_ms: number; seq: number; path: string | null }

/** The label a session would wear WITHOUT a Drydock rename — i.e. what
 *  "Clear name" restores: claude custom-title > card summary > title. */
export function sessionAutoLabel(s: SessionView): string {
  if (s.title_source === 'custom-title' && s.title.trim()) return s.title
  return s.summary && s.summary.trim() ? s.summary : s.title
}

/** Display label for a session. Precedence: a Drydock rename > a claude-side
 *  user name (claude -n / /rename) > the AI card summary > the indexed title.
 *  User-set names always beat generated ones; Drydock's own rename beats
 *  claude's because it was set later and deliberately, in this app. */
export function sessionLabel(s: SessionView): string {
  if (s.name && s.name.trim()) return s.name
  return sessionAutoLabel(s)
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

// One tab in the pre-update-restart snapshot (backend updates::RestoreTab).
// Written right before the updater relaunches the app; read back (once) on the
// next boot to rebuild the workspace. claude tabs resume their session, shell
// tabs reopen at their last cwd, transcript tabs reopen read-only.
export type RestoreTab = {
  kind: 'claude' | 'shell' | 'transcript'
  session_id: string | null
  cwd: string | null
  title: string | null
  active: boolean
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

/** Per-session accent color. Prefer the SEMANTIC hue when given (backend:
 *  sessions about similar things wear similar colors); otherwise a stable
 *  FNV-1a hash of the id, so the same session reads as the same color in the
 *  sidebar and its tab either way. Pass an `alpha` below 1 for a translucent
 *  tint (e.g. a row background). */
export function sessionColor(sessionId: string, alpha = 1, hue?: number | null): string {
  let h = hue ?? null
  if (h == null) {
    let x = 0x811c9dc5
    for (let i = 0; i < sessionId.length; i++) {
      x ^= sessionId.charCodeAt(i)
      x = Math.imul(x, 0x01000193)
    }
    h = (x >>> 0) % 360
  }
  const deg = Math.round(h)
  return alpha >= 1 ? `hsl(${deg}, 60%, 62%)` : `hsla(${deg}, 60%, 62%, ${alpha})`
}
