use crate::store::Store;
use crate::sync::{sync_all, SyncReport};
use anyhow::Result;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use std::path::Path;
use std::time::Duration;

/// Blocking watch loop with a callback fired after every sync (including the initial one).
pub fn watch_with(claude_dir: &Path, db: &Path, on_sync: impl Fn(&SyncReport) + Send + 'static) -> Result<()> {
    let mut store = Store::open(db)?;
    let report = sync_all(&mut store, claude_dir)?;
    on_sync(&report);

    let (tx, rx) = std::sync::mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(400), tx)?;
    let projects = claude_dir.join("projects");
    std::fs::create_dir_all(&projects).ok();
    debouncer.watcher().watch(&projects, RecursiveMode::Recursive)?;

    for events in rx {
        if events.is_ok() {
            match sync_all(&mut store, claude_dir) {
                Ok(report) => on_sync(&report),
                Err(e) => eprintln!("sync error (will retry on next event): {e:#}"),
            }
        }
    }
    Ok(())
}

/// Blocking watch loop (no callback) — kept for the CLI.
pub fn watch(claude_dir: &Path, db: &Path) -> Result<()> {
    watch_with(claude_dir, db, |_| {})
}
