import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { relAge } from './types'

// File time machine: Claude Code snapshots every file it edits (per message)
// into ~/.claude/file-history/<sid>/. This overlay joins those checkpoints
// into a version rail + before/after diff. Full-window overlay (the artifact
// -expand pattern) because diffs need width the 252px panel can't give — and
// it must never displace a running terminal. Everything read-only.

export type FileVersion = { version: number; backup_file: string | null; ts: number | null }
export type FileHistory = { path: string; versions: FileVersion[] }

type Props = {
  sessionId: string
  // absolute path from FILES CHANGED (matched by suffix against the
  // snapshot's cwd-relative paths); null = whole-session view
  initialPath: string | null
  onClose: () => void
}

type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'gap'; text: string }

const DIFF_CAP = 1500 // lines per side; beyond this the DP table gets silly

/// Split blob text into lines: CRLF normalized (a line-endings-only rewrite
/// must not read as a total rewrite), empty content = zero lines (not ['']).
function toLines(s: string): string[] {
  if (s === '') return []
  return s.replace(/\r\n/g, '\n').split('\n')
}

/// Plain LCS line diff — small, dependency-free, fine at checkpoint sizes.
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n > DIFF_CAP || m > DIFF_CAP) {
    // don't dump 100k DOM rows: show the head of the newer version only
    const head = b.slice(0, 400)
    return [
      { kind: 'gap', text: `file too large to diff (${n} → ${m} lines) — showing the start of the newer version` },
      ...head.map((text) => ({ kind: 'add' as const, text })),
      ...(m > head.length ? [{ kind: 'gap' as const, text: `··· ${m - head.length} more lines ···` }] : []),
    ]
  }
  // LCS lengths, bottom-up
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/// Fold long unchanged runs down to 3 lines of context around each change.
function foldContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.kind !== 'ctx') {
      for (let k = Math.max(0, idx - 3); k <= Math.min(lines.length - 1, idx + 3); k++) keep[k] = true
    }
  })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `··· ${skipped} unchanged lines ···` })
        skipped = 0
      }
      out.push(l)
    } else {
      skipped++
    }
  })
  if (skipped > 0) out.push({ kind: 'gap', text: `··· ${skipped} unchanged lines ···` })
  return out
}

