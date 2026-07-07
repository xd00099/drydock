#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifacts;
mod attention;
mod capabilities;
mod embedder;
mod enricher;
mod files;
mod hues;
mod index;
mod pty;
mod search;
mod settings;
mod updates;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use files::unique_path;
use pty::PtyManager;
use tauri::{AppHandle, Emitter, State};

/// True for the shell commands Drydock builds to launch claude (`exec claude`
/// and `exec claude --resume '<id>'`). Drydock owns these strings, so the match
/// is reliable and naturally excludes plain shells (which pass `["-l"]`).
fn is_claude_exec(arg: &str) -> bool {
    arg == "exec claude" || arg.starts_with("exec claude ")
}

/// Splice the artifact flags right after `exec claude`, preserving the rest of
/// the command (e.g. ` --resume '<id>'`). `cfg_path` is single-quoted, so the
/// caller must ensure it has no single quote. NUDGE is single-quote-safe by
/// construction (asserted in artifacts.rs tests).
fn inject_artifact_flags(cmd: &str, cfg_path: &str) -> String {
    let rest = &cmd["exec claude".len()..];
    format!(
        "exec claude --mcp-config '{cfg}' --allowedTools {tool} --append-system-prompt '{nudge}'{rest}",
        cfg = cfg_path,
        tool = artifacts::TOOL_ID,
        nudge = artifacts::NUDGE,
    )
}

/// Insert an arbitrary flag string right after `exec claude`, preserving the
/// rest. Used to splice the MCP deny-list ahead of any `--resume`/`--session-id`.
fn splice_claude_flags(cmd: &str, flags: &str) -> String {
    let rest = &cmd["exec claude".len()..];
    format!("exec claude {flags}{rest}")
}

