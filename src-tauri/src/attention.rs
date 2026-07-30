//! Attention radar for the claude sessions Drydock launches.
//!
//! At spawn, pty_spawn registers Notification/Stop/StopFailure hooks for that
//! session via `--settings` (spawn-scoped — NOTHING is written under
//! ~/.claude). The hook command curls the hook's stdin JSON to the loopback
//! server's `/hook` endpoint, authenticated by the session's bearer token.
//!
//! Two stored states, deliberately distinct (see `Attn`):
//!
//!   * BLOCKED — the session is stopped waiting on an answer from you. Amber
//!     dot, dock badge, menu-bar count, and the one thing that makes a sound.
//!     Cleared by typing into its terminal, by the turn ending, or by exit.
//!   * DONE — the turn finished and you haven't looked yet. A quiet marker on
//!     the session, no badge and no sound. Cleared once you can see the pane
//!     (which needs the window focused, not merely the tab staged).
//!
//! Keeping those apart is the whole point of this module. Claude Code's
//! `Notification` hook multiplexes at least ten unrelated meanings through one
//! event — permission prompts, but also "you've been idle", "auth succeeded",
//! "computer use started", and events about entirely different sessions — so
//! classifying on `notification_type` is what stops a session you merely walked
//! away from from claiming to need you. A third outcome, NOTIFY, exists for the
//! ones that are worth announcing but say nothing about this session.
//!
//! State fans out to: the sidebar/tab indicators (joined into sessions_snapshot
//! as live_status "needs_input" / "done"), the macOS dock badge (BLOCKED count
//! only), a menu-bar item ("⚓ n" with a jump-to-session menu), and a
//! `session-attention` event the frontend turns into OS notifications.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// What a hook delivery means for the user's attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attn {
    /// Stopped, waiting on an answer from the user. Earns the badge and a sound.
    Blocked,
    /// This session's turn ended. Worth a quiet marker on the session; never a
    /// badge and never a sound.
    Done,
    /// Worth telling the user once, but it says nothing about THIS session's
    /// state, so it must not be stored. The distinction exists because several
    /// notification types are emitted by a session on behalf of a *different*
    /// one — see `classify`.
    Notify,
    /// Not about attention at all — don't touch state, don't even notify.
    Ignore,
}

/// `notification_type` values that mean the session is genuinely stopped waiting
/// on the user. `worker_permission_prompt` is the background-worker flavor of
/// the same thing.
const BLOCKING_NOTIFICATIONS: [&str; 4] =
    ["permission_prompt", "elicitation_dialog", "worker_permission_prompt", "agent_needs_input"];

/// Types that are pure information: something succeeded, something was answered,
/// a mode was entered or left, or the user simply hasn't typed in a while.
///
/// `idle_prompt` is the important one. It carries "Claude is waiting for your
/// input" and fires *because you stopped typing*, not because anything was
/// asked. Treating it as blocking is what put a permanent amber dot on every
/// session you walked away from: nothing clears a stopped session's flag except
/// typing into that exact tab, because an idle session will never emit a Stop.
const QUIET_NOTIFICATIONS: [&str; 6] = [
    "idle_prompt",
    "auth_success",
    "elicitation_complete",
    "elicitation_response",
    "computer_use_enter",
    "computer_use_exit",
];

/// Types that are about something other than this session's own lifecycle, so
/// they may be announced but must never be written to the session's state.
///
/// `agent_completed` is the subtle one, and getting it wrong is worse than not
/// handling it. Claude Code emits it from a poller over BACKGROUND AGENT jobs:
/// the payload's `session_id` is the parent session doing the polling, while the
/// event is about a different session entirely. Storing it as `Done` on the
/// parent would silently overwrite a real `Blocked` — a permission prompt you
/// are actually waiting on would lose its amber dot and its badge because some
/// unrelated background agent happened to finish.
const NOTIFY_ONLY_NOTIFICATIONS: [&str; 2] = ["agent_completed", "push_notification"];

