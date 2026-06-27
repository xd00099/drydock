//! Loopback MCP server that lets a Claude Code session render an artifact in
//! Drydock's right-panel "Preview" tab.
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
//! adding zero new backend dependencies. It only ever INGESTS render calls; it
//! exposes no read path to session data. Each request is gated by a per-session
//! bearer token (the tab id is guessable; the random token is the auth) and an
//! Origin check (reject non-loopback origins to block DNS-rebinding).
//!
//! NOTHING here is written under ~/.claude.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
pub const NUDGE: &str = "You are running inside Drydock, which has a Preview side panel. When you create a self-contained visual artifact for the user to look at (an HTML page or UI mockup, an SVG image or diagram, or a Markdown document), ALSO call the tool mcp__drydock-artifacts__render_artifact with a short title, the kind (html, svg, or markdown), and the complete content, so it renders in the Preview panel. It renders locally inside Drydock and is not published to claude.ai. Prefer calling this tool whenever the user would benefit from seeing the result, in addition to any file you write.";

const TOOL_DESCRIPTION: &str = "Render a self-contained visual artifact in Drydock's Preview side panel so the user can SEE it immediately. Use this whenever you produce something visual to look at — an HTML page or UI mockup, an SVG image/diagram, or a Markdown document — instead of only writing a file or printing code. The artifact renders locally inside Drydock and is NOT published to claude.ai.";

/// Reject content larger than this (bytes). Bounds webview memory; the model
/// gets an isError result it can react to.
const MAX_CONTENT: usize = 4 * 1024 * 1024;

/// Per-session render token → the pty tab id that owns the session.
type Tokens = Arc<Mutex<HashMap<String, u32>>>;

/// Artifact pushed to the webview. Field names cross to the frontend verbatim.
#[derive(Clone, serde::Serialize)]
struct ArtifactEvent {
    pty_id: u32,
    id: String,
    title: String,
    kind: String,
    content: String,
}

/// Managed Tauri state: the ephemeral port + the live token map. `pty_spawn`
/// mints a token per claude tab; the serve thread resolves tokens to tab ids.
pub struct ArtifactServer {
    pub port: u16,
    pub enabled: bool,
    tokens: Tokens,
}

impl ArtifactServer {
    /// Bind the loopback listener and (if enabled) start the accept thread.
    pub fn start(app: AppHandle, enabled: bool) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let tokens: Tokens = Arc::new(Mutex::new(HashMap::new()));
        if enabled {
            let t = Arc::clone(&tokens);
            std::thread::spawn(move || serve(listener, t, app));
        }
        Ok(Self { port, enabled, tokens })
    }

    /// Mint a token for a tab id (call once per claude spawn). The token goes in
    /// the injected --mcp-config Authorization header; it never hits a cmdline.
    pub fn mint(&self, pty_id: u32) -> String {
        let token = random_token();
        self.tokens.lock().unwrap().insert(token.clone(), pty_id);
        token
    }

    /// Drop every token for a tab id (on pty exit).
    pub fn release(&self, pty_id: u32) {
        self.tokens.lock().unwrap().retain(|_, v| *v != pty_id);
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

fn serve(listener: TcpListener, tokens: Tokens, app: AppHandle) {
    let counter = Arc::new(AtomicU64::new(1));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let tokens = Arc::clone(&tokens);
        let app = app.clone();
        let counter = Arc::clone(&counter);
        std::thread::spawn(move || {
            let _ = handle_conn(stream, &tokens, &app, &counter);
        });
    }
}

fn handle_conn(
    mut stream: TcpStream,
    tokens: &Tokens,
    app: &AppHandle,
    counter: &AtomicU64,
) -> std::io::Result<()> {
    // Idle keep-alive connections must not pin a thread forever.
    stream.set_read_timeout(Some(Duration::from_secs(120))).ok();
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

        // Auth: resolve the bearer token to the owning tab id.
        let pty_id = {
            let map = tokens.lock().unwrap();
            resolve_token(header(&req, "authorization"), &map)
        };
        let Some(pty_id) = pty_id else {
            write_status(&mut stream, 401, keep_alive)?;
            if keep_alive { continue } else { return Ok(()) }
        };

        let routed = route(&req.body, pty_id);
        for e in &routed.emits {
            let id = counter.fetch_add(1, Ordering::Relaxed);
            let _ = app.emit(
                "artifact",
                ArtifactEvent {
                    pty_id,
                    id: id.to_string(),
                    title: e.title.clone(),
                    kind: e.kind.clone(),
                    content: e.content.clone(),
                },
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
    write!(
        w,
        "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: {conn}\r\n\r\n"
    )?;
    w.flush()
}

fn write_json<W: Write>(w: &mut W, code: u16, body: &Value, keep_alive: bool) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let conn = if keep_alive { "keep-alive" } else { "close" };
    write!(
        w,
        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {conn}\r\n\r\n",
        bytes.len()
    )?;
    w.write_all(&bytes)?;
    w.flush()
}

// ---- auth / origin -----------------------------------------------------------

fn parse_bearer(h: &str) -> Option<&str> {
    let h = h.trim();
    h.strip_prefix("Bearer ")
        .or_else(|| h.strip_prefix("bearer "))
        .map(str::trim)
}

fn resolve_token(auth: Option<&str>, tokens: &HashMap<String, u32>) -> Option<u32> {
    let token = parse_bearer(auth?)?;
    tokens.get(token).copied()
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
}

struct Routed {
    status: u16,
    json: Option<Value>,
    emits: Vec<Emit>,
}

/// Route a raw request body (single message, or a batch array) to a response.
fn route(body: &[u8], pty_id: u32) -> Routed {
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
            let r = route_one(it, pty_id);
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
        route_one(&v, pty_id)
    }
}

