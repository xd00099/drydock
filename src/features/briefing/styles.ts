/** Style atoms shared across the briefing panel's tabs.
 *
 *  These predate the `@/components/ui` primitives and are the panel's own
 *  vocabulary (section heads, skill/MCP name+description pairs). New controls
 *  should reach for a primitive first — Button, Chip, IconButton — and only add
 *  here when the shape is genuinely panel-specific.
 */
export const S = {
  muted: { color: 'var(--dd-dim)' } as const,

  // Panel tab. The active tab was marked by a 2px accent underline against a
  // --dd-border rule on its siblings — a classic tab-widget idiom. It now reads
  // as a soft filled pill, so the strip is a segmented control with no rules.
  tabBtn: (active: boolean) =>
    ({
      flex: 1,
      // flex items default to min-width:auto — without minWidth: 0 the labels
      // set a floor and the strip overflows/clips at narrow panel widths
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      background: active ? 'var(--dd-tint-active)' : 'transparent',
      border: 'none',
      borderRadius: 'var(--dd-r-md)',
      color: active ? 'var(--dd-text)' : 'var(--dd-text3)',
      fontWeight: active ? 550 : 400,
      cursor: 'pointer',
      fontSize: 11,
      padding: '6px 4px',
      fontFamily: 'system-ui',
      transition: 'background var(--dd-t) var(--dd-ease), color var(--dd-t) var(--dd-ease)',
    }) as const,

  groupBtn: { display: 'flex', alignItems: 'center', gap: 4, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dd-text3)', fontWeight: 600, fontSize: 11, padding: '3px 0', textAlign: 'left' } as const,
  name: { color: 'var(--dd-text1)' } as const,
  desc: {
    color: 'var(--dd-text3)',
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  } as const,
  chip: { fontSize: 9, color: 'var(--dd-text2)', background: 'var(--dd-tint)', borderRadius: 'var(--dd-r-pill)', padding: '1px 6px' } as const,
  secHead: { color: 'var(--dd-text3)', fontWeight: 700, fontSize: 10, letterSpacing: 0.8 } as const,
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
