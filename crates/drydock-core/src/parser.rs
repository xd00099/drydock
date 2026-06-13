use crate::records::{Chain, ParsedRecord, State, CHAIN_KINDS, STATE_KINDS};
use serde_json::Value;

pub fn parse_line(line: &str) -> ParsedRecord {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return ParsedRecord::Malformed,
    };
    let t = v.get("type").and_then(Value::as_str);
    match t {
        Some(k) if CHAIN_KINDS.contains(&k) => ParsedRecord::Chain(parse_chain(k, &v)),
        Some(k) if STATE_KINDS.contains(&k) => ParsedRecord::State(State {
            kind: k.to_string(),
            session_id: str_field(&v, "sessionId"),
            ai_title: str_field(&v, "aiTitle"),
            last_prompt: str_field(&v, "lastPrompt"),
        }),
        other => ParsedRecord::Unknown { raw_type: other.map(|s| s.to_string()) },
    }
}

fn parse_chain(kind: &str, v: &Value) -> Chain {
    let message = v.get("message");
    let content = message.and_then(|m| m.get("content"));
    let text = content
        .and_then(extract_text)
        // away_summary & friends keep text in a top-level "content" field
        .or_else(|| v.get("content").and_then(extract_text));
    let is_tool_result_only = matches!(content, Some(Value::Array(blocks))
        if !blocks.is_empty() && blocks.iter().all(|b|
            b.get("type").and_then(Value::as_str) == Some("tool_result")));
    Chain {
        kind: kind.to_string(),
        subtype: str_field(v, "subtype"),
        uuid: str_field(v, "uuid"),
        session_id: str_field(v, "sessionId"),
        timestamp_ms: str_field(v, "timestamp").and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(&s).ok().map(|d| d.timestamp_millis())
        }),
        cwd: str_field(v, "cwd"),
        git_branch: str_field(v, "gitBranch"),
        version: str_field(v, "version"),
        is_meta: v.get("isMeta").and_then(Value::as_bool).unwrap_or(false),
        is_sidechain: v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false),
        is_tool_result_only,
        slug: str_field(v, "slug"),
        role: message.and_then(|m| m.get("role")).and_then(Value::as_str).map(String::from),
        text,
    }
}

/// Extract human text from a content value: plain string, or array of blocks.
/// text blocks are joined; tool_result content is truncated to its first line;
/// tool_use and other block types are skipped.
fn extract_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => nonempty(s.clone()),
        Value::Array(blocks) => {
            let mut parts: Vec<String> = Vec::new();
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            parts.push(t.to_string());
                        }
                    }
                    Some("tool_result") => {
                        if let Some(t) = b.get("content").and_then(Value::as_str) {
                            if let Some(first) = t.lines().next() {
                                parts.push(first.chars().take(200).collect());
                            }
                        }
                    }
                    _ => {} // tool_use, thinking, images, future blocks
                }
            }
            nonempty(parts.join("\n"))
        }
        _ => None,
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn nonempty(s: String) -> Option<String> {
    if s.trim().is_empty() { None } else { Some(s) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::ParsedRecord;

    fn fixture_lines(name: &str) -> Vec<String> {
        let p = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
        std::fs::read_to_string(p).unwrap().lines().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_basic_user_record() {
        let lines = fixture_lines("session_basic.jsonl");
        match parse_line(&lines[1]) {
            ParsedRecord::Chain(c) => {
                assert_eq!(c.kind, "user");
                assert_eq!(c.session_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
                assert_eq!(c.cwd.as_deref(), Some("/Users/dev/work"));
                assert_eq!(c.text.as_deref(), Some("fix the build script"));
                assert_eq!(c.timestamp_ms, Some(1780308005000)); // 2026-06-01T10:00:05Z
                assert!(!c.is_meta);
                assert_eq!(c.slug.as_deref(), Some("fix-lights"));
            }
            other => panic!("expected Chain, got {:?}", other),
        }
    }

    #[test]
    fn extracts_text_from_content_array_skipping_tool_use() {
        let lines = fixture_lines("session_basic.jsonl");
        let ParsedRecord::Chain(c) = parse_line(&lines[2]) else { panic!() };
        assert_eq!(c.kind, "assistant");
        assert_eq!(c.text.as_deref(), Some("Looking at the config file now."));
    }

    #[test]
    fn tool_result_text_is_first_line_only() {
        let lines = fixture_lines("session_basic.jsonl");
        let ParsedRecord::Chain(c) = parse_line(&lines[3]) else { panic!() };
        assert_eq!(c.text.as_deref(), Some("automation:"));
    }

    #[test]
    fn parses_state_records() {
        let lines = fixture_lines("session_basic.jsonl");
        let ParsedRecord::State(s) = parse_line(&lines[4]) else { panic!() };
        assert_eq!(s.kind, "ai-title");
        assert_eq!(s.ai_title.as_deref(), Some("Build script fix"));
        let ParsedRecord::State(s) = parse_line(&lines[5]) else { panic!() };
        assert_eq!(s.last_prompt.as_deref(), Some("fix the build script"));
    }

    #[test]
    fn away_summary_is_chain_with_content_text() {
        let lines = fixture_lines("session_recap.jsonl");
        let ParsedRecord::Chain(c) = parse_line(&lines[3]) else { panic!() };
        assert_eq!(c.kind, "system");
        assert_eq!(c.subtype.as_deref(), Some("away_summary"));
        assert!(c.text.as_deref().unwrap().starts_with("Recovering report data"));
    }

    #[test]
    fn sidechain_unknown_and_malformed() {
        let lines = fixture_lines("session_recap.jsonl");
        let ParsedRecord::Chain(c) = parse_line(&lines[4]) else { panic!() };
        assert!(c.is_sidechain);
        assert!(matches!(parse_line(&lines[6]), ParsedRecord::Unknown { .. }));
        assert!(matches!(parse_line(&lines[8]), ParsedRecord::Malformed));
    }

    #[test]
    fn missing_fields_never_panic() {
        for raw in [r#"{"type":"user"}"#, r#"{"type":"assistant","message":{}}"#, r#"{}"#, r#"{"type":"ai-title"}"#] {
            let _ = parse_line(raw); // must not panic
        }
    }
}
