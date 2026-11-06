# Changelog

Each tagged release's `## vX.Y.Z` section becomes the GitHub release body and
the in-app updater's release notes (extracted by `scripts/release-notes.py` in
CI — a tag without its section fails the release).

## v1.0.0 — 2026-11-05

Drydock 1.0 is the first official release: a local macOS workspace for finding,
resuming, reviewing, and handing off coding-agent sessions.

- **A cohesive workspace.** Refreshed Home, sidebar, tabs, session details,
  Settings, search, and launch dialogs share consistent typography, spacing,
  controls, icons, and quieter separators. Home adapts to narrow windows and
  puts session search and creation within reach. Existing theme palettes carry
  through the new surfaces.
- **Richer Codex briefings.** Read the latest successful plan, track successful
  patches with file and line counts, and see token usage without double-counting
  repeated usage events. Briefing cards now use the source harness: Claude for
  Claude sessions, Codex for Codex sessions. Codex's card model can be set with
  `codex_card_model`; its provider configuration and authentication are retained.
- **Clear refresh state.** Card refreshes show progress and CLI errors, with a
  bounded execution time. Threads without readable local rollouts explain which
  briefing data is unavailable. Claude-only checkpoint controls stay out of
  Codex sessions.
- **Cross-agent workflows.** Independent snapshot reviews and editable context
  handoffs connect Claude Code and Codex, with saved results, source links,
  cancellation, and stale-review detection.
- **Clean builds.** The terminal engine has its own bundle, keeping each
  JavaScript chunk below the existing size warning threshold. Removed obsolete
  Rust code and build warnings.

Codex file tracking covers recorded patches; arbitrary shell edits cannot be
attributed from a rollout. Compressed and database-only conversation content
is not yet imported, and checkpoint history remains Claude-only. macOS builds
are for Apple Silicon and are not yet Apple Developer ID signed or notarized.

## v0.9.0 — 2026-11-05

- **Review with another agent.** Open an indexed session's Briefing panel and
  choose **Review with…** to ask Claude Code or Codex for an independent code
  review. The reviewer receives a captured source snapshot, the diff and your
  acceptance criteria, without the builder's conversation. Findings include
  severity, file/line locations, explanations and suggested reproductions.
  Inspect the captured source, copy selected findings back to your original
  agent, or prepare a fixes handoff. Changed files mark the review stale.
- **Continue work across harnesses.** **Handoff…** creates an editable packet
  containing the goal, source identity, working directory, recent conversation,
  briefing and current diff. Choose the destination and open a new interactive
  agent session with that context. Source/destination links are retained;
  Codex pairing uses a unique handoff marker to avoid linking another session
  that happens to be running in the same directory.
- **Saved, bounded review jobs.** Results and errors survive restarts. Reviews
  can be cancelled, time out after five minutes and run at most two at once.
  Interrupted reviews are not automatically restarted. Reviewers use read-only
  controls and do not execute tests or apply fixes automatically.
- **Explicit agent selection.** Both flows show enabled Claude Code/Codex
  profiles. Claude Code is enabled by default; enable Codex in Settings →
  Agents to add it. The dialog now explains this when only one is enabled.

Review jobs use the installed CLI binaries. Codex review jobs use the standard
provider/login without custom user configuration; interactive handoffs use
profile startup commands. Handoffs share the source working files, so pause
other agents editing them. Separate task workspaces are a future feature.

## v0.8.4 — 2026-11-05

- **Semantic search wakes when you search.** Keyword matches appear immediately,
  then the local embedding model loads on demand to enrich the results. It
  unloads after two minutes without searches or indexing work. Document
  embeddings still catch up at startup and twice daily.
- **Search filters apply before the result cap.** Project, starred, and live
  filters no longer lose matches to unrelated sessions. Multiple matching
  chunks from one session cannot crowd other sessions out; hidden sessions
  stay out of search and automatic briefing generation.
