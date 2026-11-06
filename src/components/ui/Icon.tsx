import type { SVGProps } from 'react'

const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
  close: 'M6 6l12 12M18 6 6 18',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  review: 'm9 12 2 2 4-4M5 3h14v18H5z',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  terminal: 'm5 6 6 6-6 6M13 18h6',
} as const

/** A single stroke and grid for UI icons; agent brand marks remain separate. */
export default function Icon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>
}
