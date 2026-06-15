use drydock_core::store::Store;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

/// One milestone in a session timeline. `detail` holds optional sub-bullets;
/// `in_progress` marks the item the session is currently working on (the last).
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TimelineItem {
    pub text: String,
    #[serde(default)]
    pub detail: Vec<String>,
    #[serde(default)]
    pub in_progress: bool,
}

#[derive(Debug, PartialEq, serde::Deserialize)]
pub struct CardJson {
    /// ~5-word description of the session, used as its display title.
    pub summary: String,
    #[serde(default)]
    pub timeline: Vec<TimelineItem>,
}

/// Pull the {summary,timeline} object out of model output that may be fenced,
/// prefixed, or wrapped in prose: take the first '{'..last '}' span.
pub fn extract_card_json(text: &str) -> Option<CardJson> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

/// Last `max_chars` characters of `s`, on a char boundary.
fn tail_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().rev().nth(max_chars.saturating_sub(1)) {
        Some((i, _)) => &s[i..],
        None => s,
    }
}

fn build_prompt(title: &str, recap: Option<&str>, tail: &str) -> String {
    format!(
        "You summarize a Claude Code session so its owner can tell at a glance what it was and resume instantly.\n\
         Session title: {title}\n\
         Latest recap: {}\n\
         Transcript tail (role-tagged):\n{tail}\n\n\
         Reply with ONLY strict JSON in this exact shape:\n\
         {{\"summary\":\"...\",\"timeline\":[{{\"text\":\"...\",\"detail\":[\"...\"],\"in_progress\":false}}]}}\n\
         Rules:\n\
         - \"summary\": a 3-6 word noun phrase naming what this session is about (e.g. \"telemetry via utils library\"). No verbs like \"helping with\", no punctuation.\n\
         - \"timeline\": chronological milestones of what happened, earliest first. Each item's \"text\" is one short clause. Use \"detail\" (omit if empty) for a few sub-points under a milestone. Set \"in_progress\":true on the single last item if work is still ongoing; otherwise omit it.\n\
         - Keep it tight: at most ~6 timeline items. Write in the language the user typed in.",
        recap.unwrap_or("(none)")
    )
}

/// The searchable payload indexed for a card: summary + every timeline clause
/// and its details, newline-joined. Keyword + semantic search index this text.
fn card_search_text(summary: &str, timeline: &[TimelineItem]) -> String {
    let mut parts = vec![summary.to_string()];
    for it in timeline {
        parts.push(it.text.clone());
        parts.extend(it.detail.iter().cloned());
    }
    parts.join("\n")
}

/// One-time: index a `card` search chunk for any card generated before card
/// search existed, so old sessions become searchable without waiting for regen.
fn backfill_card_search_chunks(store: &mut Store) {
    for sid in store.cards_without_search_chunk().unwrap_or_default() {
        if let Ok(Some(card)) = store.get_card(&sid) {
            let timeline: Vec<TimelineItem> = serde_json::from_str(&card.timeline).unwrap_or_default();
            let _ = store.put_card_search_chunk(&sid, &card_search_text(&card.summary, &timeline));
        }
    }
}