/// The per-session `--settings` JSON registering Notification/Stop hooks that
/// forward their stdin to the loopback `/hook` endpoint. Token and port are
/// Drydock-generated (base64url / a number), so the single-quoted shell command
/// stays quote-safe by construction.
fn hooks_settings_json(token: &str, port: u16) -> String {
    let curl = format!(
        "curl -sS -m 3 -X POST -H 'Authorization: Bearer {token}' --data-binary @- 'http://127.0.0.1:{port}/hook' >/dev/null 2>&1 || true"
    );
    let hook = serde_json::json!([{ "hooks": [{ "type": "command", "command": curl, "timeout": 10 }] }]);
    serde_json::json!({ "hooks": { "Notification": hook.clone(), "Stop": hook } }).to_string()
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
    id: u32,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    session_id: Option<String>,
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
    let mut cleanup_files: Vec<std::path::PathBuf> = Vec::new();
    if let Some(idx) = args.iter().position(|a| is_claude_exec(a)) {
        if let Some(flags) = disallowed_flags(&settings.mcp_disabled()) {
            args[idx] = splice_claude_flags(&args[idx], &flags);
        }
        // One bearer token per claude tab authenticates BOTH loopback surfaces:
        // hook deliveries (/hook) and artifact renders (/mcp).
        let token = artifacts.mint(id, cwd.clone().map(std::path::PathBuf::from), session_id.clone());
        if let Ok(dir) = app.path().app_data_dir() {
            let hooks_dir = dir.join("hooks");
            let _ = std::fs::create_dir_all(&hooks_dir);
            let hooks_path = hooks_dir.join(format!("{id}.json"));
            let hooks_str = hooks_path.to_string_lossy().to_string();
            // The hook forwards its stdin JSON to the loopback server; `|| true`
            // so a dead/slow server never blocks or errors the session's hooks.
            let hooks_cfg = hooks_settings_json(&token, artifacts.port);
            if !hooks_str.contains('\'') && std::fs::write(&hooks_path, hooks_cfg).is_ok() {
                args[idx] = splice_claude_flags(&args[idx], &format!("--settings '{hooks_str}'"));
                cleanup_files.push(hooks_path);
            }
            if settings.artifacts_enabled() {
                let mcp_dir = dir.join("mcp");
                let _ = std::fs::create_dir_all(&mcp_dir);
                let cfg_path = mcp_dir.join(format!("{id}.json"));
                let cfg_str = cfg_path.to_string_lossy().to_string();
                let mut servers = serde_json::Map::new();
                servers.insert(
                    artifacts::SERVER_NAME.to_string(),
                    serde_json::json!({
                        "type": "http",
                        "url": format!("http://127.0.0.1:{}/mcp", artifacts.port),
                        "headers": { "Authorization": format!("Bearer {token}") }
                    }),
                );
                let cfg = serde_json::json!({ "mcpServers": serde_json::Value::Object(servers) });
                if !cfg_str.contains('\'') && std::fs::write(&cfg_path, cfg.to_string()).is_ok() {
                    args[idx] = inject_artifact_flags(&args[idx], &cfg_str);
                    cleanup_files.push(cfg_path);
                }
            }
        }
    }
    let release_tokens = artifacts.tokens_handle();
    let exit_cleanup = cleanup_files.clone();

    let app_exit = app.clone();
    let result = mgr.spawn(
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

#[tauri::command]
fn pty_write(app: AppHandle, mgr: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    // typing into a waiting session answers it — drop its attention flag
    attention::pty_interacted(&app, id);
    mgr.write(id, &bytes).map_err(|e| e.to_string())
}

/// Show a macOS notification (used by the frontend when a session needs input
/// or finishes while unfocused). Requests permission lazily on first use.
#[tauri::command]
fn notify_user(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let n = app.notification();
    if !matches!(n.permission_state(), Ok(PermissionState::Granted)) {
        let _ = n.request_permission();
    }
    let _ = n.builder().title(&title).body(&body).show();
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
#[tauri::command]
fn list_mcp_servers(
    project_path: Option<String>,
    settings: State<'_, settings::SettingsState>,
    artifacts: State<'_, artifacts::ArtifactServer>,
) -> Vec<capabilities::McpServer> {
    let disabled = settings.mcp_disabled();
    let mut servers = capabilities::mcp_servers(project_path.as_deref());
    for s in &mut servers {
        s.enabled = !disabled.iter().any(|d| d == &s.name);
    }
    let builtin = capabilities::McpServer {
        name: artifacts::SERVER_NAME.to_string(),
        kind: "http".to_string(),
        detail: format!("loopback 127.0.0.1:{} · renders to the Artifacts tab", artifacts.port),
        scope: "drydock".to_string(),
        builtin: true,
        enabled: settings.artifacts_enabled(),
        tools: vec![artifacts::TOOL_NAME.to_string()],
    };
    let mut out = Vec::with_capacity(servers.len() + 1);
    out.push(builtin); // Drydock's own server first
    out.extend(servers);
    out
}

/// Live `claude mcp list` health-check for the user's configured servers:
/// (name, status token, raw CLI text) triples. Read-only, killed after a hard
/// timeout; errors surface so the UI can say "check failed" rather than
/// leaving a stale green dot (see capabilities::mcp_status). Blocking-friendly:
/// runs on Tauri's async runtime, not the main thread.
#[tauri::command(async)]
fn mcp_status(project_path: Option<String>) -> Result<Vec<(String, String, String)>, String> {
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
            // Drydock settings drive both spawn paths; inject claude_env into
            // every PTY (terminal tabs) and, in the enricher, into card calls.
            let cfg = settings::Settings::load(&data);
            app.manage(PtyManager::with_env(cfg.env_pairs()));
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
                let emit = app.handle().clone();
                std::thread::spawn(move || embedder::imp::run(db, cache, emit));
            }
            {
                let db = data.join("drydock.db");
                let handle = app.handle().clone();
                std::thread::spawn(move || enricher::run(handle, db));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_cwds,
            list_mcp_servers,
            mcp_status,
            set_mcp_enabled,
            reveal_artifact,
            save_artifact,
            list_saved_artifacts,
            read_saved_artifact,
            save_saved_artifact,
            notify_user,
            force_quit,
            index::sessions_snapshot,
            index::set_starred,
            index::set_hidden,
            index::create_folder,
            index::rename_folder,
            index::delete_folder,
            index::reorder_folders,
            index::set_session_folder,
            index::delete_session_permanently,
            index::session_chunks,
            files::session_transcript,
            files::export_transcript,
            files::session_files,
            files::session_agents,
            files::agent_transcript,
            files::open_path,
            search::search,
            enricher::get_card,
            enricher::refresh_card,
            enricher::check_claude,
            capabilities::list_skills,
            updates::app_version,
            updates::check_update,
            updates::open_releases_page
        ])
        .build(tauri::generate_context!())
        .expect("error while running Drydock")
        // No ExitRequested guard here: code=None only fires after the last
        // window is already destroyed (nothing left to show a modal in;
        // prevent_exit would leave a windowless zombie). Window close is
        // guarded by the frontend's onCloseRequested, ⌘Q by the menu above.
        .run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_settings_registers_notification_and_stop() {
        let s = hooks_settings_json("tOk-123_ab", 49152);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        for event in ["Notification", "Stop"] {
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
    }

    #[test]
    fn inject_artifact_flags_preserves_session_id_suffix() {
        let out = inject_artifact_flags("exec claude --session-id 'abc-123'", "/cfg/7.json");
        // flags are spliced right after `exec claude`, the rest is preserved
        assert!(out.starts_with("exec claude --mcp-config '/cfg/7.json'"));
        assert!(out.contains(artifacts::TOOL_ID));
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
    }
}
