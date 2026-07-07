# Changelog

Each tagged release's `## vX.Y.Z` section becomes the GitHub release body and
the in-app updater's release notes (extracted by `scripts/release-notes.py` in
CI — a tag without its section fails the release).

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
