// Drydock frontend settings — thin typed access over localStorage (dd.*) with
// a change event so consumers (App's notify gate, ⌘N's default parent, the
// close guard) stay in sync with the Settings overlay without prop-drilling.
// Backend-relevant settings live in src-tauri settings.rs; these are UI-only.
import { useEffect, useState } from 'react'

export const SETTINGS_EVENT = 'dd-settings-changed'

export function getSetting(key: string, def: string): string {
  const v = localStorage.getItem(`dd.${key}`)
  return v === null ? def : v
}

export function setSetting(key: string, value: string) {
  localStorage.setItem(`dd.${key}`, value)
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key } }))
}

/** Live-updating setting value + setter, for the Settings overlay's controls. */
export function useSetting(key: string, def: string): [string, (v: string) => void] {
  const [val, setVal] = useState(() => getSetting(key, def))
  useEffect(() => {
    const sync = () => setVal(getSetting(key, def))
    window.addEventListener(SETTINGS_EVENT, sync)
    return () => window.removeEventListener(SETTINGS_EVENT, sync)
  }, [key, def])
  return [val, (v: string) => setSetting(key, v)]
}
