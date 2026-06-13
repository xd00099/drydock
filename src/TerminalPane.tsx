import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'

type Props = {
  id: number
  program: string | null
  args: string[]
  cwd: string | null
  visible: boolean
  onExit: () => void
  onInteract?: () => void // any user input into the terminal
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

export default function TerminalPane({ id, program, args, cwd, visible, onExit, onInteract }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const readyRef = useRef(false)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onInteractRef = useRef(onInteract)
  onInteractRef.current = onInteract

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
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

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
}
