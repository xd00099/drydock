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
    /// Sidebar title. From the threads DB: the user's rename, else codex's
    /// own AI-curated thread name, else the raw first prompt (clipped). From
    /// a rollout scan: the first real user prompt (preambles skipped).
    pub title: Option<String>,
    /// One-line description under the title: the first user prompt, filled
    /// only when the title is a CURATED name (otherwise it would repeat it).
    pub recap: Option<String>,
    /// Last-activity ms — file mtime (rollout tier) or recency/updated from
    /// the threads DB. Recent ⇒ the session is (or just was) active.
    pub mtime_ms: i64,
    /// The rollout file, when one exists. Paginated threads (codex ≥ ~0.147)
    /// live only in codex's own sqlite and have no file — Drydock never
    /// writes vendor stores, so those can be hidden but not deleted.
    pub path: Option<PathBuf>,
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
    Some(CodexSession { session_id, cwd, title, recap: None, mtime_ms, path: Some(path.to_path_buf()) })
}

/// Collapse whitespace and clip to the sidebar-title budget. The threads DB's
/// `title` is the raw first prompt for un-named threads — one real row was a
/// 36 KB dev-server log, so clipping here is a correctness matter, not taste.
fn clean_title(s: &str) -> Option<String> {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        return None;
    }
    Some(joined.chars().take(120).collect())
}

