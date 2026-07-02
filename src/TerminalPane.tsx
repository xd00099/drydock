import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { PaneSearch } from './types'
import '@xterm/xterm/css/xterm.css'

type Props = {
  id: number
  program: string | null
  args: string[]
  cwd: string | null
  visible: boolean
  onExit: () => void
  onInteract?: () => void // any user input into the terminal
  onMatches?: (index: number, count: number) => void // ⌘F results (index<0 = count-only)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// The search addon navigates to matches, but its "highlight all" decoration
// path throws on wide/CJK columns — so we never enable it, which also means it
// can't give us a match index. To still show a "n of m" counter we walk the
// buffer ourselves: count every match and locate the one the addon just
// selected. Everything is string-based and cell-width-aware, so CJK (the user
// types Chinese) and wrapped rows are handled correctly.
type TermMatchInfo = { count: number; index: number } // index: 0-based active match, -1 if none/unknown
function termMatchInfo(term: Terminal, q: string): TermMatchInfo {
  if (!q) return { count: 0, index: -1 }
  const needle = q.toLowerCase()
  const buf = term.buffer.active
  // The addon leaves the active match selected. getSelectionPosition is 1-based
  // and in absolute-buffer coords (same space as getLine) — map its start cell
  // to an offset within the logical line so we can match it to a found index.
  const sel = term.getSelectionPosition()
  const selRow = sel ? sel.start.y - 1 : -1
  const selCol = sel ? sel.start.x - 1 : -1

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
  { id, program, args, cwd, visible, onExit, onInteract, onMatches },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
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
      try {
        if (!query) { search.clearDecorations(); onMatchesRef.current?.(-1, 0); return }
        // No `decorations`: that path highlights all matches but throws on
        // wide-char columns. Plain find still selects + scrolls to the match;
        // we derive the "n of m" counter ourselves from the selection.
        const opts = { caseSensitive: false }
        const found = dir === 'prev'
          ? search.findPrevious(query, opts)
          : search.findNext(query, { ...opts, incremental: !!incremental })
        const info = termMatchInfo(term, query)
        onMatchesRef.current?.(found ? info.index : -1, info.count)
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
      // a faint wash. Opaque selection keeps the found text obvious.
      theme: {
        background: '#10141a',
        foreground: '#c8cdd5',
        cursor: '#7fb0ff',
        cursorAccent: '#10141a',
        selectionBackground: '#3d5878',
        selectionInactiveBackground: '#2c3647',
        black: '#1d2530',
        red: '#cf6b6b',
        green: '#7ec8a0',
        yellow: '#e8c35a',
        blue: '#7fb0ff',
        magenta: '#c792ea',
        cyan: '#7ecfc0',
        white: '#c8cdd5',
        brightBlack: '#7d8794',
        brightRed: '#e8907a',
        brightGreen: '#a3dcbd',
        brightYellow: '#f0d38a',
        brightBlue: '#9cc3ff',
        brightMagenta: '#dab6f4',
        brightCyan: '#a2e0d5',
        brightWhite: '#e8edf4',
      },
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(host)
    // Physical mouse wheels feel awful in the alt buffer (Claude Code's TUI):
    // there's no scrollback there, so xterm converts wheel to arrow keys at
    // amount = deltaY / cell-height — one WKWebView mouse notch (~120px) becomes
    // 5-25 up/down keys and the conversation leaps. Touchpads are fine (small
    // pixel deltas). For big pixel deltas in the alt buffer, send a gentle 1-3
    // arrows per notch instead. Everything else falls through to xterm: normal
    // buffer (real scrollback), touchpads, and TUIs that track the mouse
    // themselves (vim mouse=a, htop — they want real SGR wheel reports).
    term.attachCustomWheelEventHandler((ev) => {
      if (
        term.buffer.active.type !== 'alternate' ||
        term.modes.mouseTrackingMode !== 'none' ||
        ev.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        Math.abs(ev.deltaY) < 40
      ) return true
      ev.preventDefault()
      const seq = '\x1b' + (term.modes.applicationCursorKeysMode ? 'O' : '[') + (ev.deltaY < 0 ? 'A' : 'B')
      const n = Math.max(1, Math.min(3, Math.round(Math.abs(ev.deltaY) / 40)))
      term.input(seq.repeat(n), true)
      return false
    })
    // GPU renderer. Claude repaints its whole alt-screen view on every scroll
    // tick and wraps each frame in "synchronized output" (DEC mode 2026) so a
    // terminal paints it atomically. xterm's default DOM renderer ignores 2026
    // and applies those big repaints incrementally — which reads as scroll jank
    // and "can't reach the bottom." WebGL paints each frame on the GPU (fast +
    // crisp). Fall back to the DOM renderer if WebGL is unavailable or its
    // context is lost (e.g. many live terminals exceed the browser's GL contexts).
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose()) // dispose → xterm reverts to DOM
      term.loadAddon(webgl)
    } catch {
      /* no GPU / WebGL blocked — DOM renderer stays; still fully functional */
    }
    fit.fit()
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
      await invoke('pty_spawn', { id, program, args, cwd, cols: term.cols, rows: term.rows })
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

    return () => {
      disposed = true
      ro.disconnect()
      dataSub.dispose()
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
      termRef.current.focus()
    }
  }, [visible, id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
})

export default TerminalPane
