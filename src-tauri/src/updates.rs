//! Native in-app updates. `check_update` asks the GitHub Releases `latest.json`
//! manifest (via tauri-plugin-updater, which also minisign-verifies every
//! artifact against the pubkey baked into this binary); `install_update`
//! downloads and swaps the .app in place; `restart_app` execs the fresh bundle.
//!
//! The module also owns the tab stash: right before the restart the frontend
//! snapshots its open tabs here, and the next launch takes the snapshot back
//! (read-and-delete) to rebuild the workspace with `claude --resume`.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// The page the fallback button opens when an in-app install fails. Fixed
/// constant — no frontend-supplied URL ever reaches `open`.
const RELEASES_PAGE: &str = "https://github.com/xd00099/drydock/releases/latest";

#[derive(Serialize, Debug, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    /// Latest released version (from the manifest). When the updater reports
    /// "nothing newer" it doesn't say what latest is, so this echoes `current`.
    pub latest: String,
    pub newer: bool,
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let updater = app.updater().map_err(|e| format!("updater unavailable: {e}"))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(UpdateInfo { current, latest: u.version.clone(), newer: true }),
        Ok(None) => Ok(UpdateInfo { latest: current.clone(), current, newer: false }),
        Err(e) => Err(format!("update check failed (offline, or no releases yet): {e}")),
    }
}

/// Download + install the newest release. The plugin verifies the artifact's
/// minisign signature before swapping the .app bundle in place. Emits
/// `update-progress` events for the footer. Deliberately does NOT restart:
/// the frontend stashes its tabs first, then calls `restart_app`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("dev build — install releases from the releases page".into());
    }
    let updater = app.updater().map_err(|e| format!("updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?
        .ok_or("already up to date")?;
    let mut downloaded: u64 = 0;
    let on_chunk = app.clone();
    let on_done = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_chunk.emit(
                    "update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total, "phase": "downloading" }),
                );
            },
            move || {
                let _ = on_done
                    .emit("update-progress", serde_json::json!({ "phase": "installing" }));
            },
        )
        .await
        .map_err(|e| format!("install failed: {e}"))?;
    Ok(())
}

/// Restart into the (freshly swapped) bundle. Kills every PTY first, exactly
/// like force_quit, so restarting for an update never orphans claude processes.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.state::<crate::pty::PtyManager>().kill_all();
    app.restart();
}

#[tauri::command]
pub fn open_releases_page() -> Result<(), String> {
    std::process::Command::new("open")
        .arg(RELEASES_PAGE)
        .spawn()
        .map_err(|e| format!("couldn't open the releases page: {e}"))?;
    Ok(())
}

/// Version shown in the sidebar footer. Comes from Cargo.toml, which the
/// release script keeps in lockstep with package.json / tauri.conf.json.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---- tab stash (workspace restore across the update restart) ----

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RestoreTab {
    /// "claude" (resume the session), "shell" (reopen at cwd), or
    /// "transcript" (read-only view).
    pub kind: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub active: bool,
}

#[derive(Serialize, Deserialize)]
struct Stash {
    saved_at_ms: u64,
    tabs: Vec<RestoreTab>,
}

const STASH_FILE: &str = "restore-tabs.json";
/// A stash older than this is a leftover from something that never relaunched,
/// not an update restart — discard rather than replay a stale workspace.
const STASH_FRESH_MS: u64 = 10 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Shell tabs report tilde-collapsed cwds (see pty_cwds); PTY spawn needs a
/// real path back.
fn expand_tilde(cwd: &str, home: Option<&str>) -> String {
    match home {
        Some(h) if cwd == "~" => h.to_string(),
        Some(h) if cwd.starts_with("~/") => format!("{h}{}", &cwd[1..]),
        _ => cwd.to_string(),
    }
}