export default function TimeMachine({ sessionId, initialPath, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [history, setHistory] = useState<FileHistory[] | null>(null)
  const [file, setFile] = useState<string | null>(null) // selected rel path
  const [ver, setVer] = useState<number | null>(null) // selected version (diff vs previous)
  const [blobs, setBlobs] = useState<Record<string, string | null>>({}) // backup_file → content (null = failed)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    invoke<FileHistory[]>('file_history', { sessionId })
      .then((h) => {
        setHistory(h)
        // preselect: suffix-match the FILES CHANGED row's absolute path
        // against the snapshot's cwd-relative ones
        const hit = initialPath ? h.find((f) => initialPath.endsWith('/' + f.path) || initialPath === f.path) : undefined
        const first = hit ?? h[0]
        if (first) {
          setFile(first.path)
          const withBlob = first.versions.filter((v) => v.backup_file)
          setVer(withBlob.length ? withBlob[withBlob.length - 1].version : null)
        }
      })
      .catch((e) => setErr(String(e)))
  }, [sessionId, initialPath])

  const current = history?.find((f) => f.path === file) ?? null
  const versions = useMemo(() => (current ? current.versions.filter((v) => v.backup_file) : []), [current])
  const selIdx = versions.findIndex((v) => v.version === ver)
  const sel = selIdx >= 0 ? versions[selIdx] : null
  const prev = selIdx > 0 ? versions[selIdx - 1] : null

  // fetch the two blobs the diff needs
  useEffect(() => {
    for (const v of [prev, sel]) {
      const bf = v?.backup_file
      if (!bf || blobs[bf] !== undefined) continue
      invoke<string>('read_file_version', { sessionId, file: bf })
        .then((c) => setBlobs((m) => ({ ...m, [bf]: c })))
        .catch(() => setBlobs((m) => ({ ...m, [bf]: null })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.backup_file, prev?.backup_file, sessionId])

  const diff = useMemo(() => {
    if (!sel?.backup_file) return null
    const after = blobs[sel.backup_file]
    if (after === undefined) return 'loading'
    if (after === null) return 'unreadable'
    const before = prev?.backup_file ? blobs[prev.backup_file] : ''
    if (before === undefined) return 'loading'
    if (before === null) return 'unreadable'
    const folded = foldContext(diffLines(toLines(before), toLines(after)))
    if (!folded.some((l) => l.kind === 'add' || l.kind === 'del')) return 'identical'
    return folded
  }, [sel, prev, blobs])

  const mono = { fontFamily: 'Menlo, monospace', fontSize: 11 } as const

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: '#0b0e13', display: 'flex', flexDirection: 'column', transform: 'translateZ(0)', outline: 'none', fontFamily: 'system-ui', fontSize: 12, color: '#c8cdd5' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1d2530' }}>
        <span style={{ flex: 1, color: '#e8edf4', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          ⏱ File time machine{file ? ` — ${file}` : ''}
        </span>
        {history && history.length > 1 && (
          <select
            value={file ?? ''}
            onChange={(e) => {
              const f = history.find((x) => x.path === e.target.value)
              setFile(e.target.value)
              const withBlob = f ? f.versions.filter((v) => v.backup_file) : []
              setVer(withBlob.length ? withBlob[withBlob.length - 1].version : null)
            }}
            style={{ maxWidth: 340, background: '#161c25', color: '#d6dbe3', border: '1px solid #2c3647', borderRadius: 4, padding: '3px 4px', fontSize: 11 }}
          >
            {history.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={onClose}
          title="Close (Esc)"
          style={{ background: 'none', border: '1px solid #2c3647', borderRadius: 4, cursor: 'pointer', color: '#9aa3af', fontSize: 12, lineHeight: 1, padding: '2px 6px' }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 210, flex: 'none', borderRight: '1px solid #1d2530', overflowY: 'auto', padding: 10 }}>
          {history === null ? (
            <div style={{ color: err ? '#cf6b6b' : '#5b6675' }}>{err ?? 'loading checkpoints…'}</div>
          ) : versions.length === 0 ? (
            <div style={{ color: '#5b6675' }}>
              {err ?? 'No file checkpoints for this session — Claude Code keeps them only for files it edited (and prunes old ones).'}
            </div>
          ) : (
            versions.map((v) => (
              <button
                key={v.version}
                onClick={() => setVer(v.version)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: v.version === ver ? '#161c25' : 'none', border: 'none', borderLeft: `3px solid ${v.version === ver ? '#5a7fb0' : 'transparent'}`, borderRadius: 6, padding: '6px 8px', marginBottom: 4, cursor: 'pointer', color: '#c8cdd5' }}
              >
                <div style={{ ...mono, fontSize: 10, color: '#5b6675' }}>
                  v{v.version}
                  {v.ts ? ` · ${relAge(v.ts)} ago` : ''}
                </div>
                <div style={{ fontSize: 11, color: '#9aa3af' }}>{v === versions[0] ? 'first backup' : `changes since v${versions[Math.max(0, versions.indexOf(v) - 1)].version}`}</div>
              </button>
            ))
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '10px 14px' }}>
          {diff === null ? (
            <div style={{ color: '#5b6675' }}>pick a checkpoint on the left</div>
          ) : diff === 'loading' ? (
            <div style={{ color: '#5b6675' }}>loading…</div>
          ) : diff === 'unreadable' ? (
            <div style={{ color: '#cf6b6b' }}>couldn’t read this version (too large or binary)</div>
          ) : diff === 'identical' ? (
            <div style={{ color: '#5b6675' }}>no line changes between these checkpoints (whitespace/line-ending identical too)</div>
          ) : (
            <pre style={{ ...mono, margin: 0, lineHeight: 1.6 }}>
              {diff.map((l, i) => (
                <div
                  key={i}
                  style={{
                    whiteSpace: 'pre',
                    color: l.kind === 'add' ? '#5fb98a' : l.kind === 'del' ? '#cf6b6b' : l.kind === 'gap' ? '#4a5462' : '#8a93a1',
                    background: l.kind === 'add' ? 'rgba(95,185,138,.07)' : l.kind === 'del' ? 'rgba(207,107,107,.07)' : 'transparent',
                  }}
                >
                  {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : l.kind === 'gap' ? '' : '  '}
                  {l.text}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
