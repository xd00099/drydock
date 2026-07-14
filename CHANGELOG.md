# Changelog

Each tagged release's `## vX.Y.Z` section becomes the GitHub release body and
the in-app updater's release notes (extracted by `scripts/release-notes.py` in
CI — a tag without its section fails the release).

## v0.3.0 — 2026-07-13

### Review artifacts by pointing at them

- **Annotate, don't describe.** When a session renders an HTML/SVG/Markdown
  artifact (a plan, a mockup, a diagram), hit ⌘I and click any element to
  leave feedback pinned to it. Queue up notes, then **Send** — Claude
  collects them (each tagged with the exact element you meant), applies
  them, and re-renders. **Send & end** closes the loop and tells it to move
  on with the work.
- **Presence built in.** The panel shows whether Claude is listening for
  feedback, working on it, or waiting on you — and a session sitting idle
  gets nudged automatically when you send.
- **Rewind-aware.** Rewinding the conversation prunes artifacts from the
  now-abandoned branch and resets the review round, so feedback never lands
  on a version that no longer exists.

### Keyboard-first

- **⌘N — start a session anywhere.** Type a path with per-segment
  autocomplete; if the folder doesn't exist yet, Enter creates it
  (`mkdir -p`) and launches claude there. Bare names land under a
  configurable default parent; empty input offers your recent projects.
  (It politely refuses `~`, `/`, and anything inside `~/.claude`.)
- **Everything else on chords too**: ⌘B sidebar, ⌘J briefing panel,
  ⌘⇧J jump to the artifact preview, ⌘1–9 / ⌘⇧[ ] tab switching, and ⌘T now
  opens shells in the active session's directory instead of home.
- **Settings (⌘, or the ⚙︎ in the footer).** Every shortcut — old and new —
  is rebindable with conflict detection and reserved-chord protection.
  General tab: notifications toggle, ⌘N's default parent folder, and an
  optional confirm before closing a live session (on by default).

### Light theme

- **Appearance: Dark / Light / System.** The entire UI — terminals and ⌘F
  highlighting included — recolors instantly, no restart. System follows
  macOS. Dark remains exactly the palette you know; artifacts keep their
  own canvas regardless of theme.

## v0.2.3 — 2026-07-13

### Take over a session running somewhere else

- **"Take over here…"** — when a session is live in another terminal (iTerm,
  VS Code, tmux, wherever), you no longer have to hunt that window down to
  continue it in Drydock. Right-click the session in the sidebar, or use the
  button on the read-only transcript banner, and Drydock stops the external
  claude and resumes the conversation in its own tab.
- **You confirm before anything happens.** The dialog names where the session
  is running (app and tty when recognizable) and warns if it's mid-task —
  taking over then loses the in-flight turn, so that's your call.
- **Safe by identity, not just pid.** Drydock verifies the target process is
  the same claude the session file points at (command and process start time
  must both match) before signalling, refuses system pids, and refuses
  sessions already running in a Drydock tab — those just get focused. Graceful
  stop first (SIGTERM), force only if needed after a few seconds.

## v0.2.2 — 2026-07-07

### Split screen

- **Drag a tab into the window to split it, VS Code-style.** A hint frame
  shows where the pane will land — left/right/top/bottom of any pane, the
  window edges for full-length splits, or the center to swap/replace.
  Layouts nest as deep as the window allows; drag the dividers to resize
  (double-click one to even out).
- **Focus follows the pane.** The briefing panel, find bar, ⌘W, and the
  sidebar highlight all track whichever pane you're working in; ⌘⌥arrows
  move focus between panes. A pane blocked on your input pulses amber.
- **Panes wear their session's color.** Each split pane gets a colored
  frame matching its session (strong when focused, faded otherwise), so
  side-by-side sessions are tellable at a glance.
- **Zoom.** Double-click a tab chip — or press ⇧⌘Return — and the focused
  pane fills the window; the split waits underneath and the same gesture
  brings it back exactly as it was.
- **Right-click a tab for split options.** "Split right/down" places the
  tab beside the pane you're on (on the current tab it picks the tab you
  were just viewing, named in the menu), plus "Zoom pane" and "Remove from
  split" (the tab stays in the bar).

### Fixes

- Dragging a tab no longer paints a text selection across the app.
- Notifications and unread badges now respect what's actually on screen —
  a session hidden behind a zoomed pane pings like any background tab.

## v0.2.1 — 2026-07-07

### Native in-app updates

- **One-click updates.** The sidebar Update button now downloads the new
  version, verifies its signature, installs it in place, and relaunches —
  no more trip to the releases page, no quarantine dance.
- **Your workspace comes back.** Right before the restart Drydock snapshots
  the open tabs and the new version reopens them: claude tabs resume their
  sessions, shell tabs reopen in their working directory, transcripts return
  read-only. (Terminal scrollback resets; the conversations themselves are
  untouched.)
- **No surprise interruptions.** If any session is mid-task, Drydock asks
  before restarting; when everything is idle it just goes.
- **Signed updates.** Update artifacts are minisign-signed and verified
  against a public key baked into the app, so the update channel can't be
  tampered with — and because Drydock downloads the update itself, macOS
  never quarantines it.

*Heads up: updating FROM v0.2.0 opens the releases page one last time — the
native flow applies from v0.2.1 onward.*
