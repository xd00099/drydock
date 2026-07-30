# Changelog

Each tagged release's `## vX.Y.Z` section becomes the GitHub release body and
the in-app updater's release notes (extracted by `scripts/release-notes.py` in
CI — a tag without its section fails the release).

## v0.5.1 — 2026-07-29

### Scrolling a fullscreen session feels right

- **The wheel moves as far as you asked it to.** A claude session tracks the
  mouse, and in that mode the terminal was handing the program a single "scroll
  one step" per wheel notch no matter how far the notch reached — about a
  seventh of it. Every row of the gesture is delivered now, with small trackpad
  movements accumulating instead of being dropped.
- **Moving the window to a second display no longer leaves the terminal
  half-rendered.** A display with a different scale factor changes the pixel
  ratio without changing the window's layout, which nothing was watching for, so
  the terminal kept drawing at the old screen's scale — softer text, more work
  per frame, and scroll distances computed against the wrong row height. It now
  re-measures and repaints when the ratio changes.
- Note on the scrollbar: a fullscreen session doesn't have one, in Drydock or in
  any other terminal, because the conversation isn't in the terminal's
  scrollback — Claude is drawing the whole screen itself. Use the transcript
  (⌘⇧T) to scroll and search a session, or set
  `"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": "1"` in the settings `claude_env` to
  go back to the inline renderer, which has real scrollback.

## v0.5.0 — 2026-07-27

### Claude tabs run Claude's own fullscreen interface

- Drydock used to force the classic inline renderer. It doesn't anymore, so a
  session in a Drydock tab looks exactly like it does in iTerm or Terminal.
- The fullscreen renderer keeps no scrollback of its own, so inside a claude
  tab ⌘F and the scroll wheel reach only what's on screen. **The transcript
  (⌘⇧T) is where you scroll back and search** — it renders from the session
  file, so it always holds the whole conversation. Shell tabs are unchanged and
  keep their full history.
- Prefer the old behavior? Set `"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": "1"` in
  the settings `claude_env`.

### "Take over here" works again

- It was refused for **every** session: Claude records a session's start time in
  UTC, Drydock read the system's in local time, and the two were compared as
  text — so on any machine not set to UTC the answer was always "session is not
  running anymore" for a session that was plainly running. The comparison is now
  between instants, not strings.
- This was worse than a dead button. Because the process was never located,
  confirming a takeover resumed the session in Drydock *without* stopping the
  other Claude, leaving two processes writing one transcript.

### Much lighter when idle

- **~1.9 GB less memory.** The embedding model's scratch memory is grow-only, so
  the largest batch Drydock ever ran became its floor for the life of the
  process. Batches are now bounded by both size and content length. Existing
  embeddings are untouched — nothing is re-indexed.
- **A quarter of a million fewer processes a day.** Checking whether a session
  was still alive launched a `ps` command per session every two seconds. It's a
  single system call now.
- **A far cheaper idle loop.** "Is anything left to index?" used to scan the
  whole index every three seconds to answer "no". It now reads a maintained
  queue — milliseconds to microseconds — and backs off when there's nothing to
  do.
- A pane waiting on your input pulses on the GPU instead of repainting its
  frame up to 120 times a second, and both attention pulses respect the system
  Reduce Motion setting.

### Rendered artifacts can't phone home

- An HTML artifact could load images from any address, which was enough to send
  what it renders back out even though network requests were already blocked.
  Images and media are now restricted to content already inside the page.
- Scripts and fonts still come from the same fixed list of CDNs, and that
  remaining exposure — plus WebRTC, which no content policy can restrict — is
  now documented rather than glossed over.

## v0.4.0 — 2026-07-15

### Five new themes

- **Dracula, Nord, One Dark, Solarized Dark, and Solarized Light** join Dark,
  Light, and System in Settings → Appearance (⌘,). Each card previews its own
  palette, so you can compare before switching.
- A theme restyles everything in lockstep: the app chrome, the terminal's
  full ANSI-16 palette, and ⌘F search highlights. Open terminals recolor
  instantly — no restart, no re-launch.
- System mode still follows macOS light/dark, mapping to Dark and Light.

### Docs

- README rewritten with an accuracy pass and eight fresh screenshots — the
  Home work-log, take-over from another terminal, split screen, the file
  time machine, and the new theme picker all have tour sections now.

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