/// Primary discovery tier for codex ≥ ~0.147: the `threads` table in
/// `<codex>/state_<N>.sqlite` (highest N wins). That version moved session
/// state into sqlite — `sessions/` empties out, rollouts land in
/// `archived_sessions/`, and new "paginated" threads have NO rollout file at
/// all — so a filesystem scan alone goes blind. Read-only; any schema
/// surprise (a future state_N+1) returns None and the caller falls back to
/// the rollout scan. Subagent threads are codex's own internal helpers, not
/// user sessions — filtered.
pub fn scan_threads_db(codex_dir: &Path) -> Option<Vec<CodexSession>> {
    let mut best: Option<(u32, PathBuf)> = None;
    for f in std::fs::read_dir(codex_dir).ok()?.flatten() {
        let name = f.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(n) = name
            .strip_prefix("state_")
            .and_then(|r| r.strip_suffix(".sqlite"))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if best.as_ref().map_or(true, |(b, _)| n > *b) {
            best = Some((n, f.path()));
        }
    }
    let (_, db) = best?;
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, title, first_user_message, cwd, rollout_path,
                    COALESCE(recency_at_ms, updated_at_ms, created_at_ms, 0),
                    thread_source, history_mode
             FROM threads",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })
        .ok()?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, name, title, first_msg, cwd, rollout_path, recency, source, history_mode) = row;
        if !matches!(source.as_deref(), None | Some("") | Some("user")) {
            continue; // subagent threads
        }
        let named = name.as_deref().map(str::trim).is_some_and(|n| !n.is_empty());
        let curated_title = title.as_deref().unwrap_or("");
        let first = first_msg.as_deref().unwrap_or("");
        // curated = codex generated a short name distinct from the raw prompt
        let curated = named || (!curated_title.is_empty() && curated_title != first);
        let shown = if named { name.as_deref().unwrap_or("") } else { curated_title };
        // Paginated threads carry a STALE rollout_path to a file codex never
        // wrote (verified on a real 0.147 install) — their transcript lives
        // only in codex's sqlite, so they get no path: delete declines, hide
        // is the offer. For file-backed threads, a missing file is a husk
        // codex can no longer replay — and exactly what "Delete permanently"
        // just did: skipping it is what makes the delete stick.
        let paginated = history_mode.as_deref() == Some("paginated");
        let mut path = if paginated {
            None
        } else {
            rollout_path.filter(|p| !p.is_empty()).map(PathBuf::from)
        };
        if !paginated {
            match path.as_deref() {
                Some(p) if p.exists() => {}
                // codex's compression worker zstd-compresses rollouts older
                // than ~7 days IN PLACE (<file>.jsonl → .jsonl.zst) — the
                // thread is alive, there's just no plain file left to delete
                Some(p) if p.with_extension("jsonl.zst").exists() => path = None,
                _ => continue,
            }
        }
        out.push(CodexSession {
            session_id: id,
            cwd: cwd.unwrap_or_default(),
            title: clean_title(shown).or_else(|| clean_title(first)),
            recap: if curated { clean_title(first) } else { None },
            mtime_ms: recency,
            path,
        });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.mtime_ms));
    Some(out)
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

    /// A state_5-shaped fixture with every row shape found in a real
    /// ~/.codex: curated title, raw-prompt title (huge), user rename,
    /// subagent, paginated (no rollout file), and a deleted-file husk.
    fn write_threads_db(dir: &Path, rows: &[(&str, Option<&str>, &str, &str, Option<&str>, i64, Option<&str>, Option<&str>)]) {
        let conn = rusqlite::Connection::open(dir.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT,
                cwd TEXT, rollout_path TEXT, recency_at_ms INTEGER,
                updated_at_ms INTEGER, created_at_ms INTEGER, thread_source TEXT,
                history_mode TEXT
            )",
        )
        .unwrap();
        for (id, name, title, first, path, recency, source, mode) in rows {
            conn.execute(
                "INSERT INTO threads (id, name, title, first_user_message, cwd, rollout_path, recency_at_ms, thread_source, history_mode)
                 VALUES (?1, ?2, ?3, ?4, '/p/proj', ?5, ?6, ?7, ?8)",
                rusqlite::params![id, name, title, first, path, recency, source, mode],
            )
            .unwrap();
        }
    }

    #[test]
    fn threads_db_supplies_titles_recaps_and_filters() {
        let tmp = tempfile::tempdir().unwrap();
        let rollout = write_rollout(
            &tmp.path().join("archived_sessions"),
            "rollout-2026-07-17T14-28-12-aaa.jsonl",
            &[META],
        );
        let rollout_str = rollout.to_str().unwrap();
        // the DB records the plain .jsonl path; only the .zst exists on disk
        let zst_plain = tmp.path().join("archived_sessions/rollout-2026-06-01T00-00-00-fff.jsonl");
        std::fs::write(zst_plain.with_extension("jsonl.zst"), b"zstd").unwrap();
        let huge = "x".repeat(40_000);
        write_threads_db(
            tmp.path(),
            &[
                // curated: codex named it, first prompt becomes the recap
                ("aaa", None, "Add stereo duplication tool", "please duplicate my left channel", Some(rollout_str), 300, Some("user"), Some("legacy")),
                // paginated: rollout_path is STALE (codex 0.147 never writes
                // the file) — must SURVIVE, path None; huge raw title clipped
                ("bbb", None, huge.as_str(), huge.as_str(), Some("/nonexistent/stale.jsonl"), 200, None, Some("paginated")),
                // user rename wins over the curated title
                ("ccc", Some("my audio thing"), "Old name", "first words", None, 400, Some("user"), Some("paginated")),
                // subagent threads are codex-internal — filtered
                ("ddd", None, "guardian dump", "x", None, 999, Some("subagent"), Some("legacy")),
                // file-backed but the file is gone (deleted) — filtered
                ("eee", None, "husk", "x", Some("/nonexistent/r.jsonl"), 500, None, Some("legacy")),
                // zstd-compressed by codex's worker: .jsonl gone, .jsonl.zst
                // present — alive, but nothing plain left to delete
                ("fff", None, "compressed one", "old prompt", Some(zst_plain.to_str().unwrap()), 100, None, Some("legacy")),
            ],
        );
        let out = scan_threads_db(tmp.path()).unwrap();
        let ids: Vec<&str> = out.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["ccc", "aaa", "bbb", "fff"], "recency order, subagent + husk dropped");
        assert_eq!(out[3].path, None, "compressed rollout: alive but not deletable");

        let aaa = &out[1];
        assert_eq!(aaa.title.as_deref(), Some("Add stereo duplication tool"));
        assert_eq!(aaa.recap.as_deref(), Some("please duplicate my left channel"));
        assert_eq!(aaa.path.as_deref(), Some(rollout.as_path()));

        let bbb = &out[2];
        assert_eq!(bbb.title.as_ref().unwrap().chars().count(), 120, "raw-prompt titles are clipped");
        assert_eq!(bbb.recap, None, "recap would just repeat an un-curated title");
        assert_eq!(bbb.path, None);

        let ccc = &out[0];
        assert_eq!(ccc.title.as_deref(), Some("my audio thing"));
        assert_eq!(ccc.recap.as_deref(), Some("first words"));
    }

    #[test]
    fn no_state_db_means_fallback_to_the_rollout_scan() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_threads_db(tmp.path()).is_none());
        // an unreadable/garbage state file also falls back rather than erroring
        std::fs::write(tmp.path().join("state_7.sqlite"), "not a database").unwrap();
        assert!(scan_threads_db(tmp.path()).is_none());
    }
}
