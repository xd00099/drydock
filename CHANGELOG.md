# Changelog

Each tagged release's `## vX.Y.Z` section becomes the GitHub release body and
the in-app updater's release notes (extracted by `scripts/release-notes.py` in
CI — a tag without its section fails the release).

## v0.6.3 — 2026-07-30

### ⌘Q stops nagging about idle sessions

- **The quit confirmation now appears only when quitting would interrupt a
  turn in flight.** It used to fire for any open tab — and since an idle
  claude tab keeps its process alive, a sidebar full of resting sessions (the
  normal state of this app) meant a dialog on every single quit. Idle
  sessions, sessions waiting on an answer, and finished-unread sessions all
  survive a quit — relaunching restores the tabs and resumes them — so they
  quit silently now.
- The one case that still confirms: a session that is actually mid-turn, by
  Claude's own self-reported status (the same signal as the sidebar spinner).
  The dialog says what's at stake and how many turns it would interrupt, and
  notes that idle sessions are unaffected.
- Two deliberate edges: shell tabs no longer block quitting (a bare prompt and
  a running command are indistinguishable from the outside), and a tab so new
  the index hasn't registered it (~2 seconds) quits without asking.

## v0.6.2 — 2026-07-30

### Half a gigabyte back

- **The semantic-search model now runs on a schedule instead of living in
  memory.** The ONNX runtime's allocator never shrinks: the largest batch it
  ever serves becomes the app's memory floor until quit — measured at 512 MB,
  the single biggest allocation in the process. The embedder now wakes at
  launch and then twice a day, indexes whatever is new, and unloads the model
  completely; the arena and the 110 MB of weights go back to the OS. On a day
  where nothing changed, the model never loads at all.
- **What that trades:** between runs, search is keyword ranking — the palette
  says so — and new sessions join the *semantic* index at the next run rather
  than within seconds. Everything is keyword-searchable the moment it is
  written, exactly as before.

### "Files changed" stops re-reading the world

- The Briefing panel's file list used to re-parse the session's entire
  transcript on refresh — tens of megabytes on a long session, up to once a
  second while it worked. The scan is now incremental: it remembers where it
  stopped, detects rewrites, and pays only for the lines appended since. An
  unchanged transcript costs a 64-byte probe.
- Subagent transcripts get the same treatment individually, so one agent
  finishing no longer re-parses every sibling. Finding those files (a walk
  across every project dir) is also cached briefly.
- Session topic hues are still maintained for future use, but no longer poke
  the UI after embedding work — nothing on screen renders them anymore.

## v0.6.1 — 2026-07-30

### The app no longer freezes under load

v0.6.0 could drive the whole machine into "not responding" territory while
sessions were active — sustained CPU near half a core and memory climbing
toward 2 GB, until macOS started swapping and every app beachballed. Three
compounding causes, all fixed:

- **The end of every turn triggered the expensive UI fan-out, twice.** Storing
  the quiet "finished" marker rebuilt the menu-bar tray and broadcast the same
  global event the file watcher uses — which every open panel answers by
  re-reading its session's transcript from disk. Turn ends now send a
  lightweight "session list changed" signal instead; the tray and dock badge
  are only rebuilt when a session actually starts or stops waiting on you.
- **The Briefing panel re-read the whole transcript up to 2.5× per second.**
  It refreshed on every watcher tick — even collapsed, when it renders as a
  30px rail. On a long session that transcript is tens of megabytes, so an
  actively-working session cost a re-parse of the entire file several times a
  second, forever. A collapsed panel now does nothing at all, and an open one
  coalesces bursts to at most one refresh every 1.2 seconds.
- **"Files changed" re-parsed transcripts that hadn't changed.** The watcher's
  tick is global — any session's file moving made the panel re-read its own
  session's file too. The parse is now cached behind a size+mtime fingerprint,
  so an unchanged transcript costs a stat instead of a full read.

Measured on the same machine and workload that froze: CPU while a large
session works dropped from ~49% sustained to ~9%, idle settles at ~1%, and
swap pressure returned to normal.

## v0.6.0 — 2026-07-30

### Notifications tell you what actually happened

- **A session you walked away from no longer claims it needs you.** Claude Code
  sends at least a dozen different meanings through a single notification event,
  and Drydock treated every one of them as "waiting for your input" — including
  the one that fires *because you stopped typing*. An idle session never emits a
  stop event, so nothing could ever clear it: every session you left alone
  accumulated a permanent amber dot and a permanent +1 on the dock badge.
  Drydock now reads the notification's type and sorts it into one of four
  outcomes, three of which stay quiet.
- **"Finished" and "needs an answer" are different things now.** A turn that
  ends gets a green check and a silent notification; only a real question gets
  amber, a pulse and a sound. The check clears as soon as you look at that pane
  with the window focused, so switching away and coming back no longer re-pings
  you about something you already read.
- **A turn killed by a rate limit says so.** Drydock now registers for the
  stop-failure event it used to ignore, so a turn that dies on a rate limit or
  an API error tells you the reason instead of quietly going green.
- The dock badge counts questions only. A finished turn is news, not a request.

### The sidebar reads as a list again

Every row used to carry a 3px stripe *and* a 10%-alpha background wash, coloured
by what the session was about. Measured against a real index, that colour was a
coin flip: two rows wearing the same colour were the same kind of work about half
the time, and two sessions that genuinely were the same kind of work looked alike
29% of the time — while the wash covered 53% of the sidebar and, between
neighbouring rows, differed by less than the eye can resolve.

- **The row wash is gone.** The selected row gets a plain fill instead, which is
  a distinction you can actually see. Colour on screen is down 86%.
- **The stripe now says which project a session belongs to,** in one of six
  low-chroma colours matched by a chip on the group header — a claim you can
  check against the label two rows up, rather than one about the session's
  contents that you can't check at all.
- **"Needs you" and "idle" are different shapes,** not one dot in two colours.
  Idle is a hollow ring; a blocked session is a solid disc with a bang in it.
  The distinction survives colourblindness now; it didn't before.
- **A NEEDS YOU block appears at the top** when something is genuinely blocked,
  with running and just-finished sessions beneath it. Neither section exists
  when it has nothing in it.
- **Project groups show five sessions and an "N older" toggle,** and rows fade
  as they age. Past about five, a list stops being something you scan — ⌘K was
  always going to beat scrolling for the rest.

### Twelve more themes

Gruvbox, Tokyo Night, Catppuccin, Rosé Pine, Kanagawa, Vesper and One Light,
with light counterparts where they have them — 19 in all, now split into Dark
and Light groups under Settings → Appearance.

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
