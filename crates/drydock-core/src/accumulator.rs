use crate::records::ParsedRecord;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionDelta {
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub latest_recap: Option<String>,
    pub ai_title: Option<String>,
    pub slug: Option<String>,
    pub last_message_at: Option<i64>,
    pub message_count: i64,
    pub user_message_count: i64,
    pub git_branch: Option<String>,
    pub cli_version: Option<String>,
}

/// True for text a human actually typed (not caveat/command meta blocks).
fn is_real_prompt(text: &str) -> bool {
    !text.trim_start().starts_with('<')
}

pub fn accumulate(records: &[ParsedRecord]) -> SessionDelta {
    let mut d = SessionDelta::default();
    for r in records {
        match r {
            ParsedRecord::Chain(c) => {
                if c.is_sidechain {
                    continue; // spec §6.9: subagent records skipped
                }
                d.session_id = d.session_id.or_else(|| c.session_id.clone());
                // First cwd wins: Claude Code files the transcript under the
                // project of the directory the session STARTED in, and
                // `claude --resume` only finds it when launched from there.
                // A session whose cwd changes mid-stream must still resume
                // (and group) by its root, not the latest cwd.
                if d.project_path.is_none() {
                    if let Some(cwd) = &c.cwd { d.project_path = Some(cwd.clone()); }
                }
                if let Some(b) = &c.git_branch { d.git_branch = Some(b.clone()); }
                if let Some(v) = &c.version { d.cli_version = Some(v.clone()); }
                if let Some(s) = &c.slug { d.slug = Some(s.clone()); }
                if let Some(ts) = c.timestamp_ms {
                    d.last_message_at = Some(d.last_message_at.map_or(ts, |m| m.max(ts)));
                }
                match c.kind.as_str() {
                    "user" | "assistant" => {
                        d.message_count += 1;
                        if c.kind == "user" && !c.is_meta && !c.is_tool_result_only {
                            if let Some(t) = &c.text {
                                if is_real_prompt(t) {
                                    d.user_message_count += 1;
                                    if d.first_prompt.is_none() {
                                        d.first_prompt = Some(t.clone());
                                    }
                                    d.last_prompt = Some(t.clone());
                                }
                            }
                        }
                    }
                    "system"
                        if c.subtype.as_deref() == Some("away_summary") => {
                            if let Some(t) = &c.text { d.latest_recap = Some(t.clone()); }
                        }
                    _ => {}
                }
            }
            ParsedRecord::State(s) => {
                d.session_id = d.session_id.or_else(|| s.session_id.clone());
                if let Some(t) = &s.ai_title { d.ai_title = Some(t.clone()); }
                if let Some(p) = &s.last_prompt { d.last_prompt = Some(p.clone()); }
            }
            ParsedRecord::Unknown { .. } | ParsedRecord::Malformed => {}
        }
    }
    d
}

fn truncate80(s: &str) -> String {
    s.chars().take(80).collect()
}

