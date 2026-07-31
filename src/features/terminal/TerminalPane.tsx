import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { PaneSearch } from '@/lib/types'
import { getSearchDecorations, getXtermTheme, THEME_EVENT } from '@/lib/theme'
import { wheelRows } from '@/lib/wheel'
import '@xterm/xterm/css/xterm.css'

/** xterm's internal mouse encoder — see the wheel handler for why we reach for it. */
type CoreMouseService = {
  triggerMouseEvent(e: {
    col: number; row: number; x: number; y: number
    button: number; action: number
    ctrl: boolean; alt: boolean; shift: boolean
  }): boolean
}

/** 1-based cell index for a pixel offset along one axis of the grid. */
function cellIndex(offset: number, size: number, cells: number): number {
  if (!(size > 0)) return 1
  return Math.max(1, Math.min(cells, Math.floor((offset / size) * cells) + 1))
}

type Props = {
  id: number
  program: string | null
  args: string[]
  cwd: string | null
  sessionId?: string // the claude session id pinned at launch (hooks/artifacts key)
  visible: boolean
  // Split screen shows several terminals at once; only the focused pane's may
  // hold the keyboard. Unfocused-but-visible terminals blur (hollow cursor).
  focused: boolean
  onExit: () => void
  onInteract?: () => void // any user input into the terminal
  onMatches?: (index: number, count: number) => void // ⌘F results (index<0 = count-only)
}

// ⌘F match highlighting, mirroring the transcript's marks: all matches get the
// muted slate wash, the active one bright yellow (the renderer's
// minimumContrastRatio auto-darkens text that would be unreadable on it). The
// *OverviewRuler colors are required by the addon's types but inert — we don't
// enable an overview ruler. Resolved per call: xterm parses these itself, so
// CSS variables won't do — theme.ts hands back concrete hexes per theme.

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// FALLBACK "i of n" counter, used only when the addon's decorations are
// unavailable (they normally report the index natively via onDidChangeResults;
// see find()). We walk the buffer ourselves: count every match and locate the
// one the addon just selected. Everything is string-based and cell-width-aware,
// so CJK (the user types Chinese) and wrapped rows are handled correctly.
type TermMatchInfo = { count: number; index: number } // index: 0-based active match, -1 if none/unknown
function termMatchInfo(term: Terminal, q: string): TermMatchInfo {
  if (!q) return { count: 0, index: -1 }
  const needle = q.toLowerCase()
  const buf = term.buffer.active
  // The addon leaves the active match selected. getSelectionPosition returns
  // 0-BASED absolute-buffer coords (same space as getLine) — the d.ts comment
  // claims 1-based, but the runtime hands back the selection model's raw
  // [col,row], and the search addon itself feeds end.x straight back in as a
  // 0-based column. Map the start cell to an offset within the logical line so
  // we can match it to a found index.
  const sel = term.getSelectionPosition()
  const selRow = sel ? sel.start.y : -1
  const selCol = sel ? sel.start.x : -1

  let count = 0
  let index = -1
  let logical = ''
  let rows: { row: number; off: number }[] = [] // each physical row's start offset within `logical`

  const flush = () => {
    if (logical) {
      // Offset of the selected match within this logical line, if it lives here.
      let selOff = -1
      const rs = selRow >= 0 ? rows.find((r) => r.row === selRow) : undefined
      if (rs) {
        const line = buf.getLine(selRow)
        let prefix = 0 // chars before selCol (a wide cell counts once; its width-0 tail is skipped)
        if (line) for (let x = 0; x < selCol; x++) {
          const cell = line.getCell(x)
          if (cell && cell.getWidth() > 0) prefix++
        }
        selOff = rs.off + prefix
      }
      const hay = logical.toLowerCase()
      let from = 0
      for (;;) {
        const idx = hay.indexOf(needle, from)
        if (idx < 0) break
        if (idx === selOff) index = count // the match the addon selected
        count++
        from = idx + needle.length
      }
    }
    logical = ''
    rows = []
  }

  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    // Build each row exactly like the search addon's own stitching: trim trailing
    // blanks ONLY on the last row of a logical line (a wrapped continuation keeps
    // its full width), and drop the lone padding cell left when a wide char
    // wraps to the next row. Matching the addon byte-for-byte keeps our count and
    // index in sync with the match it actually selected (e.g. queries with spaces).
    const next = i + 1 < buf.length ? buf.getLine(i + 1) : undefined
    const continues = !!next && next.isWrapped
    let s = line.translateToString(!continues)
    if (continues && next) {
      const last = line.getCell(line.length - 1)
      if (last && last.getCode() === 0 && last.getWidth() === 1 && next.getCell(0)?.getWidth() === 2) {
        s = s.slice(0, -1)
      }
    }
    if (i > 0 && line.isWrapped) {
      rows.push({ row: i, off: logical.length })
      logical += s
    } else {
      flush()
      rows.push({ row: i, off: 0 })
      logical = s
    }
  }
  flush()
  return { count, index }
}

