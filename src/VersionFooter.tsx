import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { relAge } from './types'
import { useChord } from './keymap'

type Update = { current: string; latest: string; newer: boolean }
type Phase = 'idle' | 'confirm' | 'downloading' | 'installing' | 'restarting' | 'failed'
type Progress = { downloaded: number; total: number | null }

type Props = {
  // claude tabs currently mid-turn; >0 gates the restart behind a confirm
  busyCount: number
  // App stashes the open tabs, then restarts into the new bundle
  onRestartForUpdate: () => Promise<void>
  onOpenSettings: () => void // footer gear — same surface as ⌘,
}

/** Sidebar footer: the app version, quietly. Checks the release manifest once
 *  shortly after launch and every 12h after; when a newer release exists the
 *  label becomes an Update button that downloads, installs, and relaunches in
 *  place (tabs are stashed and restored by App). If sessions are mid-turn it
 *  asks before restarting; if the install fails it falls back to opening the
 *  releases page. Clicking the plain version re-checks on demand — auto-check
 *  failures (offline, no releases yet) stay silent, only a manual check reports. */
export default function VersionFooter({ busyCount, onRestartForUpdate, onOpenSettings }: Props) {
  const settingsChord = useChord('settings.toggle')
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<Update | null>(null)
  const [checking, setChecking] = useState(false)
  const [flash, setFlash] = useState<'ok' | 'fail' | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [lastErr, setLastErr] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [installErr, setInstallErr] = useState<string | null>(null)
  const busyRef = useRef(false)
  const flashTimer = useRef(0)

  const check = (manual: boolean) => {
    if (busyRef.current) return
    busyRef.current = true
    if (manual) setChecking(true)
    invoke<Update>('check_update')
      .then((u) => {
        setUpdate(u)
        setLastErr(null)
        if (manual && !u.newer) {
          setFlash('ok')
          clearTimeout(flashTimer.current)
          flashTimer.current = window.setTimeout(() => setFlash(null), 2500)
        }
      })
      .catch((e) => {
        setLastErr(String(e))
        if (manual) {
          setFlash('fail')
          clearTimeout(flashTimer.current)
          flashTimer.current = window.setTimeout(() => setFlash(null), 2500)
        }
      })
      .finally(() => {
        busyRef.current = false
        setChecking(false)
        setCheckedAt(Date.now())
      })
  }

  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
    // first check waits out the launch rush (index rebuild, radar, embedder)
    const t = window.setTimeout(() => check(false), 5000)
    const h = window.setInterval(() => check(false), 12 * 3600 * 1000)
    return () => { clearTimeout(t); clearInterval(h); clearTimeout(flashTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // download progress from the backend while install_update runs
  useEffect(() => {
    let cancelled = false
    let un: UnlistenFn | null = null
    listen<{ downloaded?: number; total?: number | null; phase: string }>('update-progress', (e) => {
      if (e.payload.phase === 'installing') setPhase((p) => (p === 'downloading' ? 'installing' : p))
      else if (e.payload.phase === 'downloading') setProgress({ downloaded: e.payload.downloaded ?? 0, total: e.payload.total ?? null })
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; un?.() }
  }, [])

  const install = () => {
    setPhase('downloading')
    setProgress(null)
    invoke('install_update')
      .then(async () => {
        // bundle swapped on disk; snapshot the workspace, then relaunch into it
        setPhase('restarting')
        await onRestartForUpdate()
      })
      .catch((e) => {
        setInstallErr(String(e))
        setPhase('failed')
      })
  }

  const box: React.CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 26,
    padding: '0 10px',
    borderTop: '1px solid #161d28',
    background: '#0b0e13',
    fontFamily: 'system-ui',
    fontSize: 11,
    color: '#5b6675',
  }
  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5, background: '#141b26',
    border: '1px solid #2c4468', borderRadius: 5, color: '#9cc3ff',
    padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  }

  if (update?.newer) {
    if (phase === 'confirm') {
      return (
        <div style={box}>
          <span style={{ color: '#c9a35f' }}>{busyCount || 'some'} working —</span>
          <button onClick={install} style={{ ...btn, borderColor: '#6a4a2c', color: '#e0b070', padding: '2px 6px' }}>
            restart anyway
          </button>
          <button
            onClick={() => setPhase('idle')}
            style={{ ...btn, background: 'none', border: '1px solid #2c3647', color: '#7d8794', padding: '2px 6px' }}
          >
            wait
          </button>
        </div>
      )
    }
    if (phase === 'downloading' || phase === 'installing' || phase === 'restarting') {
      const pct = progress?.total ? Math.min(99, Math.round((progress.downloaded / progress.total) * 100)) : null
      const label =
        phase === 'downloading'
          ? pct != null ? `Downloading… ${pct}%` : progress ? `Downloading… ${(progress.downloaded / 1e6).toFixed(1)} MB` : 'Downloading…'
          : phase === 'installing' ? 'Installing…' : 'Restarting…'
      return (
        <div style={box}>
          <span style={{ color: '#9cc3ff' }}>{label}</span>
        </div>
      )
    }
    if (phase === 'failed') {
      return (
        <div style={box}>
          <button
            onClick={() => invoke('open_releases_page').catch(() => {})}
            title={`${installErr ?? 'update failed'}\nOpens the releases page to update manually`}
            style={{ ...btn, borderColor: '#6a4a2c', color: '#c9a35f' }}
          >
            ⚠ update failed — get v{update.latest} manually
          </button>
        </div>
      )
    }
    return (
      <div style={box}>
        <button
          onClick={() => (busyCount > 0 ? setPhase('confirm') : install())}
          title={`v${update.current} → v${update.latest} — downloads, installs, and relaunches; your tabs come back`}
          style={btn}
        >
          <span style={{ fontSize: 10 }}>↑</span> Update to v{update.latest}
        </button>
      </div>
    )
  }

  const label = checking ? 'checking…' : flash === 'ok' ? '✓ up to date' : flash === 'fail' ? '⚠ couldn’t check' : version ? `v${version}` : ''
  const tip = [
    `Drydock${version ? ` v${version}` : ''} — click to check for updates`,
    checkedAt ? `last checked ${relAge(checkedAt) === 'now' ? 'just now' : `${relAge(checkedAt)} ago`}` : null,
    lastErr,
  ].filter(Boolean).join('\n')
  return (
    <div style={box}>
      <button
        onClick={onOpenSettings}
        title={`Settings (${settingsChord})`}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5b6675', fontSize: 13, padding: 0, lineHeight: 1 }}
      >
        ⚙︎
      </button>
      <span
        onClick={() => check(true)}
        title={tip}
        style={{ cursor: 'pointer', color: flash === 'fail' ? '#c9a35f' : flash === 'ok' ? '#5fb98a' : '#5b6675' }}
      >
        {label}
      </span>
    </div>
  )
}
