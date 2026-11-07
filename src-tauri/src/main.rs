#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifacts;
mod agents;
mod attention;
mod capabilities;
mod cc_data;
mod cli;
mod collaboration;
mod codex_delete;
mod embedder;
mod files;
mod fs_nav;
mod hues;
mod index;
mod pty;
mod project_tools;
mod search;
mod settings;
mod summary;
mod takeover;
mod updates;
mod wake;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use files::unique_path;
use pty::PtyManager;
use tauri::{AppHandle, Emitter, State};

/// Where the agent's command word ENDS inside a Drydock-built shell line, or
/// None if the line doesn't invoke that agent. Simple commands arrive as
/// `exec <command>`; compound overrides (env setup like `export FOO=1 &&
/// codex`) arrive bare, because `exec` on a compound line makes the shell run
/// the first builtin and exit (frontend shellLine). The word only counts in
/// COMMAND position — line start, or after `exec`/`env`/assignments/flags, or
/// after a `&&`/`||`/`;` — so `echo exec claude` and env VALUES containing the
/// name never match. Basename comparison lets `/opt/bin/codex` decorate too.
/// Naturally excludes plain shells (their args are just `-l`, a flag).
///
/// The tokenizer is QUOTE-AWARE at the top level: a quoted span glues into
/// one token, so `--prompt 'run x && codex'` is a single opaque token — never
/// an operator, never the agent word, and `FOO='a b'` stays one assignment.
/// A quoted token never matches (splicing near quotes risks re-pairing them),
/// and unbalanced quotes refuse the whole line. Known accepted edge: a flag's
/// separate VALUE in prefix position (`env -u codex mytool`) reads as the
/// command word — flag arity is unknowable here, and agent overrides don't
/// realistically take that shape.
fn find_agent_word(line: &str, word: &str) -> Option<usize> {
    // (start, end, contained a quote)
    let mut toks: Vec<(usize, usize, bool)> = Vec::new();
    {
        let mut start: Option<usize> = None;
        let mut quoted = false;
        let mut in_q: Option<char> = None;
        let mut end_pos = 0;
        for (i, c) in line.char_indices() {
            end_pos = i + c.len_utf8();
            if let Some(q) = in_q {
                if c == q {
                    in_q = None;
                }
                continue; // inside quotes: everything is token body
            }
            if c == '\'' || c == '"' {
                in_q = Some(c);
                quoted = true;
                if start.is_none() {
                    start = Some(i);
                }
                continue;
            }
            if c.is_whitespace() {
                if let Some(s) = start.take() {
                    toks.push((s, i, quoted));
                    quoted = false;
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        if in_q.is_some() {
            return None; // unbalanced quotes — refuse to reason about it
        }
        if let Some(s) = start {
            toks.push((s, end_pos, quoted));
        }
    }
    let mut expect_cmd = true;
    for (s, e, quoted) in toks {
        let tok = &line[s..e];
        if expect_cmd {
            // still in the command's prefix, not the command itself
            if tok == "exec" || tok == "env" || tok.contains('=') || tok.starts_with('-') {
                continue;
            }
            let clean = tok.trim_end_matches(';');
            let base = clean.rsplit('/').next().unwrap_or(clean);
            // a trailing `;` (tok != clean) would garble a splice — skip it;
            // the launch still works, only the decoration is declined
            if !quoted && base == word && clean == tok {
                return Some(e);
            }
            expect_cmd = tok.ends_with(';') && !quoted;
        } else if !quoted && (tok == "&&" || tok == "||" || tok == ";" || tok.ends_with(';')) {
            expect_cmd = true;
        }
    }
    None
}

/// True for the shell lines Drydock builds to launch claude — `exec claude`,
/// `exec claude --resume '<id>'`, and compound overrides like
/// `export FOO=1 && claude`.
fn is_claude_exec(arg: &str) -> bool {
    find_agent_word(arg, "claude").is_some()
}

/// Same contract for codex tabs (`exec codex`, `exec codex resume '<id>'`,
/// override forms like `exec codex --profile work`, and compound overrides).
fn is_codex_exec(arg: &str) -> bool {
    find_agent_word(arg, "codex").is_some()
}

/// Insert flags right after the codex word, preserving the rest — `-c` is a
/// global flag, so it lands before any `resume` subcommand.
fn splice_codex_flags(cmd: &str, flags: &str) -> String {
    let Some(end) = find_agent_word(cmd, "codex") else { return cmd.to_string() };
    format!("{} {}{}", &cmd[..end], flags, &cmd[end..])
}

/// Splice the artifact flags right after the claude word, preserving the rest
/// of the command (e.g. ` --resume '<id>'`). `cfg_path` is single-quoted, so
/// the caller must ensure it has no single quote. NUDGE is single-quote-safe
/// by construction (asserted in artifacts.rs tests).
fn inject_artifact_flags(cmd: &str, cfg_path: &str) -> String {
    let Some(end) = find_agent_word(cmd, "claude") else { return cmd.to_string() };
    format!(
        "{head} --mcp-config {cfg} --allowedTools {tool} {await_tool} --append-system-prompt {nudge}{rest}",
        head = &cmd[..end],
        cfg = cli::sh_single_quote(cfg_path),
        tool = artifacts::TOOL_ID,
        await_tool = artifacts::AWAIT_TOOL_ID,
        nudge = cli::sh_single_quote(artifacts::NUDGE),
        rest = &cmd[end..],
    )
}

/// Insert an arbitrary flag string right after the claude word, preserving the
/// rest. Used to splice the MCP deny-list ahead of any `--resume`/`--session-id`.
fn splice_claude_flags(cmd: &str, flags: &str) -> String {
    let Some(end) = find_agent_word(cmd, "claude") else { return cmd.to_string() };
    format!("{} {}{}", &cmd[..end], flags, &cmd[end..])
}

/// The per-session `--settings` JSON registering the hooks that forward their
/// stdin to the loopback `/hook` endpoint. Token and port are Drydock-generated
/// (base64url / a number), so the single-quoted shell command stays quote-safe
/// by construction.
///
/// All three events land on one endpoint and are told apart by
/// `attention::classify`, rather than being filtered here with per-event
/// `matcher`s. Notification's eight subtypes include one Drydock actively wants
/// (`agent_completed`), so filtering at registration would mean two hook
/// entries and two curls per delivery to end up in the same place.
fn hooks_settings_json(token: &str, port: u16) -> String {
    let curl = format!(
        "curl -sS -m 3 -X POST -H 'Authorization: Bearer {token}' --data-binary @- 'http://127.0.0.1:{port}/hook' >/dev/null 2>&1 || true"
    );
    let hook = serde_json::json!([{ "hooks": [{ "type": "command", "command": curl, "timeout": 10 }] }]);
    serde_json::json!({
        "hooks": {
            "Notification": hook.clone(),
            "Stop": hook.clone(),
            // A turn killed by a rate limit emits StopFailure and no Stop.
            "StopFailure": hook,
        }
    })
    .to_string()
}

/// `--disallowedTools 'mcp__<name>' …` for the servers the user switched off, so
/// their tools aren't offered to this session — without touching ~/.claude. Each
/// token is single-quoted for the shell `-c`; a name containing a single quote is
/// skipped (can't be quoted safely). Returns None when nothing is disabled.
fn disallowed_flags(disabled: &[String]) -> Option<String> {
    let toks: Vec<String> = disabled
        .iter()
        .filter(|n| !n.is_empty() && !n.contains('\''))
        .map(|n| format!("'mcp__{n}'"))
        .collect();
    if toks.is_empty() {
        None
    } else {
        Some(format!("--disallowedTools {}", toks.join(" ")))
    }
}

/// Codex accepts per-invocation TOML overrides. Keep the bearer token in the
/// child environment, rather than exposing it in the shell command or argv.
fn codex_mcp_flags(port: u16, enabled: bool, disabled: &[String], shared: &toml::Table) -> String {
    let mut servers = shared.clone();
    for name in disabled {
        servers.entry(name.clone()).or_insert_with(|| toml::Value::Table(Default::default()))
            .as_table_mut().unwrap().insert("enabled".into(), toml::Value::Boolean(false));
    }
    if enabled {
        let config = toml::from_str::<toml::Table>(&format!("url=\"http://127.0.0.1:{port}/mcp\"\nbearer_token_env_var=\"DRYDOCK_ARTIFACT_TOKEN\"\nenabled=true\ntool_timeout_sec=60")).unwrap();
        servers.insert(artifacts::SERVER_NAME.into(), toml::Value::Table(config));
    }
    if servers.is_empty() { return String::new(); }
    format!("-c {}", cli::sh_single_quote(&format!("mcp_servers={}", toml::Value::Table(servers))))
}

/// Spawn a PTY under a frontend-chosen id. program=None → login shell from
/// $SHELL. `session_id` is the claude session id the frontend pinned at launch
/// (None for plain shells) — it keys hook deliveries and artifact persistence.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: AppHandle,
    mgr: State<'_, PtyManager>,
    artifacts: State<'_, artifacts::ArtifactServer>,
    settings: State<'_, settings::SettingsState>,
    project_tools: State<'_, project_tools::ProjectTools>,
    id: u32,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    session_id: Option<String>,
    agent: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use tauri::Manager;
    let program = program
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut args = args.unwrap_or_default();
    // a "+"/⌘T shell passes no cwd; start it in $HOME so it has a real,
    // nameable directory instead of the app's launch dir ("/").
    let cwd = cwd.or_else(|| std::env::var("HOME").ok());
    let supported = agent.as_deref().is_none_or(|a| a == "claude" || a == "codex")
        && args.iter().any(|a| is_claude_exec(a) || is_codex_exec(a));
    let shared = if supported { cwd.as_deref().map(|p| project_tools.get(p)).transpose()?.unwrap_or_default() } else { Default::default() };
    let mut prepared = if shared.servers.is_empty() { project_tools::Prepared::new() } else {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        project_tools::Prepared::prepare(&shared, cwd.as_deref().unwrap_or("/"), &data.join("mcp"), id)?
    };
    let native_enabled = settings.artifacts_enabled() || !shared.skills.is_empty();

    // Drydock shapes the claude tabs it launches purely with spawn flags — it
    // NEVER edits ~/.claude. For a claude tab we:
    //  1. deny the tools of any server the user switched off in the MCP panel
    //     (`--disallowedTools`), leaving that server's config untouched;
    //  2. register per-session Notification/Stop hooks via `--settings` (the
    //     needs-input radar; hooks from all settings sources merge, so the
    //     user's own hooks still run); and
    //  3. inject the Preview artifact tool when enabled (a per-session
    //     `--mcp-config` at Drydock's loopback server, additive — no --strict —
    //     so the user's own servers are untouched).
    // session_id gates the splice, not just the string match: every claude tab
    // Drydock builds pins one (--session-id / --resume), so a CUSTOM agent
    // profile whose command merely starts with "claude" (matching
    // is_claude_exec) still runs as the plain `exec <command>` the Agents
    // settings page promises — no hooks, no MCP, no system-prompt nudge.
    let mut cleanup_files: Vec<std::path::PathBuf> = Vec::new();
    let mut launch_env = Vec::new();
    if let Some(idx) = (session_id.is_some() && agent.as_deref().is_none_or(|a| a == "claude"))
        .then(|| args.iter().position(|a| is_claude_exec(a)))
        .flatten()
    {
        let mut disabled: Vec<_> = settings.mcp_disabled().into_iter().filter(|name| !shared.servers.contains_key(name)).collect();
        disabled.extend(shared.servers.iter().filter(|(_, s)| !s.enabled).map(|(name, _)| name.clone()));
        if let Some(flags) = disallowed_flags(&disabled) {
            args[idx] = splice_claude_flags(&args[idx], &flags);
        }
        // One bearer token per claude tab authenticates BOTH loopback surfaces:
        // hook deliveries (/hook) and artifact renders (/mcp).
        let token = artifacts.mint_with_tools(id, cwd.clone().map(std::path::PathBuf::from), session_id.clone(), shared.skills.clone(), settings.artifacts_enabled());
        if let Ok(dir) = app.path().app_data_dir() {
            let hooks_dir = dir.join("hooks");
            let _ = std::fs::create_dir_all(&hooks_dir);
            let hooks_path = hooks_dir.join(format!("{id}.json"));
            let hooks_str = hooks_path.to_string_lossy().to_string();
            // The hook forwards its stdin JSON to the loopback server; `|| true`
            // so a dead/slow server never blocks or errors the session's hooks.
            let hooks_cfg = hooks_settings_json(&token, artifacts.port);
            if project_tools::write_private(&hooks_path, hooks_cfg.as_bytes()).is_ok() {
                args[idx] = splice_claude_flags(&args[idx], &format!("--settings {}", cli::sh_single_quote(&hooks_str)));
                cleanup_files.push(hooks_path);
            }
            if native_enabled || !prepared.claude.is_empty() {
                let mcp_dir = dir.join("mcp");
                let _ = std::fs::create_dir_all(&mcp_dir);
                let cfg_path = mcp_dir.join(format!("{id}.json"));
                let cfg_str = cfg_path.to_string_lossy().to_string();
                let mut servers = prepared.claude.clone();
                if native_enabled { servers.insert(
                    artifacts::SERVER_NAME.to_string(),
                    serde_json::json!({
                        "type": "http",
                        "url": format!("http://127.0.0.1:{}/mcp", artifacts.port),
                        "headers": { "Authorization": format!("Bearer {token}") }
                    }),
                ); }
                let cfg = serde_json::json!({ "mcpServers": serde_json::Value::Object(servers) });
                if let Err(e) = project_tools::write_private(&cfg_path, cfg.to_string().as_bytes()) {
                    artifacts.release(id);
                    for path in &cleanup_files { let _ = std::fs::remove_file(path); }
                    return Err(format!("Could not prepare shared project tools: {e}"));
                }
                args[idx] = if settings.artifacts_enabled() { inject_artifact_flags(&args[idx], &cfg_str) }
                    else { splice_claude_flags(&args[idx], &format!("--mcp-config {}", cli::sh_single_quote(&cfg_str))) };
                cleanup_files.push(cfg_path);
            }
        }
    }
    // Codex tabs get turn-complete badges the same spawn-time way — never an
    // edit to ~/.codex. `-c 'notify=[…]'` (a global, per-invocation config
    // override) points codex's one-event notify hook at a per-tab script that
    // forwards the payload to the loopback listener. Codex passes the payload
    // as the FINAL ARGV ARGUMENT with the program's stdio nulled — hence a
    // script reading "$1", not stdin. Cleaned up on exit like the hook files.
    if let Some(idx) = agent.as_deref().is_none_or(|a| a == "codex")
        .then(|| args.iter().position(|a| is_codex_exec(a))).flatten() {
        let token = artifacts.mint_with_tools(id, cwd.clone().map(std::path::PathBuf::from), session_id.clone(), shared.skills.clone(), settings.artifacts_enabled());
        let disabled = settings.mcp_disabled();
        // A lone enabled=false entry for an absent server is invalid Codex
        // config. Resolve names before applying Drydock's shared deny-list.
        let disabled = if disabled.is_empty() { disabled } else {
            let configured = capabilities::codex_mcp_servers(cwd.as_deref()).map_err(|e| {
                artifacts.release(id);
                e
            })?;
            disabled.into_iter().filter(|name| !shared.servers.contains_key(name) && configured.iter().any(|s| &s.name == name)).collect()
        };
        let flags = codex_mcp_flags(artifacts.port, native_enabled, &disabled, &prepared.codex);
        if !flags.is_empty() { args[idx] = splice_codex_flags(&args[idx], &flags); }
        if native_enabled {
            launch_env.push(("DRYDOCK_ARTIFACT_TOKEN".to_string(), token.clone()));
        }
        if let Ok(dir) = app.path().app_data_dir() {
            let hooks_dir = dir.join("hooks");
            let _ = std::fs::create_dir_all(&hooks_dir);
            let script_path = hooks_dir.join(format!("notify-{id}.sh"));
            let script_str = script_path.to_string_lossy().to_string();
            let script = format!(
                "#!/bin/sh\ncurl -sS -m 3 -X POST -H 'Authorization: Bearer {token}' --data-binary \"$1\" 'http://127.0.0.1:{}/hook' >/dev/null 2>&1 || true\n",
                artifacts.port
            );
            // path is spliced into shell + TOML quoting — refuse both quote kinds
            if !script_str.contains('\'') && !script_str.contains('"') && project_tools::write_private(&script_path, script.as_bytes()).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
                }
                args[idx] = splice_codex_flags(&args[idx], &format!("-c 'notify=[\"{script_str}\"]'"));
                cleanup_files.push(script_path);
            }
        }
    }

    if let Some(path) = &prepared.env_script {
        if let Some(idx) = args.iter().position(|a| is_claude_exec(a) || is_codex_exec(a)) {
            args[idx] = format!(". {}\n{}", cli::sh_single_quote(&path.to_string_lossy()), args[idx]);
        }
    }
    cleanup_files.append(&mut prepared.files);
    let release_tokens = artifacts.tokens_handle();
    let release_feedback = artifacts.feedback_handle();
    let exit_cleanup = cleanup_files.clone();

    let app_exit = app.clone();
    let result = mgr.with_spawn_env(launch_env).spawn(
        id,
        &program,
        &args,
        cwd.as_deref(),
        cols,
        rows,
        move |id, bytes| {
            let _ = app.emit(&format!("pty-output-{id}"), B64.encode(bytes));
        },
        move |id, code| {
            // The session is gone: invalidate its token, remove its injected
            // config files, and clear any waiting-for-input flag.
            release_tokens.lock().unwrap().retain(|_, v| v.pty_id != id);
            // Drop any pending review feedback and wake a poll blocked on it
            // (it then returns `ended`, since the session is gone).
            release_feedback.drop_session(id);
            for p in &exit_cleanup {
                let _ = std::fs::remove_file(p);
            }
            attention::pty_exited(&app_exit, id);
            let _ = app_exit.emit(&format!("pty-exit-{id}"), code);
        },
    );
    if result.is_err() {
        // Spawn failed, so the reader thread never started and on_exit won't run:
        // clean up the token + configs we injected for this dead spawn ourselves.
        artifacts.release(id);
        for p in &cleanup_files {
            let _ = std::fs::remove_file(p);
        }
    }
    result.map_err(|e| e.to_string())
}

