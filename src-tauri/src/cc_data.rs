//! Read-only views over Claude Code's own data stores — ~/.claude/tasks/,
//! stats-cache.json, file-history/ — plus Drydock's own index (token usage,
//! recaps). Drydock NEVER writes any of the ~/.claude paths here.

use crate::index::AppDb;
use serde_json::Value;
use std::io::BufRead;
use tauri::State;

/// Path-safety gate: session ids are only ever joined into ~/.claude paths
/// when they look like the uuids Claude Code mints (hex + dashes, 36 chars).
fn is_session_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

// ---- live task board (~/.claude/tasks/<sid>/*.json) ----------------------

#[derive(serde::Serialize)]
pub struct TaskView {
    pub id: String,
    pub subject: String,
    pub active_form: Option<String>,
    pub status: String, // pending | in_progress | completed (future values pass through)
    pub blocked_by: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct TasksView {
    pub tasks: Vec<TaskView>,
    /// Newest task-file mtime (ms) — the UI shows the board's age so a stale
    /// "in progress" reads as stale, not live.
    pub updated_at: Option<i64>,
}

#[tauri::command]
pub fn session_tasks(session_id: String) -> Result<TasksView, String> {
    if !is_session_uuid(&session_id) {
        return Err("bad session id".into());
    }
    let dir = crate::index::claude_dir().join("tasks").join(&session_id);
    let mut tasks: Vec<(i64, TaskView)> = Vec::new();
    let mut updated_at: Option<i64> = None;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(TasksView { tasks: vec![], updated_at: None }); // no board = empty, not an error
    };
    for e in entries.flatten() {
        if tasks.len() >= 500 {
            break; // a task board is a checklist, not a database
        }
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if e.metadata().map(|m| m.len() > 256_000).unwrap_or(true) {
            continue; // oversized or unreadable — not a task file we render
        }
        if let Ok(md) = e.metadata() {
            let mt = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            updated_at = updated_at.max(mt);
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        let id = s("id").unwrap_or_else(|| path.file_stem().and_then(|x| x.to_str()).unwrap_or("").to_string());
        let ord = id.parse::<i64>().unwrap_or(i64::MAX);
        tasks.push((
            ord,
            TaskView {
                subject: s("subject").unwrap_or_default(),
                active_form: s("activeForm"),
                status: s("status").unwrap_or_else(|| "pending".into()),
                blocked_by: v
                    .get("blockedBy")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                id,
            },
        ));
    }
    tasks.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    Ok(TasksView { tasks: tasks.into_iter().map(|(_, t)| t).collect(), updated_at })
}

// ---- Home recaps digest (Drydock's own index) ------------------------------

#[derive(serde::Serialize)]
pub struct RecapEntry {
    pub session_id: String,
    pub project_path: String,
    /// A genuine short name, or None — never the recap (see Store::recap_digest).
    pub label: Option<String>,
    pub summary: String,
    /// The card's milestones, parsed here so the frontend never re-parses
    /// store-owned JSON; unparseable/absent timelines become [].
    pub timeline: Vec<crate::enricher::TimelineItem>,
    pub last_message_at: i64,
}

/// Newest-first page of the "what happened" work log: each visible session's
/// distilled recap. `before`/`before_sid` form a keyset cursor — the exact
/// (last_message_at, session_id) of the last row shown; both or neither.
#[tauri::command]
pub fn recap_digest(
    db: State<'_, AppDb>,
    limit: i64,
    before: Option<i64>,
    before_sid: Option<String>,
) -> Result<Vec<RecapEntry>, String> {
    let store = db.0.lock().unwrap();
    let cursor = match (before, before_sid.as_deref()) {
        (Some(ts), Some(sid)) => Some((ts, sid)),
        _ => None,
    };
    let rows = store.recap_digest(cursor, limit).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| RecapEntry {
            session_id: r.session_id,
            project_path: r.project_path,
            label: r.label,
            summary: r.summary,
            timeline: serde_json::from_str(&r.timeline).unwrap_or_default(),
            last_message_at: r.last_message_at,
        })
        .collect())
}

// ---- usage: per-session (Drydock index) + global (stats-cache.json) -------

#[derive(serde::Serialize)]
pub struct ModelUsageView {
    pub model: String,
    pub scope: String, // 'main' or an agent id
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
}

#[derive(serde::Serialize)]
pub struct SessionUsageView {
    pub rows: Vec<ModelUsageView>,
    pub total_output: i64,
    /// input + output + cache_creation (cache READS excluded: numerically
    /// dominant, economically cheap — they'd drown the signal)
    pub total_tokens: i64,
    pub agent_output: i64, // share of total_output from subagents
}

