//! "Needs input" radar for the claude sessions Drydock launches.
//!
//! At spawn, pty_spawn registers Notification/Stop hooks for that session via
//! `--settings` (spawn-scoped — NOTHING is written under ~/.claude). The hook
//! command curls the hook's stdin JSON to the loopback server's `/hook`
//! endpoint, authenticated by the session's bearer token. A Notification event
//! ("Claude needs your permission…", "Claude is waiting for your input")
//! marks the session as waiting; typing into its terminal, a Stop event, or
//! the pty exiting clears it.
//!
//! Waiting state fans out to: the sidebar/tab indicators (joined into
//! sessions_snapshot as live_status "needs_input"), the macOS dock badge
//! (count), a menu-bar item ("⚓ n" with a jump-to-session menu), and a
//! `session-attention` event the frontend turns into OS notifications.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// One waiting session: which tab it lives in, and what it asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub pty_id: u32,
    pub message: String,
}

/// session_id → waiting info. Pure state (no Tauri types) so it unit-tests;
/// the UI fan-out lives in the free functions below.
#[derive(Default)]
pub struct AttentionState {
    waiting: Mutex<HashMap<String, Waiting>>,
}

impl AttentionState {
    /// Mark a session as waiting. Returns false when nothing changed (same
    /// message re-delivered), so callers can skip redundant UI work.
    pub fn mark(&self, session_id: &str, pty_id: u32, message: &str) -> bool {
        let w = Waiting { pty_id, message: message.to_string() };
        self.waiting.lock().unwrap().insert(session_id.to_string(), w.clone()) != Some(w)
    }

    pub fn clear_session(&self, session_id: &str) -> bool {
        self.waiting.lock().unwrap().remove(session_id).is_some()
    }

    /// Clear every session waiting in this tab (session ids can rotate within
    /// one pty via /clear, so exit/typing clears by tab).
    pub fn clear_pty(&self, pty_id: u32) -> bool {
        let mut map = self.waiting.lock().unwrap();
        let before = map.len();
        map.retain(|_, w| w.pty_id != pty_id);
        map.len() != before
    }

    pub fn has_pty(&self, pty_id: u32) -> bool {
        self.waiting.lock().unwrap().values().any(|w| w.pty_id == pty_id)
    }

    pub fn snapshot(&self) -> HashMap<String, Waiting> {
        self.waiting.lock().unwrap().clone()
    }
}

/// Parsed hook delivery (Claude Code writes its hook input JSON to stdin; the
/// injected command forwards it verbatim).
#[derive(Debug, PartialEq)]
pub struct HookEvent {
    pub event: String,
    pub session_id: Option<String>,
    pub message: String,
}

pub fn parse_hook(body: &[u8]) -> Option<HookEvent> {
    let v: Value = serde_json::from_slice(body).ok()?;
    Some(HookEvent {
        event: v.get("hook_event_name")?.as_str()?.to_string(),
        session_id: v.get("session_id").and_then(Value::as_str).map(String::from),
        message: v.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

#[derive(Clone, serde::Serialize)]
struct AttentionEvent {
    session_id: String,
    pty_id: u32,
    state: &'static str, // "needs_input" | "done"
    message: String,
}

/// A hook delivery arrived on the loopback server for `pty_id`'s session.
/// `token_session` is the session id pinned at spawn — a fallback when the
/// hook body carries none (the body's id wins: /clear rotates it).
pub fn handle_hook(app: &AppHandle, pty_id: u32, token_session: Option<&str>, body: &[u8]) {
    let Some(h) = parse_hook(body) else { return };
    let Some(sid) = h.session_id.as_deref().or(token_session).filter(|s| !s.is_empty()) else { return };
    let Some(state) = app.try_state::<AttentionState>() else { return };
    match h.event.as_str() {
        "Notification" => {
            state.mark(sid, pty_id, &h.message);
            let _ = app.emit(
                "session-attention",
                AttentionEvent { session_id: sid.to_string(), pty_id, state: "needs_input", message: h.message.clone() },
            );
            sync_ui(app);
        }
        "Stop" => {
            let changed = state.clear_session(sid);
            let _ = app.emit(
                "session-attention",
                AttentionEvent { session_id: sid.to_string(), pty_id, state: "done", message: String::new() },
            );
            if changed {
                sync_ui(app);
            }
        }
        _ => {}
    }
}

/// Typing into a terminal answers whatever it was waiting on.
pub fn pty_interacted(app: &AppHandle, pty_id: u32) {
    if let Some(state) = app.try_state::<AttentionState>() {
        // cheap containment check first: this runs on every keystroke
        if state.has_pty(pty_id) && state.clear_pty(pty_id) {
            sync_ui(app);
        }
    }
}

/// The session's process is gone; nothing is waiting anymore.
pub fn pty_exited(app: &AppHandle, pty_id: u32) {
    if let Some(state) = app.try_state::<AttentionState>() {
        if state.clear_pty(pty_id) {
            sync_ui(app);
        }
    }
}

/// Menu-bar tray handle (rebuilt menu/title on every attention change).
pub struct Tray(Mutex<Option<TrayIcon>>);

/// Build the menu-bar item and manage the shared state. Called once at setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(AttentionState::default());
    let tray = TrayIconBuilder::with_id("drydock")
        .title("⚓")
        .tooltip("Drydock — sessions waiting for your input")
        .menu(&menu_for(app, &HashMap::new())?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    app.manage(Tray(Mutex::new(Some(tray))));
    Ok(())
}

fn session_label(app: &AppHandle, session_id: &str) -> String {
    // same precedence as the sidebar (Drydock name > custom-title > card
    // summary > title) — a renamed session must read the same in the tray
    let title = app
        .try_state::<crate::index::AppDb>()
        .and_then(|db| db.0.lock().unwrap().display_label(session_id).ok().flatten());
    match title {
        Some(t) if !t.trim().is_empty() => t,
        _ => session_id.chars().take(8).collect(),
    }
}

fn clip_label(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max - 1).collect::<String>())
    } else {
        s.to_string()
    }
}