/// Fresh Codex sessions acquire an id after launch. Attach their native tools
/// to that id and save artifacts rendered before discovery finished.
#[tauri::command]
fn pty_bind_session(id: u32, session_id: String, artifacts: State<'_, artifacts::ArtifactServer>) {
    artifacts.bind_session(id, &session_id);
}

#[tauri::command]
fn pty_write(app: AppHandle, mgr: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    // typing into a waiting session answers it — drop its attention flag
    attention::pty_interacted(&app, id);
    mgr.write(id, &bytes).map_err(|e| e.to_string())
}

/// The user can see these tabs, so clear their "finished, unseen" markers.
/// Called on window focus and whenever the staged panes change.
#[tauri::command]
fn attention_seen(app: AppHandle, pty_ids: Vec<u32>) {
    attention::mark_seen(&app, &pty_ids);
}

/// Show a macOS notification (used by the frontend when a session needs input
/// or finishes while unfocused). Requests permission lazily on first use.
/// `sound` plays the "Glass" system sound — the frontend sets it only for a
/// session blocked on an answer, and `attention::classify` is what makes that
/// claim true (an idle nag and a completion both used to ping);
/// per-app mute stays available in System Settings → Notifications.
#[tauri::command]
fn notify_user(app: AppHandle, title: String, body: String, sound: bool) {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let n = app.notification();
    if !matches!(n.permission_state(), Ok(PermissionState::Granted)) {
        let _ = n.request_permission();
    }
    let mut b = n.builder().title(&title).body(&body);
    if sound {
        b = b.sound("Glass");
    }
    let _ = b.show();
}

