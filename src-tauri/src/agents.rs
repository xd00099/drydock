//! Codex session discovery state — the app-side half of drydock-core/codex.
//!
//! A poll thread rescans `~/.codex/sessions` (mtime-cached, so steady state is
//! a directory walk with zero file reads) and holds the result; the sessions
//! snapshot merges it beside Claude sessions as rows with agent = "codex".
//! Plain rollout content is mirrored into Drydock's shared index.
//! Codex has no live-PID registry (unlike ~/.claude/sessions), so "busy" is
//! recency: codex appends to the rollout during a turn, and a session whose
//! file moved in the last two minutes is treated as active.

use drydock_core::codex::{self, CodexSession};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Rollout mtime younger than this ⇒ live_status "busy" (coarse by design —
/// turn-level truth arrives with the notify hook, not from the filesystem).
pub const ACTIVE_MS: i64 = 120_000;

#[derive(Default)]
pub struct CodexState {
    indexing: Mutex<()>,
    sessions: Mutex<Vec<CodexSession>>,
    cache: Mutex<HashMap<PathBuf, (i64, Option<CodexSession>)>>,
}

impl CodexState {
    pub(crate) fn index_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.indexing.lock().unwrap()
    }
    pub fn snapshot(&self) -> Vec<CodexSession> {
        self.sessions.lock().unwrap().clone()
    }

    pub fn find(&self, session_id: &str) -> Option<CodexSession> {
        self.sessions.lock().unwrap().iter().find(|s| s.session_id == session_id).cloned()
    }

    /// Drop a just-deleted session immediately — the poll thread would take up
    /// to 5s to notice the file is gone, and the frontend refreshes right after
    /// a delete, which must not resurrect the row.
    pub fn forget(&self, session_id: &str) {
        let mut cur = self.sessions.lock().unwrap();
        if let Some(i) = cur.iter().position(|s| s.session_id == session_id) {
            if let Some(path) = cur[i].path.clone() {
                self.cache.lock().unwrap().remove(&path);
            }
            cur.remove(i);
        }
    }

    pub(crate) fn rescan(&self, dir: &std::path::Path) -> bool {
        // sqlite tier first (codex ≥ ~0.147 keeps threads there and may have
        // no rollout files at all); the rollout scan still runs so an install
        // mid-migration keeps its file-only sessions, and remains the sole
        // source on older codex versions.
        let fs = codex::scan_sessions(dir, &mut self.cache.lock().unwrap());
        let fresh = match codex::scan_threads_db(dir) {
            Some(mut db) => {
                let seen: std::collections::HashSet<String> =
                    db.iter().map(|s| s.session_id.clone()).collect();
                db.extend(fs.into_iter().filter(|s| !seen.contains(&s.session_id)));
                db.sort_by_key(|s| std::cmp::Reverse(s.mtime_ms));
                db
            }
            None => fs,
        };
        let mut cur = self.sessions.lock().unwrap();
        if *cur == fresh {
            false
        } else {
            *cur = fresh;
            true
        }
    }

    /// Ids currently inside the ACTIVE_MS window. busy→ended flips by TIME
    /// passing, not by a file changing, so the poll loop must watch this set
    /// too — otherwise a finished session shows a stale spinner until some
    /// unrelated refresh.
    fn active_ids(&self, now_ms: i64) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|s| now_ms.saturating_sub(s.mtime_ms) < ACTIVE_MS)
            .map(|s| s.session_id.clone())
            .collect()
    }
}

/// External/native deletion also removes metadata-only sessions, which have no
/// sync_state path. Prune only when a readable Codex DB confirms absence and
/// neither discovery nor an existing indexed rollout can account for the id.
pub(crate) fn prune_deleted_codex(
    store: &mut drydock_core::store::Store,
    dir: &std::path::Path,
    discovered: &[CodexSession],
) -> anyhow::Result<bool> {
    let Some(known) = codex::thread_ids(dir) else { return Ok(false) };
    prune_missing_codex(store, &known, discovered)
}

