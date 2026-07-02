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
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter};

/// MCP server name (the key in the injected --mcp-config). The tool the model
/// calls is `mcp__<server>__<tool>`, so these two strings define `TOOL_ID`.
pub const SERVER_NAME: &str = "drydock-artifacts";
pub const TOOL_NAME: &str = "render_artifact";
/// Fully-qualified tool id for `--allowedTools` (pre-approves the tool so the
/// model's first call doesn't halt on a permission prompt).
pub const TOOL_ID: &str = "mcp__drydock-artifacts__render_artifact";

/// System-prompt nudge injected via `--append-system-prompt`. MUST stay a single
/// line with NO single quotes/apostrophes — it is spliced single-quoted into the
/// shell `-c` command. It names the exact tool id because current Claude Code may
/// defer/lazy-load MCP tool schemas, so the model needs an explicit pointer.
pub const NUDGE: &str = "You are running inside Drydock, which has an Artifacts side panel. When you create a self-contained visual artifact for the user to look at (an HTML page or UI mockup, an SVG image or diagram, or a Markdown document), show it by calling the tool mcp__drydock-artifacts__render_artifact with a short title. IMPORTANT for efficiency: if the artifact is in a file (including one you just wrote), pass its `path` (absolute, or relative to your working directory) and do NOT paste the file contents into the call — Drydock reads the file itself, so you avoid regenerating it. Use the `content` argument only for artifacts that are not saved to any file. It renders locally inside Drydock and is not published to claude.ai.";

const TOOL_DESCRIPTION: &str = "Render a self-contained visual artifact (HTML page/UI mockup, SVG image/diagram, or Markdown document) in Drydock's Artifacts side panel so the user can SEE it immediately. Pass EITHER `path` (preferred — a file you already wrote; Drydock reads it, so you don't resend or regenerate its content) OR inline `content` (only for artifacts not saved to a file). Renders locally inside Drydock and is NOT published to claude.ai.";

/// Reject content larger than this (bytes). Bounds webview memory; the model
/// gets an isError result it can react to.
const MAX_CONTENT: usize = 4 * 1024 * 1024;

/// Keep at most this many HTML artifacts per session in the served store, so a
/// session that re-renders many times can't grow memory without bound (mirrors
/// the frontend's per-tab cap). Older ones are evicted by arrival order.
const MAX_ARTIFACTS_PER_PTY: usize = 20;

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

/// Per-session render token → (owning pty tab id, that session's working
/// directory). The cwd resolves relative `path` arguments to render_artifact.
type Tokens = Arc<Mutex<HashMap<String, (u32, Option<PathBuf>)>>>;

/// One rendered artifact, retained so the user can re-fetch (HTML over the
/// `artifact://` scheme), download, or reveal it in Finder. `seq` is the
/// monotonic id (also the map key as a string), used to evict the oldest when a
/// session exceeds the per-pty cap. `path` is the on-disk source when the model
/// rendered from a file (None for inline content).
struct Stored {
    pty_id: u32,
    seq: u64,
    kind: String,
    title: String,
    content: String,
    path: Option<PathBuf>,
}

/// Artifact id (string form of the monotonic counter) → stored artifact. Every
/// kind is kept (download/reveal work for all); only HTML is also served over
/// the `artifact://` scheme — SVG/Markdown render in a sanitized srcdoc.
type Store = Arc<Mutex<HashMap<String, Stored>>>;

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

/// Managed Tauri state: the ephemeral port + the live token map. `pty_spawn`
/// mints a token per claude tab; the serve thread resolves tokens to tab ids.
pub struct ArtifactServer {
    pub port: u16,
    tokens: Tokens,
    store: Store,
}