#[tauri::command]
pub fn session_usage(db: State<'_, AppDb>, session_id: String) -> Result<SessionUsageView, String> {
    let store = db.0.lock().unwrap();
    let raw = store.session_usage(&session_id).map_err(|e| e.to_string())?;
    let mut total_output = 0i64;
    let mut total_tokens = 0i64;
    let mut agent_output = 0i64;
    // collapse per-agent scopes to one 'agents' bucket per model: the chip
    // tooltip wants "who wrote what", not one line per subagent id
    let mut agg: std::collections::BTreeMap<(String, String), [i64; 4]> = Default::default();
    for r in raw {
        total_output += r.output;
        total_tokens += r.input + r.output + r.cache_creation;
        let scope = if r.scope == "main" { "main" } else { "agents" };
        if scope == "agents" {
            agent_output += r.output;
        }
        let e = agg.entry((scope.to_string(), r.model)).or_insert([0; 4]);
        e[0] += r.input;
        e[1] += r.output;
        e[2] += r.cache_read;
        e[3] += r.cache_creation;
    }
    let rows = agg
        .into_iter()
        .map(|((scope, model), [i, o, cr, cc])| ModelUsageView {
            model,
            scope,
            input: i,
            output: o,
            cache_read: cr,
            cache_creation: cc,
        })
        .collect();
    Ok(SessionUsageView { rows, total_output, total_tokens, agent_output })
}

#[derive(serde::Serialize)]
pub struct DailyActivityView {
    pub date: String,
    pub messages: i64,
    pub sessions: i64,
    pub tools: i64,
    pub tokens: i64, // summed across models from dailyModelTokens
}

#[derive(serde::Serialize)]
pub struct ModelTotalsView {
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    /// Claude Code's OWN figure — shown only when it reports one (> 0). We
    /// never price tokens ourselves: price tables go stale silently.
    pub cost_usd: f64,
}

#[derive(serde::Serialize)]
pub struct TopSessionView {
    pub session_id: String,
    pub label: String,
    pub project: String,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(serde::Serialize)]
pub struct UsageOverview {
    /// stats-cache.json's own last-computed date — it can lag by days; the UI
    /// must disclose the age instead of implying live numbers.
    pub last_computed: Option<String>,
    pub total_sessions: Option<i64>,
    pub daily: Vec<DailyActivityView>,
    pub models: Vec<ModelTotalsView>,
    pub top_sessions: Vec<TopSessionView>,
}

#[tauri::command]
pub fn usage_overview(db: State<'_, AppDb>) -> Result<UsageOverview, String> {
    // stats-cache.json: optional, possibly stale — absence is not an error
    let mut last_computed = None;
    let mut total_sessions = None;
    let mut daily: Vec<DailyActivityView> = Vec::new();
    let mut models: Vec<ModelTotalsView> = Vec::new();
    let stats_path = crate::index::claude_dir().join("stats-cache.json");
    if let Ok(text) = std::fs::read_to_string(&stats_path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            last_computed = v.get("lastComputedDate").and_then(Value::as_str).map(String::from);
            total_sessions = v.get("totalSessions").and_then(Value::as_i64);
            // tokens per day, summed across models
            let mut day_tokens: std::collections::HashMap<String, i64> = Default::default();
            if let Some(arr) = v.get("dailyModelTokens").and_then(Value::as_array) {
                for d in arr {
                    let Some(date) = d.get("date").and_then(Value::as_str) else { continue };
                    let sum: i64 = d
                        .get("tokensByModel")
                        .and_then(Value::as_object)
                        .map(|m| m.values().filter_map(Value::as_i64).sum())
                        .unwrap_or(0);
                    *day_tokens.entry(date.to_string()).or_insert(0) += sum;
                }
            }
            if let Some(arr) = v.get("dailyActivity").and_then(Value::as_array) {
                for d in arr {
                    let date = d.get("date").and_then(Value::as_str).unwrap_or("").to_string();
                    let n = |k: &str| d.get(k).and_then(Value::as_i64).unwrap_or(0);
                    daily.push(DailyActivityView {
                        tokens: day_tokens.get(&date).copied().unwrap_or(0),
                        messages: n("messageCount"),
                        sessions: n("sessionCount"),
                        tools: n("toolCallCount"),
                        date,
                    });
                }
                daily.sort_by(|a, b| a.date.cmp(&b.date));
            }
            if let Some(obj) = v.get("modelUsage").and_then(Value::as_object) {
                for (model, u) in obj {
                    let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
                    models.push(ModelTotalsView {
                        model: model.clone(),
                        input: n("inputTokens"),
                        output: n("outputTokens"),
                        cache_read: n("cacheReadInputTokens"),
                        cache_creation: n("cacheCreationInputTokens"),
                        cost_usd: u.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0),
                    });
                }
                models.sort_by(|a, b| b.output.cmp(&a.output));
            }
        }
    }

    // top sessions by indexed usage (always fresh — our own index)
    let store = db.0.lock().unwrap();
    let top = store.top_sessions_by_tokens(8).map_err(|e| e.to_string())?;
    let top_sessions = top
        .into_iter()
        .filter_map(|(sid, out, total)| {
            let label = store.display_label(&sid).ok().flatten()?;
            let project = store.get_session(&sid).ok().flatten().map(|r| r.project_path).unwrap_or_default();
            Some(TopSessionView { session_id: sid, label, project, output_tokens: out, total_tokens: total })
        })
        .collect();

    Ok(UsageOverview { last_computed, total_sessions, daily, models, top_sessions })
}

