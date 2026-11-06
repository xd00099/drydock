/** Style atoms shared across the briefing panel's tabs.
 *
 *  These predate the `@/components/ui` primitives and are the panel's own
 *  vocabulary (section heads, skill/MCP name+description pairs). New controls
 *  should reach for a primitive first — Button, Chip, IconButton — and only add
 *  here when the shape is genuinely panel-specific.
 */
export const S = {
  muted: { color: 'var(--dd-dim)' } as const,

  groupBtn: { display: 'flex', alignItems: 'center', gap: 4, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontWeight: 600, fontSize: 12, padding: '6px 0', textAlign: 'left' } as const,
  name: { color: 'var(--dd-text1)' } as const,
  desc: {
    color: 'var(--dd-text3)',
    lineHeight: 1.5,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  } as const,
  chip: { fontSize: 11, color: 'var(--dd-text2)', background: 'var(--dd-tint)', borderRadius: 'var(--dd-r-pill)', padding: '1px 6px' } as const,
  secHead: { color: 'var(--dd-text3)', fontWeight: 600, fontSize: 11, letterSpacing: 0.04 * 11 } as const,
  iconBtn: { background: 'none', border: 'none', borderRadius: 'var(--dd-r-sm)', cursor: 'pointer', color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '3px 6px', transition: 'background var(--dd-t) var(--dd-ease), color var(--dd-t) var(--dd-ease)' } as const,
}

/** Collapsed-group keys persist in localStorage as a JSON string array. */
export const loadStrSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[])
  } catch {
    return new Set()
  }
}