#[tauri::command]
fn pty_resize(mgr: State<'_, PtyManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    mgr.resize(id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(mgr: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    mgr.kill(id).map_err(|e| e.to_string())
}

/// Live working directories of the given shell PTYs, $HOME collapsed to `~`.
/// Only ids whose cwd is currently readable are returned (dead/exited dropped).
#[tauri::command]
fn pty_cwds(mgr: State<'_, PtyManager>, ids: Vec<u32>) -> Vec<(u32, String)> {
    let home = std::env::var("HOME").ok();
    ids.into_iter()
        .filter_map(|id| {
            let cwd = pty::process_cwd(mgr.pid(id)?)?;
            let shown = match &home {
                Some(h) if cwd == *h => "~".to_string(),
                Some(h) if cwd.starts_with(&format!("{h}/")) => format!("~{}", &cwd[h.len()..]),
                _ => cwd,
            };
            Some((id, shown))
        })
        .collect()
}

/// MCP servers visible to `project_path`, with Drydock's own loopback server
/// (`drydock-artifacts`) prepended and each config-sourced server's `enabled`
/// reflecting the Drydock deny-list. This is the config/intent view; live
/// connection status comes separately from `mcp_status`.
#[tauri::command(async)]
fn list_mcp_servers(
    project_path: Option<String>,
    agent: Option<String>,
    settings: State<'_, settings::SettingsState>,
    artifacts: State<'_, artifacts::ArtifactServer>,
    project_tools: State<'_, project_tools::ProjectTools>,
) -> Result<Vec<capabilities::McpServer>, String> {
    let disabled = settings.mcp_disabled();
    let mut servers = match agent.as_deref().unwrap_or("claude") {
        "claude" => capabilities::mcp_servers(project_path.as_deref()),
        "codex" => capabilities::codex_mcp_servers(project_path.as_deref())?,
        "shared" => project_path.as_deref().map(|p| project_tools.get(p).map(|s| project_tools::server_views(&s))).transpose()?.unwrap_or_default(),
        _ => return Ok(Vec::new()),
    };
    if agent.as_deref() != Some("shared") {
        let setup = project_path.as_deref().map(|p| project_tools.get(p)).transpose()?.unwrap_or_default();
        servers = project_tools::merge_servers(servers, &setup);
    }
    for s in &mut servers {
        if s.scope != "shared" { s.enabled &= !disabled.iter().any(|d| d == &s.name); }
    }
    let builtin = capabilities::McpServer {
        name: artifacts::SERVER_NAME.to_string(),
        kind: "http".to_string(),
        detail: format!("loopback 127.0.0.1:{} · renders to the Artifacts tab", artifacts.port),
        scope: "drydock".to_string(),
        builtin: true,
        enabled: settings.artifacts_enabled(),
        configured_enabled: true,
        tools: vec![artifacts::TOOL_NAME.to_string(), artifacts::AWAIT_TOOL_NAME.to_string()],
    };
    let mut out = Vec::with_capacity(servers.len() + 1);
    out.push(builtin); // Drydock's own server first
    out.extend(servers.into_iter().filter(|s| s.name != artifacts::SERVER_NAME));
    Ok(out)
}

