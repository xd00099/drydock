//! Codex CLI session discovery — the second agent Drydock indexes.
//!
//! Codex writes one "rollout" JSONL per session at
//! `<codex_dir>/sessions/YYYY/MM/DD/rollout-<ISO ts>-<uuid>.jsonl`.
//! Line 1 is `{"type":"session_meta","payload":{id, cwd, ...}}`; later lines
//! are `response_item` (messages/tool calls), `event_msg`, `turn_context`.
//! Codex appends to the SAME file on resume, so mtime is a live-activity
//! signal. A background worker zstd-compresses rollouts older than ~7 days to
//! `.jsonl.zst` — those are SKIPPED here (deliberate: recent sessions are what
//! the sidebar needs, and a decompression dependency isn't worth the tail yet).
//!
//! This module only DISCOVERS sessions (id, cwd, title, mtime). Transcript
//! indexing/search for codex is a later stage; nothing here touches the store.

use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct CodexSession {
    pub session_id: String,
    pub cwd: String,
    /// First real user prompt (injected AGENTS.md / IDE-context / environment
    /// preambles skipped), clipped — the sidebar title.
    pub title: Option<String>,
    /// File mtime in ms — codex appends during a turn, so a recent mtime
    /// means the session is (or just was) active.
    pub mtime_ms: i64,
    pub path: PathBuf,
}

/// $CODEX_HOME override honored, matching the CLI's own resolution.
pub fn codex_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(home));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex"))
}

/// The injected preambles codex records as "user" messages. The first user
/// text NOT matching these is the prompt the human actually typed.
fn is_boilerplate(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('<') // <environment_context>, <permissions instructions>, …
        || t.starts_with("# AGENTS.md")
        || t.starts_with("# Context from my IDE")
}

/// Parse one rollout: session_meta from line 1, then scan (bounded) for the
/// first real user prompt. Returns None when line 1 isn't a session_meta —
/// not a rollout we understand.
pub fn parse_rollout(path: &Path, mtime_ms: i64) -> Option<CodexSession> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut lines = BufReader::new(file).lines();
    let first = lines.next()?.ok()?;
    let meta: Value = serde_json::from_str(&first).ok()?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = meta.get("payload")?;
    let session_id = payload.get("id").and_then(Value::as_str)?.to_string();
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();

    // Bounded scan: preamble user messages arrive before the first prompt,
    // but tool-heavy turns can push it down — 80 lines covers what we've seen
    // with margin, and a title-less row still renders (falls back to the id).
    let mut title = None;
    for line in lines.take(80).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(Value::as_str) != Some("message")
            || p.get("role").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        let text = p
            .get("content")
            .and_then(Value::as_array)
            .and_then(|c| c.iter().find(|x| x.get("type").and_then(Value::as_str) == Some("input_text")))
            .and_then(|x| x.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !text.is_empty() && !is_boilerplate(text) {
            let clipped: String = text.chars().take(120).collect();
            title = Some(clipped.split_whitespace().collect::<Vec<_>>().join(" "));
            break;
        }
    }
    Some(CodexSession { session_id, cwd, title, mtime_ms, path: path.to_path_buf() })
}

