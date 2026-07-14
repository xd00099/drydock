//! Loopback MCP server that lets a Claude Code session render an artifact in
//! Drydock's right-panel "Artifacts" tab.
//!
//! Why this shape (see docs/artifact-preview.md for the full rationale): Claude
//! Code is a terminal MCP *client* and cannot render HTML. But because Drydock
//! supplies the MCP server, the `render_artifact` tool call lands in Drydock's
//! own process — so Drydock reads the payload and renders it in its own webview,
//! returning a short text ack to the model. We invert the usual MCP-Apps roles:
//! Drydock is both the server and the renderer.
//!
//! The transport is a hand-rolled minimal Streamable-HTTP / JSON-RPC server on
//! `127.0.0.1:0` — no tokio/rmcp, matching Drydock's `std::thread` idiom and
//! adding zero new backend dependencies. A render call carries either inline
//! content OR a path to a file the session wrote — which Drydock reads (size
//! capped) and renders only in its own local webview, the same content the model
//! could already print; it exposes no other read path. Each request is gated by a
//! per-session bearer token (the tab id is guessable; the random token is the
//! auth) and an Origin check (reject non-loopback origins to block DNS-rebinding).
//!
//! NOTHING here is written under ~/.claude.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter};

/// MCP server name (the key in the injected --mcp-config). The tool the model
/// calls is `mcp__<server>__<tool>`, so these two strings define `TOOL_ID`.
pub const SERVER_NAME: &str = "drydock-artifacts";
pub const TOOL_NAME: &str = "render_artifact";
/// Fully-qualified tool id for `--allowedTools` (pre-approves the tool so the
/// model's first call doesn't halt on a permission prompt).
pub const TOOL_ID: &str = "mcp__drydock-artifacts__render_artifact";

/// Second tool: block until the human sends inline feedback on a rendered
/// artifact (the interactive-review loop — the native analog of `lavish-axi
/// poll`). See docs/artifact-review.md.
pub const AWAIT_TOOL_NAME: &str = "await_artifact_feedback";
pub const AWAIT_TOOL_ID: &str = "mcp__drydock-artifacts__await_artifact_feedback";

/// Space-joined `--allowedTools` value pre-approving BOTH tools at spawn.
pub const ALLOWED_TOOLS: &str = "mcp__drydock-artifacts__render_artifact mcp__drydock-artifacts__await_artifact_feedback";

/// How long a single `await_artifact_feedback` call blocks before returning
/// `status:"waiting"` (the model then re-calls). Kept safely under Claude Code's
/// MCP tool-call timeout so the client never aborts the call mid-wait.
const POLL_BLOCK_MS: u64 = 25_000;

/// Bound the per-session feedback queue and each prompt's length so a runaway
/// artifact can't balloon memory; excess is dropped (the render still worked).
const MAX_PROMPTS_PER_SESSION: usize = 200;
const MAX_PROMPT_LEN: usize = 8 * 1024;
/// Cap on remembered delivered-layout-warning keys (repeat/persistent tracking).
const MAX_DELIVERED_LAYOUT_KEYS: usize = 200;

/// System-prompt nudge injected via `--append-system-prompt`. MUST stay a single
/// line with NO single quotes/apostrophes — it is spliced single-quoted into the
/// shell `-c` command. It names the exact tool id because current Claude Code may
/// defer/lazy-load MCP tool schemas, so the model needs an explicit pointer.
pub const NUDGE: &str = "You are running inside Drydock, which has an Artifacts side panel. When you create a self-contained visual artifact for the user to look at (an HTML page or UI mockup, an SVG image or diagram, or a Markdown document), show it by calling the tool mcp__drydock-artifacts__render_artifact with a short title. IMPORTANT for efficiency: if the artifact is in a file (including one you just wrote), pass its `path` (absolute, or relative to your working directory) and do NOT paste the file contents into the call — Drydock reads the file itself, so you avoid regenerating it. Use the `content` argument only for artifacts that are not saved to any file. It renders locally inside Drydock and is not published to claude.ai. After you render an HTML plan or mockup for the user to review, call mcp__drydock-artifacts__await_artifact_feedback to receive the inline annotations the user leaves on it; apply them, re-render, and call it again until it returns status ended. It blocks briefly and returns status waiting when nothing has arrived yet, so just call it again to keep waiting.";

const TOOL_DESCRIPTION: &str = "Render a self-contained visual artifact (HTML page/UI mockup, SVG image/diagram, or Markdown document) in Drydock's Artifacts side panel so the user can SEE it immediately. Pass EITHER `path` (preferred — a file you already wrote; Drydock reads it, so you don't resend or regenerate its content) OR inline `content` (only for artifacts not saved to a file). Renders locally inside Drydock and is NOT published to claude.ai. For an HTML plan/mockup you want reviewed, follow the render with await_artifact_feedback to collect the user's inline annotations.";

const AWAIT_TOOL_DESCRIPTION: &str = "Block until the user sends inline feedback on the HTML artifact you rendered for review, then return it. Call this after render_artifact when you want the user to annotate a plan or mockup. Returns {status:\"feedback\", prompts:[{prompt, selector, tag, text, target?}], layout_warnings?}, or {status:\"waiting\"} after a short wait when nothing has arrived yet (just call it again), or {status:\"ended\"} when the user finishes the review. Follow the returned next_step. Pass `reply` to post a short message into the review panel first.";

/// Reject content larger than this (bytes). Bounds webview memory; the model
/// gets an isError result it can react to.
const MAX_CONTENT: usize = 4 * 1024 * 1024;

/// Keep at most this many HTML artifacts per session in the served store, so a
/// session that re-renders many times can't grow memory without bound (mirrors
/// the frontend's per-tab cap). Older ones are evicted by arrival order.
const MAX_ARTIFACTS_PER_PTY: usize = 20;

/// Artifacts persisted to disk per session (the Artifacts tab's gallery).
/// Oldest content+meta pairs are pruned past this.
const MAX_SAVED_PER_SESSION: usize = 50;

/// Minimal dark-theme wrapper for an HTML *fragment* (a full document keeps its
/// own head/styles). Kept small and inline so a fragment still reads on the dark
/// panel; full pages style themselves.
const ARTIFACT_FRAME_CSS: &str = ":root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#0f1115;color:#e8edf4;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55}";

/// Content-Security-Policy served WITH each HTML artifact (its own isolated
/// `artifact://` origin, so this — not the main app's strict CSP — governs it).
/// Intent: run the artifact's own JavaScript (inline + a few well-known CDN
/// libraries) so charts/animations/clicks work like Chrome, but block it from
/// sending data back out (`connect-src 'none'`: no fetch/XHR/WebSocket/beacon)
/// or navigating/embedding anything. 'self' is deliberately unused — the iframe
/// runs sandboxed (opaque origin), so we permit by explicit source, not origin.
const ARTIFACT_CSP: &str = "default-src 'none'; \
script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://cdn.plot.ly https://d3js.org; \
style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com; \
img-src data: blob: https:; \
media-src data: blob: https:; \
font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; \
worker-src blob:; \
connect-src 'none'; frame-src 'none'; child-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

/// What a per-session bearer token resolves to: the owning pty tab, that
/// session's working directory (resolves relative `path` args to
/// render_artifact), and the session id pinned at spawn (a fallback for hook
/// deliveries whose body carries none).
#[derive(Debug, Clone, PartialEq)]
pub struct TokenInfo {
    pub pty_id: u32,
    pub cwd: Option<PathBuf>,
    pub session_id: Option<String>,
}

/// Per-session render/hook token → its resolution.
type Tokens = Arc<Mutex<HashMap<String, TokenInfo>>>;

/// One rendered artifact, retained so the user can re-fetch (HTML over the
/// `artifact://` scheme), download, or reveal it in Finder. `seq` is the
/// monotonic id (also the map key as a string), used to evict the oldest when a
/// session exceeds the per-pty cap. `path` is the on-disk source when the model
/// rendered from a file (None for inline content).
struct Stored {
    pty_id: u32,
    seq: u64,
    /// Render wall-clock (ms) — compared against the transcript's rewound-to
    /// point to prune artifacts from a discarded timeline.
    created_ms: i64,
    kind: String,
    title: String,
    content: String,
    path: Option<PathBuf>,
}

/// Artifact id (string form of the monotonic counter) → stored artifact. Every
/// kind is kept (download/reveal work for all); only HTML is also served over
/// the `artifact://` scheme — SVG/Markdown render in a sanitized srcdoc.
type Store = Arc<Mutex<HashMap<String, Stored>>>;

// ---- interactive review (annotate + await feedback) --------------------------

/// One queued human annotation or message, as the injected SDK reports it and as
/// `await_artifact_feedback` delivers it to the model. Field names cross the
/// frontend and the model verbatim. `target` (present for text-range selections)
/// carries the selected text + boundary anchors; element clicks omit it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReviewPrompt {
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
}

/// One render-time layout defect the in-iframe audit found. `persistent` flips to
/// true once its `kind:selector` key has already been delivered to the model, so
/// a re-report after a failed fix reads as "still broken", not "fresh".
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LayoutWarning {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default, rename = "overflowPx")]
    pub overflow_px: f64,
    #[serde(default, rename = "viewportWidth")]
    pub viewport_width: f64,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub persistent: bool,
}

/// One session's pending feedback, drained by `await_artifact_feedback`.
#[derive(Default)]
struct SessionFeedback {
    prompts: Vec<ReviewPrompt>,
    layout: Vec<LayoutWarning>,
    delivered_layout_keys: Vec<String>,
    /// The human ended the review. A consumable EDGE, not a latch: delivering it
    /// clears it, so a later render in the same session starts a fresh round.
    ended: bool,
    /// A re-audit came back clean AFTER warnings were delivered — a deliverable
    /// "your fix worked" signal (otherwise an empty audit is indistinguishable
    /// from "nothing happened yet").
    layout_clean: bool,
    /// Consecutive polls that timed out empty. Past a limit the next_step tells
    /// the model to stop polling (each empty round costs it a tool-call cycle).
    waiting_streak: u32,
}

/// Shared feedback state: a per-pty map plus a condvar the poll waits on and the
/// submit/report/release paths notify. One condvar for the whole map is fine —
/// spurious wakes just re-check the caller's own entry.
#[derive(Default)]
pub struct FeedbackHub {
    map: Mutex<HashMap<u32, SessionFeedback>>,
    cv: Condvar,
}

impl FeedbackHub {
    /// Drop a session's queue and wake any blocked poll (which then returns
    /// `ended`, since its entry has vanished). Called on pty exit.
    pub fn drop_session(&self, pty_id: u32) {
        self.map.lock().unwrap().remove(&pty_id);
        self.cv.notify_all();
    }

    /// A new HTML artifact was rendered for this session: its pending layout
    /// report belongs to the PREVIOUS document, so clear it (delivered keys are
    /// kept — "still broken after the re-render" must read as persistent), and
    /// reset the empty-poll streak (a fresh render restarts engagement).
    fn begin_render(&self, pty_id: u32) {
        let mut map = self.map.lock().unwrap();
        if let Some(fb) = map.get_mut(&pty_id) {
            fb.layout.clear();
            fb.layout_clean = false;
            fb.waiting_streak = 0;
        }
    }