/// Live `claude mcp list` health-check for the user's configured servers:
/// (name, status token, raw CLI text) triples. Read-only, killed after a hard
/// timeout; errors surface so the UI can say "check failed" rather than
/// leaving a stale green dot (see capabilities::mcp_status). Blocking-friendly:
/// runs on Tauri's async runtime, not the main thread.
#[tauri::command(async)]
fn mcp_status(project_path: Option<String>, agent: Option<String>) -> Result<Vec<(String, String, String)>, String> {
    if agent.as_deref().unwrap_or("claude") != "claude" { return Ok(Vec::new()); }
    capabilities::mcp_status(project_path.as_deref())
}

/// Toggle a server on/off for the claude tabs Drydock launches. `drydock-artifacts`
/// flips Drydock's own injection; any other name is added to/removed from the
/// deny-list. Persists to Drydock's settings.json — never ~/.claude — and takes
/// effect on the next session spawned.
#[tauri::command]
fn set_mcp_enabled(
    name: String,
    enabled: bool,
    settings: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    if name == artifacts::SERVER_NAME {
        settings.set_artifacts_enabled(enabled).map_err(|e| e.to_string())
    } else {
        settings.set_mcp_disabled(&name, !enabled).map_err(|e| e.to_string())
    }
}

/// The agents page's persisted state, one atomic read. Builtin profile
/// definitions (names, commands, tints) live in the frontend registry
/// (src/lib/agents.ts); the backend only stores the user's choices.
#[derive(serde::Serialize)]
struct AgentsConfig {
    enabled: Vec<String>,
    commands: std::collections::BTreeMap<String, String>,
    custom: Vec<settings::CustomAgent>,
}

