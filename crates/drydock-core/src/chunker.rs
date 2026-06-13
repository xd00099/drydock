use crate::records::ParsedRecord;

pub const CHUNK_CHAR_LIMIT: usize = 2000;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub role: String, // role of first message in chunk, or "recap"
    pub text: String,
    pub ts: Option<i64>,
}

pub fn chunk_records(records: &[ParsedRecord]) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    let mut buf = String::new();
    let mut buf_role: Option<String> = None;
    let mut buf_ts: Option<i64> = None;

    let flush = |buf: &mut String, role: &mut Option<String>, ts: &mut Option<i64>, out: &mut Vec<Chunk>| {
        if !buf.trim().is_empty() {
            out.push(Chunk { role: role.clone().unwrap_or_else(|| "mixed".into()), text: std::mem::take(buf), ts: *ts });
        } else {
            buf.clear();
        }
        *role = None;
        *ts = None;
    };

    for r in records {
        let ParsedRecord::Chain(c) = r else { continue };
        if c.is_sidechain { continue; }
        let Some(text) = c.text.as_deref().filter(|t| !t.trim().is_empty()) else { continue };

        // recaps are standalone high-signal chunks (spec §7)
        if c.kind == "system" && c.subtype.as_deref() == Some("away_summary") {
            flush(&mut buf, &mut buf_role, &mut buf_ts, &mut out);
            out.push(Chunk { role: "recap".into(), text: text.to_string(), ts: c.timestamp_ms });
            continue;
        }
        if c.kind != "user" && c.kind != "assistant" { continue; }

        let tagged = format!("{}: {}\n", c.kind, text);
        if tagged.chars().count() > CHUNK_CHAR_LIMIT {
            // oversize message: flush buffer, split message on paragraph boundaries
            flush(&mut buf, &mut buf_role, &mut buf_ts, &mut out);
            let mut piece = String::new();
            for para in text.split("\n\n") {
                if piece.chars().count() + para.chars().count() + 2 > CHUNK_CHAR_LIMIT && !piece.is_empty() {
                    out.push(Chunk { role: c.kind.clone(), text: piece.clone(), ts: c.timestamp_ms });
                    piece.clear();
                }
                if para.chars().count() > CHUNK_CHAR_LIMIT {
                    // pathological single paragraph: hard split
                    let chars: Vec<char> = para.chars().collect();
                    for w in chars.chunks(CHUNK_CHAR_LIMIT) {
                        out.push(Chunk { role: c.kind.clone(), text: w.iter().collect(), ts: c.timestamp_ms });
                    }
                } else {
                    if !piece.is_empty() { piece.push_str("\n\n"); }
                    piece.push_str(para);
                }
            }
            if !piece.is_empty() {
                out.push(Chunk { role: c.kind.clone(), text: piece, ts: c.timestamp_ms });
            }
            continue;
        }

        if buf.chars().count() + tagged.chars().count() > CHUNK_CHAR_LIMIT {
            flush(&mut buf, &mut buf_role, &mut buf_ts, &mut out);
        }
        if buf.is_empty() {
            buf_role = Some(c.kind.clone());
            buf_ts = c.timestamp_ms;
        }
        buf.push_str(&tagged);
    }
    flush(&mut buf, &mut buf_role, &mut buf_ts, &mut out);
    out
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
    fn small_session_is_one_chunk_plus_recap() {
        let chunks = chunk_records(&records("session_recap.jsonl"));
        // conversation text folds into one chunk; away_summary gets its own
        let recap: Vec<_> = chunks.iter().filter(|c| c.role == "recap").collect();
        assert_eq!(recap.len(), 1);
        assert!(recap[0].text.starts_with("Recovering report data"));
        let convo: Vec<_> = chunks.iter().filter(|c| c.role != "recap").collect();
        assert_eq!(convo.len(), 1);
        assert!(convo[0].text.contains("user: Summary of earlier conversation"));
        assert!(convo[0].text.contains("assistant: Continuing from the summary"));
        // sidechain text excluded
        assert!(!convo[0].text.contains("subagent prompt"));
    }

    #[test]
    fn long_message_splits_on_paragraphs() {
        let para = "p".repeat(900);
        let long = format!("{para}\n\n{para}\n\n{para}"); // ~2700 chars
        // build via json! so embedded newlines are escaped into valid JSON
        let line = serde_json::json!({
            "type": "user", "uuid": "u1", "sessionId": "s",
            "timestamp": "2026-06-01T10:00:00.000Z",
            "message": {"role": "user", "content": long}
        })
        .to_string();
        let chunks = chunk_records(&[parse_line(&line)]);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.text.chars().count() <= CHUNK_CHAR_LIMIT));
    }

    #[test]
    fn chunk_carries_first_timestamp() {
        let chunks = chunk_records(&records("session_basic.jsonl"));
        assert!(chunks[0].ts.is_some());
    }
}