/// Classify a hook delivery. `kind` is the Notification hook's
/// `notification_type` — a free-form string in Claude Code's schema
/// (`notification_type: E.string()`, required and NOT an enum), so the lists
/// above are the values 2.1.220 is observed to emit, not a closed universe.
/// Other hook events don't carry it at all.
pub fn classify(event: &str, kind: Option<&str>) -> Attn {
    match event {
        // A turn that ended, either way. StopFailure is the one Drydock used to
        // miss entirely: a turn killed by a rate limit emits no Stop, so the
        // session just went quietly green as if it had answered you.
        "Stop" | "StopFailure" => Attn::Done,
        "Notification" => match kind {
            Some(k) if QUIET_NOTIFICATIONS.contains(&k) => Attn::Ignore,
            Some(k) if NOTIFY_ONLY_NOTIFICATIONS.contains(&k) => Attn::Notify,
            Some(k) if BLOCKING_NOTIFICATIONS.contains(&k) => Attn::Blocked,
            // Anything unrecognized. Fail loud: a new blocking type read as
            // quiet is a session that hangs forever with no indication, while a
            // quiet one read as blocking is a nuisance you can see and report.
            // An ABSENT type means a Claude Code too old to send one, where
            // "assume it wants you" is the behavior that shipped before.
            _ => Attn::Blocked,
        },
        _ => Attn::Ignore,
    }
}

/// The `state` string the frontend switches on. "info" is the notify-only case:
/// the frontend may show a notification but must not treat it as this session's
/// state, because no state was stored for it.
fn ui_state(kind: Attn) -> &'static str {
    match kind {
        Attn::Blocked => "needs_input",
        Attn::Done => "done",
        _ => "info",
    }
}

/// Render a StopFailure `error` enum member as something a notification can say.
/// The hook always carries `error` (rate_limit, overloaded, billing_error, …)
/// but `error_details` is optional, so this is what stops a rate-limited turn
/// from being announced as "Finished — ready for you".
pub fn humanize_error(code: &str) -> String {
    match code {
        "rate_limit" => "rate limit reached".into(),
        "overloaded" => "the API was overloaded".into(),
        "max_output_tokens" => "hit the output limit".into(),
        "authentication_failed" => "authentication failed".into(),
        "oauth_org_not_allowed" => "your organization doesn't allow this login".into(),
        "billing_error" => "a billing problem".into(),
        "invalid_request" => "an invalid request".into(),
        "model_not_found" => "the model was not found".into(),
        "server_error" => "a server error".into(),
        // "unknown" and anything added later
        other => other.replace('_', " "),
    }
}

/// One session needing attention: which tab it lives in, why, and what it said.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub pty_id: u32,
    pub message: String,
    /// `Blocked` or `Done` — never `Ignore` (those are never stored).
    pub kind: Attn,
}

/// session_id → attention info. Pure state (no Tauri types) so it unit-tests;
/// the UI fan-out lives in the free functions below.
#[derive(Default)]
pub struct AttentionState {
    waiting: Mutex<HashMap<String, Waiting>>,
}

impl AttentionState {
    /// Record a session as blocked or done. Returns false when nothing changed
    /// (the same delivery repeated), so callers can skip redundant UI work.
    /// A `Done` overwrites a `Blocked` for the same session: the turn ending is
    /// the answer to whatever it was blocked on.
    pub fn mark(&self, session_id: &str, pty_id: u32, message: &str, kind: Attn) -> bool {
        // Only Blocked and Done describe this session. Notify and Ignore are
        // deliberately unstorable: writing them would let an event about another
        // session (or about nothing) overwrite real state.
        if !matches!(kind, Attn::Blocked | Attn::Done) {
            return false;
        }
        let w = Waiting { pty_id, message: message.to_string(), kind };
        self.waiting.lock().unwrap().insert(session_id.to_string(), w.clone()) != Some(w)
    }

    /// Clear every session flagged in this tab (session ids can rotate within
    /// one pty via /clear, so exit/typing clears by tab).
    pub fn clear_pty(&self, pty_id: u32) -> bool {
        let mut map = self.waiting.lock().unwrap();
        let before = map.len();
        map.retain(|_, w| w.pty_id != pty_id);
        map.len() != before
    }

    /// The user can now see these tabs, so their "finished, unseen" markers have
    /// served their purpose. Deliberately leaves `Blocked` alone: looking at a
    /// permission prompt doesn't answer it.
    pub fn seen_ptys(&self, pty_ids: &[u32]) -> bool {
        let mut map = self.waiting.lock().unwrap();
        let before = map.len();
        map.retain(|_, w| !(w.kind == Attn::Done && pty_ids.contains(&w.pty_id)));
        map.len() != before
    }

