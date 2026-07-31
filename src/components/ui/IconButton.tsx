import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import s from './IconButton.module.css'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
  /** Pressed/toggled state (panel open, star set). */
  on?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Required: these render a glyph, so the name has to come from somewhere. */
  label: string
  className?: string
  children: ReactNode
}

export default function IconButton({ on, size = 'md', label, className, children, ...rest }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={on}
      className={cx(s.icon, on && s.on, size !== 'md' && s[size], className)}
      {...rest}
    >
      {children}
    </button>
  )
}
