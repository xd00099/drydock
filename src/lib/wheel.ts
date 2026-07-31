// Wheel-gesture → terminal-rows math, split out from TerminalPane so it can be
// tested without a DOM or a live terminal.
//
// Why this exists at all: in the ALTERNATE screen (Claude Code's fullscreen
// TUI) there is no scrollback for the browser to scroll, so a wheel gesture has
// to be handed to the program as input. xterm does that, but it sends exactly
// ONE wheel report per wheel event however far the gesture asked to go — and one
// WKWebView mouse notch is ~120px, which at a ~17px row is about seven rows of
// intent arriving as a single "scroll one step". That is the whole reason
// scrolling a fullscreen session felt slow.

/// Rows one wheel event may move. A cap only matters for a hard fling; it keeps
/// a single event from firing a burst the program then has to repaint through.
export const MAX_WHEEL_ROWS = 8

/// Rows a pixel-delta gesture asks for, plus the sub-row remainder to carry into
/// the next event.
///
/// The carry is what makes a trackpad feel right: its deltas are a few pixels at
/// a time, so truncating each one independently would floor every event to zero
/// and the view would never move. Accumulating means small deltas add up to a
/// row and large ones stay proportional.
///
/// `cellHeight` is measured from the live layout by the caller rather than taken
/// from xterm, whose cached row height is derived as (device cell height ÷
/// devicePixelRatio) and can be stale on the frame after the window moves to a
/// display with a different scale factor.
export function wheelRows(
  deltaY: number,
  cellHeight: number,
  carry: number,
  max: number = MAX_WHEEL_ROWS,
): { rows: number; carry: number } {
  // A zero/NaN cell height means we were asked before layout settled; drop the
  // carry rather than divide by it and send a garbage burst.
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) return { rows: 0, carry: 0 }
  const want = carry + deltaY / cellHeight
  // toward zero, so a reversal doesn't round the previous direction's remainder
  // into a row of travel the user didn't ask for
  const whole = Math.trunc(want)
  const rows = Math.max(-max, Math.min(max, whole))
  return { rows, carry: want - whole }
}