// ---- file time machine (~/.claude/file-history/<sid>/<hash>@vN) -----------

#[derive(serde::Serialize)]
pub struct FileVersionView {
    pub version: i64,
    /// blob name (<16-hex>@vN) under file-history/<sid>/; None when CC tracked
    /// the file but stored no backup for this version
    pub backup_file: Option<String>,
    pub ts: Option<i64>, // backupTime, ms
}

#[derive(serde::Serialize)]
pub struct FileHistoryView {
    /// cwd-relative path exactly as the snapshot records it
    pub path: String,
    pub versions: Vec<FileVersionView>,
}

/// Checkpoint index for a session: every file-history-snapshot record in the
/// transcript, folded into per-file version lists. Read-only; snapshots are
/// cumulative, so later records may repeat earlier versions (last wins).
#[tauri::command]
pub fn file_history(db: State<'_, AppDb>, session_id: String) -> Result<Vec<FileHistoryView>, String> {
    if !is_session_uuid(&session_id) {
        return Err("bad session id".into());
    }
    let path = {
        let store = db.0.lock().unwrap();
        store.transcript_path(&session_id).map_err(|e| e.to_string())?
    };
    let Some(path) = path else { return Ok(vec![]) };
    let Ok(f) = std::fs::File::open(&path) else { return Ok(vec![]) };
    let blob_dir = crate::index::claude_dir().join("file-history").join(&session_id);

    // path → version → (backup_file, ts); BTreeMaps keep output deterministic
    let mut files: std::collections::BTreeMap<String, std::collections::BTreeMap<i64, (Option<String>, Option<i64>)>> =
        Default::default();
    for line in std::io::BufReader::new(f).lines() {
        let Ok(line) = line else { continue };
        if !line.contains("\"file-history-snapshot\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("file-history-snapshot") {
            continue;
        }
        let Some(tracked) = v.pointer("/snapshot/trackedFileBackups").and_then(Value::as_object) else { continue };
        for (rel, info) in tracked {
            let Some(version) = info.get("version").and_then(Value::as_i64) else { continue };
            // shape-gate BEFORE any disk probe: the name comes from the
            // transcript and is joined into a path
            let backup = info
                .get("backupFileName")
                .and_then(Value::as_str)
                .filter(|b| is_blob_name(b))
                .map(String::from);
            let ts = info
                .get("backupTime")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis());
            files.entry(rel.clone()).or_default().insert(version, (backup, ts));
        }
    }
    Ok(files
        .into_iter()
        .map(|(path, versions)| FileHistoryView {
            path,
            versions: versions
                .into_iter()
                .map(|(version, (backup, ts))| FileVersionView {
                    version,
                    // only offer blobs that actually exist on disk
                    backup_file: backup.filter(|b| blob_dir.join(b).is_file()),
                    ts,
                })
                .collect(),
        })
        .filter(|fh| fh.versions.iter().any(|v| v.backup_file.is_some()))
        .collect())
}

/// One backed-up file version's raw contents. `file` must be exactly a blob
/// name CC mints (<hex>@vN) — never a path.
#[tauri::command]
pub fn read_file_version(session_id: String, file: String) -> Result<String, String> {
    if !is_session_uuid(&session_id) {
        return Err("bad session id".into());
    }
    if !is_blob_name(&file) {
        return Err("bad version file name".into());
    }
    let path = crate::index::claude_dir().join("file-history").join(&session_id).join(&file);
    let md = std::fs::metadata(&path).map_err(|_| "version not on disk".to_string())?;
    if md.len() > 4_000_000 {
        return Err("this version is too large to preview (>4 MB)".into());
    }
    std::fs::read_to_string(&path).map_err(|_| "couldn't read this version (binary file?)".to_string())
}

/// <16 hex>@v<digits> — the only shape CC uses for backup blobs.
fn is_blob_name(s: &str) -> bool {
    let Some((hash, v)) = s.split_once("@v") else { return false };
    !hash.is_empty()
        && hash.len() <= 32
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
        && !v.is_empty()
        && v.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_name_gate_refuses_paths() {
        assert!(is_blob_name("0258a693c32ab31b@v12"));
        assert!(!is_blob_name("../../evil@v1"));
        assert!(!is_blob_name("0258a693c32ab31b"));
        assert!(!is_blob_name("0258a693c32ab31b@vx"));
        assert!(!is_blob_name("@v1"));
    }

    #[test]
    fn session_id_gate_refuses_path_shapes() {
        assert!(is_session_uuid("11111111-1111-1111-1111-111111111111"));
        assert!(!is_session_uuid("../../../etc/passwd"));
        assert!(!is_session_uuid("11111111-1111-1111-1111-11111111111X"));
        assert!(!is_session_uuid(""));
    }
}
