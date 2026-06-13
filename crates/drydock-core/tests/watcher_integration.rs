use drydock_core::store::Store;
use std::fs;
use std::time::{Duration, Instant};

const SID: &str = "11111111-1111-1111-1111-111111111111";

#[test]
fn watcher_picks_up_new_file() {
    let tmp = tempfile::tempdir().unwrap();
    let proj = tmp.path().join("projects").join("-Users-dev-work");
    fs::create_dir_all(&proj).unwrap();
    let db = tmp.path().join("drydock.db");

    let claude_dir = tmp.path().to_path_buf();
    let db_for_thread = db.clone();
    std::thread::spawn(move || {
        let _ = drydock_core::watcher::watch(&claude_dir, &db_for_thread);
    });
    std::thread::sleep(Duration::from_millis(500)); // let watcher start

    let fixture = format!("{}/tests/fixtures/session_basic.jsonl", env!("CARGO_MANIFEST_DIR"));
    fs::copy(fixture, proj.join(format!("{SID}.jsonl"))).unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(store) = Store::open(&db) {
            if let Ok(Some(row)) = store.get_session(SID) {
                assert_eq!(row.message_count, 4);
                return;
            }
        }
        assert!(Instant::now() < deadline, "watcher never indexed the new file");
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn watch_with_reports_initial_sync() {
    let tmp = tempfile::tempdir().unwrap();
    let proj = tmp.path().join("projects").join("-Users-dev-work");
    fs::create_dir_all(&proj).unwrap();
    let fixture = format!("{}/tests/fixtures/session_basic.jsonl", env!("CARGO_MANIFEST_DIR"));
    fs::copy(fixture, proj.join(format!("{SID}.jsonl"))).unwrap();
    let db = tmp.path().join("drydock.db");

    let (tx, rx) = std::sync::mpsc::channel::<usize>();
    let claude_dir = tmp.path().to_path_buf();
    std::thread::spawn(move || {
        let _ = drydock_core::watcher::watch_with(&claude_dir, &db, move |r| {
            let _ = tx.send(r.files_parsed);
        });
    });
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(first, 1); // initial sync parsed the pre-existing fixture
}
