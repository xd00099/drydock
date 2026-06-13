use crate::accumulator::accumulate;
use crate::chunker::chunk_records;
use crate::parser::parse_line;
use crate::scanner::{scan_projects, SessionFile};
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
            store.delete_session(&sf.session_id)?;
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
                store.delete_session(&sf.session_id)?;
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
    let new_offset = start + consumed as u64;
    let tail = tail_fingerprint(&sf.path, new_offset)?;
    store.set_sync_state(&path_str, &sf.session_id, new_offset as i64, sf.mtime, Some(&tail))?;
    Ok(SyncOutcome::Parsed { malformed })
}

/// Scan everything under <claude_dir>/projects, sync each file, and mirror deletions.
pub fn sync_all(store: &mut Store, claude_dir: &Path) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    let files = scan_projects(claude_dir)?;

    for sf in &files {
        match sync_file(store, sf)? {
            SyncOutcome::Parsed { malformed } => {
                report.files_parsed += 1;
                report.malformed_lines += malformed;
            }
            SyncOutcome::Skipped => report.files_skipped += 1,
        }
    }

    // deletion mirroring: any synced path that no longer exists on disk
    let on_disk: std::collections::HashSet<String> =
        files.iter().map(|f| f.path.to_string_lossy().to_string()).collect();
    for path in store.all_synced_paths()? {
        if !on_disk.contains(&path) {
            if let Some(st) = store.get_sync_state(&path)? {
                store.delete_session(&st.session_id)?;
                report.sessions_deleted += 1;
            }
        }
    }
    Ok(report)
}
