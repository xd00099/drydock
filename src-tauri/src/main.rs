#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifacts;
mod capabilities;
mod embedder;
mod enricher;
mod index;
mod pty;
mod search;
mod settings;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
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

/// Spawn a PTY under a frontend-chosen id. program=None → login shell from $SHELL.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: AppHandle,
    mgr: State<'_, PtyManager>,
    artifacts: State<'_, artifacts::ArtifactServer>,
    id: u32,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
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

    // Give claude tabs the Preview-panel artifact tool: a per-session
    // --mcp-config pointing at Drydock's loopback MCP server. Written to
    // Drydock's OWN app-data dir, never ~/.claude. `--mcp-config` is additive
    // (no --strict), so it never clobbers the user's own MCP servers.
    let mut cleanup_cfg: Option<std::path::PathBuf> = None;
    if artifacts.enabled {
        if let Some(idx) = args.iter().position(|a| is_claude_exec(a)) {
            if let Ok(dir) = app.path().app_data_dir() {
                let mcp_dir = dir.join("mcp");
                let _ = std::fs::create_dir_all(&mcp_dir);
                let cfg_path = mcp_dir.join(format!("{id}.json"));
                let cfg_str = cfg_path.to_string_lossy().to_string();
                let token = artifacts.mint(id);
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
                    cleanup_cfg = Some(cfg_path);
                } else {
                    artifacts.release(id); // couldn't wire it; don't leak a token
                }
            }
        }
    }
    let release_tokens = artifacts.tokens_handle();
    let exit_cfg = cleanup_cfg.clone();

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
            // The session is gone: invalidate its render token and remove its
            // injected config file.
            release_tokens.lock().unwrap().retain(|_, v| *v != id);
            if let Some(p) = &exit_cfg {
                let _ = std::fs::remove_file(p);
            }
            let _ = app_exit.emit(&format!("pty-exit-{id}"), code);
        },
    );
    if result.is_err() {
        // Spawn failed, so the reader thread never started and on_exit won't run:
        // clean up the token + config we injected for this dead spawn ourselves.
        artifacts.release(id);
        if let Some(p) = &cleanup_cfg {
            let _ = std::fs::remove_file(p);
        }
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(mgr: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    mgr.write(id, &bytes).map_err(|e| e.to_string())
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

/// Quit confirmed by the frontend: "Quit anyway" from the guard modal, or a
/// ⌘Q that the frontend found no live tabs for.
#[tauri::command]
fn force_quit(app: AppHandle) {
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
    let builder = tauri::Builder::default();
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
            // per-session --mcp-config pointing at it into claude tabs.
            let artifact_server =
                artifacts::ArtifactServer::start(app.handle().clone(), cfg.artifacts_enabled)?;
            app.manage(artifact_server);
            index::start(&app.handle().clone())?;
            {
                let db = data.join("drydock.db");
                let cache = data.join("models");
                std::thread::spawn(move || embedder::imp::run(db, cache));
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
            force_quit,
            index::sessions_snapshot,
            index::set_starred,
            index::set_hidden,
            index::delete_session_permanently,
            index::session_chunks,
            search::search,
            enricher::get_card,
            enricher::refresh_card,
            enricher::check_claude,
            capabilities::list_skills,
            capabilities::list_mcp_servers
        ])
        .build(tauri::generate_context!())
        .expect("error while running Drydock")
        // No ExitRequested guard here: code=None only fires after the last
        // window is already destroyed (nothing left to show a modal in;
        // prevent_exit would leave a windowless zombie). Window close is
        // guarded by the frontend's onCloseRequested, ⌘Q by the menu above.
        .run(|_, _| {});
}
