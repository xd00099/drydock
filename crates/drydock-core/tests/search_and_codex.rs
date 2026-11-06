use drydock_core::{codex, scanner::SessionFile, store::Store, sync::{sync_all, sync_file}, transcript};
use std::collections::HashSet;

fn index(store: &mut Store, path: &std::path::Path, sid: &str) {
    let md = path.metadata().unwrap();
    sync_file(store, &SessionFile { path: path.into(), session_id: sid.into(), size: md.len(), mtime: 1 }).unwrap();
}

#[test]
fn filters_and_session_deduplication_precede_search_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = Store::open(&tmp.path().join("index.db")).unwrap();
    for n in 0..65 {
        let sid = format!("s{n}");
        let path = tmp.path().join(format!("{sid}.jsonl"));
        let line = serde_json::json!({"type":"user","message":{"role":"user","content":"needle"}}).to_string();
        std::fs::write(&path, format!("{line}\n{line}\n")).unwrap();
        index(&mut store, &path, &sid);
    }
    let eligible: HashSet<String> = ["s64".into()].into();
    let hits = store.search_keyword_filtered("needle", 1, Some(&eligible)).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id, "s64");
    let chunks = store.chunks_without_embeddings(1000).unwrap();
    for (id, _) in chunks { store.put_embedding(id, &[1., 0.]).unwrap(); }
    let hits = store.search_semantic_filtered(&[1., 0.], 1, Some(&eligible)).unwrap();
    assert_eq!(hits[0].session_id, "s64");
    assert_eq!(store.search_keyword("needle", 50).unwrap().len(), 50);
}

#[test]
fn unavailable_source_does_not_erase_index_and_external_agents_survive_claude_sync() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("claude");
    let project = root.join("projects/p");
    std::fs::create_dir_all(&project).unwrap();
    let mut store = Store::open(&tmp.path().join("index.db")).unwrap();
    let line = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
    std::fs::write(project.join("claude-session.jsonl"), line).unwrap();
    sync_all(&mut store, &root).unwrap();
    std::fs::rename(root.join("projects"), root.join("unmounted")).unwrap();
    sync_all(&mut store, &root).unwrap();
    assert!(store.get_session("claude-session").unwrap().is_some());
    // ENOTDIR is an inventory failure, never a successful empty scan.
    std::fs::write(root.join("projects"), "not a directory").unwrap();
    assert!(sync_all(&mut store, &root).is_err());
    assert!(store.get_session("claude-session").unwrap().is_some());
    std::fs::remove_file(root.join("projects")).unwrap();
    std::fs::rename(root.join("unmounted"), root.join("projects")).unwrap();
    let codex = tmp.path().join("codex.jsonl");
    std::fs::write(&codex, line).unwrap();
    index(&mut store, &codex, "codex-session");
    std::fs::remove_file(project.join("claude-session.jsonl")).unwrap();
    sync_all(&mut store, &root).unwrap();
    assert!(store.get_session("claude-session").unwrap().is_none());
    assert!(store.get_session("codex-session").unwrap().is_some());
}

#[test]
fn codex_rollout_shares_transcript_search_and_briefing_context() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("rollout.jsonl");
    let records = [
        serde_json::json!({"type":"session_meta","payload":{"id":"codex-session","cwd":"/project"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix reconnect"}]}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"call1","name":"shell","arguments":"{\"command\":\"ls\"}"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"src"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"inspect retry"}]}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"backoff implemented"}]}}),
        serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"backoff implemented"}}),
    ];
    let text = records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n") + "\n";
    std::fs::write(&path, &text).unwrap();
    let mut store = Store::open(&tmp.path().join("index.db")).unwrap();
    index(&mut store, &path, "codex-session");
    let row = store.get_session("codex-session").unwrap().unwrap();
    assert_eq!(row.project_path, "/project");
    assert_eq!(row.user_message_count, 1);
    assert_eq!(store.search_keyword("backoff", 10).unwrap().len(), 1);
    assert!(store.get_chunks("codex-session").unwrap().iter().any(|c| c.text.contains("backoff")));
    let page = transcript::read_page(&path, 0).unwrap();
    assert_eq!(page.entries.iter().filter(|e| e.text == "backoff implemented").count(), 1);
    assert!(page.entries.iter().any(|e| e.kind == "tool_use" && e.tool_use_id.as_deref() == Some("call1")));
    assert!(page.entries.iter().any(|e| e.kind == "tool_result" && e.tool_use_id.as_deref() == Some("call1")));
    assert!(page.entries.iter().any(|e| e.kind == "thinking"));
    assert!(transcript::read_page(&path, page.next_offset).unwrap().entries.is_empty());
    let normalized = codex::normalize_record(records[1].clone());
    assert_eq!(normalized["type"], "user");
}

#[test]
fn metadata_only_codex_sessions_are_visible_without_inventing_messages() {
    let mut store = Store::open_in_memory().unwrap();
    let delta = drydock_core::accumulator::SessionDelta {
        project_path: Some("/project".into()),
        first_prompt: Some("Repair reconnect".into()),
        last_message_at: Some(1234),
        ..Default::default()
    };
    store.apply_delta("paginated", &delta, &[
        drydock_core::chunker::Chunk {
            role: "user".into(), text: "Repair reconnect".into(), ts: Some(1234),
        },
    ]).unwrap();
    store.apply_delta("ghost", &Default::default(), &[]).unwrap();
    // Existing installations already have these rows marked as ghosts.
    assert!(store.get_session("paginated").unwrap().unwrap().hidden);
    store.set_session_hidden("paginated", true).unwrap();
    assert!(store.clear_session_ghost("paginated").unwrap());
    assert!(!store.clear_session_ghost("paginated").unwrap(), "polling is idempotent");

    let row = store.get_session("paginated").unwrap().unwrap();
    assert!(!row.hidden);
    assert_eq!(row.message_count, 0);
    assert_eq!(row.user_message_count, 0);
    assert_eq!(store.search_keyword("reconnect", 10).unwrap().len(), 1);
    assert_eq!(store.hidden_session_ids().unwrap(), vec!["paginated"]);
    assert!(store.get_session("ghost").unwrap().unwrap().hidden);
}

#[test]
fn concurrent_agent_writers_preserve_every_delta() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("index.db");
    Store::open(&db).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let writers: Vec<_> = (0..4).map(|_| {
        let db = db.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let mut store = Store::open(&db).unwrap();
            barrier.wait();
            for _ in 0..25 {
                store.apply_delta("shared-session", &drydock_core::accumulator::SessionDelta {
                    message_count: 1, ..Default::default()
                }, &[]).unwrap();
                assert!(store.apply_agent_chunks("shared-session", "worker", &[
                    drydock_core::chunker::Chunk { role: "assistant".into(), text: "indexed concurrently".into(), ts: None }
                ], &Default::default()).unwrap());
            }
        })
    }).collect();
    for writer in writers { writer.join().unwrap(); }
    let store = Store::open(&db).unwrap();
    assert_eq!(store.get_session("shared-session").unwrap().unwrap().message_count, 100);
    assert_eq!(store.search_keyword("concurrently", 200).unwrap().len(), 100);
}
