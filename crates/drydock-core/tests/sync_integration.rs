use drydock_core::store::Store;
use drydock_core::sync::sync_all;
use std::fs;
use std::path::PathBuf;

const SID: &str = "11111111-1111-1111-1111-111111111111";

fn fixture(name: &str) -> String {
    let p = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    fs::read_to_string(p).unwrap()
}

/// Build a fake ~/.claude with one project dir; returns (claude_dir, transcript_path).
fn setup() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let proj = tmp.path().join("projects").join("-Users-dev-work");
    fs::create_dir_all(&proj).unwrap();
    let file = proj.join(format!("{SID}.jsonl"));
    (tmp, file)
}

#[test]
fn transcript_path_resolves_the_synced_file() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    fs::write(&file, format!("{}\n", fixture("session_basic.jsonl").lines().next().unwrap())).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    // this is exactly the path delete_session_permanently removes
    assert_eq!(store.transcript_path(SID).unwrap().as_deref(), file.to_str());
    assert!(store.transcript_path("no-such-session").unwrap().is_none());
}

#[test]
fn full_lifecycle_create_append_replace_delete() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    let basic = fixture("session_basic.jsonl");
    let lines: Vec<&str> = basic.lines().collect();

    // CREATE: first 3 lines
    fs::write(&file, format!("{}\n{}\n{}\n", lines[0], lines[1], lines[2])).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.message_count, 3);
    assert_eq!(row.title_source, "slug"); // no ai-title yet, no recap

    // APPEND: remaining lines (includes ai-title) — only the tail is parsed
    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    write!(f, "{}\n{}\n{}\n", lines[3], lines[4], lines[5]).unwrap();
    drop(f);
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.message_count, 4);
    assert_eq!(row.title, "Build script fix");
    assert_eq!(row.title_source, "ai-title");

    // REPLACE with a shorter file (offset > size) → full reparse from zero
    fs::write(&file, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.message_count, 2);

    // DELETE → cascade removal (spec §6.11)
    fs::remove_file(&file).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    assert!(store.get_session(SID).unwrap().is_none());
    assert_eq!(store.chunk_count(SID).unwrap(), 0);
}

#[test]
fn partial_trailing_line_is_not_consumed() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    let basic = fixture("session_basic.jsonl");
    let lines: Vec<&str> = basic.lines().collect();

    // write one complete line + half of the next, no trailing newline
    let half = &lines[1][..lines[1].len() / 2];
    fs::write(&file, format!("{}\n{}", lines[0], half)).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.message_count, 1); // only the complete line

    // complete the half line
    let rest = &lines[1][lines[1].len() / 2..];
    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    writeln!(f, "{rest}").unwrap();
    drop(f);
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.message_count, 2);
    assert_eq!(row.first_prompt.as_deref(), Some("fix the build script"));
}

/// Parse `content` in a fresh store/dir and return (message_count, chunk_count)
/// — the ground truth a rewrite-detection resync must match.
fn fresh_parse_counts(content: &str) -> (i64, i64) {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    fs::write(&file, content).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    let row = store.get_session(SID).unwrap().unwrap();
    (row.message_count, store.chunk_count(SID).unwrap())
}

#[test]
fn append_only_sync_stays_incremental() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    let basic = fixture("session_basic.jsonl");
    let lines: Vec<&str> = basic.lines().collect();

    fs::write(&file, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();
    store.set_starred(SID, true).unwrap(); // dropped if the session is ever reparsed from zero

    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    write!(f, "{}\n{}\n", lines[2], lines[3]).unwrap();
    drop(f);
    sync_all(&mut store, tmp.path()).unwrap();

    let row = store.get_session(SID).unwrap().unwrap();
    assert!(row.starred, "append must not trigger a full reparse");
    // chunk grouping is batch-dependent, so only message_count is comparable here
    let full = format!("{}\n{}\n{}\n{}\n", lines[0], lines[1], lines[2], lines[3]);
    assert_eq!(row.message_count, fresh_parse_counts(&full).0);
}

#[test]
fn rewrite_ending_past_old_offset_is_detected() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    let basic = fixture("session_basic.jsonl");
    let lines: Vec<&str> = basic.lines().collect();

    // sync 3 lines, then (within one debounce window) rewind to 2 lines and
    // append 4 more, ending past the old offset — invisible to the size check
    fs::write(&file, format!("{}\n{}\n{}\n", lines[0], lines[1], lines[2])).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();

    fs::write(&file, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    write!(f, "{}\n{}\n{}\n{}\n", lines[4], lines[5], lines[2], lines[3]).unwrap();
    drop(f);
    sync_all(&mut store, tmp.path()).unwrap();

    let rewritten = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n",
        lines[0], lines[1], lines[4], lines[5], lines[2], lines[3]
    );
    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(
        (row.message_count, store.chunk_count(SID).unwrap()),
        fresh_parse_counts(&rewritten),
        "rewrite must be detected and fully reparsed, not double-counted"
    );
}

#[test]
fn same_size_different_content_rewrite_is_detected() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    let basic = fixture("session_basic.jsonl");
    let lines: Vec<&str> = basic.lines().collect();

    fs::write(&file, format!("{}\n", lines[1])).unwrap();
    sync_all(&mut store, tmp.path()).unwrap();

    // same-length content swap; bump mtime so the size+mtime fast path can't skip
    let swapped = lines[1].replace("build script", "build SCRIPT");
    assert_eq!(swapped.len(), lines[1].len());
    assert_ne!(swapped, lines[1]);
    fs::write(&file, format!("{swapped}\n")).unwrap();
    let f = fs::OpenOptions::new().write(true).open(&file).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2)).unwrap();
    drop(f);
    sync_all(&mut store, tmp.path()).unwrap();

    let row = store.get_session(SID).unwrap().unwrap();
    assert_eq!(row.first_prompt.as_deref(), Some("fix the build SCRIPT"));
    assert_eq!(
        (row.message_count, store.chunk_count(SID).unwrap()),
        fresh_parse_counts(&format!("{swapped}\n"))
    );
}

#[test]
fn unchanged_file_is_skipped() {
    let (tmp, file) = setup();
    let mut store = Store::open_in_memory().unwrap();
    fs::write(&file, fixture("session_basic.jsonl")).unwrap();
    let r1 = sync_all(&mut store, tmp.path()).unwrap();
    assert_eq!(r1.files_parsed, 1);
    let r2 = sync_all(&mut store, tmp.path()).unwrap();
    assert_eq!(r2.files_parsed, 0);
    assert_eq!(r2.files_skipped, 1);
}
