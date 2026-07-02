//! Direct, full-fidelity reads of a session's transcript .jsonl for DISPLAY —
//! unlike `parser`/`chunker`, which distill searchable text chunks for the
//! index, this keeps the conversation's structure: user/assistant text,
//! thinking, tool calls (with a one-line input summary), tool results, recaps
//! and compaction boundaries, each with its timestamp. Reads are incremental
//! (byte offset in/out, complete lines only) so a live session can be tailed
//! cheaply on every index tick.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Longest tool-result snippet kept (chars). Results can be huge (whole file
/// dumps); the view only needs enough to tell what happened.
const RESULT_SNIPPET_CHARS: usize = 700;
/// Longest tool-input summary (chars) — one line, e.g. a path or a command.
const INPUT_SUMMARY_CHARS: usize = 200;

/// One display entry, in document order. `kind` is one of:
/// "user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "recap" | "compact".
/// tool_use/tool_result pairs share `tool_use_id`; the frontend folds results
/// into their call's chip (pairing may span two incremental pages).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Entry {
    pub kind: String,
    pub text: String,
    /// Tool name, on "tool_use" entries.
    pub tool: Option<String>,
    pub tool_use_id: Option<String>,
    /// Meta/command noise (isMeta records, `<caveat>`/`<command-…>` blocks) —
    /// shown dimmed rather than dropped, so the transcript stays complete.
    pub meta: bool,
    /// tool_result with is_error, for red styling.
    pub error: bool,
    pub ts: Option<i64>,
}

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Page {
    pub entries: Vec<Entry>,
    /// Byte offset consumed up to (complete lines only) — pass back on the
    /// next call to read only what's new.
    pub next_offset: u64,
    /// The file shrank below `from_offset` (rewritten/truncated): this page was
    /// re-read from zero and the caller must discard previously-held entries.
    pub reset: bool,
}

/// One file a session modified, aggregated from its Edit/Write tool calls.
/// Calls whose tool_result came back is_error are not counted.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileTouch {
    pub path: String,
    /// Edit / MultiEdit / NotebookEdit calls.
    pub edits: i64,
    /// Write calls (file created or fully rewritten).
    pub writes: i64,
    pub last_ts: Option<i64>,
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// First line only, truncated — tool inputs summarize to a single line.
fn one_line(s: &str, max: usize) -> String {
    truncate_chars(s.lines().next().unwrap_or(""), max)
}

fn ts_ms(v: &Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}

/// True for user text a human didn't really type (caveat/command meta blocks).
fn is_meta_text(text: &str) -> bool {
    text.trim_start().starts_with('<')
}