    /// The session's timeline went backwards (Claude Code rewind): everything
    /// this round accumulated — queued prompts, layout state, delivered keys,
    /// the end flag — describes a discarded future. Start the round over.
    fn reset_round(&self, pty_id: u32) {
        {
            let mut map = self.map.lock().unwrap();
            if let Some(fb) = map.get_mut(&pty_id) {
                fb.prompts.clear();
                fb.layout.clear();
                fb.layout_clean = false;
                fb.delivered_layout_keys.clear();
                fb.ended = false;
                fb.waiting_streak = 0;
            }
        }
        self.cv.notify_all(); // a parked poll re-checks and keeps waiting
    }

    /// A poll drained this batch but the response write failed (the client
    /// aborted the call while the poll was parked — Esc, timeout, crash): put
    /// the feedback BACK so the next poll delivers it instead of losing it.
    fn requeue(&self, pty_id: u32, mut prompts: Vec<ReviewPrompt>, layout: Vec<LayoutWarning>, ended: bool) {
        {
            let mut map = self.map.lock().unwrap();
            // A vanished entry means the session itself is gone — nothing to save.
            let Some(fb) = map.get_mut(&pty_id) else { return };
            prompts.append(&mut fb.prompts); // drained batch back in FRONT, order kept
            fb.prompts = prompts;
            if fb.layout.is_empty() {
                fb.layout = layout; // a newer audit (if any) outranks the drained one
            }
            fb.ended |= ended;
        }
        self.cv.notify_all();
    }
}

/// Char-boundary-safe truncation for attacker-influenceable strings (a hostile
/// artifact can put anything in selector/text/tag via window.dd).
fn clamp_str(s: &mut String, max: usize) {
    if s.len() > max {
        let mut cut = max;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
}

type Feedback = Arc<FeedbackHub>;

/// What `await_artifact_feedback` returns to the model (JSON-stringified into the
/// tool result). `next_step` is agent-facing guidance mirroring lavish-axi.
#[derive(Debug, PartialEq, serde::Serialize)]
struct PollResult {
    status: String, // "feedback" | "waiting" | "ended"
    #[serde(skip_serializing_if = "Vec::is_empty")]
    prompts: Vec<ReviewPrompt>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    layout_warnings: Vec<LayoutWarning>,
    #[serde(skip_serializing_if = "is_false")]
    session_ended: bool,
    /// True when a re-audit came back clean after warnings had been delivered —
    /// "your layout fix worked".
    #[serde(skip_serializing_if = "is_false")]
    layout_clean: bool,
    next_step: String,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Artifact pushed to the webview. Field names cross to the frontend verbatim.
#[derive(Clone, serde::Serialize)]
struct ArtifactEvent {
    pty_id: u32,
    id: String,
    title: String,
    kind: String,
    content: String,
    /// Absolute source path when rendered from a file (enables "Reveal in
    /// Finder"); null for inline content.
    path: Option<String>,
}

/// Managed Tauri state: the ephemeral port, the live token map, and the disk
/// gallery root. `pty_spawn` mints a token per claude tab; the serve thread
/// resolves tokens to tab ids.
pub struct ArtifactServer {
    pub port: u16,
    tokens: Tokens,
    store: Store,
    /// Per-session interactive-review feedback queue + wait condvar.
    feedback: Feedback,
    /// Root of the persisted gallery: `<dir>/<session_id>/<ms>-<seq>.<ext>`
    /// plus a `.meta.json` sidecar per artifact.
    dir: PathBuf,
}

impl ArtifactServer {
    /// Bind the loopback listener and start the accept thread. The server always
    /// listens — it's token-gated, so an idle/disabled state simply means no
    /// tokens are minted (every request 401s). Whether new sessions get the tool
    /// is decided at spawn time from settings (`artifacts_enabled`), which lets
    /// the user toggle it at runtime without restarting the listener.
    pub fn start(app: AppHandle, dir: PathBuf) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let tokens: Tokens = Arc::new(Mutex::new(HashMap::new()));
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        let feedback: Feedback = Arc::new(FeedbackHub::default());
        let t = Arc::clone(&tokens);
        let s = Arc::clone(&store);
        let f = Arc::clone(&feedback);
        let d = dir.clone();
        std::thread::spawn(move || serve(listener, t, s, f, app, d));
        Ok(Self { port, tokens, store, feedback, dir })
    }

    /// HTML for an artifact id, for the `artifact://` scheme handler. Live ids
    /// are the in-memory counter; `saved/<session>/<file>` ids read the disk
    /// gallery (components strictly validated — no traversal). Only HTML is
    /// served this way; other kinds return None.
    pub fn lookup_html(&self, id: &str) -> Option<String> {
        if let Some(rest) = id.strip_prefix("saved/") {
            let (sid, file) = rest.split_once('/')?;
            if !valid_session_component(sid) || !valid_saved_file(file) || !file.ends_with(".html") {
                return None;
            }
            return std::fs::read_to_string(self.dir.join(sid).join(file)).ok();
        }
        let m = self.store.lock().unwrap();
        m.get(id).filter(|s| s.kind == "html").map(|s| s.content.clone())
    }

    /// The persisted gallery for a session, oldest first.
    pub fn list_saved(&self, session_id: &str) -> Vec<SavedArtifact> {
        list_saved_in(&self.dir, session_id)
    }

    /// Raw content of one persisted artifact (frontend renders svg/markdown
    /// through the sanitized srcdoc path).
    pub fn read_saved(&self, session_id: &str, file: &str) -> Option<String> {
        if !valid_session_component(session_id) || !valid_saved_file(file) {
            return None;
        }
        std::fs::read_to_string(self.dir.join(session_id).join(file)).ok()
    }

    /// Download name + bytes for a persisted artifact (mirrors artifact_download).
    pub fn saved_download(&self, session_id: &str, file: &str) -> Option<(String, Vec<u8>)> {
        let content = self.read_saved(session_id, file)?;
        let meta = self
            .list_saved(session_id)
            .into_iter()
            .find(|s| s.file == file)?;
        let source = meta.path.as_deref().map(Path::new);
        Some((download_filename(&meta.title, &meta.kind, source), content.into_bytes()))
    }

    /// On-disk source path for an artifact, when it was rendered from a file
    /// (used by "Reveal in Finder"; None for inline-content artifacts).
    pub fn artifact_path(&self, id: &str) -> Option<PathBuf> {
        self.store.lock().unwrap().get(id).and_then(|s| s.path.clone())
    }

    /// A suggested download filename and the bytes to write, for "Download".
    pub fn artifact_download(&self, id: &str) -> Option<(String, Vec<u8>)> {
        let m = self.store.lock().unwrap();
        let s = m.get(id)?;
        Some((download_filename(&s.title, &s.kind, s.path.as_deref()), s.content.clone().into_bytes()))
    }

    /// Mint a token for a tab id (call once per claude spawn). `cwd` is the
    /// session's working directory, used to resolve relative artifact paths;
    /// `session_id` is the id pinned at spawn. The token travels in the injected
    /// --mcp-config / hook-command Authorization header; never a cmdline arg.
    pub fn mint(&self, pty_id: u32, cwd: Option<PathBuf>, session_id: Option<String>) -> String {
        let token = random_token();
        self.tokens.lock().unwrap().insert(token.clone(), TokenInfo { pty_id, cwd, session_id });
        token
    }

    /// Drop every token AND stored artifact for a tab id (on pty exit) — an
    /// ended session keeps nothing in memory. Also drops any pending review
    /// feedback and wakes a poll blocked on it.
    pub fn release(&self, pty_id: u32) {
        self.tokens.lock().unwrap().retain(|_, v| v.pty_id != pty_id);
        self.store.lock().unwrap().retain(|_, s| s.pty_id != pty_id);
        self.feedback.drop_session(pty_id);
    }

    /// Shared handle to the token map, for an exit closure that outlives `&self`.
    pub fn tokens_handle(&self) -> Tokens {
        Arc::clone(&self.tokens)
    }

    /// Shared handle to the feedback hub, for the exit closure (mirrors
    /// `tokens_handle`) — lets a dying pty drop its queue and wake a blocked poll.
    pub fn feedback_handle(&self) -> Feedback {
        Arc::clone(&self.feedback)
    }

    /// Queue the human's annotations/messages for `pty_id` (frontend →
    /// `submit_artifact_feedback`) and wake the session's poll. Over-long prompts
    /// are truncated and the queue is capped (oldest dropped) to bound memory.
    pub fn submit_feedback(&self, pty_id: u32, prompts: Vec<ReviewPrompt>, end_review: bool) {
        {
            let mut map = self.feedback.map.lock().unwrap();
            let fb = map.entry(pty_id).or_default();
            for mut p in prompts {
                // Every field is attacker-influenceable (window.dd in the
                // artifact) and lands verbatim in the model's context — bound
                // them all, not just the comment.
                clamp_str(&mut p.prompt, MAX_PROMPT_LEN);
                clamp_str(&mut p.selector, 1024);
                clamp_str(&mut p.tag, 64);
                clamp_str(&mut p.text, 4 * 1024);
                clamp_str(&mut p.uid, 128);
                if let Some(t) = &p.target {
                    if serde_json::to_string(t).map(|s| s.len()).unwrap_or(usize::MAX) > 8 * 1024 {
                        p.target = None;
                    }
                }
                fb.prompts.push(p);
            }
            if fb.prompts.len() > MAX_PROMPTS_PER_SESSION {
                let drop = fb.prompts.len() - MAX_PROMPTS_PER_SESSION;
                fb.prompts.drain(0..drop);
            }
            if end_review {
                fb.ended = true;
            }
            fb.waiting_streak = 0; // the user engaged
        }
        self.feedback.cv.notify_all();
    }

    /// The session's transcript rewound to `tail_ms`: artifacts rendered after
    /// that point belong to a discarded timeline. Drop them from the live
    /// in-memory store, record the discarded window in the session's gallery
    /// (persisted copies stay, badged "rewound"), and reset the review round.
    /// Returns (pty_id, removed live artifact ids) per open tab of the session.
    pub fn handle_rewind(&self, session_id: &str, tail_ms: i64) -> Vec<(u32, Vec<String>)> {
        append_rewound_window(&self.dir, session_id, tail_ms, now_ms());
        let ptys: Vec<u32> = self
            .tokens
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.session_id.as_deref() == Some(session_id))
            .map(|t| t.pty_id)
            .collect();
        let mut removed: Vec<(u32, Vec<String>)> = Vec::new();
        if !ptys.is_empty() {
            let mut m = self.store.lock().unwrap();
            for &pty in &ptys {
                let ids: Vec<String> = m
                    .iter()
                    .filter(|(_, s)| s.pty_id == pty && s.created_ms > tail_ms)
                    .map(|(k, _)| k.clone())
                    .collect();
                for id in &ids {
                    m.remove(id);
                }
                removed.push((pty, ids));
            }
        }
        for &pty in &ptys {
            self.feedback.reset_round(pty);
        }
        removed
    }

    /// Replace the current layout warnings for `pty_id` (frontend →
    /// `report_layout_warnings`), marking any whose `kind:selector` key was
    /// already delivered as `persistent`, and wake the poll.
    pub fn report_layout(&self, pty_id: u32, mut warnings: Vec<LayoutWarning>) {
        warnings.truncate(100); // a hostile page can't flood the queue
        {
            let mut map = self.feedback.map.lock().unwrap();
            let fb = map.entry(pty_id).or_default();
            // An EMPTY audit after warnings were delivered is meaningful ("the
            // fix worked") — flag it deliverable. Empty before any delivery is
            // just a clean page: nothing to say.
            if warnings.is_empty() {
                fb.layout_clean = !fb.delivered_layout_keys.is_empty();
            } else {
                fb.layout_clean = false;
            }
            for w in &mut warnings {
                clamp_str(&mut w.kind, 64);
                clamp_str(&mut w.selector, 1024);
                clamp_str(&mut w.severity, 16);
                w.persistent = fb.delivered_layout_keys.contains(&layout_key(w));
            }
            // Only a MEANINGFUL report counts as engagement — a routine empty
            // audit (every iframe remount posts one) must not keep resetting
            // the model's give-up counter.
            if !warnings.is_empty() || fb.layout_clean {
                fb.waiting_streak = 0;
            }
            fb.layout = warnings;
        }
        self.feedback.cv.notify_all();
    }
}

