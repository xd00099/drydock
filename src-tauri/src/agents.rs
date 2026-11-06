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
    sessions: Mutex<Vec<CodexSession>>,
    cache: Mutex<HashMap<PathBuf, (i64, Option<CodexSession>)>>,
}

impl CodexState {
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

    fn rescan(&self, dir: &std::path::Path) -> bool {
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
                                if matches!(drydock_core::sync::sync_file(&mut store, &sf)?, drydock_core::sync::SyncOutcome::Parsed { .. }) {
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
