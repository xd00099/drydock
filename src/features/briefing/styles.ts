/** Style atoms shared across the briefing panel's tabs, lifted verbatim from
 *  the monolith this package replaces. */
export const S = {
  muted: { color: 'var(--dd-dim)' } as const,
  tabBtn: (active: boolean) =>
    ({
      flex: 1,
      // flex items default to min-width:auto — without minWidth: 0 the labels
      // set a floor and the strip overflows/clips at narrow panel widths
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      background: active ? 'var(--dd-surface2)' : 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid var(--dd-accent-muted)' : '2px solid var(--dd-border)',
      color: active ? 'var(--dd-text)' : 'var(--dd-text3)',
      cursor: 'pointer',
      fontSize: 11,
      padding: '5px 2px',
      fontFamily: 'system-ui',
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
  chip: { fontSize: 9, color: 'var(--dd-text2)', background: 'var(--dd-row)', border: '1px solid var(--dd-border2)', borderRadius: 4, padding: '0 5px' } as const,
  secHead: { color: 'var(--dd-text3)', fontWeight: 700, fontSize: 10, letterSpacing: 0.8 } as const,
  iconBtn: { background: 'none', border: '1px solid var(--dd-border2)', borderRadius: 4, cursor: 'pointer', color: 'var(--dd-text2)', fontSize: 12, lineHeight: 1, padding: '2px 6px' } as const,
}

export const loadStrSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[])
  } catch {
    return new Set()
  }
}