#[tauri::command]
fn agents_get(settings: State<'_, settings::SettingsState>) -> AgentsConfig {
    let (enabled, commands, custom) = settings.agents_config();
    AgentsConfig { enabled, commands, custom }
}

#[tauri::command]
fn agents_set(
    enabled: Vec<String>,
    commands: std::collections::BTreeMap<String, String>,
    custom: Vec<settings::CustomAgent>,
    settings: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    settings.set_agents_config(enabled, commands, custom).map_err(|e| e.to_string())
}

/// Which of these commands exist in the user's login shell? One shell probe for
/// the whole list (a login shell costs ~100ms+; per-command spawns would stack).
/// Only the command's first token is probed, and tokens with shell metacharacters
/// are reported available rather than spliced into the probe line — the picker
/// erring visible beats a quoting hole. Blocking-friendly: async runtime, not
/// the main thread (same as mcp_status).
#[tauri::command(async)]
fn agents_probe(commands: Vec<String>) -> std::collections::HashMap<String, bool> {
    let safe = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c));
    let mut out: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let mut probe: Vec<String> = Vec::new();
    for cmd in &commands {
        let tok = cmd.split_whitespace().next().unwrap_or("").to_string();
        if safe(&tok) {
            probe.push(tok);
        } else {
            out.insert(cmd.clone(), true);
        }
    }
    if probe.is_empty() {
        return out;
    }
    // `command -v a b c` (not a for-loop): POSIX shells AND fish parse it —
    // $SHELL is whatever the user runs, and a probe the shell can't parse
    // would report every agent "not found". Output lines are resolved paths
    // (or the bare name for builtins/aliases), so match by basename.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let line = format!("command -v {}", probe.join(" "));
    let base = |s: &str| s.rsplit('/').next().unwrap_or(s).to_string();
    let found: std::collections::HashSet<String> = std::process::Command::new(shell)
        .args(["-l", "-c", &line])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(|s| base(s.trim())).collect())
        .unwrap_or_default();
    for cmd in &commands {
        let tok = cmd.split_whitespace().next().unwrap_or("");
        if safe(tok) {
            out.insert(cmd.clone(), found.contains(&base(tok)));
        }
    }
    out
}

/// The human queued/sent inline annotations on a rendered artifact: hand them to
/// the session's feedback queue, waking a blocked `await_artifact_feedback` poll.
/// `end_review` marks the review finished (the poll then reports `ended`).
#[tauri::command]
fn submit_artifact_feedback(
    pty_id: u32,
    prompts: Vec<artifacts::ReviewPrompt>,
    end_review: bool,
    artifacts: State<'_, artifacts::ArtifactServer>,
) {
    artifacts.submit_feedback(pty_id, prompts, end_review);
}

/// Reveal an artifact's source file in Finder. Only meaningful when the model
/// rendered from a `path`; inline-content artifacts have no file on disk.
#[tauri::command]
fn reveal_artifact(id: String, artifacts: State<'_, artifacts::ArtifactServer>) -> Result<(), String> {
    let path = artifacts
        .artifact_path(&id)
        .ok_or_else(|| "this artifact wasn't rendered from a file, so there's nothing to reveal".to_string())?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("couldn't open Finder: {e}"))?;
    Ok(())
}

/// Write an artifact straight to the user's Downloads folder (deduping the file
/// name), then reveal it in Finder. Returns the saved path for confirmation.
#[tauri::command]
fn save_artifact(id: String, app: AppHandle, artifacts: State<'_, artifacts::ArtifactServer>) -> Result<String, String> {
    use tauri::Manager;
    let (filename, bytes) = artifacts
        .artifact_download(&id)
        .ok_or_else(|| "artifact not found (it may have been cleared)".to_string())?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "couldn't find your Downloads folder".to_string())?;
    let dest = unique_path(&dir, &filename);
    std::fs::write(&dest, bytes).map_err(|e| format!("couldn't write the file: {e}"))?;
    // Best-effort reveal so the user sees where it landed.
    let _ = std::process::Command::new("open").arg("-R").arg(&dest).spawn();
    Ok(dest.display().to_string())
}