    pub fn has_pty(&self, pty_id: u32) -> bool {
        self.waiting.lock().unwrap().values().any(|w| w.pty_id == pty_id)
    }

    /// Sessions blocked on the user — the only ones that earn a badge or a
    /// menu-bar count. `Stop` fires at the end of every turn, so counting
    /// `Done` here would peg the badge to "number of open sessions" and destroy
    /// the one signal that means "something needs you".
    pub fn blocked(&self) -> HashMap<String, Waiting> {
        let map = self.waiting.lock().unwrap();
        map.iter().filter(|(_, w)| w.kind == Attn::Blocked).map(|(k, v)| (k.clone(), v.clone())).collect()
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
    /// The Notification hook's `notification_type` discriminator. Absent on
    /// every other event, and on Claude Code versions predating it.
    pub notification_type: Option<String>,
}

pub fn parse_hook(body: &[u8]) -> Option<HookEvent> {
    let v: Value = serde_json::from_slice(body).ok()?;
    Some(HookEvent {
        event: v.get("hook_event_name")?.as_str()?.to_string(),
        session_id: v.get("session_id").and_then(Value::as_str).map(String::from),
        // Notification carries `message`. StopFailure carries neither: it has an
        // optional `error_details` and an always-present `error` enum, and
        // falling through to `error` is what keeps a rate-limited turn from
        // being announced as if it had finished normally.
        message: v
            .get("message")
            .or_else(|| v.get("error_details"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| v.get("error").and_then(Value::as_str).map(humanize_error))
            .unwrap_or_default(),
        notification_type: v.get("notification_type").and_then(Value::as_str).map(String::from),
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
    let kind = classify(&h.event, h.notification_type.as_deref());
    // An Ignore is genuinely nothing: no state change, no event, no UI churn.
    // Returning here is what keeps an idle nag from touching the session.
    if kind == Attn::Ignore {
        return;
    }
    // Notify announces without recording — a background agent finishing must not
    // overwrite what THIS session's state actually is.
    let changed = state.mark(sid, pty_id, &h.message, kind);
    let ui_state = ui_state(kind);
    // Emitted on every delivery even when the stored state is unchanged: the
    // frontend uses this to decide whether to notify, and a repeat delivery of
    // the same permission prompt is still worth a ping if you're away.
    let _ = app.emit(
        "session-attention",
        AttentionEvent { session_id: sid.to_string(), pty_id, state: ui_state, message: h.message.clone() },
    );
    if changed {
        sync_ui(app);
    }
}

/// The frontend can now see these tabs, so drop their "finished, unseen"
/// markers. Blocked sessions are untouched — seeing a permission prompt is not
/// answering it.
pub fn mark_seen(app: &AppHandle, pty_ids: &[u32]) {
    if let Some(state) = app.try_state::<AttentionState>() {
        if state.seen_ptys(pty_ids) {
            sync_ui(app);
        }
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

/// Push the current state to every surface: dock badge and menu-bar count
/// (BLOCKED sessions only — see `AttentionState::blocked`), and an
/// index-updated so the sidebar re-snapshots both states.
pub fn sync_ui(app: &AppHandle) {
    let Some(state) = app.try_state::<AttentionState>() else { return };
    let waiting = state.blocked();
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
        assert!(s.mark("sid-1", 7, "Claude needs your permission to use Bash", Attn::Blocked));
        assert!(
            !s.mark("sid-1", 7, "Claude needs your permission to use Bash", Attn::Blocked),
            "same message = no change"
        );
        assert!(s.mark("sid-1", 7, "Claude needs your permission to use Edit", Attn::Blocked), "new message = change");
        assert!(s.has_pty(7));
        assert!(!s.has_pty(8));
        assert_eq!(s.snapshot().len(), 1);

        assert!(s.clear_pty(7));
        assert!(!s.clear_pty(7), "already cleared");
        assert!(s.snapshot().is_empty());
    }

    #[test]
    fn clear_pty_drops_all_of_that_tab() {
        let s = AttentionState::default();
        s.mark("sid-old", 7, "m1", Attn::Blocked); // pre-/clear id
        s.mark("sid-new", 7, "m2", Attn::Blocked); // post-/clear id, same tab
        s.mark("sid-other", 9, "m3", Attn::Blocked);
        assert!(s.clear_pty(7));
        assert!(!s.clear_pty(7));
        let left = s.snapshot();
        assert_eq!(left.len(), 1);
        assert!(left.contains_key("sid-other"));
    }

    /// THE BUG. Claude Code fires Notification for at least ten different
    /// reasons and only a few of them mean "answer me". Reading them all as
    /// blocking is what put a permanent amber dot on every session the user
    /// walked away from.
    ///
    /// This is a LITERAL table on purpose. Iterating the constants under test
    /// would let a maintainer move a type between the lists and stay green while
    /// silently reclassifying it.
    #[test]
    fn every_known_notification_type_is_pinned() {
        for (t, want) in [
            // genuinely stopped, waiting on you
            ("permission_prompt", Attn::Blocked),
            ("elicitation_dialog", Attn::Blocked),
            ("worker_permission_prompt", Attn::Blocked),
            ("agent_needs_input", Attn::Blocked),
            // announce, but they describe another session or no session
            ("agent_completed", Attn::Notify),
            ("push_notification", Attn::Notify),
            // nothing to say
            ("idle_prompt", Attn::Ignore),
            ("auth_success", Attn::Ignore),
            ("elicitation_complete", Attn::Ignore),
            ("elicitation_response", Attn::Ignore),
            ("computer_use_enter", Attn::Ignore),
            ("computer_use_exit", Attn::Ignore),
        ] {
            assert_eq!(classify("Notification", Some(t)), want, "notification_type {t}");
        }
    }

    /// The three lists must stay disjoint, or the arm order in `classify`
    /// silently decides which one wins.
    #[test]
    fn the_classification_lists_do_not_overlap() {
        for a in BLOCKING_NOTIFICATIONS {
            assert!(!QUIET_NOTIFICATIONS.contains(&a), "{a} is both blocking and quiet");
            assert!(!NOTIFY_ONLY_NOTIFICATIONS.contains(&a), "{a} is both blocking and notify-only");
        }
        for q in QUIET_NOTIFICATIONS {
            assert!(!NOTIFY_ONLY_NOTIFICATIONS.contains(&q), "{q} is both quiet and notify-only");
        }
    }

    /// `agent_completed` is emitted by a poller over BACKGROUND AGENT jobs, so
    /// its payload carries the polling parent's session id while describing a
    /// different session. Storing it would clear a permission prompt the user is
    /// genuinely waiting on.
    #[test]
    fn a_background_agent_finishing_cannot_erase_a_real_question() {
        let s = AttentionState::default();
        s.mark("parent", 1, "Claude needs your permission to use Bash", Attn::Blocked);
        assert!(!s.mark("parent", 1, "worker finished", Attn::Notify), "Notify stores nothing");
        assert_eq!(s.blocked().len(), 1, "the permission prompt survives");
        assert_eq!(s.snapshot()["parent"].kind, Attn::Blocked);
        assert!(s.snapshot()["parent"].message.contains("permission"));
    }

    #[test]
    fn the_frontend_state_string_matches_what_was_stored() {
        // "info" must correspond to nothing being stored, or the frontend would
        // render a state the backend never recorded.
        assert_eq!(ui_state(Attn::Blocked), "needs_input");
        assert_eq!(ui_state(Attn::Done), "done");
        assert_eq!(ui_state(Attn::Notify), "info");
        let s = AttentionState::default();
        for kind in [Attn::Notify, Attn::Ignore] {
            assert!(!s.mark("sid", 1, "m", kind), "{kind:?} is not storable");
        }
        assert!(s.snapshot().is_empty());
    }

    #[test]
    fn a_failed_turn_says_what_went_wrong() {
        // `error_details` is optional and absent for a plain rate limit; without
        // the `error` fallback the notification would claim the turn finished.
        let bare = parse_hook(br#"{"session_id":"s","hook_event_name":"StopFailure","error":"rate_limit"}"#).unwrap();
        assert_eq!(bare.message, "rate limit reached");
        let detailed = parse_hook(
            br#"{"session_id":"s","hook_event_name":"StopFailure","error":"rate_limit","error_details":"retry after 60s"}"#,
        )
        .unwrap();
        assert_eq!(detailed.message, "retry after 60s", "details win when present");
        // an empty string must not beat the enum
        let empty = parse_hook(br#"{"session_id":"s","hook_event_name":"StopFailure","error":"overloaded","error_details":""}"#).unwrap();
        assert_eq!(empty.message, "the API was overloaded");
        assert_eq!(humanize_error("some_new_code"), "some new code");
    }

    #[test]
    fn an_idle_session_is_never_reported_as_blocked() {
        // "Claude is waiting for your input" arrives because you stopped typing.
        // Nothing would ever clear it: an idle session emits no Stop, so the
        // flag outlived the reason for it until the user returned to that tab.
        assert_eq!(classify("Notification", Some("idle_prompt")), Attn::Ignore);
        let s = AttentionState::default();
        assert!(!s.mark("sid", 3, "Claude is waiting for your input", Attn::Ignore), "Ignore stores nothing");
        assert!(s.snapshot().is_empty());
        assert!(!s.has_pty(3));
    }

    #[test]
    fn an_unknown_notification_type_still_blocks() {
        // Fail loud, not silent: a blocking type we've never heard of must not
        // become an invisible hang. An absent field means a Claude Code older
        // than the discriminator, where the previous always-blocked read holds.
        assert_eq!(classify("Notification", Some("some_future_prompt")), Attn::Blocked);
        assert_eq!(classify("Notification", None), Attn::Blocked);
    }

    #[test]
    fn a_turn_that_died_still_counts_as_finished() {
        // A rate-limited turn emits StopFailure and no Stop, so the session used
        // to go quietly green as though it had answered.
        assert_eq!(classify("StopFailure", None), Attn::Done);
        assert_eq!(classify("Stop", None), Attn::Done);
        assert_eq!(classify("SubagentStop", None), Attn::Ignore, "a subagent finishing is not your turn ending");
        assert_eq!(classify("PreToolUse", None), Attn::Ignore);
    }

    #[test]
    fn finishing_answers_whatever_it_was_blocked_on() {
        let s = AttentionState::default();
        s.mark("sid", 4, "Claude needs your permission to use Bash", Attn::Blocked);
        assert_eq!(s.blocked().len(), 1);
        s.mark("sid", 4, "", Attn::Done);
        assert!(s.blocked().is_empty(), "no longer waiting on the user");
        assert_eq!(s.snapshot().len(), 1, "but still finished-and-unseen");
        assert_eq!(s.snapshot()["sid"].kind, Attn::Done);
    }

    /// Stop fires at the end of EVERY turn, so counting Done in the badge would
    /// peg it to the number of open sessions and destroy the only signal that
    /// means "something needs you".
    #[test]
    fn the_badge_counts_questions_not_completions() {
        let s = AttentionState::default();
        s.mark("blocked-1", 1, "permission", Attn::Blocked);
        s.mark("done-1", 2, "", Attn::Done);
        s.mark("done-2", 3, "", Attn::Done);
        assert_eq!(s.snapshot().len(), 3);
        assert_eq!(s.blocked().len(), 1, "only the real question earns the badge");
        assert!(s.blocked().contains_key("blocked-1"));
    }

    #[test]
    fn looking_at_a_tab_clears_done_but_not_a_question() {
        let s = AttentionState::default();
        s.mark("done-here", 1, "", Attn::Done);
        s.mark("asking-here", 2, "permission", Attn::Blocked);
        s.mark("done-elsewhere", 9, "", Attn::Done);

        assert!(s.seen_ptys(&[1, 2]));
        let left = s.snapshot();
        assert!(!left.contains_key("done-here"), "you saw it finish");
        assert!(left.contains_key("asking-here"), "seeing a prompt does not answer it");
        assert!(left.contains_key("done-elsewhere"), "a tab you cannot see keeps its marker");
        assert!(!s.seen_ptys(&[1, 2]), "idempotent");
    }

    #[test]
    fn parse_hook_reads_the_notification_discriminator() {
        let body = br#"{"session_id":"abc","hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}"#;
        let h = parse_hook(body).unwrap();
        assert_eq!(h.notification_type.as_deref(), Some("idle_prompt"));
        assert_eq!(classify(&h.event, h.notification_type.as_deref()), Attn::Ignore);

        // StopFailure's detail lands in `message` so the notification can say
        // what went wrong instead of claiming the turn finished.
        let fail = parse_hook(br#"{"session_id":"abc","hook_event_name":"StopFailure","error_details":"rate limit reached"}"#).unwrap();
        assert_eq!(fail.message, "rate limit reached");
        assert_eq!(fail.notification_type, None);
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
