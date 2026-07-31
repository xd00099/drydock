import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import s from './Button.module.css'

export type ButtonVariant = 'default' | 'ghost' | 'primary' | 'danger'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: ButtonVariant
  /** 11px/tighter padding — for dense rows and panel headers. */
  small?: boolean
  /** Fill the container width and center the label. */
  block?: boolean
  className?: string
  children?: ReactNode
}

/** The app's only button. Anything that needs a different shape is a different
 *  primitive (IconButton, Tab) rather than a one-off inline style. */
export default function Button({ variant = 'default', small, block, className, ...rest }: Props) {
  return (
    <button
      type="button"
      className={cx(
        s.btn,
        variant !== 'default' && s[variant],
        small && s.sm,
        block && s.block,
        className
      )}
      {...rest}
    />
  )
}
