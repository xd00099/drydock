import type { MouseEvent, ReactNode } from 'react'
import { cx } from './cx'
import s from './Tab.module.css'

type Props = {
  active?: boolean
  /** Ordinal shown as a pill badge (the ⌘1…⌘9 target). */
  ordinal?: number
  title?: string
  /** Omit to render a tab that can't be closed. */
  onClose?: () => void
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void
  /** Per-session accent, applied as a left edge so tabs inherit sidebar color. */
  accent?: string
  className?: string
  children?: ReactNode
}

export default function Tab({
  active,
  ordinal,
  title,
  onClose,
  accent,
  className,
  children,
  ...rest
}: Props) {
  return (
    <div
      className={cx(s.tab, active && s.on, className)}
      title={title}
      // A tab is a control, not a heading — keep it reachable and announced.
      role="tab"
      aria-selected={!!active}
      tabIndex={0}
      style={accent ? { boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
      {...rest}
    >
      {ordinal !== undefined && <span className={s.num}>{ordinal}</span>}
      <span className={s.label}>{children}</span>
      {onClose && (
        <button
          type="button"
          className={s.close}
          aria-label="Close tab"
          // mousedown would race the tab's own activation handler
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ✕
        </button>
      )}
    </div>
  )
}
