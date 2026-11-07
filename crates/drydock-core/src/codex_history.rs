//! Read-only conversation context from Codex's paginated thread history.
//! Deliberately selects user/agent messages only: reasoning and tool payloads
//! are neither summary context nor evidence of completed work.
use crate::chunker::Chunk;
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{path::{Path, PathBuf}, time::Duration};

pub struct HistoryContext {
    pub first_user: Option<String>,
    pub messages: Vec<Chunk>,
    pub version: String,
}
fn database(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root).ok()?.flatten().filter_map(|entry| {
        let name = entry.file_name().to_str()?.to_string();
        let version = name.strip_prefix("thread_history_")?.strip_suffix(".sqlite")?.parse::<u32>().ok()?;
        Some((version, entry.path()))
    }).max_by_key(|(version, _)| *version).map(|(_, path)| path)
}
fn message(raw: &str, ts: i64) -> Result<Option<Chunk>> {
    let item: Value = serde_json::from_str(raw).context("Codex history item is not valid JSON")?;
    let (role, text) = match item["type"].as_str() {
        Some("userMessage") => ("user", item["content"].as_array().map(|parts| parts.iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()),
        Some("agentMessage") => ("assistant", item["text"].as_str().unwrap_or_default().to_string()),
        _ => return Ok(None),
    };
    if text.trim().is_empty() || (role == "user" && crate::codex::is_boilerplate(&text)) { return Ok(None); }
    Ok(Some(Chunk { role: role.into(), text, ts: Some(ts) }))
}

pub fn read_context(root: &Path, id: &str) -> Result<Option<HistoryContext>> {
    let Some(path) = database(root) else { return Ok(None); };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .context("Cannot read Codex thread history")?;
    db.busy_timeout(Duration::from_millis(100))?;
    // One read transaction keeps the tail and its freshness marker consistent
    // while Codex appends or updates a streaming agent message.
    db.execute_batch("BEGIN")?;
    let columns = db.prepare("PRAGMA table_info(thread_items)")?.query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let updated = if columns.iter().any(|c| c == "updated_at_ordinal") { "MAX(updated_at_ordinal)" } else { "0" };
    let types = "(item_type IN ('userMessage','agentMessage') OR item_type = '')";
    let sql = format!("SELECT COUNT(*), COALESCE(MAX(rollout_ordinal),0), COALESCE(SUM(length(item_json)),0), COALESCE({updated},0) FROM thread_items WHERE thread_id = ?1 AND {types}");
    let marker: (i64, i64, i64, i64) = db.query_row(&sql, [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    if marker.0 == 0 { return Ok(None); }
    let sql = format!("SELECT item_json,created_at_ms FROM thread_items WHERE thread_id = ?1 AND {types} ORDER BY rollout_ordinal DESC LIMIT 80");
    let mut messages = db.prepare(&sql)?.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?.into_iter().map(|(raw, ts)| message(&raw, ts))
        .collect::<Result<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>();
    messages.reverse();
    let mut first_user = None;
    let sql = "SELECT item_json,created_at_ms FROM thread_items WHERE thread_id = ?1 AND item_type IN ('userMessage','') ORDER BY rollout_ordinal LIMIT 20";
    for (raw, ts) in db.prepare(sql)?.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()? {
        if let Some(chunk) = message(&raw, ts)?.filter(|c| c.role == "user") { first_user = Some(chunk.text); break; }
    }
    db.execute_batch("COMMIT")?;
    Ok(Some(HistoryContext { first_user, messages, version: format!("{}:{}:{}:{}", marker.0, marker.1, marker.2, marker.3) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("thread_history_1.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER DEFAULT 0)").unwrap();
        (root, db)
    }
    fn insert(db: &Connection, thread: &str, n: i64, item: Value) {
        db.execute("INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type) VALUES (?1,'turn',?2,?3,?3,?4,?5)",
            rusqlite::params![thread, format!("item-{n}"), n, item.to_string(), item["type"].as_str().unwrap()]).unwrap();
    }
    #[test]
    fn reads_real_parent_messages_with_role_order_and_no_tools_or_reasoning() {
        let (root, db) = fixture();
        insert(&db, "parent", 0, serde_json::json!({"type":"userMessage","content":[{"type":"text","text":"<environment_context>setup</environment_context>"}]}));
        insert(&db, "parent", 1, serde_json::json!({"type":"userMessage","content":[{"type":"localImage","path":"private.png"},{"type":"text","text":"Recover sessions"}]}));
        insert(&db, "parent", 2, serde_json::json!({"type":"reasoning","content":"private reasoning"}));
        insert(&db, "parent", 3, serde_json::json!({"type":"commandExecution","aggregatedOutput":"tool output"}));
        insert(&db, "child", 4, serde_json::json!({"type":"agentMessage","text":"Unrelated child result"}));
        insert(&db, "parent", 5, serde_json::json!({"type":"agentMessage","text":"Recovered 49 sessions","phase":"final_answer"}));
        let before = std::fs::read(root.path().join("thread_history_1.sqlite")).unwrap();
        let context = read_context(root.path(), "parent").unwrap().unwrap();
        assert_eq!(context.first_user.as_deref(), Some("Recover sessions"));
        assert_eq!(context.messages.len(), 2);
        assert_eq!(context.messages[0].role, "user");
        assert_eq!(context.messages[1].text, "Recovered 49 sessions");
        assert_eq!(std::fs::read(root.path().join("thread_history_1.sqlite")).unwrap(), before);
        assert!(read_context(root.path(), "absent").unwrap().is_none());
    }
    #[test]
    fn bounds_tail_and_changes_version_for_streamed_updates_and_new_messages() {
        let (root, db) = fixture();
        for n in 0..100 { insert(&db, "thread", n, serde_json::json!({"type":"userMessage","content":[{"type":"text","text":format!("message {n}")}]})); }
        let old = read_context(root.path(), "thread").unwrap().unwrap();
        assert_eq!(old.messages.len(), 80);
        assert_eq!(old.messages[0].text, "message 20");
        assert_eq!(old.first_user.as_deref(), Some("message 0"));
        db.execute("UPDATE thread_items SET updated_at_ordinal=200 WHERE rollout_ordinal=99", []).unwrap();
        let streaming = read_context(root.path(), "thread").unwrap().unwrap();
        assert_ne!(old.version, streaming.version);
        insert(&db, "thread", 100, serde_json::json!({"type":"agentMessage","text":"Finished work"}));
        let latest = read_context(root.path(), "thread").unwrap().unwrap();
        assert_ne!(streaming.version, latest.version);
        assert_eq!(latest.messages.last().unwrap().text, "Finished work");
    }
}
