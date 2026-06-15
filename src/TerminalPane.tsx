import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
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

// Count matches across the buffer ourselves (the search addon's decoration
// "highlight all" path throws on wide/CJK columns). String-based, so wide chars
// are counted correctly; wrapped rows are stitched into one logical line.
function countTermMatches(term: Terminal, q: string): number {
  if (!q) return 0
  const needle = q.toLowerCase()
  const buf = term.buffer.active
  let count = 0
  let logical = ''
  const flush = () => {
    if (logical) {
      const hay = logical.toLowerCase()
      let from = 0
      for (;;) {
        const idx = hay.indexOf(needle, from)
        if (idx < 0) break
        count++
        from = idx + needle.length
      }
    }
    logical = ''
  }
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    if (i > 0 && line.isWrapped) logical += line.translateToString(true)
    else { flush(); logical = line.translateToString(true) }
  }
  flush()
  return count
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
        // wide-char columns. Plain find still selects + scrolls to the match.
        const opts = { caseSensitive: false }
        if (dir === 'prev') search.findPrevious(query, opts)
        else search.findNext(query, { ...opts, incremental: !!incremental })
        onMatchesRef.current?.(-1, countTermMatches(term, query)) // index unknown, total counted
      } catch (e) {
        console.error('terminal find failed:', e)
        onMatchesRef.current?.(-1, 0)
      }
    },
    clear() {
      searchRef.current?.clearDecorations() // also clears the selection
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
      theme: { background: '#10141a' },
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(host)
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