fn layout_key(w: &LayoutWarning) -> String {
    format!("{}:{}", w.kind, w.selector)
}

/// 128 bits of OS randomness, URL-safe base64 (header-safe charset). Fails loud
/// rather than ever handing out a predictable token (e.g. all-zeros).
fn random_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn serve(listener: TcpListener, tokens: Tokens, store: Store, feedback: Feedback, app: AppHandle, dir: PathBuf) {
    let counter = Arc::new(AtomicU64::new(1));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let tokens = Arc::clone(&tokens);
        let store = Arc::clone(&store);
        let feedback = Arc::clone(&feedback);
        let app = app.clone();
        let counter = Arc::clone(&counter);
        let dir = dir.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, &tokens, &store, &feedback, &app, &counter, &dir);
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_conn(
    mut stream: TcpStream,
    tokens: &Tokens,
    store: &Store,
    feedback: &Feedback,
    app: &AppHandle,
    counter: &AtomicU64,
    dir: &Path,
) -> std::io::Result<()> {
    // Idle keep-alive connections must not pin a thread forever. The window must
    // exceed POLL_BLOCK_MS: while an await_artifact_feedback call is parked on
    // the condvar, this thread is inside route_with — the timeout only governs
    // reads BETWEEN requests, but keep the margin generous anyway.
    stream.set_read_timeout(Some(Duration::from_secs(120))).ok();
    // Disable Nagle's algorithm: responses are small JSON written right after the
    // request is read, and Nagle + the client's delayed-ACK would otherwise add a
    // ~40ms (up to 200ms) stall to every MCP call on loopback.
    stream.set_nodelay(true).ok();
    loop {
        let Some(req) = read_request(&mut stream)? else { return Ok(()) };
        let keep_alive = header(&req, "connection")
            .map(|c| !c.eq_ignore_ascii_case("close"))
            .unwrap_or(true);

        // DNS-rebinding guard: a non-loopback Origin means a browser page is
        // probing us; the legitimate CLI client sends no Origin at all.
        if !origin_allowed(header(&req, "origin")) {
            write_status(&mut stream, 403, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        }

        let status_only = match req.method.as_str() {
            "OPTIONS" => Some(204),
            "DELETE" => Some(204),               // session teardown (we are stateless)
            "GET" => Some(405),                  // no server-initiated SSE stream
            "POST" if req.path.starts_with("/mcp") || req.path.starts_with("/hook") => None,
            _ => Some(404),
        };
        if let Some(code) = status_only {
            write_status(&mut stream, code, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        }

        // Auth: resolve the bearer token to its session info.
        let resolved = {
            let map = tokens.lock().unwrap();
            resolve_token(header(&req, "authorization"), &map)
        };
        let Some(TokenInfo { pty_id, cwd, session_id }) = resolved else {
            write_status(&mut stream, 401, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        };

        // Hook delivery (Notification/Stop stdin JSON forwarded by the injected
        // hook command): update the attention state, no body in the response.
        if req.path.starts_with("/hook") {
            crate::attention::handle_hook(app, pty_id, session_id.as_deref(), &req.body);
            write_status(&mut stream, 204, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        }

        let ctx = PollCtx { hub: feedback, pty_id, app, block: Duration::from_millis(POLL_BLOCK_MS) };
        let routed = route_with(&req.body, cwd.as_deref(), Some(&ctx));
        for e in &routed.emits {
            // A fresh HTML render supersedes the previous document's pending
            // layout report and restarts the review round's engagement clock.
            if e.kind == "html" {
                feedback.begin_render(pty_id);
            }
            let seq = counter.fetch_add(1, Ordering::Relaxed);
            let id = seq.to_string();
            // Retain every artifact so Download / Reveal-in-Finder work for all
            // kinds and HTML can be re-fetched over the artifact:// scheme.
            store_insert(store, &id, pty_id, seq, now_ms(), &e.kind, &e.title, &e.content, e.path.clone());
            // ...and persist it to the session's on-disk gallery, so it survives
            // the session and the app (the Artifacts tab lists these as "saved").
            if let Some(sid) = &session_id {
                persist_artifact(dir, sid, seq, &e.kind, &e.title, &e.content, e.path.as_deref());
            }
            // HTML runs its own JS, so it loads from the isolated artifact://
            // origin via an <iframe src> — send NO inline content on the event.
            // SVG/Markdown need no scripting; they ride the payload and render
            // through the sanitized srcdoc path.
            let content = if e.kind == "html" { String::new() } else { e.content.clone() };
            let path = e.path.as_ref().map(|p| p.display().to_string());
            let _ = app.emit(
                "artifact",
                ArtifactEvent { pty_id, id, title: e.title.clone(), kind: e.kind.clone(), content, path },
            );
        }
        let write_res = match &routed.json {
            Some(v) => write_json(&mut stream, routed.status, v, keep_alive),
            None => write_status(&mut stream, routed.status, keep_alive),
        };
        if let Err(e) = write_res {
            // The client is gone (it aborted the call — Esc, timeout, crash). A
            // poll that just drained feedback must NOT lose it: put the batch
            // back so the next poll delivers it.
            if let Some(r) = routed.redeliver {
                feedback.requeue(r.pty_id, r.prompts, r.layout, r.ended);
            }
            return Err(e);
        }
        if !keep_alive {
            return Ok(());
        }
    }
}

// ---- HTTP parsing ------------------------------------------------------------

struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>, // keys lowercased
    body: Vec<u8>,
}

fn header<'a>(req: &'a Req, name: &str) -> Option<&'a str> {
    req.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Read one HTTP/1.1 request. Generic over `Read` so it unit-tests with a
/// Cursor. Returns Ok(None) on a clean close / oversized header.
fn read_request<R: Read>(stream: &mut R) -> std::io::Result<Option<Req>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > 64 * 1024 {
            return Ok(None); // header too large; refuse
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = head.split("\r\n");
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok(None); // connection closed mid-body: incomplete request
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length); // drop anything past this request's body
    Ok(Some(Req { method, path, headers, body }))
}

// Each response is built into ONE buffer and written with a single `write_all`,
// so it leaves as one TCP segment. `write!`'s piecewise writes would otherwise
// emit several tiny segments per response — extra syscalls and, with Nagle, a
// stall (we also set TCP_NODELAY on the stream).
fn write_status<W: Write>(w: &mut W, code: u16, keep_alive: bool) -> std::io::Result<()> {
    let reason = match code {
        204 => "No Content",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let resp = format!("HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: {conn}\r\n\r\n");
    w.write_all(resp.as_bytes())?;
    w.flush()
}

fn write_json<W: Write>(w: &mut W, code: u16, body: &Value, keep_alive: bool) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let mut resp = format!(
        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {conn}\r\n\r\n",
        bytes.len()
    )
    .into_bytes();
    resp.extend_from_slice(&bytes);
    w.write_all(&resp)?;
    w.flush()
}

// ---- auth / origin -----------------------------------------------------------

fn parse_bearer(h: &str) -> Option<&str> {
    let h = h.trim();
    h.strip_prefix("Bearer ")
        .or_else(|| h.strip_prefix("bearer "))
        .map(str::trim)
}

fn resolve_token(auth: Option<&str>, tokens: &HashMap<String, TokenInfo>) -> Option<TokenInfo> {
    let token = parse_bearer(auth?)?;
    tokens.get(token).cloned()
}

/// Allow the CLI (no Origin) and loopback origins; reject everything else so a
/// malicious web page can't DNS-rebind to our port. Matches the host EXACTLY
/// (not a prefix) so `http://127.0.0.1.evil.com` is rejected.
fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true }; // a CLI client sends no Origin
    let rest = match o.trim().split_once("://") {
        Some(("http", r)) | Some(("https", r)) => r,
        _ => return false,
    };
    // host[:port]; brackets wrap an IPv6 literal (`[::1]:port`).
    let host = if let Some(after) = rest.strip_prefix('[') {
        match after.split_once(']') {
            Some((h, _)) => h,
            None => return false,
        }
    } else {
        rest.split(':').next().unwrap_or(rest)
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

// ---- JSON-RPC routing --------------------------------------------------------

struct Emit {
    title: String,
    kind: String,
    content: String,
    path: Option<PathBuf>,
}

/// Feedback a poll drained from the queue, carried on the response so the
/// transport can put it BACK if the response write fails (client aborted).
struct Redeliver {
    pty_id: u32,
    prompts: Vec<ReviewPrompt>,
    layout: Vec<LayoutWarning>,
    ended: bool,
}

struct Routed {
    status: u16,
    json: Option<Value>,
    emits: Vec<Emit>,
    redeliver: Option<Redeliver>,
}

/// Context for the blocking `await_artifact_feedback` call: which session, the
/// hub to wait on, an app handle to emit presence/replies, and how long to
/// block. Threaded through routing; `None` (unit tests) makes the await tool a
/// fast tool-error instead of blocking.
struct PollCtx<'a> {
    hub: &'a FeedbackHub,
    pty_id: u32,
    app: &'a AppHandle,
    block: Duration,
}

/// Route a raw request body with no poll context (used by unit tests).
#[cfg(test)]
fn route(body: &[u8], cwd: Option<&Path>) -> Routed {
    route_with(body, cwd, None)
}

/// Route a raw request body (single message, or a batch array) to a response.
/// `cwd` is the calling session's working directory, for relative artifact paths.
fn route_with(body: &[u8], cwd: Option<&Path>, ctx: Option<&PollCtx>) -> Routed {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return Routed {
                status: 200,
                json: Some(rpc_error(Value::Null, -32700, "Parse error")),
                emits: vec![],
                redeliver: None,
            }
        }
    };
    if let Value::Array(items) = v {
        let mut out = Vec::new();
        let mut emits = Vec::new();
        for it in &items {
            // Batch items get NO poll context: a blocking await inside a batch
            // would hold every other item's response (and emits) hostage for
            // 25s. It fails fast as a tool error the model can recover from.
            let r = route_one(it, cwd, None);
            if let Some(j) = r.json {
                out.push(j);
            }
            emits.extend(r.emits);
        }
        if out.is_empty() {
            Routed { status: 202, json: None, emits, redeliver: None }
        } else {
            Routed { status: 200, json: Some(Value::Array(out)), emits, redeliver: None }
        }
    } else {
        route_one(&v, cwd, ctx)
    }
}

fn route_one(msg: &Value, cwd: Option<&Path>, ctx: Option<&PollCtx>) -> Routed {
    // No id → JSON-RPC notification: never gets a response.
    let Some(id) = msg.get("id").cloned() else {
        return Routed { status: 202, json: None, emits: vec![], redeliver: None };
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => respond(id, initialize_result(msg)),
        "ping" => respond(id, json!({})),
        "tools/list" => respond(id, tools_list_result()),
        "tools/call" => tools_call(id, msg, cwd, ctx),
        _ => respond_err(id, -32601, "Method not found"),
    }
}

fn respond(id: Value, result: Value) -> Routed {
    Routed {
        status: 200,
        json: Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        emits: vec![],
        redeliver: None,
    }
}

