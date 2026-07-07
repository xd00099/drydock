// Split-screen layout: a binary tree of row/col splits whose leaves are tab
// ids. The whole feature hangs off one invariant — `Stage` is the single
// source of truth for "what's on stage and who has focus":
//
//   layout === null  → classic single-pane mode: `active` (may be null = Home)
//                      is the only tab shown, exactly the pre-split app.
//   layout !== null  → the tree has ≥2 leaves, every leaf is an open tab, and
//                      `active` is one of the leaves (the focused pane).
//
// All transitions are pure functions on Stage so multi-step flows (close a
// tab, then open another in the same handler) compose through functional
// setState without ever seeing a stale half. Rects are computed fresh from
// the tree + content box on every render; panes are never re-parented in the
// DOM (App keeps every tab mounted in one flat layer), so terminals survive
// any re-layout untouched.

export type SplitDir = 'row' | 'col' // row: a│b side by side; col: a over b
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type SplitNode = { dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode }
export type LayoutNode = number | SplitNode // number = leaf tab id
export type Stage = { layout: LayoutNode | null; active: number | null }

export type Rect = { x: number; y: number; w: number; h: number }
export type PaneRect = { tabId: number; rect: Rect }
// `box` is the split node's own box — ratio-drag math needs it, not just the
// gutter's rect.
export type DividerRect = { path: string; dir: SplitDir; rect: Rect; box: Rect }

export type DropTarget =
  | { kind: 'empty' } // nothing on stage (Home): drop = plain select
  | { kind: 'pane'; tabId: number; zone: 'center' | Edge }
  | { kind: 'root'; edge: Edge } // full-length split of the whole stage

export const GUTTER = 6 // gap between sibling panes; the divider lives in it
export const MIN_W = 220 // a pane below this is unusable — gates drops & dividers
export const MIN_H = 140
const EDGE_BAND = 20 // outer strip of the stage that means "split the root"
const ZONE = 0.28 // fraction of a pane that counts as an edge drop zone

const isLeaf = (n: LayoutNode): n is number => typeof n === 'number'

export function leaves(n: LayoutNode): number[] {
  return isLeaf(n) ? [n] : [...leaves(n.a), ...leaves(n.b)]
}

export function firstLeaf(n: LayoutNode): number {
  return isLeaf(n) ? n : firstLeaf(n.a)
}

/** Tab ids currently visible, in tree order (single-pane mode included). */
export function stagedIds(st: Stage): number[] {
  return st.layout !== null ? leaves(st.layout) : st.active !== null ? [st.active] : []
}

function makeSplit(existing: LayoutNode, edge: Edge, newId: number): SplitNode {
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const newFirst = edge === 'left' || edge === 'top'
  return { dir, ratio: 0.5, a: newFirst ? newId : existing, b: newFirst ? existing : newId }
}

