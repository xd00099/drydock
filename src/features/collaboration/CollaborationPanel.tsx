import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@/components/ui'
import Icon from '@/components/ui/Icon'
import type { ResolvedAgent } from '@/lib/agents'
import { findingsPacket, type CollaborationRecord, type HandoffLaunch } from './types'
import s from './Collaboration.module.css'

export type CollaborationActions = { review: ReactNode; handoff: ReactNode; history: ReactNode }
type Props = { sessionId: string; sourceAgent: string; agents: ResolvedAgent[]; onHandoff: (launch: HandoffLaunch) => void; onOpenSession: (id: string) => void; children?: (actions: CollaborationActions) => ReactNode }
export default function CollaborationPanel({ sessionId, sourceAgent, agents, onHandoff, onOpenSession, children }: Props) {
  const choices = agents.filter((a) => a.enabled && (a.id === 'claude' || a.id === 'codex'))
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'review' | 'handoff'>('review')
  const [record, setRecord] = useState<CollaborationRecord | null>(null)
  const [history, setHistory] = useState<CollaborationRecord[]>([])
  const [target, setTarget] = useState(choices.find((a) => a.id !== sourceAgent)?.id ?? choices[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [criteria, setCriteria] = useState('')
  const [packet, setPacket] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [stale, setStale] = useState<boolean | null>(null)
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)
  const alive = useRef(true)
  const preparing = useRef(false)
  const [retryPreparation, setRetryPreparation] = useState<{ mode: 'review' | 'handoff'; review?: CollaborationRecord; findings: string } | null>(null)

  useEffect(() => {
    alive.current = true
    let dead = false
    const refresh = () => invoke<CollaborationRecord[]>('collaboration_list', { sessionId }).then((records) => {
      if (dead) return
      setHistory(records)
      setRecord((r) => r ? records.find((next) => next.id === r.id) ?? r : null)
    }).catch((e) => { if (!dead) setError(String(e)) })
    refresh()
    const timer = window.setInterval(refresh, 4000)
    const un = listen<string>('collaboration-updated', (event) => { if (event.payload === sessionId) refresh() })
    return () => { dead = true; alive.current = false; ++sequence.current; clearInterval(timer); un.then((u) => u()) }
  }, [sessionId])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [open])
  useEffect(() => {
    if (!open || !record || record.scope.startsWith('Handoff')) return
    let dead = false
    setStale(null)
    const check = () => invoke<boolean>('collaboration_stale', { id: record.id }).then((value) => { if (!dead) setStale(value) })
      .catch(() => { if (!dead) setStale(null) })
    check()
    const timer = window.setInterval(check, 10_000)
    return () => { dead = true; clearInterval(timer) }
  }, [open, record?.id])

  const close = () => { ++sequence.current; setOpen(false); setBusy(false) }
  const prepare = async (nextMode: 'review' | 'handoff', review?: CollaborationRecord, carriedFindings?: string) => {
    if (preparing.current) return
    preparing.current = true
    const fixes = carriedFindings ?? (review ? findingsPacket(review, selected) : '')
    const token = ++sequence.current
    setRetryPreparation(null)
    setMode(nextMode); setOpen(true); setBusy(true); setError(''); setNotice(''); setFile(null)
    setRecord(null); setSelected([])
    setTarget(nextMode === 'handoff' && review ? sourceAgent : choices.find((a) => a.id !== sourceAgent)?.id ?? choices[0]?.id ?? '')
    try {
      const next = await invoke<CollaborationRecord>('collaboration_prepare', { sessionId, kind: nextMode })
      if (token !== sequence.current) return
      if (review && await invoke<boolean>('collaboration_stale', { id: review.id })) throw new Error('The code changed since this review. Run a new review before preparing fixes.')
      if (token !== sequence.current) return
      setRecord(next)
      setPacket(fixes ? next.packet + '\n\n' + fixes : next.packet)
      setCriteria(''); setModel('')
    } catch (e) { if (token === sequence.current) { setError(String(e)); setRetryPreparation({ mode: nextMode, review, findings: fixes }) } }
    finally { preparing.current = false; if (token === sequence.current) setBusy(false) }
  }
  const view = (r: CollaborationRecord) => {
    ++sequence.current; setBusy(false); setOpen(true); setRecord(r); setPacket(r.packet); setCriteria(r.criteria)
    setModel(r.model); setTarget(r.target_agent ?? choices[0]?.id ?? ''); setMode(r.status === 'handoff' ? 'handoff' : 'review')
    setSelected([]); setFile(null); setError(''); setNotice('')
  }
  const start = async () => {
    if (!record || !choices.some((a) => a.id === target)) return
    const token = ++sequence.current
    setBusy(true); setError(''); setNotice('')
    try {
      if (mode === 'review') {
        await invoke('collaboration_review', { id: record.id, agent: target, model, criteria })
        if (token !== sequence.current) return
        setRecord({ ...record, status: 'running', target_agent: target, criteria, model })
        const records = await invoke<CollaborationRecord[]>('collaboration_list', { sessionId })
        if (token === sequence.current) { setHistory(records); setRecord(records.find((r) => r.id === record.id) ?? record) }
      } else {
        const launch = await invoke<HandoffLaunch>('collaboration_handoff', { id: record.id, agent: target, packet })
        // Once persisted, deliver this launch exactly once even if the dialog
        // was closed while the request ran. Never type into an existing TUI.
        if (alive.current) onHandoff(launch)
        if (token === sequence.current) close()
      }
    } catch (e) { if (token === sequence.current) setError(String(e)) }
    finally { if (token === sequence.current) setBusy(false) }
  }
  const showFile = async (name: string, line: number) => {
    if (!record) return
    const id = record.id
    const token = sequence.current
    const text = await invoke<string>('collaboration_file', { id, file: name }).catch((e) => { setError(String(e)); return null })
    if (text !== null && token === sequence.current) setFile({ name: `${name}:${line} · captured source`, text: text.split('\n').slice(Math.max(0, line - 5), line + 8).map((v, i) => `${Math.max(1, line - 4) + i}  ${v}`).join('\n') })
  }
  const incoming = record?.source_session_id !== sessionId
  const packetBytes = new TextEncoder().encode(packet).length
  const draft = record?.status === 'draft'
  const running = record?.status === 'running'
  const result = record?.result
  const choiceIds = choices.map((a) => a.id).join(',')
  useEffect(() => {
    if (record?.status === 'draft' && !choices.some((a) => a.id === target)) {
      setTarget(choices.find((a) => a.id !== sourceAgent)?.id ?? choices[0]?.id ?? '')
    }
  }, [choiceIds, record?.status, sourceAgent, target])
  const latest = history[0]
  const actions: CollaborationActions = {
    review: <Button small onClick={() => prepare('review')}><Icon name="review" size={14} />Review with…</Button>,
    handoff: <Button small onClick={() => prepare('handoff')}><Icon name="arrow" size={14} />Handoff…</Button>,
    history: latest ? <button className={s.latest} onClick={() => view(latest)}>{latest.status === 'handoff' ? 'Handoff' : 'Review'} · {latest.target_agent} · {latest.status}</button> : null,
  }
  return <>
    {children ? children(actions) : <div className={s.actions}>{actions.review}{actions.handoff}{actions.history}</div>}
    {open && <div className={s.scrim} onClick={(e) => { if (e.target === e.currentTarget && !busy) close() }}>
      <div ref={dialog} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="collaboration-title" tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape' && !busy) { e.preventDefault(); close() }
          if (e.key === 'Tab') {
            const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
            const first = items[0], last = items[items.length - 1]
            if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus() }
            else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus() }
          }
        }}>
        <div className={s.header}>
          <div><h2 id="collaboration-title" className={s.heading}>{mode === 'review' ? 'Independent agent review' : 'Continue with another agent'}</h2>
            <div className={s.subtitle}>{record?.title ?? (mode === 'handoff' ? 'Refreshing your session summary…' : 'Capturing your project…')}</div></div>
          <Button variant="ghost" onClick={close} disabled={busy}>Close</Button>
        </div>
        <div className={s.body}>
          <aside className={s.history} aria-label="Review and handoff history">
            <Button small onClick={() => prepare('review')} disabled={busy}>New review</Button>
            <Button small onClick={() => prepare('handoff')} disabled={busy}>New handoff</Button>
            {history.map((r) => <button key={r.id} className={s.historyRow} aria-current={r.id === record?.id} onClick={() => view(r)} disabled={busy}>
              {r.status === 'handoff' ? 'Handoff' : 'Review'} · {r.target_agent}<div className={s.subtitle}>{r.status} · {new Date(r.created_at).toLocaleDateString()}</div>
            </button>)}
          </aside>
          <main className={s.content}>
            {busy && !record && <p role="status">{mode === 'handoff' ? 'Refreshing the title and summary, then preparing your handoff…' : 'Capturing files and preparing context…'}</p>}
            {error && <p className={s.error} role="alert">{error}</p>}
            {!busy && !record && retryPreparation && <Button small onClick={() => prepare(retryPreparation.mode, retryPreparation.review, retryPreparation.findings)}>Try again</Button>}
            {notice && <p className={s.note} role="status">{notice}</p>}
            {record && <>
              <p className={s.note}>{record.scope}{!record.scope.startsWith('Handoff') && ` · ${record.files.length} captured files · snapshot ${record.snapshot_id.slice(0, 10)}`}</p>
              {stale === true && <p className={s.warning}>The project has changed since this snapshot. Findings describe the captured code.</p>}
              {record.omitted.length > 0 && <details className={s.warning}><summary>{record.omitted.length} files excluded from the snapshot</summary>{record.omitted.map((f) => <div key={f}>{f}</div>)}</details>}
              {draft && <>
                <div className={s.form}>
                  <label className={s.label}>Destination agent<select className={s.input} value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
                    {choices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select></label>
                  {mode === 'review' && <label className={s.label}>Model (optional)<input className={s.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Agent default" disabled={busy} maxLength={200} /></label>}
                </div>
                {choices.length === 0 && <p className={s.warning}>Enable Claude Code or Codex in Settings → Agents to continue.</p>}
                {choices.length > 0 && choices.length < 2 && <p className={s.note}>Only enabled agents appear here. Enable {choices[0].id === 'claude' ? 'Codex' : 'Claude Code'} in Settings → Agents to add it.</p>}
                {mode === 'review' ? <>
                  <label className={s.label}>Acceptance criteria or review focus<textarea className={s.textarea} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="What should this change do? Any edge cases to check?" disabled={busy} maxLength={16000} /></label>
                  <p className={s.note}>The reviewer reads a separate captured copy. It receives the changes and your criteria, with no source conversation. Findings include suggested tests; tests are not run.</p>
                  <p className={s.note}>{target === 'codex' ? 'Codex reviews use its standard provider and login, with a read-only sandbox. Custom Codex config is excluded from review jobs.' : 'Claude reviews use your CLI authentication and provider environment, with only read and search tools enabled.'}</p>
                </> : <>
                  <label className={s.label}>Handoff packet<textarea className={s.packet} value={packet} onChange={(e) => setPacket(e.target.value)} disabled={busy} /></label>
                  <p className={packetBytes > 96 * 1024 ? s.warning : s.note}>{packetBytes.toLocaleString()} / 98,304 bytes</p>
                  <p className={s.note}>Review what you share with the selected agent. A new interactive session will open in {record.working_directory}. It can edit the same working files; pause other agents editing them first.</p>
                </>}
              </>}
              <details><summary>Captured changes</summary><pre className={s.diff}>{record.diff || 'No code changes captured.'}</pre></details>
              {running && <p className={s.note} role="status">{record.target_agent} is reviewing the snapshot. You can close this window; results will be saved. Reviews time out after five minutes.</p>}
              {record.error && <p className={s.error} role="alert">{record.error}</p>}
              {result && <>
                <p>{result.summary}</p>
                {result.findings.length === 0 && <p className={s.note}>No concrete issues reported. This is a review opinion, not proof that the change is correct.</p>}
                {result.findings.map((f, i) => <article className={s.finding} key={i}>
                  <label className={s.findingTitle}><input type="checkbox" checked={selected.includes(i)} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, i] : prev.filter((n) => n !== i))} />{f.severity.toUpperCase()} · {f.title}</label>
                  <button className={s.location} onClick={() => showFile(f.file, f.line)}>{f.file}:{f.line} · view snapshot</button>
                  <p>{f.explanation}</p><p className={s.note}>Suggested reproduction: {f.reproduction || 'Not supplied'}</p>
                </article>)}
                {file && <details open><summary>{file.name}</summary><pre className={s.diff}>{file.text}</pre></details>}
                {result.findings.length > 0 && <div className={s.buttons}>
                  <Button disabled={!selected.length} onClick={() => navigator.clipboard.writeText(findingsPacket(record, selected)).then(() => setNotice('Selected findings copied. Paste them into the source session to request fixes.')).catch((e) => setError(String(e)))}>Copy selected findings</Button>
                  <Button disabled={!selected.length || stale !== false} onClick={() => prepare('handoff', record)}>Prepare fixes in a new session</Button>
                </div>}
              </>}
              {record.status === 'handoff' && <>
                <p className={s.note}>{incoming ? `Continued from ${record.source_agent}` : `Handed off to ${record.target_agent}`} · source session {record.source_session_id}</p>
                <pre className={s.diff}>{record.packet}</pre>
                <div className={s.buttons}><Button onClick={() => onOpenSession(record.source_session_id)}>Open source session</Button>
                  {record.destination_session_id && <Button onClick={() => onOpenSession(record.destination_session_id!)}>Open destination session</Button>}</div>
              </>}
            </>}
          </main>
        </div>
        <div className={s.footer}><span className={s.note}>{draft && mode === 'review' ? 'Runs through your installed CLI and uses its account usage.' : running ? 'Review continues in the background.' : ''}</span>
          <div className={s.buttons}>
            {running && record && <Button variant="danger" onClick={() => invoke('collaboration_cancel', { id: record.id }).then(() => setNotice('Stopping reviewer…')).catch((e) => setError(String(e)))}>Cancel review</Button>}
            {draft && <Button variant="primary" disabled={busy || !target || !choices.some((a) => a.id === target) || (mode === 'review' && !record?.diff.trim()) || (mode === 'handoff' && (!packet.trim() || packetBytes > 96 * 1024))} onClick={start}>{busy ? 'Starting…' : mode === 'review' ? 'Start review' : 'Open new agent session'}</Button>}
          </div>
        </div>
      </div>
    </div>}
  </>
}
