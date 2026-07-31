import type { ReactNode } from 'react'
import { cx } from './cx'
import s from './Chip.module.css'

export type ChipTone = 'default' | 'accent' | 'ok' | 'warn' | 'err' | 'key'

export default function Chip({
  tone = 'default',
  title,
  className,
  children,
}: {
  tone?: ChipTone
  title?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <span className={cx(s.chip, tone !== 'default' && s[tone], className)} title={title}>
      {children}
    </span>
  )
}
