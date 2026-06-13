use drydock_core::store::Store;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppDb(pub Mutex<Store>);

#[derive(serde::Serialize, Clone)]
pub struct SessionView {
    pub session_id: String,
    pub project_path: String,
    pub title: String,
    pub latest_recap: Option<String>,
    pub last_message_at: Option<i64>,
    pub starred: bool,
    pub hidden: bool,
    pub live_status: String,
}

#[derive(serde::Serialize)]
pub struct Snapshot {
    pub sessions: Vec<SessionView>,
    pub pinned: Vec<String>,
}

pub fn claude_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME not set")
        .join(".claude")
}

/// The cwd of a transcript's first non-sidechain record — the directory the
/// session was rooted in, which is where `claude --resume` must be launched.
/// Reads only as far as the first record carrying a cwd (usually line 1).
fn first_cwd(path: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let drydock_core::records::ParsedRecord::Chain(c) = drydock_core::parser::parse_line(&line) {
            if !c.is_sidechain {
                if let Some(cwd) = c.cwd {
                    return Some(cwd);
                }
            }
        }
    }
    None
}

/// One-time fix for sessions indexed before "first cwd wins": they stored their
/// LAST cwd as project_path, so a session whose directory changed mid-stream
/// resumed from the wrong place and `claude --resume` failed to find it.
/// Re-derives each session's root cwd from its transcript. Gated by a meta flag
/// and run before the watcher so later (now sticky) syncs keep the fix.
fn repair_project_paths(db: &std::path::Path) {
    let Ok(store) = Store::open(db) else { return };
    if store.meta_get("project_path_repair_v1").ok().flatten().is_some() {
        return;
    }
    let mut fixed = 0u32;
    for f in drydock_core::scanner::scan_projects(&claude_dir()).unwrap_or_default() {
        let Some(root) = first_cwd(&f.path) else { continue };
        if let Ok(Some(row)) = store.get_session(&f.session_id) {
            if row.project_path != root {
                let _ = store.set_project_path(&f.session_id, &root);
                fixed += 1;
            }
        }
    }
    let _ = store.meta_set("project_path_repair_v1", "done");
    if fixed > 0 {
        eprintln!("project_path repair: corrected {fixed} session(s)");
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct FlagsBackup {
    stars: Vec<String>,
    pins: Vec<String>,
}

fn backup_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("no app data dir").join("flags-backup.json")
}

fn write_backup(app: &AppHandle, store: &Store) {
    let stars: Vec<String> = store
        .list_sessions()
        .map(|v| v.into_iter().filter(|s| s.starred).map(|s| s.session_id).collect())
        .unwrap_or_default();
    let pins = store.pinned_projects().unwrap_or_default();
    if let Ok(json) = serde_json::to_string(&FlagsBackup { stars, pins }) {
        let _ = std::fs::write(backup_path(app), json);
    }
}

/// Re-apply starred/pinned flags from the backup (used after index rebuilds).
fn restore_backup(app: &AppHandle, store: &mut Store) {
    let Ok(text) = std::fs::read_to_string(backup_path(app)) else { return };
    let Ok(b) = serde_json::from_str::<FlagsBackup>(&text) else { return };
    for sid in &b.stars {
        if let Ok(Some(row)) = store.get_session(sid) {
            if !row.starred {
                let _ = store.set_starred(sid, true);
            }
        }
    }
    let pinned_now = store.pinned_projects().unwrap_or_default();
    for p in &b.pins {
        if !pinned_now.contains(p) {
            let _ = store.toggle_pin(p);
        }
    }
}

fn db_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("drydock.db")
}

/// Open the store for IPC reads and start the background watcher (its own
/// connection, same file). Every sync — including the initial one — emits
/// `index-updated`, so the frontend never needs a timer.
pub fn start(app: &AppHandle) -> anyhow::Result<()> {
    let db = db_path(app);
    let store = Store::open(&db)?;
    app.manage(AppDb(Mutex::new(store)));

    repair_project_paths(&db); // one-time, before the watcher; no-op after first run

    let emit_handle = app.clone();
    let db_for_restore = db.clone();
    std::thread::spawn(move || {
        let claude = claude_dir();
        // shared across retries so restore_backup runs at most once per app run
        let restored = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        loop {
            let restored = restored.clone();
            let restore_handle = emit_handle.clone();
            let restore_db = db_for_restore.clone();
            let emit = emit_handle.clone();
            if let Err(e) = drydock_core::watcher::watch_with(&claude, &db, move |_report| {
                if !restored.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    if let Ok(mut s) = Store::open(&restore_db) {
                        restore_backup(&restore_handle, &mut s);
                    }
                }
                let _ = emit.emit("index-updated", ());
            }) {
                eprintln!("watcher error (retrying in 5s): {e:#}");
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });

    // radar: poll the live-session registry; apply + emit only on change
    let radar_db = db_path(app);
    let radar_handle = app.clone();
    std::thread::spawn(move || {
        let mut prev: Vec<drydock_core::radar::LiveSession> = Vec::new();
        loop {
            let mut live = drydock_core::radar::live_sessions(&claude_dir());
            live.sort_by_key(|l| l.pid);
            if live != prev {
                if let Ok(mut store) = Store::open(&radar_db) {
                    if store.apply_live(&live).is_ok() {
                        let _ = radar_handle.emit("index-updated", ());
                        // only on success, so a failed apply is retried next tick
                        prev = live;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ChunkView {
    pub role: String,
    pub text: String,
    pub ts: Option<i64>,
}

#[tauri::command]
pub fn session_chunks(db: State<'_, AppDb>, session_id: String) -> Result<Vec<ChunkView>, String> {
    let store = db.0.lock().unwrap();
    Ok(store
        .get_chunks(&session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| ChunkView { role: c.role, text: c.text, ts: c.ts })
        .collect())
}

#[tauri::command]
pub fn sessions_snapshot(db: State<'_, AppDb>) -> Result<Snapshot, String> {
    let store = db.0.lock().unwrap();
    let sessions = store
        .list_sessions()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| SessionView {
            session_id: r.session_id,
            project_path: r.project_path,
            title: r.title,
            latest_recap: r.latest_recap,
            last_message_at: r.last_message_at,
            starred: r.starred,
            hidden: r.hidden,
            live_status: r.live_status,
        })
        .collect();
    let pinned = store.pinned_projects().map_err(|e| e.to_string())?;
    Ok(Snapshot { sessions, pinned })
}

#[tauri::command]
pub fn set_starred(app: AppHandle, db: State<'_, AppDb>, session_id: String, starred: bool) -> Result<(), String> {
    let mut store = db.0.lock().unwrap();
    store.set_starred(&session_id, starred).map_err(|e| e.to_string())?;
    write_backup(&app, &store);
    Ok(())
}

#[tauri::command]
pub fn toggle_pin(app: AppHandle, db: State<'_, AppDb>, project_path: String) -> Result<bool, String> {
    let mut store = db.0.lock().unwrap();
    let pinned = store.toggle_pin(&project_path).map_err(|e| e.to_string())?;
    write_backup(&app, &store);
    Ok(pinned)
}