- **Safer indexing.** Failed or incomplete project-directory scans no longer
  count as deleted transcripts. Claude sync leaves other agents' indexed
  content alone, and simultaneous agent writes wait rather than failing to
  upgrade a stale database transaction.
- **Codex JSONL transcripts join the shared index.** Read conversations and
  tool calls, search their content, export Markdown, star sessions, and get
  briefing cards through your configured Claude CLI. Database-only threads
  remain discoverable and searchable by title; compressed and database-only
  conversation content is not yet imported.
- **Recent projects fill the new-session input.** Use arrows to highlight a
  project, then Tab, right arrow, Enter, or a click to fill its path for
  editing. Enter again starts the session. Keyboard hints, selection scrolling,
  and accessible suggestion semantics make the flow easier to follow.

## v0.8.3 — 2026-08-17

- **Codex sessions now wear codex's own names.** Sidebar rows read the thread
  list straight from codex's local database: the AI-generated thread name (or
  your rename in codex) becomes the title, with the first prompt as the
  subtitle. Just as important, recent codex versions (≥ ~0.147) stopped
  keeping session files where Drydock looked — sessions moved into that
  database and old rollouts into an archive folder — so without this, codex
  rows would silently thin out and new "paginated" threads would never appear
  at all. Older codex installs keep working through the original file scan,
  and codex-internal subagent threads are filtered out. Read-only, as always:
  Drydock never writes another tool's data — which also means DB-only threads
  offer Hide instead of Delete.

## v0.8.2 — 2026-08-17

- **Agent commands can now be full shell lines.** A startup command like
  `export FOO=1 && codex` used to kill the tab instantly with "exited 0" —
  the launcher wrapped every command in `exec`, and zsh runs `exec export …`
  as "run the builtin, then exit the shell". Compound commands (env setup,
  `&&` chains, pipes) now launch correctly, and codex turn-finished badges,
  claude hooks, and resume all survive the env prefix — Drydock finds the
  agent inside the line instead of requiring it to come first.

## v0.8.1 — 2026-08-14

- **Codex sessions get the sidebar context menu.** Right-click any codex row
  to rename it, file it into a folder (dragging works too), hide it, or delete
  it permanently — the delete removes the session file from `~/.codex` behind
  the same path-safety guard as claude deletes. Star, transcript view, and
  take-over remain claude-only for now.
- **The window is actually draggable now.** Two bugs stacked: the drag
  permission (`core:window:allow-start-dragging`) was never granted, so every
  drag region in the app was silently dead — and the only region that existed
  was a few empty pixels in the sidebar header anyway. The permission is
  granted, and the whole top edge now drags the window like a title bar
  should: the sidebar header (the DRYDOCK corner — its Home label and buttons
  still click; a drag starts once the pointer moves), the collapsed-sidebar
  rail, and the tab strip's empty space.

## v0.8.0 — 2026-08-14

### Agents beyond Claude

- **Launch any coding agent in a tab — strictly opt-in.** Enable codex, pi,
  opencode, Copilot, Cursor, droid, or Gemini in **Settings → Agents** (or add
  any custom command). Out of the box only Claude Code is enabled, so nothing
  changes until you opt in. With more than one agent enabled, every new
  session (⌘N, Home, sidebar ＋) first asks which agent to start; with one, it
  launches directly — exactly today's behavior.
- **Every agent's startup command is yours to set** — Claude Code's included:
  make it `claude --some-option` and new sessions, resumes, and post-update
  restores all use it.
- **Sessions declare their agent.** Tabs and sidebar rows wear a small
  monogram in the agent's color, and the tab strip washes in the active
  agent's color (window tint — toggle in Settings → Agents) so a codex window
  never gets mistaken for a claude one.
- Agent tabs live in the sessions lane and survive update restarts.
- **Codex sessions live in the sidebar.** Drydock discovers codex's session
  files (`~/.codex/sessions`) — every codex conversation shows up beside your
  claude sessions with the OpenAI mark, grouped by project, with live activity
  status; click to resume it in a tab (`codex resume`). New codex tabs pair
  with their session automatically, resume across update restarts, and report
  "turn finished" through codex's own notify hook — injected per-launch, never
  written into `~/.codex`. (Transcript reading/search for codex comes later.)