fn menu_for(app: &AppHandle, waiting: &HashMap<String, Waiting>) -> tauri::Result<Menu<Wry>> {
    let mut b = MenuBuilder::new(app);
    if waiting.is_empty() {
        let none = MenuItemBuilder::with_id("attn-none", "No sessions waiting").enabled(false).build(app)?;
        b = b.item(&none);
    } else {
        for (sid, w) in waiting {
            let label = if w.message.is_empty() {
                clip_label(&session_label(app, sid), 48)
            } else {
                clip_label(&format!("{} — {}", session_label(app, sid), w.message), 64)
            };
            b = b.item(&MenuItemBuilder::with_id(format!("attn:{sid}"), label).build(app)?);
        }
    }
    let show = MenuItemBuilder::with_id("attn-show", "Show Drydock").build(app)?;
    b.separator().item(&show).build()
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    if id == "attn-show" {
        focus_main(app);
    } else if let Some(sid) = id.strip_prefix("attn:") {
        focus_main(app);
        let _ = app.emit("focus-session", sid.to_string());
    }
}

/// Push the current waiting set to every surface: dock badge (count),
/// menu-bar title + menu, and an index-updated so the sidebar re-snapshots.
pub fn sync_ui(app: &AppHandle) {
    let Some(state) = app.try_state::<AttentionState>() else { return };
    let waiting = state.snapshot();
    let n = waiting.len();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if n > 0 { Some(n as i64) } else { None });
    }
    if let Some(tray) = app.try_state::<Tray>() {
        if let Some(t) = tray.0.lock().unwrap().as_ref() {
            let _ = t.set_title(Some(if n > 0 { format!("⚓ {n}") } else { "⚓".to_string() }));
            if let Ok(menu) = menu_for(app, &waiting) {
                let _ = t.set_menu(Some(menu));
            }
        }
    }
    let _ = app.emit("index-updated", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_and_clear_track_change() {
        let s = AttentionState::default();
        assert!(s.mark("sid-1", 7, "Claude needs your permission to use Bash"));
        assert!(!s.mark("sid-1", 7, "Claude needs your permission to use Bash"), "same message = no change");
        assert!(s.mark("sid-1", 7, "Claude is waiting for your input"), "new message = change");
        assert!(s.has_pty(7));
        assert!(!s.has_pty(8));
        assert_eq!(s.snapshot().len(), 1);

        assert!(s.clear_session("sid-1"));
        assert!(!s.clear_session("sid-1"), "already cleared");
        assert!(s.snapshot().is_empty());
    }

    #[test]
    fn clear_pty_drops_all_of_that_tab() {
        let s = AttentionState::default();
        s.mark("sid-old", 7, "m1"); // pre-/clear id
        s.mark("sid-new", 7, "m2"); // post-/clear id, same tab
        s.mark("sid-other", 9, "m3");
        assert!(s.clear_pty(7));
        assert!(!s.clear_pty(7));
        let left = s.snapshot();
        assert_eq!(left.len(), 1);
        assert!(left.contains_key("sid-other"));
    }

    #[test]
    fn parse_hook_reads_claude_hook_stdin_shape() {
        let body = br#"{"session_id":"abc-123","transcript_path":"/tmp/t.jsonl","cwd":"/p","hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#;
        let h = parse_hook(body).unwrap();
        assert_eq!(h.event, "Notification");
        assert_eq!(h.session_id.as_deref(), Some("abc-123"));
        assert!(h.message.contains("permission"));

        // Stop events carry no message
        let stop = parse_hook(br#"{"session_id":"abc","hook_event_name":"Stop","stop_hook_active":false}"#).unwrap();
        assert_eq!(h.session_id.as_deref(), Some("abc-123"));
        assert_eq!(stop.event, "Stop");
        assert_eq!(stop.message, "");

        assert!(parse_hook(b"not json").is_none());
        assert!(parse_hook(br#"{"no_event":true}"#).is_none());
    }
}