/// Walk `<codex_dir>/sessions/YYYY/MM/DD/*.jsonl`. `cache` carries parses
/// across polls keyed by (path, mtime) — only new/appended files re-read, so
/// the steady-state poll is a directory walk plus zero file reads.
pub fn scan_sessions(
    codex_dir: &Path,
    cache: &mut std::collections::HashMap<PathBuf, (i64, Option<CodexSession>)>,
) -> Vec<CodexSession> {
    let root = codex_dir.join("sessions");
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut out = Vec::new();
    let years = match std::fs::read_dir(&root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for y in years.flatten() {
        let Ok(months) = std::fs::read_dir(y.path()) else { continue };
        for m in months.flatten() {
            let Ok(days) = std::fs::read_dir(m.path()) else { continue };
            for d in days.flatten() {
                let Ok(files) = std::fs::read_dir(d.path()) else { continue };
                for f in files.flatten() {
                    let path = f.path();
                    if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                        continue; // .jsonl.zst ends in "zst" — skipped here
                    }
                    let Ok(md) = f.metadata() else { continue };
                    let mtime_ms = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    seen.insert(path.clone());
                    let hit = cache.get(&path).filter(|(m, _)| *m == mtime_ms);
                    let parsed = match hit {
                        Some((_, s)) => s.clone(),
                        None => {
                            let s = parse_rollout(&path, mtime_ms);
                            cache.insert(path.clone(), (mtime_ms, s.clone()));
                            s
                        }
                    };
                    if let Some(mut s) = parsed {
                        s.mtime_ms = mtime_ms; // cache hit keeps parse, mtime stays fresh
                        out.push(s);
                    }
                }
            }
        }
    }
    cache.retain(|p, _| seen.contains(p)); // deleted/archived rollouts drop out
    out.sort_by_key(|s| std::cmp::Reverse(s.mtime_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_rollout(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    const META: &str = r#"{"timestamp":"2026-08-14T10:00:00Z","type":"session_meta","payload":{"id":"0199-aaaa","timestamp":"2026-08-14T10:00:00Z","cwd":"/p/proj","originator":"codex_cli_rs","cli_version":"0.147.0","source":"cli"}}"#;

    fn user_msg(text: &str) -> String {
        format!(
            r#"{{"timestamp":"t","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn parses_meta_and_skips_injected_preambles_for_the_title() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_rollout(
            tmp.path(),
            "r.jsonl",
            &[
                META,
                r#"{"type":"turn_context","payload":{}}"#,
                &user_msg("# AGENTS.md instructions for /p/proj\nstuff"),
                &user_msg("<environment_context>\n  <cwd>/p/proj</cwd>"),
                &user_msg("# Context from my IDE setup:\n## Open tabs"),
                &user_msg("fix the flaky login test"),
            ],
        );
        let s = parse_rollout(&p, 42).unwrap();
        assert_eq!(s.session_id, "0199-aaaa");
        assert_eq!(s.cwd, "/p/proj");
        assert_eq!(s.title.as_deref(), Some("fix the flaky login test"));
        assert_eq!(s.mtime_ms, 42);
    }

    #[test]
    fn no_real_prompt_yet_yields_no_title_not_no_session() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_rollout(tmp.path(), "r.jsonl", &[META, &user_msg("<environment_context>")]);
        let s = parse_rollout(&p, 1).unwrap();
        assert_eq!(s.title, None);
    }

    #[test]
    fn non_rollout_and_garbage_files_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_rollout(tmp.path(), "r.jsonl", &[r#"{"type":"other"}"#]);
        assert!(parse_rollout(&p, 1).is_none());
        let g = write_rollout(tmp.path(), "g.jsonl", &["not json at all"]);
        assert!(parse_rollout(&g, 1).is_none());
    }

    #[test]
    fn scan_walks_date_tree_caches_by_mtime_and_drops_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let day = tmp.path().join("sessions/2026/08/14");
        let p = write_rollout(&day, "rollout-2026-08-14T10-00-00-0199-aaaa.jsonl", &[META, &user_msg("hello codex")]);
        write_rollout(&day, "skipme.jsonl.zst", &["binary"]); // wrong extension → skipped
        let mut cache = std::collections::HashMap::new();
        let out = scan_sessions(tmp.path(), &mut cache);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title.as_deref(), Some("hello codex"));
        assert_eq!(cache.len(), 1);

        // unchanged mtime → served from cache even if the file went unreadable
        let out2 = scan_sessions(tmp.path(), &mut cache);
        assert_eq!(out2, out);

        std::fs::remove_file(&p).unwrap();
        let out3 = scan_sessions(tmp.path(), &mut cache);
        assert!(out3.is_empty());
        assert!(cache.is_empty(), "deleted rollouts must not pin cache entries");
    }
}
