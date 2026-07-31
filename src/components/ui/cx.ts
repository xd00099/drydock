/** Join class names, dropping anything falsy.
 *
 *  `cx(s.btn, active && s.on, className)` — the whole reason this exists is so
 *  conditional CSS-module classes read as one expression instead of a chain of
 *  template literals. Deliberately not a dependency: 3 lines beats clsx here.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
