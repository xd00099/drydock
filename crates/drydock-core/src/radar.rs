use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct LiveSession {
    pub pid: u32,
    pub session_id: String,
    pub status: String, // "busy" | "idle"
    pub updated_at: Option<i64>,
    pub cwd: Option<String>,
    /// Process start time as claude recorded it (`ps -o lstart=` format), if
    /// the CLI version wrote one. The pid-reuse defense: compared to the live
    /// pid's actual start time before we ever signal it (see `identity_matches`).
    pub proc_start: Option<String>,
}

/// Parse <claude_dir>/sessions/<pid>.json files; keep entries whose pid passes `alive`.
/// Defensive: malformed files and entries without a sessionId are skipped;
/// a missing `status` field (older CLI versions) counts as "idle".
pub fn live_sessions_with(claude_dir: &Path, alive: impl Fn(u32) -> bool) -> Vec<LiveSession> {
    let dir = claude_dir.join("sessions");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(pid) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(session_id) = v.get("sessionId").and_then(Value::as_str) else { continue };
        if !alive(pid) {
            continue;
        }
        let status = match v.get("status").and_then(Value::as_str) {
            Some("busy") => "busy",
            _ => "idle",
        };
        out.push(LiveSession {
            pid,
            session_id: session_id.to_string(),
            status: status.to_string(),
            updated_at: v.get("updatedAt").and_then(Value::as_i64),
            cwd: v.get("cwd").and_then(Value::as_str).map(String::from),
            proc_start: v.get("procStart").and_then(Value::as_str).map(String::from),
        });
    }
    out
}

/// Production liveness: the pid exists AND its command line mentions claude
/// (PID-reuse guard — a recycled pid belonging to another claude is vanishingly rare).
pub fn process_is_claude(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("claude"))
        .unwrap_or(false)
}

pub fn live_sessions(claude_dir: &Path) -> Vec<LiveSession> {
    live_sessions_with(claude_dir, process_is_claude)
}

/// The live pid's own start time (`ps -o lstart=`) — the value claude stamps
/// into `procStart`. `None` if the pid is gone or ps fails.
pub fn process_start(pid: u32) -> Option<String> {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Exact identity of a pid-file entry: the pid is a live claude AND — when the
/// file recorded a `procStart` — the live pid's start time still matches. This
/// is what makes killing safe: a recycled pid now owned by an unrelated
/// "claude"-ish process (Claude.app, an MCP server, `claude mcp serve`) fails
/// the start-time check even though it passes the command substring test. A
/// file with no procStart (older CLI) falls back to the substring guard.
pub fn identity_matches(s: &LiveSession) -> bool {
    identity_matches_with(s, process_is_claude, process_start)
}

pub fn identity_matches_with(
    s: &LiveSession,
    is_claude: impl Fn(u32) -> bool,
    start: impl Fn(u32) -> Option<String>,
) -> bool {
    if !is_claude(s.pid) {
        return false;
    }
    match &s.proc_start {
        Some(expected) => start(s.pid).as_deref() == Some(expected.as_str()),
        None => true,
    }
}

/// Locate the live process owning one session — the takeover locator. Unlike
/// the radar's display scan this VERIFIES identity (pid-reuse safe) and, when
/// stale duplicate files claim the same sessionId (a SIGKILLed claude never
/// unlinks its file), picks the freshest surviving one by `updatedAt` rather
/// than arbitrary directory order. None = not verifiably running right now.
pub fn find_live(claude_dir: &Path, session_id: &str) -> Option<LiveSession> {
    find_live_with(claude_dir, session_id, identity_matches)
}

pub fn find_live_with(claude_dir: &Path, session_id: &str, ok: impl Fn(&LiveSession) -> bool) -> Option<LiveSession> {
    let mut matches: Vec<LiveSession> = live_sessions_with(claude_dir, |_| true)
        .into_iter()
        .filter(|s| s.session_id == session_id && ok(s))
        .collect();
    matches.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)); // freshest first
    matches.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_reg(dir: &std::path::Path, pid: u32, json: &str) {
        let d = dir.join("sessions");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(format!("{pid}.json")), json).unwrap();
    }

    #[test]
    fn parses_registry_and_filters_dead_pids() {
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 101, r#"{"pid":101,"sessionId":"aaa","cwd":"/p","status":"busy","updatedAt":5}"#);
        write_reg(tmp.path(), 102, r#"{"pid":102,"sessionId":"bbb","status":"idle"}"#);
        write_reg(tmp.path(), 103, r#"{"pid":103,"sessionId":"ccc","status":"busy"}"#);
        write_reg(tmp.path(), 104, r#"not json"#);
        // v2.1.114-era entry without status — counts as idle
        write_reg(tmp.path(), 105, r#"{"pid":105,"sessionId":"eee"}"#);

        let live = live_sessions_with(tmp.path(), |pid| pid != 103); // 103 is dead
        let mut ids: Vec<_> = live.iter().map(|l| (l.session_id.as_str(), l.status.as_str())).collect();
        ids.sort();
        assert_eq!(ids, vec![("aaa", "busy"), ("bbb", "idle"), ("eee", "idle")]);
    }

    #[test]
    fn missing_registry_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(live_sessions_with(tmp.path(), |_| true).is_empty());
    }

    #[test]
    fn find_live_matches_session_and_respects_liveness() {
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 201, r#"{"pid":201,"sessionId":"want","status":"busy","cwd":"/w"}"#);
        write_reg(tmp.path(), 202, r#"{"pid":202,"sessionId":"other","status":"idle"}"#);
        let hit = find_live_with(tmp.path(), "want", |_| true).unwrap();
        assert_eq!((hit.pid, hit.status.as_str(), hit.cwd.as_deref()), (201, "busy", Some("/w")));
        assert!(find_live_with(tmp.path(), "want", |s| s.pid != 201).is_none()); // fails identity
        assert!(find_live_with(tmp.path(), "missing", |_| true).is_none());
    }

    #[test]
    fn find_live_prefers_freshest_of_duplicate_session_files() {
        // A SIGKILLed claude leaves its pid file behind; on pid reuse two files
        // can claim one sessionId. The freshest updatedAt wins deterministically.
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 301, r#"{"pid":301,"sessionId":"dup","status":"idle","updatedAt":100}"#);
        write_reg(tmp.path(), 302, r#"{"pid":302,"sessionId":"dup","status":"busy","updatedAt":900}"#);
        let hit = find_live_with(tmp.path(), "dup", |_| true).unwrap();
        assert_eq!(hit.pid, 302);
    }

    #[test]
    fn identity_matches_checks_start_time_when_present() {
        let base = LiveSession {
            pid: 42, session_id: "s".into(), status: "idle".into(),
            updated_at: None, cwd: None, proc_start: Some("Fri Jul 10 17:05:10 2026".into()),
        };
        // right command, right start time → ok
        assert!(identity_matches_with(&base, |_| true, |_| Some("Fri Jul 10 17:05:10 2026".into())));
        // right command, DIFFERENT start time (pid reused) → refused
        assert!(!identity_matches_with(&base, |_| true, |_| Some("Thu Jan  1 00:00:00 2026".into())));
        // not claude at all → refused regardless of start time
        assert!(!identity_matches_with(&base, |_| false, |_| Some("Fri Jul 10 17:05:10 2026".into())));
        // older CLI wrote no procStart → substring guard alone decides
        let no_start = LiveSession { proc_start: None, ..base.clone() };
        assert!(identity_matches_with(&no_start, |_| true, |_| None));
        assert!(!identity_matches_with(&no_start, |_| false, |_| None));
    }
}