impl ArtifactServer {
    /// Bind the loopback listener and start the accept thread. The server always
    /// listens — it's token-gated, so an idle/disabled state simply means no
    /// tokens are minted (every request 401s). Whether new sessions get the tool
    /// is decided at spawn time from settings (`artifacts_enabled`), which lets
    /// the user toggle it at runtime without restarting the listener.
    pub fn start(app: AppHandle) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let tokens: Tokens = Arc::new(Mutex::new(HashMap::new()));
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        let t = Arc::clone(&tokens);
        let s = Arc::clone(&store);
        std::thread::spawn(move || serve(listener, t, s, app));
        Ok(Self { port, tokens, store })
    }

    /// Stored HTML for an artifact id, for the `artifact://` scheme handler.
    /// Only HTML is served this way; other kinds return None.
    pub fn lookup_html(&self, id: &str) -> Option<String> {
        let m = self.store.lock().unwrap();
        m.get(id).filter(|s| s.kind == "html").map(|s| s.content.clone())
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
    /// session's working directory, used to resolve relative artifact paths. The
    /// token goes in the injected --mcp-config Authorization header; never a cmdline.
    pub fn mint(&self, pty_id: u32, cwd: Option<PathBuf>) -> String {
        let token = random_token();
        self.tokens.lock().unwrap().insert(token.clone(), (pty_id, cwd));
        token
    }

    /// Drop every token AND stored artifact for a tab id (on pty exit) — an
    /// ended session keeps nothing in memory.
    pub fn release(&self, pty_id: u32) {
        self.tokens.lock().unwrap().retain(|_, v| v.0 != pty_id);
        self.store.lock().unwrap().retain(|_, s| s.pty_id != pty_id);
    }

    /// Shared handle to the token map, for an exit closure that outlives `&self`.
    pub fn tokens_handle(&self) -> Tokens {
        Arc::clone(&self.tokens)
    }
}

/// 128 bits of OS randomness, URL-safe base64 (header-safe charset). Fails loud
/// rather than ever handing out a predictable token (e.g. all-zeros).
fn random_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn serve(listener: TcpListener, tokens: Tokens, store: Store, app: AppHandle) {
    let counter = Arc::new(AtomicU64::new(1));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let tokens = Arc::clone(&tokens);
        let store = Arc::clone(&store);
        let app = app.clone();
        let counter = Arc::clone(&counter);
        std::thread::spawn(move || {
            let _ = handle_conn(stream, &tokens, &store, &app, &counter);
        });
    }
}