- **Real agent marks.** Tabs, sidebar rows, the picker, and Settings wear each
  agent's actual mark (Claude, OpenAI, Gemini, Copilot, Cursor, droid,
  opencode, π) — monochrome, tinted per agent, legible on all 12 themes.
  Custom agents keep their monogram. The window tint covers claude tabs too
  (claude’s clay); only shells stay neutral.
- **Quitting Drydock now ends every session and terminal on every exit path.**
  Closing the window with ✕ used to leave claude/agent/shell processes running
  in the background; now ⌘Q, window close, and Dock → Quit all terminate every
  tab's whole process group.

## v0.7.1 — 2026-08-14

### The overnight display fix

- **Waking from a long sleep no longer leaves the window scrambled.** After a
  lid-close, macOS purges the GPU surfaces behind the webview; the app woke
  compositing stale tiles, and every terminal's WebGL context came back dead —
  the only cure was quitting and reopening. Drydock now detects the wake
  (natively, with a clock-jump fallback) and repairs itself in place: the
  layer tree is rebuilt and every terminal re-arms its GPU renderer, refreshes
  its glyph atlas, and repaints. Nothing is lost — tabs, scrollback, and
  running sessions all stay put.
- A terminal whose WebGL context died used to fall back to the slower DOM
  renderer *permanently* (visible as scroll jank in Claude's UI). The fallback
  still happens, but the next wake sweep restores the GPU renderer.

## v0.7.0 — 2026-07-31

### Modern chrome

- **A chrome pass over the whole app**: the titlebar becomes an overlay so the
  window is all content, window controls soften, and transitions animate. A
  new **Classic Dark** theme — modeled on VS Code / Cursor's "Dark Modern" —
  joins the theme picker.
- Under the hood, the frontend reorganized around a design-token layer and
  CSS modules, with tests guarding the styling contract — groundwork that
  made the chrome pass possible and makes future themes cheaper.

### Permission grants that stick

- **macOS folder-access grants no longer reset on every rebuild.** macOS keys
  privacy permissions to an app's code signature, and ad-hoc builds get a new
  signature every compile — so each upgrade looked like a brand-new app and
  re-asked for Documents, Desktop, and friends. Local builds via
  `scripts/build-app.sh` now sign with whatever Apple code-signing identity
  the machine has (a free "Apple Development" certificate from Xcode is
  enough), giving the app a stable identity that keeps grants across
  rebuilds. Downloaded builds are unchanged for now — a Developer ID
  certificate is the eventual fix there.
- Two things worth knowing while we're on the subject: granting Drydock Full
  Disk Access removes the per-folder prompts entirely, and when a prompt
  mentions Music or Photos it is macOS attributing a terminal command's file
  sweep (say, an agent running `grep` across your home directory) to the app
  hosting the terminal — the same reason Terminal.app asks about Documents.

### Develop Drydock beside Drydock

- `npm run tauri:dev` (or `scripts/build-app.sh --config
  src-tauri/tauri.dev.conf.json`) now runs as **Drydock Dev**, with its own
  bundle identifier and data directory. A development build and a daily
  install can run side by side without contending for one database.

## v0.6.4 — 2026-07-30

### ⌘W stops nagging too

- **Closing a tab now asks for confirmation only when that session is
  mid-turn** — the same rule ⌘Q got in v0.6.3, scoped to one tab. An idle
  session closes silently; it stays resumable from the sidebar and nothing in
  flight is lost. The dialog, when it does appear, says what it means:
  closing interrupts the turn, not "ends" the session.
- Both guards now share one predicate, and it gained a correction over
  v0.6.3: a **read-only transcript tab** carries a session id but owns no
  process, so having one open on a working session no longer triggers the
  quit confirmation. Reading a busy session is not killing it.

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
