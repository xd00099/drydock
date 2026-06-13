use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct LiveSession {
    pub pid: u32,
    pub session_id: String,
    pub status: String, // "busy" | "idle"
    pub updated_at: Option<i64>,
    pub cwd: Option<String>,
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
}