fn respond_err(id: Value, code: i64, message: &str) -> Routed {
    Routed { status: 200, json: Some(rpc_error(id, code, message)), emits: vec![], redeliver: None }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize_result(msg: &Value) -> Value {
    // Echo the client's protocol version for max compatibility.
    let pv = msg
        .get("params")
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    json!({
        "protocolVersion": pv,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
    })
}

fn tools_list_result() -> Value {
    json!({
        "tools": [{
            "name": TOOL_NAME,
            "title": "Render artifact in Drydock",
            "description": TOOL_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short title for the artifact." },
                    "path": { "type": "string", "description": "PREFERRED. Path to the file to render (absolute, or relative to your working directory). Use this for any artifact saved to a file so you don't resend its content. Kind is inferred from the extension (.html/.htm, .svg, .md/.markdown)." },
                    "content": { "type": "string", "description": "Inline artifact source (full HTML document, SVG markup, or Markdown). Use only when the artifact is NOT in a file; otherwise pass `path`." },
                    "kind": { "type": "string", "enum": ["html", "svg", "markdown"], "description": "Content type. Optional when `path` has a known extension; required with inline `content`." }
                },
                "required": ["title"]
            }
        }, {
            "name": AWAIT_TOOL_NAME,
            "title": "Await user feedback on an artifact",
            "description": AWAIT_TOOL_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reply": { "type": "string", "description": "Optional one-line message to show the user in the review panel before waiting (e.g. a summary of what you built and what to review first)." }
                }
            }
        }]
    })
}

/// Infer artifact kind from a file extension, if recognizable.
fn kind_from_path(path: &str) -> Option<&'static str> {
    match Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html") | Some("htm") => Some("html"),
        Some("svg") => Some("svg"),
        Some("md") | Some("markdown") => Some("markdown"),
        _ => None,
    }
}

/// Read a model-supplied artifact file: absolute, or resolved against the
/// session cwd. Bounded to MAX_CONTENT and required to be UTF-8 text. The model
/// already has filesystem read access, and the bytes only reach the local
/// webview — so this grants no new capability, but we still fail closed on
/// oversize / unreadable / non-text inputs.
fn read_artifact_file(path: &str, cwd: Option<&Path>) -> Result<(String, PathBuf), String> {
    let p = Path::new(path);
    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else if let Some(base) = cwd {
        base.join(p)
    } else {
        return Err(format!("relative path \"{path}\" can't be resolved here — pass an absolute path"));
    };
    let meta = std::fs::metadata(&resolved).map_err(|_| format!("can't read file: {}", resolved.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", resolved.display()));
    }
    if meta.len() as usize > MAX_CONTENT {
        return Err("file too large (4 MB limit)".to_string());
    }
    let text = std::fs::read_to_string(&resolved)
        .map_err(|_| format!("file is not UTF-8 text: {}", resolved.display()))?;
    Ok((text, resolved))
}

fn tools_call(id: Value, msg: &Value, cwd: Option<&Path>, ctx: Option<&PollCtx>) -> Routed {
    let params = msg.get("params");
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    match name {
        Some(TOOL_NAME) => {} // fall through to the render logic below
        Some(AWAIT_TOOL_NAME) => return await_feedback_call(id, params, ctx),
        _ => return respond_err(id, -32602, "Unknown tool"),
    }
    let args = params.and_then(|p| p.get("arguments"));
    let get = |k: &str| args.and_then(|a| a.get(k)).and_then(Value::as_str);
    let title = match get("title") {
        Some(t) if !t.trim().is_empty() => t,
        _ => "Untitled",
    };
    let path = get("path").map(str::trim).filter(|s| !s.is_empty());
    let inline = get("content").filter(|s| !s.is_empty());
    let kind_arg = get("kind");

    // Resolve the source: a file `path` (preferred — no content re-sent) or
    // inline `content`. Exactly one must be given. `source` is the on-disk path
    // for path-based renders (carried through for Reveal in Finder).
    let (content, kind_from_ext, source) = match (path, inline) {
        (Some(_), Some(_)) => return tool_error(id, "provide either `path` or `content`, not both"),
        (None, None) => return tool_error(id, "provide `path` (preferred — a file you wrote) or inline `content`"),
        (Some(p), None) => match read_artifact_file(p, cwd) {
            Ok((text, resolved)) => (text, kind_from_path(p), Some(resolved)),
            Err(e) => return tool_error(id, &e),
        },
        (None, Some(c)) => (c.to_string(), None, None),
    };

    // kind: explicit arg wins, else inferred from the file extension.
    let kind = match kind_arg.or(kind_from_ext) {
        Some(k) if matches!(k, "html" | "svg" | "markdown") => k,
        Some(_) => return tool_error(id, "kind must be one of: html, svg, markdown"),
        None => return tool_error(id, "specify `kind` (html, svg, or markdown) — it can't be inferred from the file"),
    };
    if content.trim().is_empty() {
        return tool_error(id, "the artifact is empty");
    }
    if content.len() > MAX_CONTENT {
        return tool_error(id, "content too large (4 MB limit)");
    }
    let from = path.map(|p| format!(" from {p}")).unwrap_or_default();
    Routed {
        status: 200,
        json: Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Rendered \"{title}\"{from} in Drydock's Artifacts panel.") }]
            }
        })),
        emits: vec![Emit { title: title.to_string(), kind: kind.to_string(), content, path: source }],
        redeliver: None,
    }
}

// ---- interactive review: await_artifact_feedback ----------------------------

/// Handle `await_artifact_feedback`: optionally post the agent's reply into the
/// review panel, then block until the human sends feedback / ends the review, or
/// return `waiting` after `POLL_BLOCK_MS` so the model re-calls. `ctx == None`
/// (unit tests without a live hub) yields a benign error result.
fn await_feedback_call(id: Value, params: Option<&Value>, ctx: Option<&PollCtx>) -> Routed {
    let Some(ctx) = ctx else {
        return tool_error(id, "feedback polling is unavailable in this context");
    };
    let reply = params
        .and_then(|p| p.get("arguments"))
        .and_then(|a| a.get("reply"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(reply) = reply {
        let _ = ctx.app.emit("artifact-review", json!({ "pty_id": ctx.pty_id, "reply": reply }));
    }
    // Presence for the review panel: "listening" while blocked in this call,
    // then "working" (feedback delivered — the model is revising) or "waiting"
    // (nothing arrived / review over; between re-calls the model isn't listening).
    let _ = ctx.app.emit("artifact-review", json!({ "pty_id": ctx.pty_id, "presence": "listening" }));
    let result = take_or_wait(ctx.hub, ctx.pty_id, ctx.block);
    // The final batch of an ended review must NOT read as "working" — the model
    // was told to stop polling, so the panel would wedge on it forever.
    let presence = if result.status == "feedback" && !result.session_ended { "working" } else { "waiting" };
    let _ = ctx.app.emit("artifact-review", json!({ "pty_id": ctx.pty_id, "presence": presence }));
    // Carry the drained batch on the response: if the client aborted this call
    // while we were parked, the transport puts it back (see handle_conn).
    let redeliver = (result.status == "feedback").then(|| Redeliver {
        pty_id: ctx.pty_id,
        prompts: result.prompts.clone(),
        layout: result.layout_warnings.clone(),
        ended: result.session_ended,
    });
    let text = serde_json::to_string(&result).unwrap_or_else(|_| "{\"status\":\"waiting\"}".to_string());
    Routed {
        status: 200,
        json: Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "content": [{ "type": "text", "text": text }] }
        })),
        emits: vec![],
        redeliver,
    }
}

/// Block up to `block` for `pty_id`'s pending feedback, draining and clearing it
/// on delivery. Returns `feedback` (prompts and/or layout warnings), `ended` (the
/// human ended the review, or the session went away), or `waiting` on timeout.
fn take_or_wait(hub: &FeedbackHub, pty_id: u32, block: Duration) -> PollResult {
    let deadline = Instant::now() + block;
    let mut map = hub.map.lock().unwrap();
    // Ensure an entry exists so a later `drop_session` (pty exit) is observable
    // as a vanished entry → `ended`, distinct from "nothing submitted yet".
    map.entry(pty_id).or_default();
    loop {
        match map.get_mut(&pty_id) {
            None => return PollResult::ended(),
            Some(fb) => {
                if !fb.prompts.is_empty() || !fb.layout.is_empty() || fb.layout_clean {
                    let prompts = std::mem::take(&mut fb.prompts);
                    let layout = std::mem::take(&mut fb.layout);
                    let layout_clean = std::mem::take(&mut fb.layout_clean);
                    // Delivering "clean" CLOSES the fix cycle: forget the
                    // delivered keys, or every later empty audit (each iframe
                    // remount posts one) would re-arm layout_clean and the
                    // model would be told "the layout is clean now" forever.
                    // A warning that reappears after a confirmed-clean cycle
                    // correctly reads as fresh — it IS a regression.
                    if layout_clean {
                        fb.delivered_layout_keys.clear();
                    }
                    for w in &layout {
                        let k = layout_key(w);
                        if !fb.delivered_layout_keys.contains(&k) {
                            fb.delivered_layout_keys.push(k);
                        }
                    }
                    if fb.delivered_layout_keys.len() > MAX_DELIVERED_LAYOUT_KEYS {
                        let drop = fb.delivered_layout_keys.len() - MAX_DELIVERED_LAYOUT_KEYS;
                        fb.delivered_layout_keys.drain(0..drop);
                    }
                    // `ended` is a consumable edge: delivering the final batch
                    // clears it, so a LATER render in this session can start a
                    // fresh review round instead of instantly reading "ended".
                    let ended = std::mem::take(&mut fb.ended);
                    fb.waiting_streak = 0;
                    return PollResult::feedback(prompts, layout, layout_clean, ended);
                }
                if fb.ended {
                    fb.ended = false; // consume the edge (see above)
                    return PollResult::ended();
                }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            let streak = match map.get_mut(&pty_id) {
                Some(fb) => {
                    fb.waiting_streak = fb.waiting_streak.saturating_add(1);
                    fb.waiting_streak
                }
                None => 0,
            };
            return PollResult::waiting(streak);
        }
        // wait_timeout releases the map lock while parked; a spurious wake just
        // re-checks at the top of the loop (bounded by the deadline).
        let (m, _res) = hub.cv.wait_timeout(map, deadline - now).unwrap();
        map = m;
    }
}

/// After this many consecutive empty polls (~5.5 min at 25s + model turnaround)
/// the next_step tells the model to stop burning tool-call cycles.
const WAITING_STREAK_LIMIT: u32 = 8;

impl PollResult {
    fn feedback(prompts: Vec<ReviewPrompt>, layout: Vec<LayoutWarning>, layout_clean: bool, ended: bool) -> Self {
        let fresh_error = layout.iter().any(|w| w.severity == "error" && !w.persistent);
        PollResult {
            status: "feedback".into(),
            next_step: next_step_feedback(fresh_error, layout_clean, ended),
            prompts,
            layout_warnings: layout,
            session_ended: ended,
            layout_clean,
        }
    }
    fn waiting(streak: u32) -> Self {
        let next_step = if streak >= WAITING_STREAK_LIMIT {
            "The user has not engaged with the review yet. Stop polling for now and continue in the conversation; call await_artifact_feedback again later if they say they are reviewing.".into()
        } else {
            "No feedback yet. Call await_artifact_feedback again to keep waiting for the user.".to_string()
        };
        PollResult {
            status: "waiting".into(),
            prompts: vec![],
            layout_warnings: vec![],
            session_ended: false,
            layout_clean: false,
            next_step,
        }
    }
    fn ended() -> Self {
        PollResult {
            status: "ended".into(),
            prompts: vec![],
            layout_warnings: vec![],
            session_ended: true,
            layout_clean: false,
            next_step: "The user ended the review. Stop polling and continue in the conversation.".into(),
        }
    }
}

fn next_step_feedback(fresh_error_layout: bool, layout_clean: bool, ended: bool) -> String {
    if ended {
        return "This is the last feedback before the user ended the review. Apply it, then continue in the conversation instead of polling again.".into();
    }
    if fresh_error_layout {
        return "Fix the error-severity layout_warnings, re-render the artifact, then call await_artifact_feedback again to recheck before asking the user to review.".into();
    }
    if layout_clean {
        return "The layout audit is clean now. Ask the user to review the artifact, then call await_artifact_feedback again.".into();
    }
    "Apply the annotations, re-render the artifact if needed, then call await_artifact_feedback again (pass reply to message the user in the review panel).".into()
}

// ---- HTML artifact store + `artifact://` rendering --------------------------

/// Store one artifact under `id`, then evict this pty's oldest if it now exceeds
/// the per-session cap (oldest = smallest `seq`).
#[allow(clippy::too_many_arguments)]
fn store_insert(store: &Store, id: &str, pty_id: u32, seq: u64, created_ms: i64, kind: &str, title: &str, content: &str, path: Option<PathBuf>) {
    let mut m = store.lock().unwrap();
    m.insert(
        id.to_string(),
        Stored { pty_id, seq, created_ms, kind: kind.to_string(), title: title.to_string(), content: content.to_string(), path },
    );
    let mut mine: Vec<(String, u64)> =
        m.iter().filter(|(_, s)| s.pty_id == pty_id).map(|(k, s)| (k.clone(), s.seq)).collect();
    if mine.len() > MAX_ARTIFACTS_PER_PTY {
        mine.sort_by_key(|(_, seq)| *seq);
        for (k, _) in mine.iter().take(mine.len() - MAX_ARTIFACTS_PER_PTY) {
            m.remove(k);
        }
    }
}

// ---- on-disk gallery ----------------------------------------------------------

/// One persisted artifact, as listed to the frontend gallery. `file` is the
/// content file name (the key for read/serve/download); `seq` was the artifact's
/// in-memory id at render time, so the gallery can dedup against the live list.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SavedArtifact {
    pub file: String,
    pub title: String,
    pub kind: String,
    pub created_ms: i64,
    pub seq: u64,
    /// Original on-disk source when rendered from a `path` (enables Reveal).
    pub path: Option<String>,
    /// Rendered on a timeline the user has since rewound away from (its
    /// created_ms falls inside a recorded rewound window). Kept — the user may
    /// still want to compare — but badged and never auto-selected.
    pub rewound: bool,
}

