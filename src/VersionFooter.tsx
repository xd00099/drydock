import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { relAge } from './types'

type Update = { current: string; latest: string; newer: boolean }

/** Sidebar footer: the app version, quietly. Checks GitHub Releases once
 *  shortly after launch and every 12h after; when a newer release exists the
 *  label becomes an Update button that opens the release page. Clicking the
 *  plain version re-checks on demand — auto-check failures (offline, no
 *  releases yet) stay silent in the tooltip, only a manual check reports. */
export default function VersionFooter() {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<Update | null>(null)
  const [checking, setChecking] = useState(false)
  const [flash, setFlash] = useState<'ok' | 'fail' | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [lastErr, setLastErr] = useState<string | null>(null)
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

  const box: React.CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    height: 26,
    padding: '0 10px',
    borderTop: '1px solid #161d28',
    background: '#0b0e13',
    fontFamily: 'system-ui',
    fontSize: 11,
    color: '#5b6675',
  }

  if (update?.newer) {
    return (
      <div style={box}>
        <button
          onClick={() => invoke('open_releases_page').catch(() => {})}
          title={`v${update.current} → v${update.latest} — opens the release page`}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, background: '#141b26',
            border: '1px solid #2c4468', borderRadius: 5, color: '#9cc3ff',
            padding: '2px 8px', fontSize: 11, cursor: 'pointer',
          }}
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