fn route_one(msg: &Value, pty_id: u32) -> Routed {
    // No id → JSON-RPC notification: never gets a response.
    let Some(id) = msg.get("id").cloned() else {
        return Routed { status: 202, json: None, emits: vec![] };
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => respond(id, initialize_result(msg)),
        "ping" => respond(id, json!({})),
        "tools/list" => respond(id, tools_list_result()),
        "tools/call" => tools_call(id, msg, pty_id),
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
                    "kind": { "type": "string", "enum": ["html", "svg", "markdown"], "description": "Content type." },
                    "content": { "type": "string", "description": "The complete artifact source: a full HTML document, SVG markup, or Markdown text." }
                },
                "required": ["title", "kind", "content"]
            }
        }]
    })
}

fn tools_call(id: Value, msg: &Value, _pty_id: u32) -> Routed {
    let params = msg.get("params");
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    if name != Some(TOOL_NAME) {
        return respond_err(id, -32602, "Unknown tool");
    }
    let args = params.and_then(|p| p.get("arguments"));
    let get = |k: &str| args.and_then(|a| a.get(k)).and_then(Value::as_str).unwrap_or("");
    let title = {
        let t = get("title");
        if t.is_empty() { "Untitled" } else { t }
    };
    let kind = get("kind");
    let content = get("content");

    if !matches!(kind, "html" | "svg" | "markdown") {
        return tool_error(id, "kind must be one of: html, svg, markdown");
    }
    if content.is_empty() {
        return tool_error(id, "content must not be empty");
    }
    if content.len() > MAX_CONTENT {
        return tool_error(id, "content too large (4 MB limit)");
    }
    Routed {
        status: 200,
        json: Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Rendered \"{title}\" in Drydock's Preview panel.") }]
            }
        })),
        emits: vec![Emit { title: title.to_string(), kind: kind.to_string(), content: content.to_string() }],
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

    fn tokens(pairs: &[(&str, u32)]) -> HashMap<String, u32> {
        pairs.iter().map(|(t, id)| (t.to_string(), *id)).collect()
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
        assert_eq!(resolve_token(Some("Bearer good"), &map), Some(5));
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
        let r = route(msg.to_string().as_bytes(), 1);
        let res = &r.json.unwrap()["result"];
        assert_eq!(res["protocolVersion"], "2025-03-26");
        assert_eq!(res["serverInfo"]["name"], SERVER_NAME);
        assert!(r.emits.is_empty());
    }

    #[test]
    fn tools_list_exposes_render_artifact() {
        let msg = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let r = route(msg.to_string().as_bytes(), 1);
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
        let r = route(msg.to_string().as_bytes(), 9);
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
        let r = route(msg.to_string().as_bytes(), 1);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn tools_call_empty_content_errors() {
        let msg = json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "render_artifact", "arguments": { "title": "X", "kind": "svg", "content": "" } }
        });
        let r = route(msg.to_string().as_bytes(), 1);
        assert!(r.emits.is_empty());
        assert_eq!(r.json.unwrap()["result"]["isError"], true);
    }

    #[test]
    fn notification_gets_no_response() {
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let r = route(msg.to_string().as_bytes(), 1);
        assert_eq!(r.status, 202);
        assert!(r.json.is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" });
        let r = route(msg.to_string().as_bytes(), 1);
        assert_eq!(r.json.unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn malformed_json_is_parse_error() {
        let r = route(b"not json", 1);
        assert_eq!(r.json.unwrap()["error"]["code"], -32700);
    }

    #[test]
    fn batch_collects_responses_and_emits() {
        let batch = json!([
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": { "name": "render_artifact", "arguments": { "title": "B", "kind": "markdown", "content": "# hi" } } }
        ]);
        let r = route(batch.to_string().as_bytes(), 2);
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
