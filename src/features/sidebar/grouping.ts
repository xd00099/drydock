/** Pure list logic for the sidebar: grouping, triage and the group cap.
 *
 *  Extracted from Sidebar.tsx for two reasons. It is the part worth testing on
 *  its own (see sidebar.test.ts), and react-refresh cannot hot-reload a module
 *  that exports both a component and plain functions — with `triage`/`capGroup`
 *  living beside the component, every sidebar edit fell back to a full reload.
 */
import type { SessionView } from '@/lib/types'

export type Group = { path: string; sessions: SessionView[]; latest: number }
export type Workspace = {
  path: string
  label: string
  projects: (Group & { label: string })[]
  count: number
  latest: number
}

export const workspaceKey = (path: string) => `workspace:${path}`
export const projectKey = (path: string) => `project:${path}`

const cleanPath = (path: string) => path.replace(/\/+$/, '') || (path.startsWith('/') ? '/' : '')
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
const homeRoot = (path: string) => path.match(/^\/(?:Users|home)\/[^/]+/)?.[0]

/** Group sibling projects under their shared parent, folding deeper projects
 *  into an existing workspace. Home and filesystem roots never swallow the
 *  other workspaces. Original project paths remain the identity/resume target. */
export function groupWorkspaces(groups: Group[], home = ''): Workspace[] {
  const normalizedHome = cleanPath(home)
  const roots = new Set(groups.filter((g) => g.path).map((g) => {
    const path = cleanPath(g.path)
    const parent = parentPath(path)
    return path === homeRoot(path) || parent === '/' ? path : parent
  }))
  const workspaces = new Map<string, Workspace>()
  for (const group of groups) {
    const path = cleanPath(group.path)
    const root = roots.has(path) ? path : [...roots]
      .filter((r) => inside(path, r) && (r !== homeRoot(path) || parentPath(path) === r || path === r))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? path
    const label = !root ? 'Other sessions'
      : normalizedHome && inside(root, normalizedHome) ? `~${root.slice(normalizedHome.length)}` : root
    const workspace = workspaces.get(root) ?? { path: root, label, projects: [], count: 0, latest: 0 }
    workspace.projects.push({ ...group, label: path === root ? 'Workspace sessions' : path.slice(root.length + 1) })
    workspace.count += group.sessions.length
    workspace.latest = Math.max(workspace.latest, group.latest)
    workspaces.set(root, workspace)
  }
  for (const workspace of workspaces.values()) {
    workspace.projects.sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path))
  }
  return [...workspaces.values()].sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path))
}

/** Explicit choices override the currently selected project's default reveal. */
export function branchOpen(choices: Record<string, boolean>, key: string, defaultOpen: boolean): boolean {
  return choices[key] ?? defaultOpen
}

export function loadTreeChoices(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('dd.sidebarTree') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === 'boolean'))
  } catch { return {} }
}

export const STARRED_KEY = '__starred__'
// Folder collapse keys share dd.closedGroups with project paths; the prefix
// can't collide because project paths start with '/'.
export const folderKey = (id: string) => `folder:${id}`

// Visible = not an auto-hidden ghost and (not user-hidden unless revealing hidden).
export function isVisible(s: SessionView, hiddenSet: Set<string>, showHidden: boolean): boolean {
  if (s.hidden) return false
  if (hiddenSet.has(s.session_id) && !showHidden) return false
  return true
}

export const byRecency = (a: SessionView, b: SessionView) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0)

// Project groups. Starred sessions and filed sessions (in an existing user
// folder) are excluded — they render in their own sections above. One rule:
// a visible session appears in exactly one place (Starred > folder > project).
export function groupSessions(sessions: SessionView[], hiddenSet: Set<string>, showHidden: boolean, folderIds: Set<string>): Group[] {
  const byPath = new Map<string, SessionView[]>()
  for (const s of sessions) {
    if (s.starred) continue
    if (s.folder_id && folderIds.has(s.folder_id)) continue
    if (!isVisible(s, hiddenSet, showHidden)) continue
    const list = byPath.get(s.project_path) ?? []
    list.push(s)
    byPath.set(s.project_path, list)
  }
  const groups: Group[] = [...byPath.entries()].map(([path, list]) => {
    list.sort(byRecency)
    return { path, sessions: list, latest: Math.max(...list.map((s) => s.last_message_at ?? 0)) }
  })
  groups.sort((a, b) => b.latest - a.latest)
  return groups
}

// Sessions that want something from the user float to the top, in exactly one
// place each — the placement rule becomes needs-you > active > Starred > folder
// > project. `needs` is the section that earns its position: a blocked session
// is the only thing in the list you cannot make progress without. `active` is
// busy + just-finished, the transient set that is worth a glance now and
// worthless in five minutes. Everything else keeps its usual home.
export function triage(visible: SessionView[]): { needs: SessionView[]; active: SessionView[]; rest: SessionView[] } {
  const needs: SessionView[] = []
  const active: SessionView[] = []
  const rest: SessionView[] = []
  for (const s of visible) {
    if (s.live_status === 'needs_input') needs.push(s)
    else if (s.live_status === 'busy' || s.live_status === 'done') active.push(s)
    else rest.push(s)
  }
  needs.sort(byRecency)
  active.sort(byRecency)
  return { needs, active, rest }
}

/** Three recent sessions per project; keep the selected session in view even
 *  when it is older than the preview. Expanding reveals the complete history. */
export function capGroup<T>(list: T[], expanded: boolean, cap = 3, selected?: T): { shown: T[]; hidden: number } {
  if (expanded || list.length <= cap) return { shown: list, hidden: 0 }
  const shown = list.slice(0, cap)
  if (selected !== undefined && list.includes(selected) && !shown.includes(selected)) shown[cap - 1] = selected
  return { shown, hidden: list.length - shown.length }
}

/** Collapsed-group / hidden-session id sets persist as a JSON string array. */
export function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]) } catch { return new Set() }
}
