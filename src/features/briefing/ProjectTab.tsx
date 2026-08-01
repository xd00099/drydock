import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { baseName, relAge, type McpServer, type Skill } from '@/lib/types'
import { S, loadStrSet } from './styles'
import pcls from './ProjectTab.module.css'

function SkillsSection({ projectPath }: { projectPath?: string }) {
  // Fetched per-mount (~17 file reads) so it stays fresh when plugins change and
  // a transient failure isn't pinned by a module cache. Includes plugin +
  // personal (~/.claude) skills and this project's own (<project>/.claude/skills).
  const [state, setState] = useState<'loading' | 'error' | Skill[]>('loading')
  // Groups start collapsed (just a header + count); persisted so an expand
  // survives the panel's per-session remount.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadStrSet('dd.skillsExpanded'))
  useEffect(() => {
    let live = true
    setState('loading')
    invoke<Skill[]>('list_skills', { projectPath: projectPath ?? null })
      .then((s) => live && setState(s))
      .catch(() => live && setState('error'))
    return () => { live = false }
  }, [projectPath])

  const toggle = (plugin: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(plugin)) next.delete(plugin); else next.add(plugin)
      localStorage.setItem('dd.skillsExpanded', JSON.stringify([...next]))
      return next
    })

  const header = (
    <div className={pcls.sectionHead}>
      <span style={S.secHead}>SKILLS</span>
      {Array.isArray(state) && state.length > 0 && (
        <span className={pcls.hint}>{state.length} · plugin, personal &amp; project</span>
      )}
    </div>
  )
  if (state === 'loading') return <div>{header}<div style={S.muted}>loading skills…</div></div>
  if (state === 'error') return <div>{header}<div style={S.muted}>couldn’t load skills</div></div>
  if (state.length === 0) return <div>{header}<div style={S.muted}>no plugin skills found</div></div>

  const groups = new Map<string, Skill[]>()
  for (const s of state) {
    if (!groups.has(s.plugin)) groups.set(s.plugin, [])
    groups.get(s.plugin)!.push(s)
  }
  return (
    <div>
      {header}
      {[...groups.entries()].map(([plugin, list]) => {
        const open = expanded.has(plugin)
        return (
          <div key={plugin} className={pcls.item}>
            <button style={S.groupBtn} onClick={() => toggle(plugin)} title={open ? 'Collapse' : 'Expand'}>
              <span className={pcls.caret}>{open ? '▾' : '▸'}</span>
              <span className={pcls.grow}>{plugin}</span>
              <span className={pcls.subtle}>{list.length}</span>
            </button>
            {open &&
              list.map((s) => (
                <div key={s.name} className={pcls.itemBody}>
                  <div style={S.name}>{s.name}</div>
                  <div style={S.desc} title={s.description}>{s.description}</div>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

// Connection-health dot color per status token from `claude mcp list`.
const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--dd-ok)',
  failed: 'var(--dd-err)',
  pending: 'var(--dd-warn-muted)',
  unknown: 'var(--dd-dim)',
  checking: 'var(--dd-border3)',
}

function StatusDot({ status, title }: { status: string; title: string }) {
  return <span title={title} style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: STATUS_COLOR[status] ?? 'var(--dd-dim)' }} />
}

// A small on/off switch. `on` = Drydock offers this server to the sessions it
// launches; off denies its tools to new sessions (the server config is untouched).
function Toggle({ on, busy, onClick, title }: { on: boolean; busy: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      style={{ flex: 'none', width: 26, height: 15, borderRadius: 8, border: '1px solid var(--dd-hairline-strong)', background: on ? 'var(--dd-ok-bg)' : 'var(--dd-hover)', position: 'relative', cursor: busy ? 'default' : 'pointer', padding: 0, opacity: busy ? 0.5 : 1 }}
    >
      <span style={{ position: 'absolute', top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: '50%', background: 'var(--dd-text1)', transition: 'left .12s' }} />
    </button>
  )
}

// `claude mcp list` spawns the CLI (seconds, not ms), and this whole panel
// remounts on every center-tab switch (key={activeTab.id} in App) — so the last
// health check is cached per project across remounts and only re-run once stale.
const MCP_RECHECK_MS = 60_000
const mcpStatusCache = new Map<string, { status: Record<string, { st: string; raw: string }>; checkedAt: number }>()
// The in-flight check, so concurrent remounts JOIN one `claude mcp list`
// spawn instead of racing several during the cold multi-second window.
const mcpCheckInFlight = new Map<string, Promise<unknown>>()
// Last server list per project: seeds the section on remount so the header
// (rollup dot, count) doesn't blink out while list_mcp_servers re-resolves.
const mcpServersCache = new Map<string, McpServer[]>()

// Worst-first, so the section header can report health even while collapsed.
const STATUS_RANK: Record<string, number> = { failed: 4, pending: 3, unknown: 2, checking: 1, connected: 0 }

function McpSection({ projectPath }: { projectPath?: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  // null = never checked (dots show "checking"); {} = checked, no statuses
  const [status, setStatus] = useState<Record<string, { st: string; raw: string }> | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // Collapsed still shows the rollup dot + age; the 60s re-check keeps running.
  const [secOpen, setSecOpen] = useState(() => localStorage.getItem('dd.mcpOpen') !== '0')
  // Result-application guard: bumped whenever projectPath changes, so a check
  // still in flight for the OLD project can't label the new one. Also the
  // "one check at a time" latch (state lags; a ref doesn't).
  const epochRef = useRef(0)
  const inFlightRef = useRef(false)
  const cacheKey = projectPath ?? ''

  const runCheck = useCallback((hasExternal: boolean) => {
    const epoch = epochRef.current
    if (!hasExternal) {
      setStatus({})
      setCheckedAt(Date.now())
      return
    }
    if (inFlightRef.current) return
    inFlightRef.current = true
    setChecking(true)
    // join the check another instance already started for this project — a
    // remount mid-check must not spawn a second concurrent CLI process
    let check = mcpCheckInFlight.get(cacheKey)
    if (!check) {
      check = invoke<[string, string, string][]>('mcp_status', { projectPath: projectPath ?? null })
        .then((triples) => {
          // single writer per spawn; joiners read the cache in their .then
          mcpStatusCache.set(cacheKey, {
            status: Object.fromEntries(triples.map(([n, st, raw]) => [n, { st, raw }])),
            checkedAt: Date.now(),
          })
        })
        .finally(() => mcpCheckInFlight.delete(cacheKey))
      mcpCheckInFlight.set(cacheKey, check)
    }
    check
      .then(() => {
        if (epochRef.current !== epoch) return
        const c = mcpStatusCache.get(cacheKey)
        if (c) { setStatus(c.status); setCheckedAt(c.checkedAt) }
        setCheckErr(null)
      })
      .catch((e) => {
        // keep the previous statuses on screen — but say the refresh failed
        if (epochRef.current === epoch) setCheckErr(String(e))
      })
      .finally(() => {
        inFlightRef.current = false
        if (epochRef.current === epoch) setChecking(false)
      })
  }, [projectPath, cacheKey])

  useEffect(() => {
    epochRef.current++
    const epoch = epochRef.current
    // a check still in flight for the OLD project must not block the new
    // project's first check for a whole interval (its result is epoch-discarded
    // anyway, and its finally() harmlessly re-clears this)
    inFlightRef.current = false
    setServers(null)
    setCheckErr(null)
    setChecking(false)
    // seed from the caches so a remount shows last-known health immediately
    const cached = mcpStatusCache.get(projectPath ?? '')
    setStatus(cached?.status ?? null)
    setCheckedAt(cached?.checkedAt ?? null)
    setServers(mcpServersCache.get(projectPath ?? '') ?? null)
    invoke<McpServer[]>('list_mcp_servers', { projectPath: projectPath ?? null })
      .then((list) => {
        if (epochRef.current !== epoch) return
        mcpServersCache.set(projectPath ?? '', list)
        setServers(list)
        // a cached check stands in for the mount-time one only while it's
        // fresh AND covers every external server — a just-added server must
        // trigger a real check, not wear "not in the output" for a minute
        const covered = !!cached && list.every((s) => s.builtin || cached.status[s.name] !== undefined)
        if (!cached || !covered || Date.now() - cached.checkedAt >= MCP_RECHECK_MS)
          runCheck(list.some((s) => !s.builtin))
      })
      .catch(() => {
        if (epochRef.current !== epoch) return
        setServers([])
        setStatus({})
      })
  }, [projectPath, runCheck])

  // A dot is only as honest as its age: re-check every minute while this tab
  // stays open (a dead server otherwise kept its green from panel-mount time).
  // The FIRST tick honors the cached check's age — a 59s-old seed re-checks in
  // ~1s, not 60 — so remounting can never stretch staleness past one TTL.
  const hasExternal = !!servers?.some((s) => !s.builtin)
  const checkedAtRef = useRef<number | null>(null)
  checkedAtRef.current = checkedAt
  useEffect(() => {
    if (!hasExternal) return
    const first = checkedAtRef.current == null
      ? MCP_RECHECK_MS
      : Math.max(0, checkedAtRef.current + MCP_RECHECK_MS - Date.now())
    let iv = 0
    const t = window.setTimeout(() => {
      runCheck(true)
      iv = window.setInterval(() => runCheck(true), MCP_RECHECK_MS)
    }, first)
    return () => { window.clearTimeout(t); if (iv) window.clearInterval(iv) }
  }, [hasExternal, runCheck])

  const toggleExpand = (name: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n })

  const toggle = async (s: McpServer) => {
    setBusy((prev) => new Set(prev).add(s.name))
    try {
      await invoke('set_mcp_enabled', { name: s.name, enabled: !s.enabled })
      setServers((prev) => {
        const next = prev && prev.map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x))
        if (next) mcpServersCache.set(cacheKey, next) // keep the remount seed honest
        return next
      })
    } catch (e) {
      console.error(e)
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(s.name); return n })
    }
  }

  const ageText = (ts: number) => {
    const w = relAge(ts)
    return w === 'now' ? 'just now' : `${w} ago`
  }

  // Health dot: the builtin loopback server is "connected" whenever enabled;
  // external servers reflect the last `claude mcp list` check. The tooltip
  // carries the CLI's raw words plus the check's age — the dot is a summary,
  // never the whole truth.
  const dotFor = (s: McpServer): { status: string; title: string } => {
    if (s.builtin)
      return s.enabled
        ? { status: 'connected', title: 'Listening · renders to the Artifacts tab' }
        : { status: 'unknown', title: 'Off — new sessions won’t get the render tool' }
    if (status === null) return { status: 'checking', title: 'Checking…' }
    const e = status[s.name]
    // not in the (possibly cache-seeded) map while a check runs: it's being
    // checked right now, not "missing from the output"
    if (!e && checking) return { status: 'checking', title: 'Checking…' }
    const st = e?.st ?? 'unknown'
    const what = e?.raw
      ? e.raw
      : st === 'connected' ? 'Connected' : st === 'failed' ? 'Failed to connect' : st === 'pending' ? 'Pending approval' : 'Not in the `claude mcp list` output'
    return { status: st, title: checkedAt ? `${what}\nchecked ${ageText(checkedAt)}` : what }
  }

  // Header rollup: the WORST status across enabled servers, so the collapsed
  // section still reports health at a glance — a red server can't be buried.
  // Disabled servers don't count: they're not offered to new sessions anyway.
  const dots = (servers ?? []).filter((s) => s.enabled).map((s) => dotFor(s).status)
  const failed = dots.filter((d) => d === 'failed').length
  const worst = dots.length
    ? dots.reduce((a, b) => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a))
    : null

  const toggleOpen = () =>
    setSecOpen((o) => { localStorage.setItem('dd.mcpOpen', o ? '0' : '1'); return !o })

  // Pinned-section layout, same recipe as FILES CHANGED: seam on top, darker
  // ground, own scroll, bounded height — skills can never bury a dead server.
  return (
    <div style={{ flex: secOpen ? '0 1 auto' : 'none', maxHeight: secOpen ? '55%' : undefined, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dd-hover)', background: 'var(--dd-well)' }}>
      <div className={pcls.toolbar}>
        {/* label and age SHRINK (ellipsize) at narrow widths; the dot, the
            count, and ↻ are flex:none so the signal + the cure never clip */}
        <button onClick={toggleOpen} title={secOpen ? 'Collapse' : 'Expand'} style={{ ...S.groupBtn, width: 'auto', flex: '0 1 auto', minWidth: 0, gap: 5, padding: 0 }}>
          <span className={pcls.caretSm}>{secOpen ? '▾' : '▸'}</span>
          <span style={{ ...S.secHead, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>MCP SERVERS</span>
        </button>
        {worst && (
          <StatusDot
            status={worst}
            title={`worst across enabled servers: ${worst}${checkedAt ? ` · checked ${ageText(checkedAt)}` : ''}\nhealth via \`claude mcp list\``}
          />
        )}
        {servers !== null && servers.length > 0 && (
          <span className={pcls.count}>
            {servers.length}{failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        )}
        <span className={pcls.fill} />
        {/* compact age ('2m'), full wording in the tooltip; turns into a red
            'check failed' when the refresh errors — visible even collapsed,
            so the rollup dot can't silently advertise stale health */}
        <span
          title={
            checkErr
              ? `${checkErr}\nlast good check: ${checkedAt ? ageText(checkedAt) : 'never'}`
              : checkedAt ? `health checked ${ageText(checkedAt)}` : undefined
          }
          style={{ color: checkErr ? 'var(--dd-err)' : 'var(--dd-dim)', fontSize: 10, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {checking ? 'checking…' : checkErr ? 'check failed' : hasExternal && checkedAt ? relAge(checkedAt) : ''}
        </span>
        {hasExternal && (
          <button
            onClick={() => runCheck(true)}
            disabled={checking}
            title="Re-check server health now"
            style={{ ...S.iconBtn, flex: 'none', fontSize: 10, padding: '1px 5px', opacity: checking ? 0.4 : 1, cursor: checking ? 'default' : 'pointer' }}
          >
            ↻
          </button>
        )}
      </div>
      {secOpen && (
      <div className={pcls.scroller}>
      {checkErr && (
        <div title={checkErr} className={pcls.errLine}>
          {checkErr}
        </div>
      )}
      <div className={pcls.note}>toggling applies to new sessions · secrets hidden</div>
      {servers === null ? (
        <div style={S.muted}>loading…</div>
      ) : servers.length === 0 ? (
        <div style={S.muted}>no MCP servers configured{projectPath ? ' for this project' : ''}</div>
      ) : (
        servers.map((s) => {
          const open = expanded.has(s.name)
          const hasTools = s.tools.length > 0
          const dot = dotFor(s)
          return (
            <div key={s.name} style={{ marginBottom: 9, opacity: s.enabled ? 1 : 0.55 }}>
              <div className={pcls.row}>
                {hasTools ? (
                  <button onClick={() => toggleExpand(s.name)} title={open ? 'Hide tools' : 'Show tools'} style={{ ...S.groupBtn, width: 10, flex: 'none', padding: 0 }}>
                    <span className={pcls.dim}>{open ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <span className={pcls.caretSlot} />
                )}
                <StatusDot status={dot.status} title={dot.title} />
                <span style={{ ...S.name, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                <span style={S.chip}>{s.kind}</span>
                <span className={pcls.tiny}>{s.scope}</span>
                <Toggle
                  on={s.enabled}
                  busy={busy.has(s.name)}
                  onClick={() => toggle(s)}
                  title={s.enabled ? 'Disable for new Drydock sessions' : 'Enable for new Drydock sessions'}
                />
              </div>
              {s.detail && (
                <div className={pcls.path}>{s.detail}</div>
              )}
              {open &&
                s.tools.map((t) => (
                  <div key={t} className={pcls.nested}>
                    <div style={S.name}>{t}</div>
                    {s.builtin && (
                      <div style={S.desc}>Renders a self-contained HTML / SVG / Markdown artifact into Drydock’s Artifacts tab.</div>
                    )}
                  </div>
                ))}
            </div>
          )
        })
      )}
      </div>
      )}
    </div>
  )
}

// The merged project/environment tab: what new sessions launched from this
// project get. Browse-y lists (skills) scroll on top; the short, actionable
// MCP section is pinned below with its own scroll — the same arrangement as
// briefing card over FILES CHANGED.
export function ProjectTab({ projectPath }: { projectPath?: string }) {
  const proj = projectPath ? baseName(projectPath) : undefined
  return (
    <div className={pcls.pane}>
      {/* pinned above the scroll: the scope must stay visible however far the
          skills list is scrolled — both sections below answer to it */}
      {proj && (
        <div className={pcls.paneHead}>
          for project: <span className={pcls.strong}>{proj}</span>
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: proj ? '8px 12px 12px' : 12 }}>
        <SkillsSection projectPath={projectPath} />
      </div>
      <McpSection projectPath={projectPath} />
    </div>
  )
}