/// One-line summary of a tool call's input: the most informative field for
/// known tools, any conventional field otherwise, compact JSON as a last resort.
fn summarize_input(name: &str, input: Option<&Value>) -> String {
    let Some(input) = input else { return String::new() };
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    let picked = match name {
        "Bash" => s("command"),
        "Edit" | "MultiEdit" | "Write" | "Read" => s("file_path"),
        "NotebookEdit" => s("notebook_path"),
        "Grep" | "Glob" => s("pattern"),
        "Task" => s("description"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Skill" => s("skill"),
        "TodoWrite" => Some("update the task list"),
        _ => None,
    };
    let text = picked
        .map(str::to_string)
        .or_else(|| {
            ["file_path", "path", "command", "query", "url", "description", "prompt", "pattern"]
                .iter()
                .find_map(|k| s(k))
                .map(str::to_string)
        })
        .unwrap_or_else(|| input.to_string());
    one_line(&text, INPUT_SUMMARY_CHARS)
}

/// Human-readable snippet of a tool_result's content (string, or blocks array).
fn result_snippet(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => truncate_chars(s, RESULT_SNIPPET_CHARS),
        Some(Value::Array(blocks)) => {
            let joined = blocks
                .iter()
                .filter_map(|b| {
                    (b.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| b.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n");
            truncate_chars(&joined, RESULT_SNIPPET_CHARS)
        }
        _ => String::new(),
    }
}

fn entry(kind: &str, text: String, ts: Option<i64>) -> Entry {
    Entry { kind: kind.to_string(), text, tool: None, tool_use_id: None, meta: false, error: false, ts }
}

/// Parse one raw record into display entries (usually 0–3: an assistant record
/// can carry thinking + text + tool calls).
fn entries_from_record(v: &Value, out: &mut Vec<Entry>) {
    if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
        return; // subagent traffic renders in its own transcript, not here
    }
    let ts = ts_ms(v);
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "system" => match v.get("subtype").and_then(Value::as_str) {
            Some("away_summary") => {
                let text = match v.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(c) => result_snippet(Some(c)),
                    None => String::new(),
                };
                if !text.trim().is_empty() {
                    out.push(entry("recap", text, ts));
                }
            }
            Some("compact_boundary") => out.push(entry("compact", "conversation compacted".into(), ts)),
            _ => {}
        },
        "user" | "assistant" => {
            let is_meta_record = v.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
            let content = v.get("message").and_then(|m| m.get("content"));
            match content {
                Some(Value::String(s)) => {
                    if !s.trim().is_empty() {
                        let mut e = entry(kind, s.clone(), ts);
                        e.meta = kind == "user" && (is_meta_record || is_meta_text(s));
                        out.push(e);
                    }
                }
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                let Some(t) = b.get("text").and_then(Value::as_str) else { continue };
                                if t.trim().is_empty() {
                                    continue;
                                }
                                let mut e = entry(kind, t.to_string(), ts);
                                e.meta = kind == "user" && (is_meta_record || is_meta_text(t));
                                out.push(e);
                            }
                            Some("thinking") => {
                                if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                                    if !t.trim().is_empty() {
                                        out.push(entry("thinking", t.to_string(), ts));
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                                let mut e = entry("tool_use", summarize_input(name, b.get("input")), ts);
                                e.tool = Some(name.to_string());
                                e.tool_use_id = b.get("id").and_then(Value::as_str).map(String::from);
                                out.push(e);
                            }
                            Some("tool_result") => {
                                let mut e = entry("tool_result", result_snippet(b.get("content")), ts);
                                e.tool_use_id = b.get("tool_use_id").and_then(Value::as_str).map(String::from);
                                e.error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                                out.push(e);
                            }
                            _ => {} // images, future block types
                        }
                    }
                }
                _ => {}
            }
        }
        _ => {} // attachment, state records, unknown
    }
}

/// Read the transcript from `from_offset`, returning display entries for every
/// complete new line. A file shorter than the offset was rewritten: start over
/// (reset=true). Malformed lines are skipped.
pub fn read_page(path: &Path, from_offset: u64) -> std::io::Result<Page> {
    let size = std::fs::metadata(path)?.len();
    let (start, reset) = if from_offset > size { (0, true) } else { (from_offset, false) };

    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;

    // consume complete lines only; a partial trailing line waits for next call
    let consumed = buf.iter().rposition(|&b| b == b'\n').map(|p| p + 1).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..consumed]);

    let mut entries = Vec::new();
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            entries_from_record(&v, &mut entries);
        }
    }
    Ok(Page { entries, next_offset: start + consumed as u64, reset })
}

