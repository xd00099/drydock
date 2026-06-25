#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

/// Spawn a PTY under a frontend-chosen id. program=None → login shell from $SHELL.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: AppHandle,
    mgr: State<'_, PtyManager>,
    id: u32,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let program = program
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let args = args.unwrap_or_default();
    // a "+"/⌘T shell passes no cwd; start it in $HOME so it has a real,
    // nameable directory instead of the app's launch dir ("/").
    let cwd = cwd.or_else(|| std::env::var("HOME").ok());
    let app_exit = app.clone();
    mgr.spawn(
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
            let _ = app_exit.emit(&format!("pty-exit-{id}"), code);
        },
    )
    .map_err(|e| e.to_string())
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
