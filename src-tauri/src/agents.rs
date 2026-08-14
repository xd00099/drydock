//! Codex session discovery state — the app-side half of drydock-core/codex.
//!
//! A poll thread rescans `~/.codex/sessions` (mtime-cached, so steady state is
//! a directory walk with zero file reads) and holds the result; the sessions
//! snapshot merges it beside the claude index as rows with agent = "codex".
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

    fn rescan(&self, dir: &std::path::Path) -> bool {
        let fresh = codex::scan_sessions(dir, &mut self.cache.lock().unwrap());
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
            let active = state.active_ids(now_ms);
            if changed || active != prev_active {
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
) -> Option<String> {
    codex
        .snapshot()
        .into_iter()
        .filter(|s| s.cwd == cwd && s.mtime_ms >= after_ms)
        .max_by_key(|s| s.mtime_ms)
        .map(|s| s.session_id)
}