/// Aggregate the files this session changed, from its whole transcript.
/// Edit/Write/MultiEdit/NotebookEdit calls count; a call whose tool_result came
/// back is_error is dropped (the change didn't happen). First-touched order.
pub fn files_touched(path: &Path) -> std::io::Result<Vec<FileTouch>> {
    let page = read_page(path, 0)?;
    // tool_use_id → index into pending, so errored results can void their call
    let mut pending: Vec<(String, bool, Option<i64>, bool)> = Vec::new(); // (path, is_write, ts, voided)
    let mut by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for e in &page.entries {
        match e.kind.as_str() {
            "tool_use" => {
                let is_write = match e.tool.as_deref() {
                    Some("Write") => true,
                    Some("Edit") | Some("MultiEdit") | Some("NotebookEdit") => false,
                    _ => continue,
                };
                if e.text.is_empty() {
                    continue; // no usable path in the input
                }
                if let Some(id) = &e.tool_use_id {
                    by_id.insert(id.clone(), pending.len());
                }
                pending.push((e.text.clone(), is_write, e.ts, false));
            }
            "tool_result" if e.error => {
                if let Some(i) = e.tool_use_id.as_ref().and_then(|id| by_id.get(id)) {
                    pending[*i].3 = true;
                }
            }
            _ => {}
        }
    }
    let mut order: Vec<String> = Vec::new();
    let mut agg: std::collections::HashMap<String, FileTouch> = std::collections::HashMap::new();
    for (p, is_write, ts, voided) in pending {
        if voided {
            continue;
        }
        let t = agg.entry(p.clone()).or_insert_with(|| {
            order.push(p.clone());
            FileTouch { path: p.clone(), edits: 0, writes: 0, last_ts: None }
        });
        if is_write {
            t.writes += 1;
        } else {
            t.edits += 1;
        }
        t.last_ts = match (t.last_ts, ts) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    Ok(order.into_iter().filter_map(|p| agg.remove(&p)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name))
    }

    #[test]
    fn reads_structured_entries_in_order() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        assert!(!page.reset);
        let kinds: Vec<&str> = page.entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "user",        // caveat (meta)
                "user",        // real prompt
                "thinking",
                "assistant",
                "tool_use",    // Edit
                "tool_result", // ok
                "tool_use",    // Write
                "tool_use",    // Bash
                "tool_result", // Write ok
                "tool_result", // Bash error
                "assistant",
                "recap",
                "compact",
            ]
        );
    }

    #[test]
    fn meta_and_real_user_text_are_distinguished() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        let users: Vec<&Entry> = page.entries.iter().filter(|e| e.kind == "user").collect();
        assert!(users[0].meta, "caveat block is meta");
        assert!(!users[1].meta);
        assert_eq!(users[1].text, "add error handling to the loader");
    }

    #[test]
    fn tool_use_carries_name_summary_and_id() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        let tools: Vec<&Entry> = page.entries.iter().filter(|e| e.kind == "tool_use").collect();
        assert_eq!(tools[0].tool.as_deref(), Some("Edit"));
        assert_eq!(tools[0].text, "/Users/dev/work/src/loader.ts");
        assert_eq!(tools[0].tool_use_id.as_deref(), Some("t1"));
        assert_eq!(tools[2].tool.as_deref(), Some("Bash"));
        assert_eq!(tools[2].text, "npm test"); // first line of the command only
    }

    #[test]
    fn tool_results_pair_by_id_and_flag_errors() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        let results: Vec<&Entry> = page.entries.iter().filter(|e| e.kind == "tool_result").collect();
        assert_eq!(results[0].tool_use_id.as_deref(), Some("t1"));
        assert!(!results[0].error);
        assert!(results[0].text.contains("updated"));
        let bash = results.iter().find(|r| r.tool_use_id.as_deref() == Some("t3")).unwrap();
        assert!(bash.error);
    }

    #[test]
    fn thinking_recap_and_compact_are_surfaced() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        assert!(page.entries.iter().any(|e| e.kind == "thinking" && e.text.contains("check the loader")));
        assert!(page.entries.iter().any(|e| e.kind == "recap" && e.text.contains("Added error handling")));
        assert!(page.entries.iter().any(|e| e.kind == "compact"));
    }

    #[test]
    fn sidechain_records_are_skipped() {
        let page = read_page(&fixture("session_tools.jsonl"), 0).unwrap();
        assert!(page.entries.iter().all(|e| !e.text.contains("subagent")));
    }

    #[test]
    fn incremental_read_resumes_at_offset_and_detects_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let l1 = r#"{"type":"user","timestamp":"2026-06-01T10:00:00.000Z","message":{"role":"user","content":"first"}}"#;
        let l2 = r#"{"type":"assistant","timestamp":"2026-06-01T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}"#;
        std::fs::write(&p, format!("{l1}\n")).unwrap();
        let page1 = read_page(&p, 0).unwrap();
        assert_eq!(page1.entries.len(), 1);
        assert_eq!(page1.next_offset as usize, l1.len() + 1);

        // nothing new → empty page, same offset
        let idle = read_page(&p, page1.next_offset).unwrap();
        assert!(idle.entries.is_empty());
        assert_eq!(idle.next_offset, page1.next_offset);

        // appended line → only the new entry
        std::fs::write(&p, format!("{l1}\n{l2}\n")).unwrap();
        let page2 = read_page(&p, page1.next_offset).unwrap();
        assert_eq!(page2.entries.len(), 1);
        assert_eq!(page2.entries[0].text, "second");
        assert!(!page2.reset);

        // partial trailing line is left for next time
        std::fs::write(&p, format!("{l1}\n{{\"type\":")).unwrap();
        let partial = read_page(&p, 0).unwrap();
        assert_eq!(partial.entries.len(), 1);
        assert_eq!(partial.next_offset as usize, l1.len() + 1);

        // truncated below the offset → reset, reparsed from zero
        std::fs::write(&p, format!("{l1}\n")).unwrap();
        let reset = read_page(&p, 10_000).unwrap();
        assert!(reset.reset);
        assert_eq!(reset.entries.len(), 1);
    }

    #[test]
    fn files_touched_aggregates_and_skips_errors() {
        let touched = files_touched(&fixture("session_tools.jsonl")).unwrap();
        // Edit loader.ts (ok) + Write loader.test.ts (ok); the errored Bash is
        // not a file tool and the errored result voids nothing else here.
        assert_eq!(touched.len(), 2);
        assert_eq!(touched[0].path, "/Users/dev/work/src/loader.ts");
        assert_eq!((touched[0].edits, touched[0].writes), (1, 0));
        assert_eq!(touched[1].path, "/Users/dev/work/src/loader.test.ts");
        assert_eq!((touched[1].edits, touched[1].writes), (0, 1));
        assert!(touched[0].last_ts.is_some());
    }

    #[test]
    fn files_touched_voids_errored_edits() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let lines = [
            r#"{"type":"assistant","timestamp":"2026-06-01T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/p/a.rs"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"e1","is_error":true,"content":"String to replace not found"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-06-01T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"e2","name":"Edit","input":{"file_path":"/p/a.rs"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"e2","content":"ok"}]}}"#,
        ];
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let touched = files_touched(&p).unwrap();
        assert_eq!(touched.len(), 1);
        assert_eq!(touched[0].edits, 1, "the errored edit must not count");
    }

    #[test]
    fn summarize_input_covers_known_and_unknown_tools() {
        use serde_json::json;
        let cases = [
            ("Bash", json!({"command": "ls -la\nsecond line ignored"}), "ls -la"),
            ("Write", json!({"file_path": "/a/b.ts", "content": "..."}), "/a/b.ts"),
            ("Grep", json!({"pattern": "fn main"}), "fn main"),
            ("WebSearch", json!({"query": "tauri tray"}), "tauri tray"),
        ];
        for (name, input, want) in cases {
            assert_eq!(summarize_input(name, Some(&input)), want);
        }
        // unknown tool falls back to a conventional key, else compact JSON
        assert_eq!(
            summarize_input("mcp__x__y", Some(&serde_json::json!({"path": "/z"}))),
            "/z"
        );
        let generic = summarize_input("mcp__x__y", Some(&serde_json::json!({"weird": 1})));
        assert!(generic.contains("weird"));
        assert_eq!(summarize_input("Bash", None), "");
    }

    #[test]
    fn long_results_and_inputs_are_truncated() {
        use serde_json::json;
        let long = "x".repeat(5000);
        let snip = result_snippet(Some(&json!(long)));
        assert!(snip.chars().count() <= RESULT_SNIPPET_CHARS + 1);
        assert!(snip.ends_with('…'));
        let cmd = format!("echo {}", "y".repeat(5000));
        let sum = summarize_input("Bash", Some(&json!({ "command": cmd })));
        assert!(sum.chars().count() <= INPUT_SUMMARY_CHARS + 1);
    }
}