fn write_stash(path: &Path, mut tabs: Vec<RestoreTab>, home: Option<&str>, now: u64) -> std::io::Result<()> {
    for t in &mut tabs {
        if let Some(c) = &t.cwd {
            t.cwd = Some(expand_tilde(c, home));
        }
    }
    let json = serde_json::to_string(&Stash { saved_at_ms: now, tabs })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// Read-and-delete, so a snapshot applies exactly once (a crash loop can't
/// replay it). None when absent, stale, or unparseable — restoring nothing is
/// always safe, every session is still in the sidebar.
fn take_stash(path: &Path, now: u64) -> Option<Vec<RestoreTab>> {
    let text = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    let stash: Stash = serde_json::from_str(&text).ok()?;
    (now.saturating_sub(stash.saved_at_ms) <= STASH_FRESH_MS).then_some(stash.tabs)
}

#[tauri::command]
pub fn stash_tabs(app: AppHandle, tabs: Vec<RestoreTab>) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    write_stash(&dir.join(STASH_FILE), tabs, std::env::var("HOME").ok().as_deref(), now_ms())
        .map_err(|e| format!("couldn't save the tab snapshot: {e}"))
}

#[tauri::command]
pub fn take_stashed_tabs(app: AppHandle) -> Option<Vec<RestoreTab>> {
    let dir = app.path().app_data_dir().ok()?;
    take_stash(&dir.join(STASH_FILE), now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(kind: &str, sid: Option<&str>, cwd: Option<&str>, active: bool) -> RestoreTab {
        RestoreTab {
            kind: kind.into(),
            session_id: sid.map(Into::into),
            cwd: cwd.map(Into::into),
            title: Some(format!("{kind} tab")),
            active,
        }
    }

    #[test]
    fn expand_tilde_covers_home_shapes() {
        assert_eq!(expand_tilde("~", Some("/Users/x")), "/Users/x");
        assert_eq!(expand_tilde("~/proj", Some("/Users/x")), "/Users/x/proj");
        assert_eq!(expand_tilde("/abs/path", Some("/Users/x")), "/abs/path");
        // no HOME → leave untouched rather than guess
        assert_eq!(expand_tilde("~/proj", None), "~/proj");
        // "~elsewhere" is a literal path segment, not a home reference
        assert_eq!(expand_tilde("~other", Some("/Users/x")), "~other");
    }

    #[test]
    fn stash_roundtrips_and_expands_shell_cwds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STASH_FILE);
        let tabs = vec![
            tab("claude", Some("sid-1"), Some("/proj/a"), false),
            tab("shell", None, Some("~/work"), true),
            tab("transcript", Some("sid-2"), None, false),
        ];
        write_stash(&path, tabs, Some("/Users/x"), 1_000).unwrap();
        let back = take_stash(&path, 2_000).unwrap();
        assert_eq!(back.len(), 3);
        assert_eq!(back[0].session_id.as_deref(), Some("sid-1"));
        assert_eq!(back[1].cwd.as_deref(), Some("/Users/x/work"), "tilde expanded at stash time");
        assert!(back[1].active);
        assert_eq!(back[2].kind, "transcript");
    }

    #[test]
    fn stash_applies_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STASH_FILE);
        write_stash(&path, vec![tab("claude", Some("s"), None, true)], None, 0).unwrap();
        assert!(take_stash(&path, 0).is_some());
        assert!(take_stash(&path, 0).is_none(), "second take must find nothing");
        assert!(!path.exists());
    }

    #[test]
    fn stale_stash_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STASH_FILE);
        write_stash(&path, vec![tab("shell", None, None, true)], None, 1_000).unwrap();
        assert!(take_stash(&path, 1_000 + STASH_FRESH_MS + 1).is_none());
        assert!(!path.exists(), "stale file is cleaned up, not left to rot");
    }

    #[test]
    fn corrupt_stash_returns_none_and_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STASH_FILE);
        std::fs::write(&path, "not json").unwrap();
        assert!(take_stash(&path, 0).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn absent_stash_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(take_stash(&dir.path().join(STASH_FILE), 0).is_none());
    }
}