fn handle_conn(
    mut stream: TcpStream,
    tokens: &Tokens,
    store: &Store,
    app: &AppHandle,
    counter: &AtomicU64,
) -> std::io::Result<()> {
    // Idle keep-alive connections must not pin a thread forever.
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
            "POST" if req.path.starts_with("/mcp") => None,
            _ => Some(404),
        };
        if let Some(code) = status_only {
            write_status(&mut stream, code, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        }

        // Auth: resolve the bearer token to the owning tab id (+ its cwd).
        let resolved = {
            let map = tokens.lock().unwrap();
            resolve_token(header(&req, "authorization"), &map)
        };
        let Some((pty_id, cwd)) = resolved else {
            write_status(&mut stream, 401, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        };

        let routed = route(&req.body, cwd.as_deref());
        for e in &routed.emits {
            let seq = counter.fetch_add(1, Ordering::Relaxed);
            let id = seq.to_string();
            // Retain every artifact so Download / Reveal-in-Finder work for all
            // kinds and HTML can be re-fetched over the artifact:// scheme.
            store_insert(store, &id, pty_id, seq, &e.kind, &e.title, &e.content, e.path.clone());
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
        match &routed.json {
            Some(v) => write_json(&mut stream, routed.status, v, keep_alive)?,
            None => write_status(&mut stream, routed.status, keep_alive)?,
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

fn resolve_token(auth: Option<&str>, tokens: &HashMap<String, (u32, Option<PathBuf>)>) -> Option<(u32, Option<PathBuf>)> {
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

struct Routed {
    status: u16,
    json: Option<Value>,
    emits: Vec<Emit>,
}

/// Route a raw request body (single message, or a batch array) to a response.
/// `cwd` is the calling session's working directory, for relative artifact paths.
fn route(body: &[u8], cwd: Option<&Path>) -> Routed {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return Routed {
                status: 200,
                json: Some(rpc_error(Value::Null, -32700, "Parse error")),
                emits: vec![],
            }
        }
    };
    if let Value::Array(items) = v {
        let mut out = Vec::new();
        let mut emits = Vec::new();
        for it in &items {
            let r = route_one(it, cwd);
            if let Some(j) = r.json {
                out.push(j);
            }
            emits.extend(r.emits);
        }
        if out.is_empty() {
            Routed { status: 202, json: None, emits }
        } else {
            Routed { status: 200, json: Some(Value::Array(out)), emits }
        }
    } else {
        route_one(&v, cwd)
    }
}

fn route_one(msg: &Value, cwd: Option<&Path>) -> Routed {
    // No id → JSON-RPC notification: never gets a response.
    let Some(id) = msg.get("id").cloned() else {
        return Routed { status: 202, json: None, emits: vec![] };
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => respond(id, initialize_result(msg)),
        "ping" => respond(id, json!({})),
        "tools/list" => respond(id, tools_list_result()),
        "tools/call" => tools_call(id, msg, cwd),
        _ => respond_err(id, -32601, "Method not found"),
    }
}

fn respond(id: Value, result: Value) -> Routed {
    Routed {
        status: 200,
        json: Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        emits: vec![],
    }
}

fn respond_err(id: Value, code: i64, message: &str) -> Routed {
    Routed { status: 200, json: Some(rpc_error(id, code, message)), emits: vec![] }
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

fn tools_call(id: Value, msg: &Value, cwd: Option<&Path>) -> Routed {
    let params = msg.get("params");
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    if name != Some(TOOL_NAME) {
        return respond_err(id, -32602, "Unknown tool");
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
    }
}

// ---- HTML artifact store + `artifact://` rendering --------------------------

/// Store one artifact under `id`, then evict this pty's oldest if it now exceeds
/// the per-session cap (oldest = smallest `seq`).
#[allow(clippy::too_many_arguments)]
fn store_insert(store: &Store, id: &str, pty_id: u32, seq: u64, kind: &str, title: &str, content: &str, path: Option<PathBuf>) {
    let mut m = store.lock().unwrap();
    m.insert(
        id.to_string(),
        Stored { pty_id, seq, kind: kind.to_string(), title: title.to_string(), content: content.to_string(), path },
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

/// The exact HTML document served for an artifact: a full page passes through
/// (plus the Esc forwarder); a fragment gets the minimal dark-theme wrapper.
fn build_artifact_document(html: &str) -> String {
    if is_full_document(html) {
        format!("{html}{ESC_FORWARDER}")
    } else {
        format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>{ARTIFACT_FRAME_CSS}</style></head><body>{html}{ESC_FORWARDER}</body></html>"
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn tokens(pairs: &[(&str, u32)]) -> HashMap<String, (u32, Option<PathBuf>)> {
        pairs.iter().map(|(t, id)| (t.to_string(), (*id, None))).collect()
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
        assert_eq!(resolve_token(Some("Bearer good"), &map), Some((5, None)));
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
            store_insert(&store, &i.to_string(), 7, i, "html", "t", &format!("<p>{i}</p>"), None);
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
            store_insert(&store, &format!("a{i}"), 1, i, "html", "t", "x", None);
            store_insert(&store, &format!("b{i}"), 2, 1000 + i, "html", "t", "y", None);
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
            format!("{doc}{ESC_FORWARDER}"),
            "a full page is served unwrapped, with only the Esc forwarder appended"
        );
    }

    #[test]
    fn artifact_documents_carry_the_esc_forwarder() {
        // fragment path: forwarder inside the wrapper's body
        let frag = build_artifact_document("<div>x</div>");
        assert!(frag.contains(ESC_FORWARDER));
        assert!(frag.contains("drydock-esc"));
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

    #[test]
    fn artifact_download_uses_stored_content_and_name() {
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        store_insert(&store, "9", 1, 9, "markdown", "Read Me", "# hi", None);
        let srv = ArtifactServer { port: 0, tokens: Arc::new(Mutex::new(HashMap::new())), store };
        let (name, bytes) = srv.artifact_download("9").unwrap();
        assert_eq!(name, "Read Me.md");
        assert_eq!(bytes, b"# hi");
        assert!(srv.artifact_download("nope").is_none());
        // inline artifact has no source path → no Reveal in Finder
        assert!(srv.artifact_path("9").is_none());
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
    }

    #[test]
    fn nudge_is_single_quote_safe() {
        // It is spliced single-quoted into a shell -c string.
        assert!(!NUDGE.contains('\''));
        assert!(!NUDGE.contains('\n'));
    }
}
