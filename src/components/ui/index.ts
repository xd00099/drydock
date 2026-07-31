/** Shared UI primitives.
 *
 *  Import from `@/components/ui` rather than reaching into a file:
 *      import { Button, Chip } from '@/components/ui'
 *
 *  These own the app's visual language — radius, tint, elevation, motion — so a
 *  feature never re-derives a control's look inline. If a feature needs a shape
 *  that isn't here, add a primitive rather than a one-off style object.
 */
export { default as Button } from './Button'
export type { ButtonVariant } from './Button'
export { default as Chip } from './Chip'
export type { ChipTone } from './Chip'
export { default as IconButton } from './IconButton'
export { default as ResizeHandle } from './ResizeHandle'
export { cx } from './cx'
