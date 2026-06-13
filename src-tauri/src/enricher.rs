use drydock_core::store::Store;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Debug, PartialEq, serde::Deserialize)]
pub struct CardJson {
    pub goal: String,
    pub state: String,
    pub next_step: String,
}

/// Pull the {goal,state,next_step} object out of model output that may be
/// fenced, prefixed, or wrapped in prose: take the first '{'..last '}' span.
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
        "You summarize a Claude Code session so its owner can resume instantly.\n\
         Session title: {title}\n\
         Latest recap: {}\n\
         Transcript tail (role-tagged):\n{tail}\n\n\
         Reply with ONLY strict JSON: {{\"goal\":\"...\",\"state\":\"...\",\"next_step\":\"...\"}} \
         — each value at most 2 short sentences, in the language the user typed in.",
        recap.unwrap_or("(none)")
    )
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
        .take(30)
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

    let mut store = Store::open(db_path).map_err(|e| e.to_string())?;
    store
        .put_card(session_id, &card.goal, &card.state, &card.next_step, row.message_count)
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
    loop {
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
    pub goal: String,
    pub state: String,
    pub next_step: String,
    pub generated_at: i64,
}

#[tauri::command]
pub fn get_card(db: tauri::State<'_, crate::index::AppDb>, session_id: String) -> Result<Option<CardView>, String> {
    let store = db.0.lock().unwrap();
    Ok(store.get_card(&session_id).map_err(|e| e.to_string())?.map(|c| CardView {
        goal: c.goal,
        state: c.state,
        next_step: c.next_step,
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
        let plain = r#"{"goal":"g","state":"s","next_step":"n"}"#;
        let fenced = "```json\n{\"goal\":\"g\",\"state\":\"s\",\"next_step\":\"n\"}\n```";
        let wrapped = "Here you go: {\"goal\":\"g\",\"state\":\"s\",\"next_step\":\"n\"} hope that helps";
        for t in [plain, fenced, wrapped] {
            let c = extract_card_json(t).unwrap();
            assert_eq!((c.goal.as_str(), c.state.as_str(), c.next_step.as_str()), ("g", "s", "n"));
        }
        assert!(extract_card_json("no json here").is_none());
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