export function replaceLeaf(n: LayoutNode, from: number, to: number): LayoutNode {
  if (isLeaf(n)) return n === from ? to : n
  const a = replaceLeaf(n.a, from, to)
  const b = replaceLeaf(n.b, from, to)
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

export function swapLeaves(n: LayoutNode, x: number, y: number): LayoutNode {
  if (isLeaf(n)) return n === x ? y : n === y ? x : n
  const a = swapLeaves(n.a, x, y)
  const b = swapLeaves(n.b, x, y)
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

/** Remove a leaf; its parent split collapses into the sibling. null = the
 *  whole tree was that leaf. */
export function removeLeaf(n: LayoutNode, tabId: number): LayoutNode | null {
  if (isLeaf(n)) return n === tabId ? null : n
  const a = removeLeaf(n.a, tabId)
  const b = removeLeaf(n.b, tabId)
  if (a === null) return b
  if (b === null) return a
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

/** The pane that absorbs a removed leaf's space (first leaf of its sibling)
 *  — where focus should land when the focused pane closes. */
export function siblingLeaf(n: LayoutNode, tabId: number): number | null {
  if (isLeaf(n)) return null
  if (n.a === tabId) return firstLeaf(n.b)
  if (n.b === tabId) return firstLeaf(n.a)
  return siblingLeaf(n.a, tabId) ?? siblingLeaf(n.b, tabId)
}

export function splitLeaf(n: LayoutNode, target: number, edge: Edge, newId: number): LayoutNode {
  if (isLeaf(n)) return n === target ? makeSplit(n, edge, newId) : n
  const a = splitLeaf(n.a, target, edge, newId)
  const b = splitLeaf(n.b, target, edge, newId)
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

/** Set a split node's ratio by its path ('a'/'b' steps from the root). */
export function setRatio(n: LayoutNode, path: string, ratio: number): LayoutNode {
  if (isLeaf(n)) return n
  if (path === '') return { ...n, ratio }
  return path[0] === 'a'
    ? { ...n, a: setRatio(n.a, path.slice(1), ratio) }
    : { ...n, b: setRatio(n.b, path.slice(1), ratio) }
}

/** Clamp a ratio so both sides of a split stay ≥ the axis minimum. When the
 *  box can't honor both (window shrank), fall back to an even split. */
export function clampRatio(ratio: number, avail: number, dir: SplitDir): number {
  const min = dir === 'row' ? MIN_W : MIN_H
  const lo = min / avail
  if (lo > 1 - lo) return 0.5
  return Math.min(1 - lo, Math.max(lo, ratio))
}

// ---- Stage transitions ----

function normalize(n: LayoutNode, active: number): Stage {
  return isLeaf(n) ? { layout: null, active: n } : { layout: n, active }
}

/** Show a tab: focus its pane if staged; otherwise it takes over the focused
 *  pane (panes are viewports — the deck stays in the tab bar). */
export function showTab(st: Stage, id: number): Stage {
  if (st.layout === null) return { layout: null, active: id }
  const staged = leaves(st.layout)
  if (staged.includes(id)) return { ...st, active: id }
  const anchor = st.active !== null && staged.includes(st.active) ? st.active : staged[0]
  return { layout: replaceLeaf(st.layout, anchor, id), active: id }
}

/** Close a tab that may be on stage. wasStaged=false → caller decides (the
 *  single-pane lane-landing rules live in App, not here). */
export function closeStaged(st: Stage, id: number): { stage: Stage; wasStaged: boolean } {
  if (st.layout === null || !leaves(st.layout).includes(id)) return { stage: st, wasStaged: false }
  const focusNext = st.active === id ? siblingLeaf(st.layout, id) : st.active
  const rest = removeLeaf(st.layout, id)
  if (rest === null) return { stage: { layout: null, active: null }, wasStaged: true } // unreachable: ≥2 leaves
  return { stage: isLeaf(rest) ? { layout: null, active: rest } : { layout: rest, active: focusNext }, wasStaged: true }
}

/** Execute a drop. Center on a pane: a staged tab swaps places with the
 *  target (rearranging the grid); an unstaged tab replaces the target's tab,
 *  which returns to the deck. Edges split; the dropped tab takes focus. */
export function dropOnStage(st: Stage, id: number, t: DropTarget): Stage {
  if (t.kind === 'empty') return { layout: null, active: id }
  const base: LayoutNode | null = st.layout ?? st.active
  if (base === null) return { layout: null, active: id }
  const staged = leaves(base)
  if (t.kind === 'pane') {
    if (t.tabId === id || !staged.includes(t.tabId)) return st
    if (t.zone === 'center') {
      const next = staged.includes(id) ? swapLeaves(base, id, t.tabId) : replaceLeaf(base, t.tabId, id)
      return normalize(next, id)
    }
    let b: LayoutNode = base
    if (staged.includes(id)) {
      const r = removeLeaf(b, id)
      if (r === null) return { layout: null, active: id }
      b = r
    }
    return normalize(splitLeaf(b, t.tabId, t.zone, id), id)
  }
  // root edge: split the whole stage
  let b: LayoutNode = base
  if (staged.includes(id)) {
    const r = removeLeaf(b, id)
    if (r === null) return { layout: null, active: id }
    b = r
  }
  return normalize(makeSplit(b, t.edge, id), id)
}

/** Drop tabs whose ids no longer exist (e.g. a staged preview tab replaced by
 *  the next preview). Safety net run whenever the tabs array changes. */
export function pruneStage(st: Stage, live: Set<number>): Stage {
  if (st.layout === null) {
    return st.active !== null && !live.has(st.active) ? { layout: null, active: null } : st
  }
  let l: LayoutNode | null = st.layout
  let active = st.active
  for (const leaf of leaves(st.layout)) {
    if (live.has(leaf) || l === null) continue
    if (active === leaf) active = siblingLeaf(l, leaf)
    l = removeLeaf(l, leaf)
  }
  if (l === st.layout) return st
  if (l === null) return { layout: null, active: null }
  if (isLeaf(l)) return { layout: null, active: l }
  return { layout: l, active: active !== null && leaves(l).includes(active) ? active : firstLeaf(l) }
}

// ---- Geometry ----

/** Pane + divider rects for the tree inside `box`. Panes are positioned by
 *  rect (never re-parented), so this is the only place layout math lives. */
export function layoutRects(root: LayoutNode, box: Rect): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = []
  const dividers: DividerRect[] = []
  const walk = (n: LayoutNode, b: Rect, path: string) => {
    if (isLeaf(n)) {
      panes.push({ tabId: n, rect: b })
      return
    }
    if (n.dir === 'row') {
      const avail = b.w - GUTTER
      const aw = avail * n.ratio
      walk(n.a, { ...b, w: aw }, path + 'a')
      dividers.push({ path, dir: 'row', rect: { x: b.x + aw, y: b.y, w: GUTTER, h: b.h }, box: b })
      walk(n.b, { x: b.x + aw + GUTTER, y: b.y, w: avail - aw, h: b.h }, path + 'b')
    } else {
      const avail = b.h - GUTTER
      const ah = avail * n.ratio
      walk(n.a, { ...b, h: ah }, path + 'a')
      dividers.push({ path, dir: 'col', rect: { x: b.x, y: b.y + ah, w: b.w, h: GUTTER }, box: b })
      walk(n.b, { x: b.x, y: b.y + ah + GUTTER, w: b.w, h: avail - ah }, path + 'b')
    }
  }
  walk(root, box, '')
  return { panes, dividers }
}

/** Would both halves of splitting `r` along `edge` be usable? */
export function canSplit(r: Rect, edge: Edge): boolean {
  return edge === 'left' || edge === 'right' ? (r.w - GUTTER) / 2 >= MIN_W : (r.h - GUTTER) / 2 >= MIN_H
}

function halfRect(r: Rect, edge: Edge): Rect {
  const w = (r.w - GUTTER) / 2
  const h = (r.h - GUTTER) / 2
  if (edge === 'left') return { ...r, w }
  if (edge === 'right') return { x: r.x + r.w - w, y: r.y, w, h: r.h }
  if (edge === 'top') return { ...r, h }
  return { x: r.x, y: r.y + r.h - h, w: r.w, h }
}

const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/** Where would dropping `draggedId` at (x, y) land? Coordinates are relative
 *  to the stage box. null = no valid target here (e.g. the tab's own pane —
 *  splitting a pane with itself means nothing). `hint` is the translucent
 *  frame previewing the resulting pane. */
export function hitTest(
  box: Rect,
  panes: PaneRect[],
  x: number,
  y: number,
  draggedId: number
): { target: DropTarget; hint: Rect } | null {
  if (!contains(box, x, y)) return null
  if (panes.length === 0) return { target: { kind: 'empty' }, hint: box }
  if (panes.length === 1 && panes[0].tabId === draggedId) return null
  const bands: [Edge, boolean][] = [
    ['left', x - box.x <= EDGE_BAND],
    ['right', box.x + box.w - x <= EDGE_BAND],
    ['top', y - box.y <= EDGE_BAND],
    ['bottom', box.y + box.h - y <= EDGE_BAND],
  ]
  for (const [edge, hit] of bands) {
    if (hit && canSplit(box, edge)) return { target: { kind: 'root', edge }, hint: halfRect(box, edge) }
  }
  const pane = panes.find((p) => contains(p.rect, x, y))
  if (!pane || pane.tabId === draggedId) return null
  const r = pane.rect
  const d: [Edge, number][] = [
    ['left', (x - r.x) / r.w],
    ['right', (r.x + r.w - x) / r.w],
    ['top', (y - r.y) / r.h],
    ['bottom', (r.y + r.h - y) / r.h],
  ]
  d.sort((p, q) => p[1] - q[1])
  const zone: 'center' | Edge = d[0][1] < ZONE && canSplit(r, d[0][0]) ? d[0][0] : 'center'
  return {
    target: { kind: 'pane', tabId: pane.tabId, zone },
    hint: zone === 'center' ? r : halfRect(r, zone),
  }
}

/** Nearest pane in a direction from the focused one (⌘⌥ arrows). Prefers the
 *  candidate with the most perpendicular overlap, then the smallest gap. */
export function focusNeighbor(panes: PaneRect[], fromId: number | null, edge: Edge): number | null {
  const from = panes.find((p) => p.tabId === fromId)?.rect
  if (!from) return null
  const horiz = edge === 'left' || edge === 'right'
  const cf = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  let best: { id: number; overlap: number; gap: number } | null = null
  for (const p of panes) {
    if (p.tabId === fromId) continue
    const c = { x: p.rect.x + p.rect.w / 2, y: p.rect.y + p.rect.h / 2 }
    const ahead =
      edge === 'left' ? c.x < cf.x - 1 : edge === 'right' ? c.x > cf.x + 1 : edge === 'top' ? c.y < cf.y - 1 : c.y > cf.y + 1
    if (!ahead) continue
    const overlap = horiz
      ? Math.min(from.y + from.h, p.rect.y + p.rect.h) - Math.max(from.y, p.rect.y)
      : Math.min(from.x + from.w, p.rect.x + p.rect.w) - Math.max(from.x, p.rect.x)
    const gap = horiz ? Math.abs(c.x - cf.x) : Math.abs(c.y - cf.y)
    if (
      best === null ||
      (overlap > 0 && best.overlap <= 0) ||
      (overlap > 0 === best.overlap > 0 && gap < best.gap)
    ) {
      best = { id: p.tabId, overlap, gap }
    }
  }
  return best?.id ?? null
}
