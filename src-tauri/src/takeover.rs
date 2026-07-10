//! "Take over here": stop the EXTERNAL claude process that owns a session so
//! Drydock can resume it in its own tab — no hunting for the old terminal.
//!
//! Read-only toward ~/.claude: the dead process's stale pid file is inert
//! (the radar's liveness guard skips dead pids) and claude removes it itself
//! on a graceful exit.

use drydock_core::radar;
use std::path::Path;
use std::time::Duration;
use tauri::State;

/// What the confirm dialog names before anything is signalled.
#[derive(serde::Serialize)]
pub struct TakeoverInfo {
    pub pid: u32,
    pub status: String, // "busy" | "idle" (pid-file granularity)
    pub cwd: Option<String>,
    pub tty: Option<String>,
    pub app: Option<String>, // friendly host-app name, if recognizable
}

fn ps_field(pid: u32, field: &str) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", &format!("{field}=")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Friendly name of the terminal/editor a command line reveals. Substring
/// match over the FULL command: `comm=` truncates to 16 chars and .app paths
/// contain spaces, so token parsing is a trap. Ordered specific → generic.
fn friendly_app(command: &str) -> Option<&'static str> {
    let c = command.to_lowercase();
    const MAP: &[(&str, &str)] = &[
        ("iterm2", "iTerm2"),
        ("terminal.app", "Terminal"),
        ("wezterm", "WezTerm"),
        ("alacritty", "Alacritty"),
        ("kitty.app", "kitty"),
        ("ghostty", "Ghostty"),
        ("warp.app", "Warp"),
        ("hyper.app", "Hyper"),
        ("visual studio code", "VS Code"),
        ("code helper", "VS Code"),
        ("cursor.app", "Cursor"),
        ("zed.app", "Zed"),
        ("tmux", "tmux"),
    ];
    MAP.iter().find(|(m, _)| c.contains(m)).map(|(_, n)| *n)
}

/// Walk the ancestor chain looking for a recognizable host app. Stops at
/// launchd (a daemonized session has no host to name).
fn host_app(pid: u32) -> Option<String> {
    let mut cur = pid;
    for _ in 0..15 {
        let ppid: u32 = ps_field(cur, "ppid")?.parse().ok()?;
        if ppid <= 1 {
            return None;
        }
        if let Some(cmd) = ps_field(ppid, "command") {
            if let Some(name) = friendly_app(&cmd) {
                return Some(name.to_string());
            }
        }
        cur = ppid;
    }
    None
}

/// Is `pid` (or any ancestor) a process Drydock itself spawned? Our own tab
/// children exec claude directly, so a claude tab's pid IS in `own` — but a
/// claude typed into a Drydock SHELL tab is a grandchild of the shell, so the
/// direct-membership test misses it and takeover would signal a process
/// living in our own window. Walk up and refuse if we own any ancestor.
fn owned_by_drydock(pid: u32, own: &[u32]) -> bool {
    let mut cur = pid;
    for _ in 0..15 {
        if own.contains(&cur) {
            return true;
        }
        match ps_field(cur, "ppid").and_then(|s| s.parse::<u32>().ok()) {
            Some(p) if p > 1 => cur = p,
            _ => return false,
        }
    }
    false
}

/// Where is this session running? None = it isn't (anymore).
#[tauri::command(async)]
pub fn session_process_info(session_id: String) -> Option<TakeoverInfo> {
    let s = radar::find_live(&crate::index::claude_dir(), &session_id)?;
    Some(TakeoverInfo {
        pid: s.pid,
        status: s.status,
        cwd: s.cwd,
        tty: ps_field(s.pid, "tty").filter(|t| t != "??"),
        app: host_app(s.pid),
    })
}

/// Kill the external claude owning `session_id`. The pid-file match and the
/// is-it-still-claude check both re-run here, immediately before signalling
/// (pid-reuse guard); pids belonging to our own tabs are refused — those have
/// "Go to live tab". SIGTERM first, SIGKILL after ~4s of polling.
#[tauri::command(async)]
pub fn takeover_kill(mgr: State<'_, crate::pty::PtyManager>, session_id: String) -> Result<(), String> {
    kill_at(&crate::index::claude_dir(), &session_id, &mgr.pids())
}

fn kill_at(claude_dir: &Path, session_id: &str, own_pids: &[u32]) -> Result<(), String> {
    let s = radar::find_live(claude_dir, session_id)
        .ok_or("session is not running anymore — resume it directly")?;
    if s.pid <= 1 {
        return Err("refusing to signal a system pid".into());
    }
    if owned_by_drydock(s.pid, own_pids) {
        return Err("this session is running in a Drydock tab — use that tab".into());
    }
    unsafe { libc::kill(s.pid as i32, libc::SIGTERM) };
    if wait_gone(s.pid, 20) {
        return Ok(());
    }
    unsafe { libc::kill(s.pid as i32, libc::SIGKILL) };
    if wait_gone(s.pid, 10) {
        return Ok(());
    }
    Err("the process did not exit".into())
}

fn wait_gone(pid: u32, ticks: u32) -> bool {
    for _ in 0..ticks {
        std::thread::sleep(Duration::from_millis(200));
        if !radar::process_is_claude(pid) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_by_drydock_walks_ancestors() {
        // a child of THIS test process is "owned" when the test pid is in the set
        let child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let cpid = child.id();
        assert!(owned_by_drydock(cpid, &[std::process::id()]), "parent in set → owned");
        assert!(owned_by_drydock(cpid, &[cpid]), "self in set → owned");
        assert!(!owned_by_drydock(cpid, &[999_999]), "unrelated set → not owned");
        unsafe { libc::kill(cpid as i32, libc::SIGKILL) };
    }

    #[test]
    fn friendly_app_maps_known_hosts() {
        assert_eq!(friendly_app("/Applications/iTerm2.app/Contents/MacOS/iTerm2"), Some("iTerm2"));
        assert_eq!(friendly_app("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"), Some("Terminal"));
        assert_eq!(friendly_app("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), Some("VS Code"));
        assert_eq!(friendly_app("tmux -u attach"), Some("tmux"));
        assert_eq!(friendly_app("/bin/zsh -il"), None);
        assert_eq!(friendly_app("login -pf dev"), None);
    }

    /// End-to-end kill path against a REAL throwaway child masquerading as
    /// claude (argv0 rename — the same string the radar's ps guard reads).
    #[test]
    fn kill_at_terminates_matched_process_and_refuses_own_pids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();

        let child = std::process::Command::new("/bin/bash")
            .args(["-c", "exec -a claude sleep 30"])
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(150)); // let exec happen
        assert!(radar::process_is_claude(pid), "test child should read as claude");
        std::fs::write(
            dir.join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"take-me","status":"idle"}}"#),
        )
        .unwrap();

        // own-pid refusal leaves it running
        let err = kill_at(tmp.path(), "take-me", &[pid]).unwrap_err();
        assert!(err.contains("Drydock tab"), "{err}");
        assert!(radar::process_is_claude(pid));

        // unknown session: no signal sent
        assert!(kill_at(tmp.path(), "someone-else", &[]).is_err());

        // the real thing
        kill_at(tmp.path(), "take-me", &[]).unwrap();
        assert!(!radar::process_is_claude(pid));
    }
}