/// Wrap a string in single quotes for safe `sh -c` interpolation, escaping any
/// embedded single quotes (`'\''`). Works in sh/bash/zsh.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One generation attempt. Runs claude via a login shell (GUI apps lack PATH).
pub fn generate_card(db_path: &Path, session_id: &str) -> Result<(), String> {
    let store = Store::open(db_path).map_err(|e| e.to_string())?;
    let row = store
        .get_session(session_id)
        .map_err(|e| e.to_string())?
        .ok_or("session gone")?;
    let chunks = store.get_chunks(session_id).map_err(|e| e.to_string())?;
    drop(store);

    let joined: String = chunks
        .iter()
        .rev()
        .take(40)
        .rev()
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = build_prompt(&row.title, row.latest_recap.as_deref(), tail_chars(&joined, 24_000));

    // Settings live next to the db (app data dir); reloaded each call so edits
    // to card_model / claude_env take effect without restarting Drydock.
    let cfg = crate::settings::Settings::load(db_path.parent().unwrap_or_else(|| Path::new(".")));
    let model_arg = match cfg.card_model.as_deref() {
        Some(m) if !m.is_empty() => format!("--model {} ", sh_single_quote(m)),
        _ => String::new(), // null/empty → the CLI's own default model
    };
    let cmd_str = format!("claude -p {model_arg}--output-format json --no-session-persistence");

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = Command::new(shell);
    command.args(["-l", "-c", &cmd_str]);
    for (k, v) in cfg.env_pairs() {
        command.env(k, v); // ANTHROPIC_BASE_URL etc. for custom endpoints
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or("no stdin")?
        .write_all(prompt.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("claude -p failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    // -p --output-format json → {"result": "<text>", ...}
    let envelope: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let result_text = envelope.get("result").and_then(|v| v.as_str()).ok_or("no result field")?;
    let card = extract_card_json(result_text).ok_or("result not card JSON")?;
    let timeline_json = serde_json::to_string(&card.timeline).map_err(|e| e.to_string())?;
    let search_text = card_search_text(&card.summary, &card.timeline);

    let mut store = Store::open(db_path).map_err(|e| e.to_string())?;
    store
        .put_card(session_id, &card.summary, &timeline_json, &search_text, row.message_count)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Per-session failure bookkeeping: (attempts so far, earliest next retry).
type Failures = std::collections::HashMap<String, (u32, std::time::Instant)>;

/// First candidate whose backoff (if any) has elapsed.
fn pick_candidate<'a>(candidates: &'a [String], failures: &Failures, now: std::time::Instant) -> Option<&'a String> {
    candidates
        .iter()
        .find(|sid| failures.get(*sid).is_none_or(|(_, retry_at)| *retry_at <= now))
}

/// Record a failed attempt: next retry in 60s * 2^attempts, capped at 1 hour.
fn note_failure(failures: &mut Failures, session_id: &str, now: std::time::Instant) {
    let attempts = failures.get(session_id).map_or(0, |(a, _)| *a) + 1;
    let delay_secs = 60u64.saturating_mul(1 << attempts.min(10)).min(3600);
    failures.insert(session_id.to_string(), (attempts, now + std::time::Duration::from_secs(delay_secs)));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Background loop: at most one card per minute, priority from the store query.
/// Failing sessions back off exponentially instead of retrying every cycle.
pub fn run(app: AppHandle, db_path: PathBuf) {
    let mut failures: Failures = Failures::new();
    let mut backfilled = false;
    loop {
        // Index search chunks for cards predating card-search (retries next cycle
        // if the DB was locked by the initial sync on the first attempt).
        if !backfilled {
            if let Ok(mut store) = Store::open(&db_path) {
                backfill_card_search_chunks(&mut store);
                backfilled = true;
            }
        }
        let candidates = Store::open(&db_path)
            .ok()
            .and_then(|s| s.sessions_needing_cards(10, now_ms()).ok())
            .unwrap_or_default();
        if let Some(sid) = pick_candidate(&candidates, &failures, std::time::Instant::now()).cloned() {
            match generate_card(&db_path, &sid) {
                Ok(()) => {
                    failures.remove(&sid);
                    let _ = app.emit("index-updated", ());
                }
                Err(e) => {
                    eprintln!("card generation failed for {sid}: {e}");
                    note_failure(&mut failures, &sid, std::time::Instant::now());
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[derive(serde::Serialize)]
pub struct CardView {
    pub summary: String,
    pub timeline: Vec<TimelineItem>,
    pub generated_at: i64,
}

#[tauri::command]
pub fn get_card(db: tauri::State<'_, crate::index::AppDb>, session_id: String) -> Result<Option<CardView>, String> {
    let store = db.0.lock().unwrap();
    Ok(store.get_card(&session_id).map_err(|e| e.to_string())?.map(|c| CardView {
        summary: c.summary,
        // stored timeline is app-owned JSON; tolerate anything unparseable
        timeline: serde_json::from_str(&c.timeline).unwrap_or_default(),
        generated_at: c.generated_at,
    }))
}

#[tauri::command]
pub fn refresh_card(app: AppHandle, session_id: String) -> Result<(), String> {
    use tauri::Manager;
    let db = app.path().app_data_dir().map_err(|e| e.to_string())?.join("drydock.db");
    std::thread::spawn(move || match generate_card(&db, &session_id) {
        Ok(()) => {
            let _ = app.emit("index-updated", ());
        }
        Err(e) => eprintln!("refresh_card failed for {session_id}: {e}"),
    });
    Ok(())
}

/// Version string if the claude CLI resolves in a login shell, else None.
#[tauri::command]
pub fn check_claude() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-l", "-c", "claude --version"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_fenced_and_wrapped_json() {
        let body = r#"{"summary":"fix telemetry","timeline":[{"text":"a","detail":["x","y"]},{"text":"b","in_progress":true}]}"#;
        let plain = body.to_string();
        let fenced = format!("```json\n{body}\n```");
        let wrapped = format!("Here you go: {body} hope that helps");
        for t in [plain, fenced, wrapped] {
            let c = extract_card_json(&t).unwrap();
            assert_eq!(c.summary, "fix telemetry");
            assert_eq!(c.timeline.len(), 2);
            assert_eq!(c.timeline[0].detail, vec!["x".to_string(), "y".to_string()]);
            assert!(!c.timeline[0].in_progress);
            assert!(c.timeline[1].in_progress);
            assert!(c.timeline[1].detail.is_empty());
        }
        assert!(extract_card_json("no json here").is_none());
    }

    #[test]
    fn card_search_text_joins_summary_and_timeline() {
        let timeline = vec![
            TimelineItem { text: "set up indexer".into(), detail: vec!["sqlite".into(), "fts5".into()], in_progress: false },
            TimelineItem { text: "wire search".into(), detail: vec![], in_progress: true },
        ];
        let t = card_search_text("telemetry pipeline", &timeline);
        assert_eq!(t, "telemetry pipeline\nset up indexer\nsqlite\nfts5\nwire search");
    }

    #[test]
    fn card_json_tolerates_missing_timeline() {
        let c = extract_card_json(r#"{"summary":"just a summary"}"#).unwrap();
        assert_eq!(c.summary, "just a summary");
        assert!(c.timeline.is_empty());
    }

    #[test]
    fn tail_chars_respects_boundaries() {
        assert_eq!(tail_chars("hello", 3), "llo");
        assert_eq!(tail_chars("你好世界", 2), "世界");
        assert_eq!(tail_chars("ab", 10), "ab");
    }

    #[test]
    fn sh_single_quote_escapes_embedded_quotes() {
        assert_eq!(sh_single_quote("sonnet"), "'sonnet'");
        assert_eq!(sh_single_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn pick_skips_sessions_in_backoff() {
        use std::time::{Duration, Instant};
        let candidates: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        let now = Instant::now();
        let mut failures = Failures::new();
        assert_eq!(pick_candidate(&candidates, &failures, now), Some(&candidates[0]));

        failures.insert("a".into(), (1, now + Duration::from_secs(120)));
        assert_eq!(pick_candidate(&candidates, &failures, now), Some(&candidates[1]));

        // backoff elapsed → eligible again
        assert_eq!(pick_candidate(&candidates, &failures, now + Duration::from_secs(120)), Some(&candidates[0]));

        failures.insert("b".into(), (1, now + Duration::from_secs(60)));
        failures.insert("c".into(), (2, now + Duration::from_secs(240)));
        assert_eq!(pick_candidate(&candidates, &failures, now), None);
    }

    #[test]
    fn failure_backoff_doubles_and_caps_at_one_hour() {
        use std::time::{Duration, Instant};
        let now = Instant::now();
        let mut failures = Failures::new();
        note_failure(&mut failures, "a", now);
        assert_eq!(failures["a"], (1, now + Duration::from_secs(120)));
        note_failure(&mut failures, "a", now);
        assert_eq!(failures["a"], (2, now + Duration::from_secs(240)));
        for _ in 0..10 {
            note_failure(&mut failures, "a", now);
        }
        assert_eq!(failures["a"].1, now + Duration::from_secs(3600));
    }
}
