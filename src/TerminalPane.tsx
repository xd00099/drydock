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
  onMatches?: (index: number, count: number) => void // ⌘F find results (active match, total)
}

// ⌘F highlight colors: dim wash for all matches, amber for the active one.
const DECORATIONS = {
  matchBackground: '#3a4656',
  matchBorder: '#5a6b82',
  matchOverviewRuler: '#8ab4f8',
  activeMatchBackground: '#e8c35a',
  activeMatchBorder: '#e8c35a',
  activeMatchColorOverviewRuler: '#e8c35a',
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
      if (!search) return
      if (!query) { search.clearDecorations(); onMatchesRef.current?.(-1, 0); return }
      const opts = { incremental: !!incremental, decorations: DECORATIONS }
      if (dir === 'prev') search.findPrevious(query, opts)
      else search.findNext(query, opts)
    },
    clear() {
      searchRef.current?.clearDecorations()
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
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
    const resultsSub = search.onDidChangeResults((r) => onMatchesRef.current?.(r.resultIndex, r.resultCount))

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
      termRef.current.focus()
    }
  }, [visible, id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
})

export default TerminalPane