/// Discarded-timeline windows for a session's gallery: `rewound.json` holds
/// `[[tail_ms, detected_at_ms], …]` — an artifact created inside any window was
/// rendered after the point a rewind went back to, before the rewind happened.
/// (The file name can't collide with content files: those are `<ms>-<seq>.<ext>`.)
fn read_rewound_windows(dir: &Path, session_id: &str) -> Vec<(i64, i64)> {
    if !valid_session_component(session_id) {
        return Vec::new();
    }
    std::fs::read_to_string(dir.join(session_id).join("rewound.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<(i64, i64)>>(&s).ok())
        .unwrap_or_default()
}

fn append_rewound_window(dir: &Path, session_id: &str, tail_ms: i64, at_ms: i64) {
    if !valid_session_component(session_id) {
        return;
    }
    let d = dir.join(session_id);
    if std::fs::create_dir_all(&d).is_err() {
        return;
    }
    let mut windows = read_rewound_windows(dir, session_id);
    windows.push((tail_ms, at_ms));
    if windows.len() > 50 {
        let excess = windows.len() - 50;
        windows.drain(0..excess);
    }
    if let Ok(json) = serde_json::to_string(&windows) {
        let _ = std::fs::write(d.join("rewound.json"), json);
    }
}

/// A session id is used as a directory component: require uuid-ish characters
/// only, so a hostile value can't traverse ("../", absolute paths, hidden dirs).
fn valid_session_component(sid: &str) -> bool {
    !sid.is_empty()
        && sid.len() <= 64
        && !sid.starts_with('.')
        && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A gallery content file is strictly `<ms>-<seq>.<html|svg|md>` — anything
/// else (paths, dotfiles, meta sidecars) is refused.
fn valid_saved_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    if !matches!(ext, "html" | "svg" | "md") {
        return false;
    }
    let Some((ms, seq)) = stem.split_once('-') else { return false };
    !ms.is_empty()
        && !seq.is_empty()
        && ms.chars().all(|c| c.is_ascii_digit())
        && seq.chars().all(|c| c.is_ascii_digit())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write one artifact (content + meta sidecar) into the session's gallery dir,
/// then prune the oldest past the per-session cap. Best-effort: a failed write
/// only loses persistence, never the render.
fn persist_artifact(dir: &Path, session_id: &str, seq: u64, kind: &str, title: &str, content: &str, source: Option<&Path>) {
    if !valid_session_component(session_id) {
        return;
    }
    let d = dir.join(session_id);
    if std::fs::create_dir_all(&d).is_err() {
        return;
    }
    let stem = format!("{}-{seq}", now_ms());
    let file = format!("{stem}.{}", ext_for_kind(kind));
    if std::fs::write(d.join(&file), content).is_err() {
        return;
    }
    let meta = serde_json::json!({
        "title": title,
        "kind": kind,
        "created_ms": now_ms(),
        "seq": seq,
        "path": source.map(|p| p.display().to_string()),
    });
    let _ = std::fs::write(d.join(format!("{stem}.meta.json")), meta.to_string());
    prune_saved(&d);
}

/// Keep only the newest MAX_SAVED_PER_SESSION artifacts (stems sort by their
/// millisecond prefix, zero-padding not needed at 13 digits until year 2286).
fn prune_saved(session_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(session_dir) else { return };
    let mut stems: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".meta.json").map(String::from)
        })
        .collect();
    if stems.len() <= MAX_SAVED_PER_SESSION {
        return;
    }
    stems.sort();
    for stem in stems.iter().take(stems.len() - MAX_SAVED_PER_SESSION) {
        for ext in ["meta.json", "html", "svg", "md"] {
            let _ = std::fs::remove_file(session_dir.join(format!("{stem}.{ext}")));
        }
    }
}

fn list_saved_in(dir: &Path, session_id: &str) -> Vec<SavedArtifact> {
    if !valid_session_component(session_id) {
        return Vec::new();
    }
    let windows = read_rewound_windows(dir, session_id);
    let d = dir.join(session_id);
    let Ok(entries) = std::fs::read_dir(&d) else { return Vec::new() };
    let mut out: Vec<SavedArtifact> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".meta.json")?;
            let meta: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            let kind = meta.get("kind").and_then(Value::as_str)?.to_string();
            let file = format!("{stem}.{}", ext_for_kind(&kind));
            if !d.join(&file).is_file() {
                return None; // meta without content (partial prune/write)
            }
            let created_ms = meta.get("created_ms").and_then(Value::as_i64).unwrap_or(0);
            Some(SavedArtifact {
                file,
                title: meta.get("title").and_then(Value::as_str).unwrap_or("Untitled").to_string(),
                kind,
                created_ms,
                seq: meta.get("seq").and_then(Value::as_u64).unwrap_or(0),
                path: meta.get("path").and_then(Value::as_str).map(String::from),
                rewound: windows.iter().any(|(tail, at)| created_ms > *tail && created_ms <= *at),
            })
        })
        .collect();
    out.sort_by_key(|s| (s.created_ms, s.seq));
    out
}

/// Default file extension for an artifact kind.
fn ext_for_kind(kind: &str) -> &'static str {
    match kind {
        "svg" => "svg",
        "markdown" => "md",
        _ => "html",
    }
}

/// Turn an artifact title into a safe single filename component: strip path
/// separators and characters Finder/HFS dislike, trim, and bound the length.
pub(crate) fn sanitize_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Suggested download filename: keep the original file's name when rendered from
/// a path; otherwise derive `<sanitized title>.<ext>` from the kind.
fn download_filename(title: &str, kind: &str, path: Option<&Path>) -> String {
    if let Some(name) = path.and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    format!("{}.{}", sanitize_filename(title), ext_for_kind(kind))
}

/// Whether `html` is already a full document (keep it verbatim) vs a bare
/// fragment we need to wrap. Mirrors the frontend's srcdoc heuristic.
fn is_full_document(html: &str) -> bool {
    let head = html.get(..html.len().min(512)).unwrap_or(html).to_ascii_lowercase();
    head.contains("<!doctype") || head.contains("<html")
}

/// Appended to every served HTML artifact. Drydock's full-window overlay closes
/// on Esc, but a parent keydown listener never sees keys typed into the iframe —
/// so the artifact itself forwards Esc via postMessage (its scripts run anyway
/// under ARTIFACT_CSP). Capture-phase, so artifact code can't swallow it first;
/// appended at the end so it can't disturb the document's own parsing.
const ESC_FORWARDER: &str = "<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({type:'drydock-esc'},'*')},true)</script>";

/// The interactive-review SDK injected into every served HTML artifact
/// (annotate elements/text, layout audit — see docs/artifact-review.md). Only
/// the SERVED copy carries it; the artifact's source file is never touched.
/// Adapted from lavish-axi (MIT © Kun Chen) — see the file header.
const REVIEW_SDK: &str = include_str!("artifact_review_sdk.js");

/// The exact HTML document served for an artifact: a full page passes through,
/// a fragment gets the minimal dark-theme wrapper; both carry the review SDK and
/// then the Esc forwarder. Order matters: the SDK registers its window-capture
/// Escape listener FIRST so an open annotation card can claim the key
/// (stopImmediatePropagation) before the forwarder would close the overlay.
fn build_artifact_document(html: &str) -> String {
    if is_full_document(html) {
        format!("{html}<script>{REVIEW_SDK}</script>{ESC_FORWARDER}")
    } else {
        format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>{ARTIFACT_FRAME_CSS}</style></head><body>{html}<script>{REVIEW_SDK}</script>{ESC_FORWARDER}</body></html>"
        )
    }
}

/// Build the HTTP response the `artifact://` scheme handler returns: the stored
/// HTML under the locked-down [`ARTIFACT_CSP`] (its own origin governs it, not
/// the app's strict CSP), or a 404 when the id is unknown/evicted.
pub fn artifact_response(html: Option<String>) -> Response<Vec<u8>> {
    match html {
        Some(h) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", ARTIFACT_CSP)
            .header("X-Content-Type-Options", "nosniff")
            .body(build_artifact_document(&h).into_bytes())
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"artifact not found".to_vec())
            .unwrap(),
    }
}