const TerminalPane = forwardRef<PaneSearch, Props>(function TerminalPane(
  { id, program, args, cwd, sessionId, visible, focused, onExit, onInteract, onMatches },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // latest onDidChangeResults payload (fires synchronously inside find calls
  // when decorations are on) — the native "i of n" source
  const resultsRef = useRef<{ index: number; count: number } | null>(null)
  // decorations threw once (the addon's highlight-all path has wide/CJK column
  // edge cases) — stay in plain selection-only mode from then on
  const decorationsBrokenRef = useRef(false)
  const readyRef = useRef(false)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onInteractRef = useRef(onInteract)
  onInteractRef.current = onInteract
  const onMatchesRef = useRef(onMatches)
  onMatchesRef.current = onMatches

  useImperativeHandle(ref, (): PaneSearch => ({
    find(query, { dir, incremental }) {
      const search = searchRef.current
      const term = termRef.current
      if (!search || !term) return
      const attempt = (withDecorations: boolean): boolean => {
        // Decorations highlight every match (yellow = active) and make the
        // addon report the exact "i of n" via onDidChangeResults.
        const opts: ISearchOptions = {
          caseSensitive: false,
          ...(withDecorations ? { decorations: getSearchDecorations() } : null),
        }
        return dir === 'prev'
          ? search.findPrevious(query, opts)
          : search.findNext(query, { ...opts, incremental: !!incremental })
      }
      try {
        if (!query) { search.clearDecorations(); onMatchesRef.current?.(-1, 0); return }
        resultsRef.current = null
        let found: boolean
        try {
          found = attempt(!decorationsBrokenRef.current)
        } catch (e) {
          if (decorationsBrokenRef.current) throw e
          // The highlight-all path can throw on wide/CJK column mapping edge
          // cases ("Invalid col"). Degrade to selection-only for this terminal
          // rather than losing search entirely.
          decorationsBrokenRef.current = true
          console.error('search decorations failed — falling back to selection-only:', e)
          search.clearDecorations()
          found = attempt(false)
        }
        // read through a function boundary: TS's flow analysis can't see that
        // attempt() repopulates the ref via the onDidChangeResults subscription,
        // and would otherwise narrow the ref (nulled above) to `never` here
        const native = ((): { index: number; count: number } | null => resultsRef.current)()
        if (native) {
          // native index/count (index is -1 when past the highlight limit)
          onMatchesRef.current?.(found ? native.index : -1, native.count)
        } else {
          // selection-only mode: derive the counter from the buffer ourselves
          const info = termMatchInfo(term, query)
          onMatchesRef.current?.(found ? info.index : -1, info.count)
        }
      } catch (e) {
        console.error('terminal find failed:', e)
        onMatchesRef.current?.(-1, 0)
      }
    },
    clear() {
      searchRef.current?.clearDecorations() // also clears the selection
    },
    focus() {
      termRef.current?.focus()
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000, // keep more history searchable (⌘F) in shell tabs
      // Auto-boost only ILLEGIBLE pairs (Claude's TUI draws its status bar and
      // hints in dim/grey text that vanishes on our dark background); legible
      // colors pass through untouched. Dim cells need only half this ratio, so
      // "faint" still reads as faint — just visibly.
      minimumContrastRatio: 4.5,
      // Full Drydock palette, not just the background: xterm's default is the
      // saturated Tango set with pure-white text and a 30%-alpha white selection
      // — which reads as a foreign app embedded in ours, and makes the ⌘F match
      // a faint wash. Opaque selection keeps the found text obvious. The palette
      // lives in theme.ts (xterm's canvas can't read the CSS tokens).
      theme: getXtermTheme(),
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // Fires synchronously inside findNext/findPrevious when decorations are on;
    // find() reads the ref right after the call returns.
    const resultsSub = search.onDidChangeResults((e) => {
      resultsRef.current = { index: e.resultIndex, count: e.resultCount }
    })
    term.open(host)
    // Scrolling the ALTERNATE screen (Claude Code's fullscreen TUI). There is no
    // scrollback there, so a wheel gesture is input for the program, and xterm's
    // own handling of that is too coarse in BOTH of the shapes we meet:
    //
    // - Program IS tracking the mouse (claude sets DECSET 1000 + SGR 1006, as do
    //   vim mouse=a and htop): xterm sends exactly ONE wheel report per wheel
    //   event, no matter how far the gesture asked to travel. A WKWebView notch
    //   is ~120px ≈ 7 rows, so seven rows of intent arrive as one "scroll a
    //   step" — the reason a fullscreen session scrolled so slowly. Send one
    //   report per row instead, which is what a terminal is supposed to do.
    // - Program is NOT tracking the mouse: xterm converts wheel to arrow keys at
    //   deltaY / cell-height, so one notch becomes 5-25 keys and the view leaps.
    //   Keep that path deliberately gentle (≤3).
    //
    // Shift/ctrl gestures and non-pixel deltas fall through untouched — those are
    // horizontal-scroll and zoom conventions, not ours to reinterpret.
    let wheelCarry = 0
    term.attachCustomWheelEventHandler((ev) => {
      if (
        term.buffer.active.type !== 'alternate' ||
        ev.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        ev.deltaY === 0 ||
        ev.shiftKey ||
        ev.ctrlKey
      ) return true
      // Measured live, not read from xterm: its cached row height comes from
      // (device cell height ÷ dpr) and is stale for a frame after the window
      // moves to a display with a different scale factor — which is exactly
      // when scrolling felt worst.
      const cellHeight = host.clientHeight / term.rows
      const { rows, carry } = wheelRows(ev.deltaY, cellHeight, wheelCarry)
      wheelCarry = carry
      ev.preventDefault()
      if (rows === 0) return false // sub-row gesture: banked in the carry
      const n = Math.abs(rows)
      const down = rows > 0

      if (term.modes.mouseTrackingMode !== 'none') {
        // Encoding (legacy vs SGR) depends on modes the public API doesn't
        // expose, so let xterm's own mouse service encode each report.
        // Internal, hence two escape hatches: an xterm that renamed it hands the
        // event back to xterm, and a service that DECLINES every report (mouse
        // reporting flagged on but not actually active) falls through to the
        // arrow-key path below. Either way the scroll is never swallowed.
        const mouse = (term as unknown as { _core?: { coreMouseService?: CoreMouseService } })._core?.coreMouseService
        if (typeof mouse?.triggerMouseEvent !== 'function') return true
        const box = host.getBoundingClientRect()
        const col = cellIndex(ev.clientX - box.left, box.width, term.cols)
        const row = cellIndex(ev.clientY - box.top, box.height, term.rows)
        let sent = 0
        for (let i = 0; i < n; i++) {
          if (mouse.triggerMouseEvent({
            col, row, x: col, y: row,
            button: 4, // WHEEL
            action: down ? 1 : 0, // DOWN / UP
            ctrl: false, alt: ev.altKey, shift: false,
          })) sent++
        }
        if (sent > 0) return false
      }
      const seq = '\x1b' + (term.modes.applicationCursorKeysMode ? 'O' : '[') + (down ? 'B' : 'A')
      term.input(seq.repeat(Math.min(n, 3)), true)
      return false
    })
    // Self-healing scroll: xterm 5.x's viewport can desync from the buffer —
    // the DOM scrollbar reads "bottom" while the view is stuck rows above it
    // (streaming output racing syncScrollArea, and trims once the 10k scrollback
    // is full, both shift the mapping mid-scroll). Typing "fixed" it only via
    // scroll-on-input. Enforce the broken invariant directly: whenever the DOM
    // scrollbar is at its bottom but the buffer viewport isn't, snap to bottom.
    // Never fires while scrolled up (scrollTop below max), so reading history
    // stays undisturbed; at true bottom viewportY === baseY and it's a no-op.
    const viewport = host.querySelector<HTMLElement>('.xterm-viewport')
    const healScroll = () => {
      if (!viewport) return
      // within half a row of the end counts as bottom (fractional scrollTop)
      const barAtBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 8
      const buf = term.buffer.active
      if (barAtBottom && buf.viewportY < buf.baseY) term.scrollToBottom()
    }
    viewport?.addEventListener('scroll', healScroll)
    // GPU renderer. Claude repaints its whole alt-screen view on every scroll
    // tick and wraps each frame in "synchronized output" (DEC mode 2026) so a
    // terminal paints it atomically. xterm's default DOM renderer ignores 2026
    // and applies those big repaints incrementally — which reads as scroll jank
    // and "can't reach the bottom." WebGL paints each frame on the GPU (fast +
    // crisp). Fall back to the DOM renderer if WebGL is unavailable or its
    // context is lost (e.g. many live terminals exceed the browser's GL contexts).
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl?.dispose()) // dispose → xterm reverts to DOM
      term.loadAddon(webgl)
    } catch {
      /* no GPU / WebGL blocked — DOM renderer stays; still fully functional */
    }
    fit.fit()

    // Dragging the window to a display with a different scale factor changes
    // devicePixelRatio WITHOUT changing this element's CSS size, so the
    // ResizeObserver below never fires. Left alone, the canvas keeps rasterizing
    // at the old scale — soft text, and more compositing work per frame on the
    // larger screen — and the glyph atlas keeps cached bitmaps at the wrong size.
    // Re-fit, rebuild the atlas, repaint. The media query has to be re-armed
    // each time because it is pinned to whatever the ratio is right now.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => {
      if (host.offsetWidth === 0) return // hidden tab; the visible-again effect refits
      fit.fit()
      webgl?.clearTextureAtlas()
      term.refresh(0, term.rows - 1)
      if (readyRef.current) invoke('pty_resize', { id, cols: term.cols, rows: term.rows })
      armDpr()
    }
    const armDpr = () => {
      dprQuery?.removeEventListener('change', onDprChange)
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    armDpr()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    let disposed = false
    let unOut: UnlistenFn | null = null
    let unExit: UnlistenFn | null = null
    const encoder = new TextEncoder()

    ;(async () => {
      // listeners BEFORE spawn so the first prompt bytes are never dropped
      unOut = await listen<string>(`pty-output-${id}`, (e) => term.write(b64ToBytes(e.payload)))
      if (disposed) { unOut(); return } // cleanup ran mid-await: unlisten here, cleanup saw null
      unExit = await listen<number | null>(`pty-exit-${id}`, (e) => {
        term.write(`\r\n[process exited: ${e.payload ?? 'killed'}]\r\n`)
        onExitRef.current()
      })
      if (disposed) { unExit(); return }
      await invoke('pty_spawn', { id, program, args, cwd, sessionId: sessionId ?? null, cols: term.cols, rows: term.rows })
      readyRef.current = true
      if (disposed) invoke('pty_kill', { id })
    })().catch((err) => {
      term.write(`\r\n[failed to start: ${err}]\r\n`)
      onExitRef.current()
    })

    const dataSub = term.onData((s) => {
      onInteractRef.current?.()
      if (readyRef.current) invoke('pty_write', { id, data: bytesToB64(encoder.encode(s)) })
    })

    const ro = new ResizeObserver(() => {
      if (host.offsetWidth === 0) return // hidden tab
      fit.fit()
      if (readyRef.current) invoke('pty_resize', { id, cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    // Appearance change: re-theme the canvas in place (CSS vars cover the
    // rest of the app; xterm needs the palette handed over explicitly).
    const onTheme = () => { term.options.theme = getXtermTheme() }
    window.addEventListener(THEME_EVENT, onTheme)

    return () => {
      disposed = true
      window.removeEventListener(THEME_EVENT, onTheme)
      dprQuery?.removeEventListener('change', onDprChange)
      ro.disconnect()
      viewport?.removeEventListener('scroll', healScroll)
      dataSub.dispose()
      resultsSub.dispose()
      unOut?.()
      unExit?.()
      if (readyRef.current) invoke('pty_kill', { id })
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (visible && termRef.current && fitRef.current && hostRef.current?.offsetWidth) {
      fitRef.current.fit()
      if (readyRef.current) {
        invoke('pty_resize', { id, cols: termRef.current.cols, rows: termRef.current.rows })
      }
    }
  }, [visible, id])

  // Keyboard follows the focused pane, not visibility: two side-by-side
  // terminals must not fight over keystrokes. Blurring the unfocused one also
  // makes its cursor hollow — the visual cue for "typing goes elsewhere".
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (focused && visible) term.focus()
    else if (!focused) term.blur()
  }, [focused, visible, id])

  // Opaque: confines a split pane's session tint to its thin mat, and hides
  // the cell-remainder strip xterm leaves (the grid snaps to whole cells).
  return <div ref={hostRef} style={{ width: '100%', height: '100%', background: 'var(--dd-bg1)' }} />
})

export default TerminalPane