/// The persisted artifact gallery for a session (survives session + app).
#[tauri::command]
fn list_saved_artifacts(session_id: String, artifacts: State<'_, artifacts::ArtifactServer>) -> Vec<artifacts::SavedArtifact> {
    artifacts.list_saved(&session_id)
}

/// Raw content of one persisted artifact (svg/markdown render through the
/// frontend's sanitized srcdoc path; html is served over artifact:// instead).
#[tauri::command]
fn read_saved_artifact(session_id: String, file: String, artifacts: State<'_, artifacts::ArtifactServer>) -> Result<String, String> {
    artifacts
        .read_saved(&session_id, &file)
        .ok_or_else(|| "saved artifact not found".to_string())
}

/// Write a persisted artifact to Downloads (deduped name) and reveal it.
#[tauri::command]
fn save_saved_artifact(
    session_id: String,
    file: String,
    app: AppHandle,
    artifacts: State<'_, artifacts::ArtifactServer>,
) -> Result<String, String> {
    use tauri::Manager;
    let (filename, bytes) = artifacts
        .saved_download(&session_id, &file)
        .ok_or_else(|| "saved artifact not found".to_string())?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "couldn't find your Downloads folder".to_string())?;
    let dest = unique_path(&dir, &filename);
    std::fs::write(&dest, bytes).map_err(|e| format!("couldn't write the file: {e}"))?;
    let _ = std::process::Command::new("open").arg("-R").arg(&dest).spawn();
    Ok(dest.display().to_string())
}

/// Quit confirmed by the frontend: "Quit anyway" from the guard modal, or a
/// ⌘Q that the frontend found no live tabs for. Terminate every running session
/// first so quitting Drydock doesn't leave orphaned claude processes behind.
#[tauri::command]
fn force_quit(app: AppHandle) {
    use tauri::Manager;
    app.state::<PtyManager>().kill_all();
    app.exit(0)
}

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "drydock-quit";

