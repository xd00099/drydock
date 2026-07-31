import type { ReactNode } from 'react'
import s from './Modal.module.css'

/** Stacking order for every modal in the app, in one place.
 *
 *  These were scattered as bare `zIndex:` numbers with the ordering rationale
 *  living in three separate comments. The invariant: a quit request raised
 *  during a takeover must sit on top, which is also the order the keydown
 *  handler resolves them in.
 */
export const MODAL_Z = {
  takeover: 100,
  confirmClose: 105,
  quitGuard: 110,
} as const

type Props = {
  z: number
  /** Pull DOM focus to the backdrop on mount. Needed whenever the dialog is
   *  confirmed with ⏎ over a live terminal — otherwise xterm also receives the
   *  Enter and types it into the very session being acted on. */
  grabFocus?: boolean
  width?: number
  children: ReactNode
}

/** Backdrop + centered card shared by every modal.
 *
 *  `transform: translateZ(0)` is not decoration: over a terminal's WebGL canvas,
 *  WebKit will paint an un-composited overlay on top while still routing clicks
 *  to the canvas — visible but not clickable. Its own compositing layer fixes it.
 */
export default function Modal({ z, grabFocus, width = 400, children }: Props) {
  return (
    <div
      className={s.backdrop}
      style={{ zIndex: z }}
      tabIndex={grabFocus ? -1 : undefined}
      ref={
        grabFocus
          ? (el) => {
              if (el && !el.dataset.focused) {
                el.dataset.focused = '1'
                el.focus()
              }
            }
          : undefined
      }
    >
      <div className={s.card} style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  )
}

export function ModalTitle({ children }: { children: ReactNode }) {
  return <div className={s.title}>{children}</div>
}

export function ModalBody({ children }: { children: ReactNode }) {
  return <div className={s.body}>{children}</div>
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>
}
