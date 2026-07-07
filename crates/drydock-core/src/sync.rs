use crate::accumulator::accumulate;
use crate::chunker::{chunk_records, chunk_records_with};
use crate::parser::parse_line;
use crate::scanner::{scan_projects, scan_subagents, AgentFile, SessionFile};
use crate::store::Store;
use anyhow::Result;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct SyncReport {
    pub files_parsed: usize,
    pub files_skipped: usize,
    pub sessions_deleted: usize,
    pub malformed_lines: usize,
    pub agent_files_parsed: usize,
}

#[derive(Debug, PartialEq)]
pub enum SyncOutcome { Parsed { malformed: usize }, Skipped }

/// Bytes the tail fingerprint covers, immediately before the synced offset.
const TAIL_FINGERPRINT_LEN: u64 = 64;

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read file bytes [from, to) — used for the tail fingerprint around offsets.
fn read_range(path: &Path, from: u64, to: u64) -> Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(from))?;
    let mut buf = vec![0u8; (to - from) as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Hex fingerprint of the (up to) 64 bytes ending at `offset`.
fn tail_fingerprint(path: &Path, offset: u64) -> Result<String> {
    Ok(to_hex(&read_range(path, offset.saturating_sub(TAIL_FINGERPRINT_LEN), offset)?))
}

/// Sync one transcript file incrementally from its stored byte offset.
pub fn sync_file(store: &mut Store, sf: &SessionFile) -> Result<SyncOutcome> {
    let path_str = sf.path.to_string_lossy().to_string();
    let prev = store.get_sync_state(&path_str)?;

    let mut start = match &prev {
        Some(st) if st.byte_offset as u64 > sf.size => {
            // file replaced/truncated: drop derived data, reparse from zero
            // (data-only: the user's name/hidden/folder flags must survive
            // the reparse — it's still the same session)
            store.delete_session_data(&sf.session_id)?;
            0u64
        }
        Some(st) => {
            if st.byte_offset as u64 == sf.size && st.mtime == sf.mtime {
                return Ok(SyncOutcome::Skipped);
            }
            st.byte_offset as u64
        }
        None => 0,
    };

    // rewrite detection: a replaced file that ends at or past the old offset gets
    // by the size check above, so compare the bytes just before the offset against
    // the stored fingerprint. None (pre-migration rows) skips the check.
    if start > 0 {
        if let Some(stored_tail) = prev.as_ref().and_then(|st| st.tail_hex.as_deref()) {
            if tail_fingerprint(&sf.path, start)? != stored_tail {
                store.delete_session_data(&sf.session_id)?;
                start = 0;
            }
        }
    }

    let mut f = std::fs::File::open(&sf.path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;

    // only consume complete lines: leave any trailing partial line for next sync
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(last_nl) => last_nl + 1,
        None => return Ok(SyncOutcome::Skipped), // no complete new line yet
    };
    let text = String::from_utf8_lossy(&buf[..consumed]);

    let mut malformed = 0usize;
    let records: Vec<_> = text
        .lines()
        .map(|l| {
            let r = parse_line(l);
            if matches!(r, crate::records::ParsedRecord::Malformed) { malformed += 1; }
            r
        })
        .collect();

    let delta = accumulate(&records);
    let chunks = chunk_records(&records);
    store.apply_delta(&sf.session_id, &delta, &chunks)?;
    // usage is deduped by message.id; the cursor stops a multi-block turn
    // straddling two batches from being counted twice. start == 0 means we
    // reparsed from scratch (fresh file / truncate) — no carry-over.
    let boundary = if start == 0 { None } else { prev.as_ref().and_then(|st| st.last_usage_id.clone()) };
    let (usage, last_id) = usage_sums(&records, boundary.as_deref());
    if !usage.is_empty() {
        store.add_usage(&sf.session_id, "main", &usage)?;
    }
    let new_offset = start + consumed as u64;
    let tail = tail_fingerprint(&sf.path, new_offset)?;
    let carry = last_id.or(boundary);
    store.set_sync_state(&path_str, &sf.session_id, new_offset as i64, sf.mtime, Some(&tail), carry.as_deref())?;
    Ok(SyncOutcome::Parsed { malformed })
}

/// Sync one SUBAGENT transcript incrementally: its chunks join the parent
/// session's search index (tagged with agent_id), but contribute no session
/// delta — a subagent's chatter must not inflate the parent's counts, recency
/// or title. Skipped until the parent session itself is indexed.
pub fn sync_agent_file(store: &mut Store, af: &AgentFile) -> Result<SyncOutcome> {
    let path_str = af.path.to_string_lossy().to_string();
    // unchanged-file check FIRST: it's one indexed row, vs a session lookup —
    // this is the hot path on every index tick. (An orphaned row can't linger:
    // delete_session sweeps agent sync rows by session_id.)
    let prev = store.get_sync_state(&path_str)?;
    if let Some(st) = &prev {
        if st.byte_offset as u64 == af.size && st.mtime == af.mtime {
            return Ok(SyncOutcome::Skipped);
        }
    }

    let mut start = match &prev {
        Some(st) if st.byte_offset as u64 > af.size => {
            store.delete_agent_file(&path_str, &af.parent_session_id, &af.agent_id)?;
            0u64
        }
        Some(st) => st.byte_offset as u64,
        None => 0,
    };
    if start > 0 {
        if let Some(stored_tail) = prev.as_ref().and_then(|st| st.tail_hex.as_deref()) {
            if tail_fingerprint(&af.path, start)? != stored_tail {
                store.delete_agent_file(&path_str, &af.parent_session_id, &af.agent_id)?;
                start = 0;
            }
        }
    }

    let mut f = std::fs::File::open(&af.path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(last_nl) => last_nl + 1,
        None => return Ok(SyncOutcome::Skipped),
    };
    let text = String::from_utf8_lossy(&buf[..consumed]);

    let mut malformed = 0usize;
    let records: Vec<_> = text
        .lines()
        .map(|l| {
            let r = parse_line(l);
            if matches!(r, crate::records::ParsedRecord::Malformed) { malformed += 1; }
            r
        })
        .collect();

    // agent records all carry isSidechain — include them, that's the content.
    // The store's in-transaction gate refuses stub/absent parents; recording
    // sync state anyway would mark the file "done" and never retry it.
    let chunks = chunk_records_with(&records, true);
    let boundary = if start == 0 { None } else { prev.as_ref().and_then(|st| st.last_usage_id.clone()) };
    let (usage, last_id) = usage_sums(&records, boundary.as_deref());
    if !store.apply_agent_chunks(&af.parent_session_id, &af.agent_id, &chunks, &usage)? {
        return Ok(SyncOutcome::Skipped);
    }
    let new_offset = start + consumed as u64;
    let tail = tail_fingerprint(&af.path, new_offset)?;
    let carry = last_id.or(boundary);
    store.set_sync_state_kind(&path_str, &af.parent_session_id, new_offset as i64, af.mtime, Some(&tail), true, carry.as_deref())?;
    Ok(SyncOutcome::Parsed { malformed })
}

/// Sum token usage per model over a batch of parsed records, DEDUPED by
/// message.id: Claude Code writes one line per assistant content block, each
/// repeating the same id and the same full-turn usage — summing per line
/// inflates every tool-using turn 2-3x (verified against real transcripts).
/// `boundary` is the last id counted by the previous batch (a turn's lines
/// can straddle batches). Returns (sums, last counted id). Records without an
/// id (old formats) are counted as-is — better slightly over than silently
/// zero. Sidechain records count: they are real cost.
fn usage_sums(
    records: &[crate::records::ParsedRecord],
    boundary: Option<&str>,
) -> (std::collections::HashMap<String, [i64; 4]>, Option<String>) {
    let mut out: std::collections::HashMap<String, [i64; 4]> = Default::default();
    let mut seen: std::collections::HashSet<String> = Default::default();
    if let Some(b) = boundary {
        seen.insert(b.to_string());
    }
    let mut last: Option<String> = None;
    for r in records {
        if let crate::records::ParsedRecord::Chain(c) = r {
            if let Some(u) = &c.usage {
                if let Some(id) = &u.message_id {
                    if !seen.insert(id.clone()) {
                        continue; // repeated block line of an already-counted turn
                    }
                    last = Some(id.clone());
                }
                let e = out.entry(u.model.clone()).or_insert([0; 4]);
                e[0] += u.input;
                e[1] += u.output;
                e[2] += u.cache_read;
                e[3] += u.cache_creation;
            }
        }
    }
    (out, last)
}

/// One-time backfill: sessions indexed BEFORE the usage column existed have
/// their sync offsets at EOF, so incremental syncs will never revisit their
/// records. Re-read each synced file's ALREADY-COVERED range — exactly
/// [0, sync offset), never the live tail — and REPLACE that (session, scope)'s
/// sums, leaving the usage cursor so the next incremental batch can't
/// double-count a straddling turn. Files without a sync row are skipped: the
/// incremental path will count them from byte 0 itself. Idempotent; the
/// caller gates it behind a store meta key.
pub fn backfill_usage(store: &mut Store, claude_dir: &Path) -> Result<usize> {
    let mut filled = 0usize;
    let mut fill = |store: &mut Store, path: &Path, session_id: &str, scope: &str, agent_gate: bool| -> Result<bool> {
        let path_str = path.to_string_lossy().to_string();
        let Some(st) = store.get_sync_state(&path_str)? else { return Ok(false) };
        if agent_gate && !store.is_real_session(session_id)? {
            return Ok(false); // orphan sidecar: the sync path refuses it, so must we
        }
        let Ok(bytes) = read_range(path, 0, st.byte_offset as u64) else { return Ok(false) };
        let text = String::from_utf8_lossy(&bytes);
        let records: Vec<_> = text.lines().map(parse_line).collect();
        let (sums, last_id) = usage_sums(&records, None);
        if sums.is_empty() {
            return Ok(false);
        }
        store.replace_usage(session_id, scope, &sums)?;
        store.set_sync_state_kind(&path_str, &st.session_id, st.byte_offset, st.mtime, st.tail_hex.as_deref(), scope != "main", last_id.as_deref())?;
        Ok(true)
    };
    for sf in scan_projects(claude_dir)? {
        if fill(store, &sf.path, &sf.session_id, "main", false)? {
            filled += 1;
        }
    }
    for af in crate::scanner::scan_subagents(claude_dir)? {
        let agent_id = af.agent_id.clone();
        if fill(store, &af.path, &af.parent_session_id, &agent_id, true)? {
            filled += 1;
        }
    }
    Ok(filled)
}

/// Scan everything under <claude_dir>/projects, sync each file, and mirror deletions.
pub fn sync_all(store: &mut Store, claude_dir: &Path) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    let files = scan_projects(claude_dir)?;

    for sf in &files {
        match sync_file(store, sf) {
            Ok(SyncOutcome::Parsed { malformed }) => {
                report.files_parsed += 1;
                report.malformed_lines += malformed;
            }
            Ok(SyncOutcome::Skipped) => report.files_skipped += 1,
            // one unreadable file (perms, vanished mid-read) must not abort
            // the whole pass — deletion mirroring below stays safe because
            // on_disk comes from the scan, not from sync success
            Err(e) => eprintln!("drydock: skipping {}: {e:#}", sf.path.display()),
        }
    }

    // subagent sidecars AFTER the main transcripts, so parents exist
    let agents = scan_subagents(claude_dir)?;
    for af in &agents {
        match sync_agent_file(store, af) {
            Ok(SyncOutcome::Parsed { malformed }) => {
                report.agent_files_parsed += 1;
                report.malformed_lines += malformed;
            }
            Ok(SyncOutcome::Skipped) => {}
            Err(e) => eprintln!("drydock: skipping agent file {}: {e:#}", af.path.display()),
        }
    }

    // deletion mirroring: any synced path that no longer exists on disk.
    // A vanished AGENT file drops only its own chunks; a vanished transcript
    // drops the whole session (which also sweeps its agent chunks + sync rows).
    let on_disk: std::collections::HashSet<String> = files
        .iter()
        .map(|f| f.path.to_string_lossy().to_string())
        .chain(agents.iter().map(|a| a.path.to_string_lossy().to_string()))
        .collect();
    for (path, session_id, is_agent) in store.all_synced_paths()? {
        if on_disk.contains(&path) {
            continue;
        }
        if is_agent {
            let agent_id = std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("agent-"))
                .unwrap_or_default()
                .to_string();
            store.delete_agent_file(&path, &session_id, &agent_id)?;
        } else {
            // transcript vanished (expiry, external cleanup) — data-only:
            // flags reattach if the session ever comes back
            store.delete_session_data(&session_id)?;
            report.sessions_deleted += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asst(id: &str, model: &str, inp: i64, out: i64) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"u-{id}-{out}","timestamp":"2026-06-01T10:00:01.000Z","sessionId":"s","message":{{"id":"{id}","role":"assistant","model":"{model}","usage":{{"input_tokens":{inp},"output_tokens":{out},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"content":[{{"type":"text","text":"x"}}]}}}}"#
        )
    }

    #[test]
    fn usage_dedupes_by_message_id_and_respects_the_batch_boundary() {
        // one turn = several lines with the SAME id and the SAME usage
        let lines = vec![
            asst("msg_a", "m1", 100, 20),
            asst("msg_a", "m1", 100, 20), // block 2 of the same turn
            asst("msg_a", "m1", 100, 20), // block 3
            asst("msg_b", "m1", 10, 5),
        ];
        let records: Vec<_> = lines.iter().map(|l| parse_line(l)).collect();
        let (sums, last) = usage_sums(&records, None);
        assert_eq!(sums["m1"], [110, 25, 0, 0], "msg_a counted once, not three times");
        assert_eq!(last.as_deref(), Some("msg_b"));

        // next batch starts with the TAIL of msg_b (straddling turn): the
        // boundary cursor keeps it from being counted again
        let lines2 = vec![asst("msg_b", "m1", 10, 5), asst("msg_c", "m2", 7, 3)];
        let records2: Vec<_> = lines2.iter().map(|l| parse_line(l)).collect();
        let (sums2, last2) = usage_sums(&records2, last.as_deref());
        assert!(sums2.get("m1").is_none(), "boundary turn not re-counted");
        assert_eq!(sums2["m2"], [7, 3, 0, 0]);
        assert_eq!(last2.as_deref(), Some("msg_c"));
    }

    #[test]
    fn usage_skips_synthetic_and_counts_sidechain() {
        let synth = r#"{"type":"assistant","uuid":"u9","timestamp":"2026-06-01T10:00:01.000Z","sessionId":"s","message":{"id":"msg_s","role":"assistant","model":"<synthetic>","usage":{"input_tokens":9999,"output_tokens":9999},"content":[{"type":"text","text":"x"}]}}"#.to_string();
        let side = r#"{"type":"assistant","uuid":"u8","isSidechain":true,"timestamp":"2026-06-01T10:00:02.000Z","sessionId":"s","message":{"id":"msg_side","role":"assistant","model":"m3","usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"agent"}]}}"#.to_string();
        let records: Vec<_> = [synth, side].iter().map(|l| parse_line(l)).collect();
        let (sums, _) = usage_sums(&records, None);
        assert_eq!(sums.len(), 1, "synthetic excluded");
        assert_eq!(sums["m3"], [7, 3, 0, 0], "sidechain usage is real cost");
    }
}
