/** Pure list logic for the sidebar: grouping, triage and the group cap.
 *
 *  Extracted from Sidebar.tsx for two reasons. It is the part worth testing on
 *  its own (see sidebar.test.ts), and react-refresh cannot hot-reload a module
 *  that exports both a component and plain functions — with `triage`/`capGroup`
 *  living beside the component, every sidebar edit fell back to a full reload.
 */
import type { SessionView } from '@/lib/types'

export type Group = { path: string; sessions: SessionView[]; latest: number }

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

/** A project group shows its five most recent sessions and puts the tail behind
 *  a disclosure: past about five, a list stops being something you scan and
 *  becomes something you search (⌘K already does that better than scrolling
 *  ever will). A group of exactly six stays whole — hiding one row behind a
 *  control that costs a row is worse than showing it. */
export function capGroup<T>(list: T[], expanded: boolean, cap = 5): { shown: T[]; hidden: number } {
  if (expanded || list.length <= cap + 1) return { shown: list, hidden: 0 }
  return { shown: list.slice(0, cap), hidden: list.length - cap }
}

/** Collapsed-group / hidden-session id sets persist as a JSON string array. */
export function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]) } catch { return new Set() }
}