/// Tauri's default macOS menu, except Quit. The predefined Quit item fires the
/// native `terminate:` selector, which tears the process down without ever
/// raising `RunEvent::ExitRequested` — so ⌘Q would SIGHUP live claude tabs
/// with no confirmation. A plain item with the same accelerator routes ⌘Q
/// through `on_menu_event` instead, where the quit guard lives.
#[cfg(target_os = "macos")]
fn macos_menu(handle: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };
    let pkg = handle.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(handle, pkg.name.clone())
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .separator()
        .item(
            &MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {}", pkg.name))
                .accelerator("Cmd+Q")
                .build(handle)?,
        )
        .build()?;
    let file = SubmenuBuilder::new(handle, "File").close_window().build()?;
    let edit = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(handle, "View").fullscreen().build()?;
    // the reserved ids keep tauri wiring these to NSApp's window/help roles
    let window = SubmenuBuilder::with_id(handle, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    let help = SubmenuBuilder::with_id(handle, HELP_SUBMENU_ID, "Help").build()?;
    MenuBuilder::new(handle)
        .items(&[&app_menu, &file, &edit, &view, &window, &help])
        .build()
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Serve HTML artifacts from their own isolated `artifact://` origin so
        // they run their JavaScript under a locked-down per-artifact CSP (charts,
        // animations, clicks) instead of inheriting the app's strict CSP, which
        // would block all scripts. The id is the trailing path segment; the bytes
        // live in ArtifactServer (managed state), evicted on session exit.
        .register_uri_scheme_protocol("artifact", |ctx, req| {
            use tauri::Manager;
            let id = req.uri().path().trim_start_matches('/').to_string();
            let html = ctx
                .app_handle()
                .try_state::<artifacts::ArtifactServer>()
                .and_then(|s| s.lookup_html(&id));
            artifacts::artifact_response(html)
        });
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(|app, event| {
        if event.id() == QUIT_MENU_ID {
            use tauri::Manager;
            if app.state::<PtyManager>().is_empty() {
                app.exit(0);
            } else {
                // The PTY map can briefly hold a just-killed session the reader
                // thread hasn't reaped, so the frontend re-checks its own tabs:
                // live ones → quitGuard modal, none → force_quit.
                let _ = app.emit("quit-requested", ());
            }
        }
    });
    builder
        .setup(|app| {
            use tauri::Manager;
            let data = app.path().app_data_dir().expect("data dir");
            std::fs::create_dir_all(&data).ok();
            // Drydock settings supply environment overrides to terminal tabs.
            let cfg = settings::Settings::load(&data);
            app.manage(PtyManager::with_env(cfg.env_pairs()));
            app.manage(collaboration::Collaboration::new(data.join("collaboration"))?);
            app.manage(summary::Summaries::default());
            app.manage(project_tools::ProjectTools::new(data.join("projects")));
            // Overnight-sleep display recovery: emit `system-woke` so the
            // frontend can rebuild layers + terminals (wake.rs / lib/wake.ts).
            wake::watch(app.handle().clone());
            // codex session discovery (sidebar rows + tab pairing)
            agents::start(app.handle());
            // Loopback MCP server for the Preview panel; pty_spawn injects a
            // per-session --mcp-config pointing at it into claude tabs. Renders
            // also persist into <data>/artifacts/<session>/ (the gallery).
            let artifact_server = artifacts::ArtifactServer::start(app.handle().clone(), data.join("artifacts"))?;
            app.manage(artifact_server);
            // Live, mutable settings (artifact toggle + MCP deny-list). Read at
            // spawn time and written back by the MCP-panel toggles.
            app.manage(settings::SettingsState::new(cfg, data.clone()));
            index::start(&app.handle().clone())?;
            // Needs-input radar surfaces: waiting map + dock badge + menu-bar
            // item. After index::start so the tray menu can resolve titles.
            attention::init(app.handle())?;
            {
                let db = data.join("drydock.db");
                let cache = data.join("models");
                // scheduled: catch-up drain now, then twice a day; the model
                // (and its half-GB ONNX arena) exists only while a run is live
                std::thread::spawn(move || embedder::imp::run(db, cache));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_bind_session,
            pty_write,
            pty_resize,
            pty_kill,
            pty_cwds,
            list_mcp_servers,
            mcp_status,
            set_mcp_enabled,
            submit_artifact_feedback,
            reveal_artifact,
            save_artifact,
            list_saved_artifacts,
            read_saved_artifact,
            save_saved_artifact,
            notify_user,
            attention_seen,
            fs_nav::list_dirs,
            fs_nav::ensure_dir,
            force_quit,
            takeover::session_process_info,
            takeover::takeover_kill,
            index::sessions_snapshot,
            index::set_starred,
            index::set_hidden,
            index::set_session_name,
            cc_data::session_tasks,
            cc_data::recap_digest,
            cc_data::session_usage,
            cc_data::usage_overview,
            cc_data::file_history,
            cc_data::read_file_version,
            index::create_folder,
            index::rename_folder,
            index::delete_folder,
            index::reorder_folders,
            index::set_session_folder,
            index::delete_session_permanently,
            index::session_chunks,
            collaboration::collaboration_prepare,
            collaboration::collaboration_changes,
            collaboration::collaboration_list,
            collaboration::collaboration_review,
            collaboration::collaboration_cancel,
            collaboration::collaboration_stale,
            collaboration::collaboration_handoff,
            collaboration::collaboration_bind,
            collaboration::collaboration_file,
            files::session_transcript,
            files::export_transcript,
            files::session_files,
            files::session_agents,
            files::agent_transcript,
            files::open_path,
            search::search,
            cli::check_claude,
            summary::get_session_summary,
            summary::refresh_session_summary,
            agents_get,
            agents_set,
            agents_probe,
            agents::codex_latest_session,
            capabilities::list_skills,
            project_tools::project_share_skill,
            project_tools::project_share_mcp,
            project_tools::project_remove_tool,
            project_tools::project_set_mcp_enabled,
            updates::app_version,
            updates::check_update,
            updates::install_update,
            updates::restart_app,
            updates::stash_tabs,
            updates::take_stashed_tabs,
            updates::open_releases_page
        ])
        .build(tauri::generate_context!())
        .expect("error while running Drydock")
        // No ExitRequested guard here: code=None only fires after the last
        // window is already destroyed (nothing left to show a modal in;
        // prevent_exit would leave a windowless zombie). Window close is
        // guarded by the frontend's onCloseRequested, ⌘Q by the menu above.
        //
        // RunEvent::Exit is the one funnel EVERY exit path crosses — the ✕
        // window close (which never went through force_quit, so it used to
        // orphan every claude/agent/shell process), force_quit itself
        // (kill_all again is idempotent: ESRCH), and Dock → Quit. Killing
        // here is what makes "quitting Drydock ends every session" a
        // guarantee rather than a property of the polite paths.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<collaboration::Collaboration>().cancel_all();
                app.state::<summary::Summaries>().cancel_all();
                app.state::<PtyManager>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_settings_registers_notification_and_both_stops() {
        let s = hooks_settings_json("tOk-123_ab", 49152);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        // StopFailure is load-bearing: a turn killed by a rate limit emits it
        // INSTEAD of Stop, so without it the session silently reads as answered.
        assert_eq!(v["hooks"].as_object().unwrap().len(), 3, "exactly these three events: {s}");
        for event in ["Notification", "Stop", "StopFailure"] {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains("Bearer tOk-123_ab"), "{event}: {cmd}");
            assert!(cmd.contains("127.0.0.1:49152/hook"), "{event}: {cmd}");
            assert!(cmd.ends_with("|| true"), "a hook failure must never block the session");
            assert_eq!(v["hooks"][event][0]["hooks"][0]["type"], "command");
        }
        // spliced single-quoted into the shell -c string via its file path only,
        // but the JSON itself must not smuggle newlines into the settings file
        assert!(!s.contains('\n'));
    }

    #[test]
    fn is_claude_exec_matches_new_resume_and_session_id_forms() {
        // a plain new session, and the new --session-id form the frontend now
        // uses to pin a brand-new session's id
        assert!(is_claude_exec("exec claude"));
        assert!(is_claude_exec("exec claude --session-id 'abc-123'"));
        assert!(is_claude_exec("exec claude --resume 'abc-123'"));
        // shells and look-alikes must not match
        assert!(!is_claude_exec("-l"));
        assert!(!is_claude_exec("exec claudette"));
        assert!(!is_claude_exec("echo exec claude"));
        // compound and env-prefixed override forms (spawned WITHOUT exec —
        // see shellLine in lib/agents.ts) match too
        assert!(is_claude_exec("export FOO=1 && claude --resume 'sid'"));
        assert!(is_claude_exec("env FOO=1 claude"));
        assert!(is_claude_exec("/opt/homebrew/bin/claude --session-id 'sid'"));
        // the name inside an env VALUE is not an invocation
        assert!(!is_claude_exec("export BIN=/x/claude && codex"));
    }

    #[test]
    fn find_agent_word_only_matches_command_position() {
        // after ; (attached or spaced) the next word is a command again
        assert!(find_agent_word("cd /x; codex", "codex").is_some());
        assert!(find_agent_word("cd /x ; codex", "codex").is_some());
        // a trailing ; on the agent word itself is refused (splice would garble)
        assert!(find_agent_word("codex; echo done", "codex").is_none());
        // an argument is not an invocation
        assert!(find_agent_word("man codex", "codex").is_none());
        // the offset lands exactly after the word — splices insert there
        let line = "export A=1 && /usr/local/bin/codex resume 'x'";
        let end = find_agent_word(line, "codex").unwrap();
        assert_eq!(&line[..end], "export A=1 && /usr/local/bin/codex");
    }

    #[test]
    fn find_agent_word_never_matches_inside_quotes() {
        // operators inside a quoted argument must not create command
        // positions — a mid-quote splice re-pairs the user's quotes and can
        // kill the launch outright (found by adversarial review)
        assert!(find_agent_word("claude --append-system-prompt 'run tests && codex review' --resume 's'", "codex").is_none());
        assert!(find_agent_word("mytool --run 'x && codex -v' --serve", "codex").is_none());
        // ...while the REAL invocation after the quoted arg still matches,
        // with the offset outside the quotes
        let line = "echo 'ready; codex on deck' && codex";
        let end = find_agent_word(line, "codex").unwrap();
        assert_eq!(end, line.len());
        // a quoted assignment value with spaces is ONE token: the prefix-skip
        // holds and the agent behind it still decorates
        assert!(find_agent_word("env FOO='a b' claude", "claude").is_some());
        assert!(find_agent_word("FOO='a b' claude --resume 'sid'", "claude").is_some());
        // a quoted command word declines (launch works, decoration doesn't)
        assert!(find_agent_word("'codex' resume 'x'", "codex").is_none());
        // unbalanced quotes refuse the whole line
        assert!(find_agent_word("codex --flag 'oops", "codex").is_none());
    }

    #[test]
    fn inject_artifact_flags_preserves_session_id_suffix() {
        let out = inject_artifact_flags("exec claude --session-id 'abc-123'", "/cfg/7.json");
        // flags are spliced right after `exec claude`, the rest is preserved
        assert!(out.starts_with("exec claude --mcp-config '/cfg/7.json'"));
        // both tools are pre-approved so neither first call halts on a prompt
        assert!(out.contains(artifacts::TOOL_ID));
        assert!(out.contains(artifacts::AWAIT_TOOL_ID));
        assert!(out.ends_with("--session-id 'abc-123'"));
    }

    #[test]
    fn disallowed_flags_quotes_names_and_skips_unsafe() {
        assert_eq!(disallowed_flags(&[]), None);
        assert_eq!(
            disallowed_flags(&["github".into(), "sentry".into()]),
            Some("--disallowedTools 'mcp__github' 'mcp__sentry'".to_string())
        );
        // a name with a single quote can't be shell-quoted safely → dropped
        assert_eq!(disallowed_flags(&["ev'il".into()]), None);
    }

    #[test]
    fn codex_exec_matcher_and_splice_cover_resume_and_override_forms() {
        assert!(is_codex_exec("exec codex"));
        assert!(is_codex_exec("exec codex resume 'abc'"));
        assert!(is_codex_exec("exec codex --profile work"));
        assert!(!is_codex_exec("exec codexx"));
        assert!(!is_codex_exec("exec claude"));
        // -c is a global flag: it must land BEFORE the resume subcommand
        let out = splice_codex_flags("exec codex resume 'abc'", "-c 'notify=[\"/tmp/n.sh\"]'");
        assert_eq!(out, "exec codex -c 'notify=[\"/tmp/n.sh\"]' resume 'abc'");
        // compound override: the env setup stays intact, flags follow the word
        let out = splice_codex_flags("export API=x && codex resume 'abc'", "-c 'n'");
        assert_eq!(out, "export API=x && codex -c 'n' resume 'abc'");
    }

    #[test]
    fn codex_native_mcp_flags_are_additive_and_never_contain_a_token() {
        let flags = codex_mcp_flags(1234, true, &["github".into(), "odd'name".into()], &Default::default());
        assert!(flags.contains("DRYDOCK_ARTIFACT_TOKEN"));
        assert!(flags.contains("127.0.0.1:1234/mcp"));
        assert!(flags.contains("tool_timeout_sec = 60"));
        assert!(flags.contains("github = { enabled = false }"));
        assert!(!flags.contains("developer_instructions"));
        let cmd = splice_codex_flags("exec codex --profile work resume 'thread'", &flags);
        assert!(cmd.ends_with(" --profile work resume 'thread'"));
        assert!(codex_mcp_flags(1234, false, &[], &Default::default()).is_empty());
        assert!(!codex_mcp_flags(1234, false, &["github".into()], &Default::default()).contains("drydock-artifacts"));
    }

    #[test]
    fn agents_probe_never_splices_unsafe_tokens_into_the_shell_line() {
        // every first token here carries shell metacharacters, so nothing is
        // probed (no shell spawns — the probe list is empty) and each command
        // reports available rather than silently vanishing from the picker
        let out = agents_probe(vec!["foo; rm -rf x".into(), "$(evil)".into(), "a'b".into(), "".into()]);
        assert_eq!(out.get("foo; rm -rf x"), Some(&true));
        assert_eq!(out.get("$(evil)"), Some(&true));
        assert_eq!(out.get("a'b"), Some(&true));
        assert_eq!(out.get(""), Some(&true));
    }

    #[test]
    fn splice_claude_flags_inserts_before_resume() {
        let out = splice_claude_flags(
            "exec claude --resume 'sid'",
            "--disallowedTools 'mcp__github'",
        );
        assert_eq!(out, "exec claude --disallowedTools 'mcp__github' --resume 'sid'");
    }

    #[test]
    fn both_injections_compose_on_one_command() {
        // deny-list spliced first, then the artifact flags — both present, the
        // original suffix preserved.
        let denied = splice_claude_flags("exec claude", "--disallowedTools 'mcp__github'");
        let full = inject_artifact_flags(&denied, "/cfg/3.json");
        assert!(full.contains("--disallowedTools 'mcp__github'"));
        assert!(full.contains("--mcp-config '/cfg/3.json'"));
        assert!(full.contains(artifacts::TOOL_ID));
        assert!(full.contains(artifacts::AWAIT_TOOL_ID));
    }
}