/// Spec §6.6 title priority: ai-title > newest recap > slug > first prompt > session-id prefix.
pub fn resolve_title(d: &SessionDelta, session_id: &str) -> (String, &'static str) {
    if let Some(t) = d.ai_title.as_deref().filter(|s| !s.trim().is_empty()) {
        return (truncate80(t), "ai-title");
    }
    if let Some(t) = d.latest_recap.as_deref().filter(|s| !s.trim().is_empty()) {
        return (truncate80(t), "recap");
    }
    if let Some(t) = d.slug.as_deref().filter(|s| !s.trim().is_empty()) {
        return (truncate80(t), "slug");
    }
    if let Some(t) = d.first_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        return (truncate80(t), "first-prompt");
    }
    (session_id.chars().take(8).collect(), "session-id")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_line;

    fn records(name: &str) -> Vec<crate::records::ParsedRecord> {
        let p = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
        std::fs::read_to_string(p).unwrap().lines().map(parse_line).collect()
    }

    #[test]
    fn basic_session_delta() {
        let d = accumulate(&records("session_basic.jsonl"));
        assert_eq!(d.session_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
        assert_eq!(d.project_path.as_deref(), Some("/Users/dev/work"));
        // caveat line skipped: first_prompt is the real prompt
        assert_eq!(d.first_prompt.as_deref(), Some("fix the build script"));
        assert_eq!(d.last_prompt.as_deref(), Some("fix the build script"));
        assert_eq!(d.ai_title.as_deref(), Some("Build script fix"));
        assert_eq!(d.user_message_count, 1); // meta + tool_result-only don't count
        assert_eq!(d.message_count, 4);      // 3 user + 1 assistant chain records
        assert_eq!(d.last_message_at, Some(1780308060000)); // last timestamped record
        assert_eq!(d.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn first_cwd_wins_when_cwd_changes_midsession() {
        use serde_json::json;
        let lines = [
            json!({"type":"user","sessionId":"s","uuid":"u1","timestamp":"2026-06-09T00:00:00.000Z","cwd":"/Users/dev/work","message":{"role":"user","content":"start here"}}),
            json!({"type":"assistant","sessionId":"s","uuid":"u2","timestamp":"2026-06-09T00:01:00.000Z","cwd":"/Users/dev/work/app","message":{"role":"assistant","content":"ok"}}),
            json!({"type":"user","sessionId":"s","uuid":"u3","timestamp":"2026-06-09T00:02:00.000Z","cwd":"/Users/dev/work/app","message":{"role":"user","content":"more"}}),
        ];
        let recs: Vec<_> = lines.iter().map(|l| parse_line(&l.to_string())).collect();
        let d = accumulate(&recs);
        // not /app (the later cwd): resume must launch from the root
        assert_eq!(d.project_path.as_deref(), Some("/Users/dev/work"));
    }

    #[test]
    fn recap_session_delta_skips_sidechain() {
        let d = accumulate(&records("session_recap.jsonl"));
        assert!(d.latest_recap.as_deref().unwrap().starts_with("Recovering report data"));
        assert_eq!(d.slug.as_deref(), Some("report-pipeline"));
        // sidechain user record must not count
        assert_eq!(d.user_message_count, 1); // only the compact-summary user record
        assert_eq!(d.project_path.as_deref(), Some("/Users/dev/work/reporter"));
    }

    #[test]
    fn ghost_session_has_zero_user_messages() {
        let d = accumulate(&records("session_ghost.jsonl"));
        assert_eq!(d.user_message_count, 0);
    }

    #[test]
    fn title_priority_chain() {
        let full = SessionDelta {
            ai_title: Some("AI Title".into()),
            latest_recap: Some("Recap text".into()),
            slug: Some("a-slug".into()),
            first_prompt: Some("first prompt".into()),
            ..Default::default()
        };
        assert_eq!(resolve_title(&full, "deadbeef-0000"), ("AI Title".into(), "ai-title"));
        assert_eq!(
            resolve_title(&SessionDelta { ai_title: None, ..full.clone() }, "deadbeef-0000").1,
            "recap"
        );
        assert_eq!(
            resolve_title(&SessionDelta { ai_title: None, latest_recap: None, ..full.clone() }, "deadbeef-0000").1,
            "slug"
        );
        assert_eq!(
            resolve_title(&SessionDelta { ai_title: None, latest_recap: None, slug: None, ..full.clone() }, "deadbeef-0000").1,
            "first-prompt"
        );
        assert_eq!(
            resolve_title(&SessionDelta::default(), "deadbeef-0000"),
            ("deadbeef".into(), "session-id")
        );
    }

    #[test]
    fn long_titles_truncated_to_80_chars() {
        let d = SessionDelta { first_prompt: Some("x".repeat(300)), ..Default::default() };
        assert_eq!(resolve_title(&d, "deadbeef-0000").0.chars().count(), 80);
    }
}