fn prune_missing_codex(
    store: &mut drydock_core::store::Store,
    known: &std::collections::HashSet<String>,
    discovered: &[CodexSession],
) -> anyhow::Result<bool> {
    let mut changed = false;
    for id in store.agent_session_ids("codex")? {
        if known.contains(&id) || discovered.iter().any(|s| s.session_id == id) { continue; }
        if let Some(path) = store.transcript_path(&id)? {
            let path = std::path::Path::new(&path);
            if path.try_exists().ok() != Some(false)
                || path.with_extension("jsonl.zst").try_exists().ok() != Some(false) { continue; }
        }
        store.delete_session(&id)?;
        changed = true;
    }
    Ok(changed)
}

/// Manage the state and start the poll thread. 5s cadence: the sidebar is a
/// radar, not a terminal — sub-second freshness buys nothing here. Steady
/// state costs a directory walk (stat only; parses are mtime-cached) and
/// emits ONLY when something the UI shows actually changed.
pub fn start(app: &AppHandle) {
    app.manage(CodexState::default());
    let Some(dir) = codex::codex_dir() else { return };
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut prev_active: Vec<String> = Vec::new();
        loop {
            let state = handle.state::<CodexState>();
            let gate = state.index_guard();
            let changed = state.rescan(&dir);
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // Use the shared index: content, cards, names and stars have the
            // same contract for both agents. Failed syncs retry next poll.
            let db_path = handle.path().app_data_dir().ok().map(|p| p.join("drydock.db"));
            let mut indexed = false;
            if let Some(db_path) = db_path {
                if let Ok(mut store) = drydock_core::store::Store::open(&db_path) {
                    match prune_deleted_codex(&mut store, &dir, &state.snapshot()) {
                        Ok(true) => { indexed = true; crate::index::write_backup(&handle, &store); }
                        Ok(false) => {}
                        Err(e) => eprintln!("codex deletion cleanup: {e:#}"),
                    }
                    // Never infer deletion from a partial discovery scan. A
                    // missing file is independently confirmed before pruning.
                    if let Ok(paths) = store.all_synced_paths() {
                        for (path, sid, _) in paths {
                            if store.meta_get(&format!("agent:{sid}")).ok().flatten().as_deref() == Some("codex")
                                && state.find(&sid).is_none()
                                && std::path::Path::new(&path).try_exists().ok() == Some(false) {
                                if store.delete_session_data(&sid).is_ok() { indexed = true; }
                            }
                        }
                    }
                    for session in state.snapshot() {
                        let result = (|| -> anyhow::Result<()> {
                            store.meta_set(&format!("agent:{}", session.session_id), "codex")?;
                            if let Some(path) = &session.path {
                                let md = std::fs::metadata(path)?;
                                let sf = drydock_core::scanner::SessionFile {
                                    path: path.clone(), session_id: session.session_id.clone(), size: md.len(),
                                    mtime: md.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_millis() as i64,
                                };
                                let parsed = matches!(drydock_core::sync::sync_file(&mut store, &sf)?, drydock_core::sync::SyncOutcome::Parsed { .. });
                                if parsed { indexed = true; }
                                // Backfill older sessions once, then only revisit facts
                                // when the rollout grows/rewrites. Scanning every archived
                                // rollout on each poll would churn the bounded cache.
                                let marker = format!("codex-briefing-v1:{}", session.session_id);
                                if parsed || store.meta_get(&marker)?.is_none() {
                                    let facts = drydock_core::codex_briefing::read(path)?;
                                    store.replace_usage(&session.session_id, "main", &facts.usage)?;
                                    store.meta_set(&marker, "1")?;
                                    indexed = true;
                                }
                            } else if store.get_session(&session.session_id)?.is_none() {
                                // A metadata-only thread remains searchable by
                                // its title; do not invent a transcript for it.
                                let delta = drydock_core::accumulator::SessionDelta {
                                    project_path: Some(session.cwd.clone()), first_prompt: session.title.clone(),
                                    last_message_at: Some(session.mtime_ms), ..Default::default()
                                };
                                let chunks = session.title.as_ref().map(|title| vec![drydock_core::chunker::Chunk {
                                    role: "user".into(), text: title.clone(), ts: Some(session.mtime_ms)
                                }]).unwrap_or_default();
                                store.apply_delta(&session.session_id, &delta, &chunks)?;
                                indexed = true;
                            }
                            // Discovery already excludes internal threads.
                            // Zero parsed user messages can mean paginated
                            // history or an older IDE prompt format, not a
                            // ghost. Repair existing rows too; user Hide
                            // choices live in a separate table.
                            indexed |= store.clear_session_ghost(&session.session_id)?;
                            store.set_agent_live_status(&session.session_id,
                                if now_ms.saturating_sub(session.mtime_ms) < ACTIVE_MS { "busy" } else { "ended" })?;
                            Ok(())
                        })();
                        if let Err(e) = result { eprintln!("codex index {}: {e:#}", session.session_id); }
                    }
                }
            }
            let active = state.active_ids(now_ms);
            if changed || indexed || active != prev_active {
                prev_active = active;
                let _ = handle.emit("index-updated", ());
            }
            drop(gate);
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

/// Pair a just-spawned codex tab with the session codex created for it: the
/// newest rollout rooted at `cwd` that appeared after the spawn. The frontend
/// polls this a few times after launch (codex writes the rollout at startup).
#[tauri::command]
pub fn codex_latest_session(
    codex: State<'_, CodexState>,
    cwd: String,
    after_ms: i64,
    prompt_contains: Option<String>,
) -> Option<String> {
    codex
        .snapshot()
        .into_iter()
        .filter(|s| s.cwd == cwd && s.mtime_ms >= after_ms)
        .filter(|s| prompt_contains.as_ref().is_none_or(|marker|
            s.title.as_ref().is_some_and(|t| t.contains(marker)) || s.recap.as_ref().is_some_and(|t| t.contains(marker))))
        .max_by_key(|s| s.mtime_ms)
        .map(|s| s.session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use drydock_core::store::Store;
    use std::collections::HashSet;

    fn seed(store: &mut Store, id: &str) {
        store.meta_set(&format!("agent:{id}"), "codex").unwrap();
        store.apply_delta(id, &Default::default(), &[]).unwrap();
        store.set_session_hidden(id, true).unwrap();
        store.set_session_name(id, "my session").unwrap();
    }

    #[test]
    fn external_deletion_cleans_metadata_only_sessions_flags_and_orphans() {
        let mut store = Store::open_in_memory().unwrap();
        for id in ["deleted", "survivor"] { seed(&mut store, id); }
        store.meta_set("agent:orphan", "codex").unwrap();
        store.set_session_hidden("orphan", true).unwrap();
        let known = HashSet::from(["survivor".into()]);
        assert!(prune_missing_codex(&mut store, &known, &[]).unwrap());
        assert!(store.get_session("deleted").unwrap().is_none());
        assert_eq!(store.hidden_session_ids().unwrap(), vec!["survivor"]);
        assert_eq!(store.agent_session_ids("codex").unwrap(), vec!["survivor"]);
        assert_eq!(store.session_names().unwrap(), vec![("survivor".into(), "my session".into())]);
        assert!(!prune_missing_codex(&mut store, &known, &[]).unwrap());
    }

    #[test]
    fn incomplete_discovery_and_missing_vendor_database_preserve_existing_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = Store::open_in_memory().unwrap();
        seed(&mut store, "db-only");
        seed(&mut store, "file-only");
        let rollout = tmp.path().join("rollout.jsonl");
        std::fs::write(&rollout, "still here").unwrap();
        store.set_sync_state(rollout.to_str().unwrap(), "file-only", 0, 0, None, None).unwrap();
        assert!(!prune_missing_codex(&mut store, &HashSet::from(["db-only".into()]), &[]).unwrap());
        assert!(!prune_deleted_codex(&mut store, tmp.path(), &[]).unwrap());
        assert_eq!(store.hidden_session_ids().unwrap().len(), 2);
    }
}