/// A tool-level failure: a normal result with isError:true, so the model sees it
/// and can correct itself (vs a protocol error that aborts the call).
fn tool_error(id: Value, text: &str) -> Routed {
    Routed {
        status: 200,
        json: Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("render_artifact failed: {text}") }],
                "isError": true
            }
        })),
        emits: vec![],
        redeliver: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn tokens(pairs: &[(&str, u32)]) -> HashMap<String, TokenInfo> {
        pairs
            .iter()
            .map(|(t, id)| (t.to_string(), TokenInfo { pty_id: *id, cwd: None, session_id: None }))
            .collect()
    }

    #[test]
    fn parse_bearer_handles_case_and_trim() {
        assert_eq!(parse_bearer("Bearer abc"), Some("abc"));
        assert_eq!(parse_bearer("bearer  xyz "), Some("xyz"));
        assert_eq!(parse_bearer("Basic abc"), None);
    }

    #[test]
    fn resolve_token_matches_only_known_tokens() {
        let map = tokens(&[("good", 5)]);
        assert_eq!(resolve_token(Some("Bearer good"), &map).map(|i| i.pty_id), Some(5));
        assert_eq!(resolve_token(Some("Bearer bad"), &map), None);
        assert_eq!(resolve_token(None, &map), None);
    }

    #[test]
    fn origin_allows_loopback_and_cli_but_blocks_web() {
        assert!(origin_allowed(None)); // CLI sends no Origin
        assert!(origin_allowed(Some("http://127.0.0.1:5173")));
        assert!(origin_allowed(Some("http://localhost")));
        assert!(origin_allowed(Some("http://[::1]:3000")));
        assert!(!origin_allowed(Some("http://evil.example")));
        assert!(!origin_allowed(Some("https://attacker.com")));
        assert!(!origin_allowed(Some("http://127.0.0.1.evil.com"))); // not a prefix match
        assert!(!origin_allowed(Some("null")));
    }

    #[test]
    fn initialize_echoes_version_and_names_server() {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } });
        let r = route(msg.to_string().as_bytes(), None);
        let res = &r.json.unwrap()["result"];
        assert_eq!(res["protocolVersion"], "2025-03-26");
        assert_eq!(res["serverInfo"]["name"], SERVER_NAME);
        assert!(r.emits.is_empty());
    }

    #[test]
    fn tools_list_exposes_render_artifact() {
        let msg = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let r = route(msg.to_string().as_bytes(), None);
        let tools = r.json.unwrap()["result"]["tools"].clone();
        assert_eq!(tools[0]["name"], TOOL_NAME);
        assert_eq!(tools[0]["inputSchema"]["required"][0], "title");
    }

    #[test]
    fn tools_call_valid_emits_and_acks() {
        let msg = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "Hi", "kind": "html", "content": "<p>x</p>" } }
        });
        let r = route(msg.to_string().as_bytes(), None);
        assert_eq!(r.emits.len(), 1);
        assert_eq!(r.emits[0].kind, "html");
        assert_eq!(r.emits[0].content, "<p>x</p>");
        let text = r.json.unwrap()["result"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(text.contains("Hi"), "ack should name the artifact: {text}");
    }

    #[test]
    fn tools_call_bad_kind_is_tool_error_not_emit() {
        let msg = json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "kind": "pdf", "content": "y" } }
        });
        let r = route(msg.to_string().as_bytes(), None);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn tools_call_empty_content_errors() {
        let msg = json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "kind": "svg", "content": "" } }
        });
        let r = route(msg.to_string().as_bytes(), None);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn tools_call_path_reads_file_and_infers_kind() {
        let dir = std::env::temp_dir().join(format!("drydock-artifact-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mockup.html"), "<h1>hi</h1>").unwrap();
        // relative path resolves against the session cwd; kind inferred from .html
        let msg = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "Mock", "path": "mockup.html" } }
        });
        let r = route(msg.to_string().as_bytes(), Some(dir.as_path()));
        assert_eq!(r.emits.len(), 1, "the file's content should be emitted");
        assert_eq!(r.emits[0].kind, "html");
        assert_eq!(r.emits[0].content, "<h1>hi</h1>");
        assert_eq!(r.emits[0].path, Some(dir.join("mockup.html")), "source path is carried through");
        let ack = r.json.unwrap()["result"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(ack.contains("mockup.html"), "ack should name the file: {ack}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tools_call_missing_file_is_tool_error() {
        let msg = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "path": "/no/such/file-xyz.html" } }
        });
        let r = route(msg.to_string().as_bytes(), None);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn tools_call_rejects_both_and_neither_source() {
        let both = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "path": "a.html", "content": "<p>x</p>", "kind": "html" } } });
        assert_eq!(route(both.to_string().as_bytes(), None).json.unwrap()["result"]["isError"], true);
        let neither = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X" } } });
        assert_eq!(route(neither.to_string().as_bytes(), None).json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn tools_call_inline_without_kind_errors() {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "content": "<p>x</p>" } } });
        let r = route(msg.to_string().as_bytes(), None);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn kind_from_path_infers_known_extensions() {
        assert_eq!(kind_from_path("a/b/page.HTML"), Some("html"));
        assert_eq!(kind_from_path("diagram.svg"), Some("svg"));
        assert_eq!(kind_from_path("notes.md"), Some("markdown"));
        assert_eq!(kind_from_path("data.json"), None);
        assert_eq!(kind_from_path("noext"), None);
    }

    #[test]
    fn notification_gets_no_response() {
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let r = route(msg.to_string().as_bytes(), None);
        assert_eq!(r.status, 202);
        assert!(r.json.is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" });
        let r = route(msg.to_string().as_bytes(), None);
        assert_eq!(r.json.unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn malformed_json_is_parse_error() {
        let r = route(b"not json", None);
        assert_eq!(r.json.unwrap()["error"]["code"], -32700);
    }

    #[test]
    fn batch_collects_responses_and_emits() {
        let batch = json!([
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": { "name": "render_artifact", "arguments": { "title": "B", "kind": "markdown", "content": "# hi" } } }
        ]);
        let r = route(batch.to_string().as_bytes(), None);
        assert_eq!(r.emits.len(), 1);
        let arr = r.json.unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1); // notification produced no response
    }

    #[test]
    fn read_request_parses_method_headers_and_body() {
        let raw = "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\nContent-Length: 9\r\n\r\n{\"a\":\"b\"}";
        let mut cur = Cursor::new(raw.as_bytes().to_vec());
        let req = read_request(&mut cur).unwrap().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/mcp");
        assert_eq!(header(&req, "authorization"), Some("Bearer tok"));
        assert_eq!(req.body, b"{\"a\":\"b\"}");
    }

    #[test]
    fn read_request_clean_close_returns_none() {
        let mut cur = Cursor::new(Vec::new());
        assert!(read_request(&mut cur).unwrap().is_none());
    }

    #[test]
    fn write_json_is_one_well_formed_response() {
        let mut buf = Vec::new();
        let body = json!({ "ok": true });
        write_json(&mut buf, 200, &body, true).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let expected_body = serde_json::to_string(&body).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains(&format!("Content-Length: {}\r\n", expected_body.len())));
        assert!(s.contains("Content-Type: application/json\r\n"));
        assert!(s.contains("Connection: keep-alive\r\n"));
        // headers and body are emitted together, body last
        assert!(s.ends_with(&format!("\r\n\r\n{expected_body}")));
    }

    #[test]
    fn write_status_close_is_exact() {
        let mut buf = Vec::new();
        write_status(&mut buf, 401, false).unwrap();
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn store_caps_artifacts_per_pty_evicting_oldest() {
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        let n = MAX_ARTIFACTS_PER_PTY as u64 + 5;
        for i in 1..=n {
            store_insert(&store, &i.to_string(), 7, i, i as i64, "html", "t", &format!("<p>{i}</p>"), None);
        }
        let m = store.lock().unwrap();
        let mine = m.values().filter(|s| s.pty_id == 7).count();
        assert_eq!(mine, MAX_ARTIFACTS_PER_PTY, "cap holds");
        assert!(!m.contains_key("1"), "oldest evicted");
        assert!(m.contains_key(&n.to_string()), "newest retained");
    }

    #[test]
    fn store_cap_is_per_pty_not_global() {
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        // two sessions each fill to the cap; neither evicts the other's
        for i in 1..=(MAX_ARTIFACTS_PER_PTY as u64) {
            store_insert(&store, &format!("a{i}"), 1, i, i as i64, "html", "t", "x", None);
            store_insert(&store, &format!("b{i}"), 2, 1000 + i, 1000 + i as i64, "html", "t", "y", None);
        }
        let m = store.lock().unwrap();
        assert_eq!(m.values().filter(|s| s.pty_id == 1).count(), MAX_ARTIFACTS_PER_PTY);
        assert_eq!(m.values().filter(|s| s.pty_id == 2).count(), MAX_ARTIFACTS_PER_PTY);
    }

    #[test]
    fn is_full_document_detects_doc_vs_fragment() {
        assert!(is_full_document("<!doctype html><html></html>"));
        assert!(is_full_document("<HTML><body>x</body></HTML>"));
        assert!(!is_full_document("<div>hi</div>"));
        assert!(!is_full_document("<svg></svg>"));
    }

    #[test]
    fn artifact_response_serves_html_under_locked_csp() {
        let r = artifact_response(Some("<div>hi</div>".to_string()));
        assert_eq!(r.status(), 200);
        let csp = r.headers().get("Content-Security-Policy").unwrap().to_str().unwrap();
        assert!(csp.contains("script-src 'unsafe-inline'"), "JS allowed: {csp}");
        assert!(csp.contains("connect-src 'none'"), "data send-out blocked: {csp}");
        assert_eq!(r.headers().get("Content-Type").unwrap(), "text/html; charset=utf-8");
        let body = String::from_utf8(r.body().clone()).unwrap();
        assert!(body.contains("<div>hi</div>"));
        assert!(body.to_ascii_lowercase().contains("<!doctype"), "fragment is wrapped");
    }

    #[test]
    fn artifact_response_passes_full_document_through_unwrapped() {
        let doc = "<!doctype html><html><head></head><body><script>1</script></body></html>";
        let r = artifact_response(Some(doc.to_string()));
        let body = String::from_utf8(r.body().clone()).unwrap();
        assert_eq!(
            body,
            format!("{doc}<script>{REVIEW_SDK}</script>{ESC_FORWARDER}"),
            "a full page is served unwrapped, with only the review SDK + Esc forwarder appended"
        );
        assert!(body.starts_with(doc), "the document itself is untouched");
    }

    #[test]
    fn artifact_documents_carry_the_esc_forwarder() {
        // fragment path: forwarder inside the wrapper's body
        let frag = build_artifact_document("<div>x</div>");
        assert!(frag.contains(ESC_FORWARDER));
        assert!(frag.contains("drydock-esc"));
    }

    #[test]
    fn artifact_documents_carry_the_review_sdk() {
        // both branches inject the SDK, and the SDK precedes the Esc forwarder
        // (its Escape handler must register first to claim the key for an open
        // annotation card)
        for doc in [
            build_artifact_document("<div>x</div>"),
            build_artifact_document("<!doctype html><html><body>x</body></html>"),
        ] {
            assert!(doc.contains("dd-artifact:queuePrompt"), "SDK marker present");
            let sdk_at = doc.find("dd-artifact:queuePrompt").unwrap();
            let esc_at = doc.find("drydock-esc").unwrap();
            assert!(sdk_at < esc_at, "SDK registers before the Esc forwarder");
        }
    }

    #[test]
    fn review_sdk_is_script_embeddable() {
        // Embedded verbatim inside a <script> tag: the closing sequence would
        // truncate the script and break every served artifact.
        assert!(!REVIEW_SDK.to_ascii_lowercase().contains("</script"), "no closing-script sequence");
        assert!(REVIEW_SDK.contains("dd-artifact:ready"), "boot handshake present");
        assert!(REVIEW_SDK.contains("dd-artifact:layout"), "layout audit present");
        assert!(REVIEW_SDK.contains("Kun Chen"), "MIT attribution retained");
    }

    #[test]
    fn artifact_response_unknown_id_is_404() {
        let r = artifact_response(None);
        assert_eq!(r.status(), 404);
    }

    #[test]
    fn download_filename_keeps_source_basename_else_derives_from_title() {
        // rendered from a file → keep the real name (and extension)
        assert_eq!(
            download_filename("My Dashboard", "html", Some(Path::new("/tmp/proj/dash.html"))),
            "dash.html"
        );
        // inline content → sanitized title + extension by kind
        assert_eq!(download_filename("My Dashboard", "html", None), "My Dashboard.html");
        assert_eq!(download_filename("Notes", "markdown", None), "Notes.md");
        assert_eq!(download_filename("Diagram", "svg", None), "Diagram.svg");
    }

    #[test]
    fn sanitize_filename_strips_separators_and_falls_back() {
        assert_eq!(sanitize_filename("a/b:c*?"), "a-b-c--");
        assert_eq!(sanitize_filename("  ..hidden.. "), "hidden");
        assert_eq!(sanitize_filename("   "), "artifact");
        assert_eq!(sanitize_filename(""), "artifact");
    }

    fn test_server(dir: PathBuf) -> ArtifactServer {
        ArtifactServer { port: 0, tokens: Arc::new(Mutex::new(HashMap::new())), store: Arc::new(Mutex::new(HashMap::new())), feedback: Arc::new(FeedbackHub::default()), dir }
    }

    #[test]
    fn artifact_download_uses_stored_content_and_name() {
        let srv = test_server(std::env::temp_dir());
        store_insert(&srv.store, "9", 1, 9, 9, "markdown", "Read Me", "# hi", None);
        let (name, bytes) = srv.artifact_download("9").unwrap();
        assert_eq!(name, "Read Me.md");
        assert_eq!(bytes, b"# hi");
        assert!(srv.artifact_download("nope").is_none());
        // inline artifact has no source path → no Reveal in Finder
        assert!(srv.artifact_path("9").is_none());
    }

    #[test]
    fn saved_component_validators_block_traversal() {
        assert!(valid_session_component("44444444-4444-4444-4444-444444444444"));
        assert!(!valid_session_component(".."));
        assert!(!valid_session_component("a/b"));
        assert!(!valid_session_component(".hidden"));
        assert!(!valid_session_component(""));

        assert!(valid_saved_file("1751300000000-3.html"));
        assert!(valid_saved_file("1-1.svg"));
        assert!(valid_saved_file("2-9.md"));
        assert!(!valid_saved_file("1-1.meta.json"), "sidecars are not content");
        assert!(!valid_saved_file("../../etc/passwd"));
        assert!(!valid_saved_file("x-1.html"));
        assert!(!valid_saved_file("1-1.js"));
    }

    #[test]
    fn persist_list_read_and_serve_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("drydock-gallery-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sid = "44444444-4444-4444-4444-444444444444";
        persist_artifact(&tmp, sid, 3, "html", "Dash", "<h1>hi</h1>", Some(Path::new("/tmp/src/dash.html")));
        persist_artifact(&tmp, sid, 4, "markdown", "Notes", "# n", None);

        let listed = list_saved_in(&tmp, sid);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].title, "Dash");
        assert_eq!(listed[0].seq, 3);
        assert_eq!(listed[0].path.as_deref(), Some("/tmp/src/dash.html"));
        assert!(listed[0].file.ends_with(".html"));
        assert_eq!(listed[1].kind, "markdown");
        assert_eq!(listed[1].path, None);

        let srv = test_server(tmp.clone());
        // read + download go through validation
        assert_eq!(srv.read_saved(sid, &listed[1].file).as_deref(), Some("# n"));
        let (name, bytes) = srv.saved_download(sid, &listed[1].file).unwrap();
        assert_eq!(name, "Notes.md");
        assert_eq!(bytes, b"# n");
        // html serves over artifact://saved/<sid>/<file>; markdown does not
        assert_eq!(srv.lookup_html(&format!("saved/{sid}/{}", listed[0].file)).as_deref(), Some("<h1>hi</h1>"));
        assert!(srv.lookup_html(&format!("saved/{sid}/{}", listed[1].file)).is_none());
        // traversal / bogus components refused
        assert!(srv.lookup_html("saved/../x.html").is_none());
        assert!(srv.read_saved(sid, "../../secrets.html").is_none());
        // unknown session → empty, not error
        assert!(list_saved_in(&tmp, "55555555-5555-5555-5555-555555555555").is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn gallery_prunes_oldest_past_cap() {
        let tmp = std::env::temp_dir().join(format!("drydock-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sid = "44444444-4444-4444-4444-444444444444";
        // fabricate stems directly (persist_artifact uses wall-clock ms, which
        // won't produce >cap distinct stems fast enough to matter here)
        let d = tmp.join(sid);
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..(MAX_SAVED_PER_SESSION + 5) {
            let stem = format!("{:013}-{i}", 1_000_000_000_000u64 + i as u64);
            std::fs::write(d.join(format!("{stem}.html")), "x").unwrap();
            std::fs::write(
                d.join(format!("{stem}.meta.json")),
                format!(r#"{{"title":"t","kind":"html","created_ms":{},"seq":{i}}}"#, 1_000_000_000_000u64 + i as u64),
            )
            .unwrap();
        }
        prune_saved(&d);
        let listed = list_saved_in(&tmp, sid);
        assert_eq!(listed.len(), MAX_SAVED_PER_SESSION);
        // the oldest 5 are gone, the newest survive
        assert_eq!(listed[0].seq, 5);
        assert_eq!(listed.last().unwrap().seq as usize, MAX_SAVED_PER_SESSION + 4);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn random_token_is_nonempty_and_url_safe() {
        let t = random_token();
        assert!(!t.is_empty());
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn tool_id_matches_server_and_tool_names() {
        assert_eq!(TOOL_ID, format!("mcp__{SERVER_NAME}__{TOOL_NAME}"));
        assert_eq!(AWAIT_TOOL_ID, format!("mcp__{SERVER_NAME}__{AWAIT_TOOL_NAME}"));
        // ALLOWED_TOOLS pre-approves exactly both fully-qualified ids
        assert!(ALLOWED_TOOLS.contains(TOOL_ID));
        assert!(ALLOWED_TOOLS.contains(AWAIT_TOOL_ID));
    }

    #[test]
    fn nudge_is_single_quote_safe() {
        // It is spliced single-quoted into a shell -c string.
        assert!(!NUDGE.contains('\''));
        assert!(!NUDGE.contains('\n'));
    }

    // ---- interactive review: feedback queue + poll ---------------------------

    fn msg_prompt(uid: &str, text: &str) -> ReviewPrompt {
        ReviewPrompt { uid: uid.into(), prompt: text.into(), selector: String::new(), tag: "message".into(), text: String::new(), target: None }
    }

    #[test]
    fn tools_list_advertises_both_tools() {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let r = route(msg.to_string().as_bytes(), None);
        let tools = r.json.unwrap()["result"]["tools"].clone();
        let names: Vec<String> = tools.as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap_or("").to_string()).collect();
        assert!(names.iter().any(|n| n == TOOL_NAME), "render tool listed: {names:?}");
        assert!(names.iter().any(|n| n == AWAIT_TOOL_NAME), "await tool listed: {names:?}");
    }

    #[test]
    fn await_tool_without_ctx_is_tool_error_not_a_hang() {
        // The test-only `route` passes ctx=None: the await tool must fail fast
        // rather than block or panic.
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": AWAIT_TOOL_NAME, "arguments": {} } });
        let r = route(msg.to_string().as_bytes(), None);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn feedback_delivered_after_submit_then_drains() {
        let srv = test_server(std::env::temp_dir());
        srv.submit_feedback(7, vec![msg_prompt("1", "make it blue")], false);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(50));
        assert_eq!(r.status, "feedback");
        assert_eq!(r.prompts.len(), 1);
        assert_eq!(r.prompts[0].prompt, "make it blue");
        assert!(!r.session_ended);
        // delivery cleared the queue: a second poll times out to waiting
        let r2 = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r2.status, "waiting");
    }

    #[test]
    fn take_or_wait_blocks_then_returns_waiting_on_timeout() {
        let srv = test_server(std::env::temp_dir());
        let start = Instant::now();
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(60));
        assert_eq!(r.status, "waiting");
        assert!(start.elapsed() >= Duration::from_millis(50), "it actually blocked ~the full window");
    }

    #[test]
    fn end_review_with_no_prompts_returns_ended() {
        let srv = test_server(std::env::temp_dir());
        srv.submit_feedback(7, vec![], true);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.status, "ended");
        assert!(r.session_ended);
    }

    #[test]
    fn send_and_end_delivers_final_batch_with_the_end_flag() {
        let srv = test_server(std::env::temp_dir());
        srv.submit_feedback(7, vec![msg_prompt("", "final note")], true);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.status, "feedback");
        assert!(r.session_ended, "last batch before an end is flagged");
        assert!(r.next_step.contains("last feedback"), "{}", r.next_step);
        // the edge was consumed with that delivery: a later poll waits fresh
        // (a NEW review round in the same session must be possible)
        let r2 = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r2.status, "waiting");
    }

    #[test]
    fn layout_warning_is_fresh_then_persistent_on_redelivery() {
        let srv = test_server(std::env::temp_dir());
        let w = LayoutWarning { kind: "page-horizontal-overflow".into(), selector: "body".into(),
            overflow_px: 12.0, viewport_width: 720.0, severity: "error".into(), persistent: false };
        srv.report_layout(7, vec![w.clone()]);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.layout_warnings.len(), 1);
        assert!(!r.layout_warnings[0].persistent, "first delivery is fresh");
        srv.report_layout(7, vec![w]);
        let r2 = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert!(r2.layout_warnings[0].persistent, "the redelivered key reads as persistent");
    }

    #[test]
    fn feedback_is_isolated_per_pty() {
        let srv = test_server(std::env::temp_dir());
        srv.submit_feedback(1, vec![msg_prompt("", "for one")], false);
        assert_eq!(take_or_wait(&srv.feedback, 2, Duration::from_millis(20)).status, "waiting");
        assert_eq!(take_or_wait(&srv.feedback, 1, Duration::from_millis(20)).status, "feedback");
    }

    #[test]
    fn prompt_queue_is_capped_and_each_prompt_truncated() {
        let srv = test_server(std::env::temp_dir());
        let big = "é".repeat(MAX_PROMPT_LEN); // 2 bytes/char: exercises the boundary-safe cut
        let many: Vec<ReviewPrompt> = (0..(MAX_PROMPTS_PER_SESSION + 10))
            .map(|i| ReviewPrompt { uid: i.to_string(), prompt: big.clone(), selector: String::new(), tag: "message".into(), text: String::new(), target: None })
            .collect();
        srv.submit_feedback(7, many, false);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.prompts.len(), MAX_PROMPTS_PER_SESSION, "queue capped");
        assert!(r.prompts.iter().all(|p| p.prompt.len() <= MAX_PROMPT_LEN), "each prompt truncated");
        assert!(r.prompts.iter().all(|p| p.prompt.chars().all(|c| c == 'é')), "cut lands on a char boundary");
        assert_eq!(r.prompts[0].uid, "10", "oldest 10 evicted");
    }

    #[test]
    fn release_wakes_a_blocked_poll_with_ended() {
        let srv = Arc::new(test_server(std::env::temp_dir()));
        let srv2 = Arc::clone(&srv);
        let handle = std::thread::spawn(move || take_or_wait(&srv2.feedback, 7, Duration::from_millis(3000)));
        std::thread::sleep(Duration::from_millis(120)); // let the poll attach + create its entry
        srv.release(7); // drops the entry and notifies
        let r = handle.join().unwrap();
        assert_eq!(r.status, "ended", "a blocked poll wakes as ended when its session is released");
    }

    #[test]
    fn submit_wakes_a_blocked_poll_with_feedback() {
        let srv = Arc::new(test_server(std::env::temp_dir()));
        let srv2 = Arc::clone(&srv);
        let handle = std::thread::spawn(move || take_or_wait(&srv2.feedback, 7, Duration::from_millis(3000)));
        std::thread::sleep(Duration::from_millis(120));
        srv.submit_feedback(7, vec![msg_prompt("", "hi")], false);
        let r = handle.join().unwrap();
        assert_eq!(r.status, "feedback");
        assert_eq!(r.prompts.len(), 1);
    }

    #[test]
    fn poll_result_serializes_to_the_documented_envelope() {
        let r = PollResult::feedback(vec![msg_prompt("2", "tweak")], vec![], false, false);
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["status"], "feedback");
        assert_eq!(v["prompts"][0]["prompt"], "tweak");
        assert!(v.get("layout_warnings").is_none(), "empty layout omitted");
        assert!(v.get("session_ended").is_none(), "false session_ended omitted");
        assert!(v.get("layout_clean").is_none(), "false layout_clean omitted");
        assert!(v["next_step"].as_str().unwrap().contains("await_artifact_feedback"));
        // waiting envelope
        let w = serde_json::to_value(PollResult::waiting(1)).unwrap();
        assert_eq!(w["status"], "waiting");
    }

    #[test]
    fn ended_is_a_consumable_edge_so_a_second_round_works() {
        let srv = test_server(std::env::temp_dir());
        // round 1: user sends & ends; the model drains the final batch + the end
        srv.submit_feedback(7, vec![msg_prompt("", "final")], true);
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "feedback");
        // (a poll arriving before the next round sees plain waiting, not ended)
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "waiting");
        // round 2: fresh feedback flows again
        srv.submit_feedback(7, vec![msg_prompt("", "round two")], false);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.status, "feedback");
        assert!(!r.session_ended, "round two is NOT marked ended");
        // end-without-prompts also consumes on delivery
        srv.submit_feedback(7, vec![], true);
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "ended");
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "waiting");
    }

    #[test]
    fn requeue_puts_a_drained_batch_back_in_front() {
        let srv = test_server(std::env::temp_dir());
        srv.submit_feedback(7, vec![msg_prompt("1", "first")], false);
        let drained = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(drained.prompts.len(), 1);
        // meanwhile the user queued more; then the aborted poll's batch returns
        srv.submit_feedback(7, vec![msg_prompt("2", "second")], false);
        srv.feedback.requeue(7, drained.prompts, drained.layout_warnings, drained.session_ended);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.prompts.len(), 2);
        assert_eq!(r.prompts[0].prompt, "first", "redelivered batch keeps original order, in front");
        assert_eq!(r.prompts[1].prompt, "second");
        // requeue for a dropped session is a no-op (no resurrection)
        srv.release(7);
        srv.feedback.requeue(7, vec![msg_prompt("", "ghost")], vec![], false);
        assert!(srv.feedback.map.lock().unwrap().get(&7).is_none());
    }

    #[test]
    fn clean_audit_after_delivered_warnings_is_deliverable() {
        let srv = test_server(std::env::temp_dir());
        let w = LayoutWarning { kind: "clipped-text".into(), selector: ".x".into(),
            overflow_px: 9.0, viewport_width: 700.0, severity: "error".into(), persistent: false };
        srv.report_layout(7, vec![w]);
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "feedback");
        // the fix-recheck cycle reports an empty audit → deliverable "clean"
        srv.report_layout(7, vec![]);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert_eq!(r.status, "feedback");
        assert!(r.layout_clean, "clean signal delivered");
        assert!(r.next_step.contains("clean"), "{}", r.next_step);
        // but an empty audit with nothing ever delivered says nothing
        let srv2 = test_server(std::env::temp_dir());
        srv2.report_layout(8, vec![]);
        assert_eq!(take_or_wait(&srv2.feedback, 8, Duration::from_millis(20)).status, "waiting");
    }

    #[test]
    fn clean_signal_fires_once_not_on_every_remount() {
        // Regression: delivering "clean" must close the fix cycle. Before, the
        // delivered keys survived, so every iframe remount's routine empty
        // audit re-armed layout_clean and the model was told "the layout is
        // clean now — ask the user to review" in an endless loop.
        let srv = test_server(std::env::temp_dir());
        let w = LayoutWarning { kind: "clipped-text".into(), selector: ".x".into(),
            overflow_px: 9.0, viewport_width: 700.0, severity: "error".into(), persistent: false };
        srv.report_layout(7, vec![w.clone()]);
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "feedback");
        srv.report_layout(7, vec![]); // the fix confirmed
        assert!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).layout_clean);
        // remounts / re-renders keep posting empty audits — NO re-fire
        for _ in 0..3 {
            srv.report_layout(7, vec![]);
            assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "waiting", "clean is one-shot");
        }
        // a warning REAPPEARING after a confirmed-clean cycle is a regression:
        // it reads as fresh, and a later empty audit can confirm clean again
        srv.report_layout(7, vec![w]);
        let again = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert!(!again.layout_warnings[0].persistent, "post-clean reappearance is fresh");
        srv.report_layout(7, vec![]);
        assert!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).layout_clean, "next cycle can confirm clean once");
    }

    #[test]
    fn empty_audit_does_not_reset_the_waiting_streak() {
        let srv = test_server(std::env::temp_dir());
        for _ in 0..WAITING_STREAK_LIMIT {
            let _ = take_or_wait(&srv.feedback, 7, Duration::from_millis(1));
        }
        srv.report_layout(7, vec![]); // routine remount report, no delivered keys
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(1));
        assert_eq!(r.status, "waiting");
        assert!(r.next_step.contains("Stop polling"), "streak survives a meaningless report: {}", r.next_step);
    }

    #[test]
    fn handle_rewind_prunes_memory_badges_gallery_and_resets_the_round() {
        let tmp = std::env::temp_dir().join(format!("drydock-rewind-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sid = "44444444-4444-4444-4444-444444444444";
        let srv = test_server(tmp.clone());
        let _token = srv.mint(7, None, Some(sid.to_string()));

        // live artifacts straddling the rewound-to point (tail_ms = 150)
        store_insert(&srv.store, "1", 7, 1, 100, "html", "before", "<p>a</p>", None);
        store_insert(&srv.store, "2", 7, 2, 200, "html", "after", "<p>b</p>", None);
        // review round state that describes the soon-discarded timeline
        srv.submit_feedback(7, vec![msg_prompt("", "stale note")], true);
        // gallery copies with the same timestamps (fabricated metas, like the prune test)
        let d = tmp.join(sid);
        std::fs::create_dir_all(&d).unwrap();
        for (stem, ms) in [("0000000000100-1", 100i64), ("0000000000200-2", 200i64)] {
            std::fs::write(d.join(format!("{stem}.html")), "x").unwrap();
            std::fs::write(
                d.join(format!("{stem}.meta.json")),
                format!(r#"{{"title":"t","kind":"html","created_ms":{ms},"seq":1}}"#),
            )
            .unwrap();
        }

        let removed = srv.handle_rewind(sid, 150);
        assert_eq!(removed, vec![(7u32, vec!["2".to_string()])], "only the post-rewind live artifact is pruned");
        assert!(srv.store.lock().unwrap().contains_key("1"), "pre-rewind artifact survives");
        assert!(!srv.store.lock().unwrap().contains_key("2"));

        // gallery: kept but badged, only inside the discarded window
        let listed = list_saved_in(&tmp, sid);
        assert_eq!(listed.len(), 2, "gallery copies are never deleted");
        assert!(!listed[0].rewound, "pre-rewind copy unbadged");
        assert!(listed[1].rewound, "discarded-future copy badged");

        // the review round was reset: the stale end/prompts are gone
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "waiting");

        // a session with no open tab still records the gallery window
        let removed2 = srv.handle_rewind("55555555-5555-5555-5555-555555555555", 10);
        assert!(removed2.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn waiting_streak_escalates_next_step_and_resets_on_engagement() {
        let srv = test_server(std::env::temp_dir());
        let mut last = String::new();
        for _ in 0..WAITING_STREAK_LIMIT {
            last = take_or_wait(&srv.feedback, 7, Duration::from_millis(1)).next_step;
        }
        assert!(last.contains("Stop polling"), "streak limit escalates: {last}");
        srv.submit_feedback(7, vec![msg_prompt("", "hi")], false);
        let _ = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        let fresh = take_or_wait(&srv.feedback, 7, Duration::from_millis(1)).next_step;
        assert!(!fresh.contains("Stop polling"), "engagement resets the streak: {fresh}");
    }

    #[test]
    fn begin_render_clears_stale_layout_but_keeps_delivered_keys() {
        let srv = test_server(std::env::temp_dir());
        let w = LayoutWarning { kind: "clipped-text".into(), selector: ".x".into(),
            overflow_px: 9.0, viewport_width: 700.0, severity: "error".into(), persistent: false };
        srv.report_layout(7, vec![w.clone()]);
        let _ = take_or_wait(&srv.feedback, 7, Duration::from_millis(20)); // delivered once
        srv.report_layout(7, vec![w.clone()]); // re-reported, now pending
        srv.feedback.begin_render(7); // new document renders: pending report is stale
        assert_eq!(take_or_wait(&srv.feedback, 7, Duration::from_millis(20)).status, "waiting");
        // the new document re-reports the same defect → still reads persistent
        srv.report_layout(7, vec![w]);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        assert!(r.layout_warnings[0].persistent, "delivered keys survive the render reset");
    }

    #[test]
    fn every_prompt_field_is_clamped() {
        let srv = test_server(std::env::temp_dir());
        let big = "y".repeat(64 * 1024);
        srv.submit_feedback(7, vec![ReviewPrompt {
            uid: big.clone(), prompt: big.clone(), selector: big.clone(), tag: big.clone(),
            text: big.clone(), target: Some(serde_json::json!({ "blob": big })),
        }], false);
        let r = take_or_wait(&srv.feedback, 7, Duration::from_millis(20));
        let p = &r.prompts[0];
        assert!(p.prompt.len() <= MAX_PROMPT_LEN);
        assert!(p.selector.len() <= 1024);
        assert!(p.tag.len() <= 64);
        assert!(p.text.len() <= 4 * 1024);
        assert!(p.uid.len() <= 128);
        assert!(p.target.is_none(), "oversized target dropped");
    }

    #[test]
    fn await_inside_a_batch_fails_fast_instead_of_blocking() {
        // Batch items route without the poll ctx → benign tool error, so a
        // batched render's emit is never held hostage by a 25s block.
        let batch = json!([
            { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": { "name": "render_artifact", "arguments": { "title": "B", "kind": "html", "content": "<p>x</p>" } } },
            { "jsonrpc": "2.0", "id": 2, "method": "tools/call",
              "params": { "name": AWAIT_TOOL_NAME, "arguments": {} } }
        ]);
        let start = Instant::now();
        let r = route(batch.to_string().as_bytes(), None);
        assert!(start.elapsed() < Duration::from_millis(500), "no blocking in a batch");
        assert_eq!(r.emits.len(), 1, "the render still emits");
        let arr = r.json.unwrap();
        let awaited = &arr.as_array().unwrap()[1];
        assert_eq!(awaited["result"]["isError"], true, "batched await is a fast tool error");
    }
}
