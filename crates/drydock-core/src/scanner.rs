use anyhow::Result;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct SessionFile {
    pub path: PathBuf,
    pub session_id: String,
    pub size: u64,
    pub mtime: i64, // epoch millis
}

/// One subagent transcript (`agent-<id>.jsonl`) found under a session's
/// sidecar dir. Sidecars live at `projects/<proj>/<session-uuid>/subagents/`
/// — and because Claude Code creates them under the project dir of the
/// session's CURRENT cwd, one session's sidecars can be spread across several
/// project dirs (the parent is always the uuid dir's name, not the location).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentFile {
    pub path: PathBuf,
    pub parent_session_id: String,
    /// File-stem id, e.g. "a0c98b8c43929f4f1" from agent-a0c98b8c43929f4f1.jsonl.
    pub agent_id: String,
    pub size: u64,
    pub mtime: i64,
}

fn session_uuid(name: &str) -> bool {
    name.len() == 36 && name.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Collect agent-*.jsonl under `dir`, recursing (workflow agents nest in
/// subdirectories like subagents/workflows/<run>/). Depth-bounded defensively.
fn collect_agents(dir: &Path, parent: &str, depth: u8, out: &mut Vec<AgentFile>) {
    if depth == 0 { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        // DirEntry::file_type does NOT follow symlinks: a planted link can't
        // pull files from outside ~/.claude into the index or loop the walk
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() { continue; }
        if ft.is_dir() {
            collect_agents(&path, parent, depth - 1, out);
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(agent_id) = stem.strip_prefix("agent-") else { continue };
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") { continue; }
        let Ok(md) = e.metadata() else { continue };
        let mtime = md.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(AgentFile {
            path: path.clone(),
            parent_session_id: parent.to_string(),
            agent_id: agent_id.to_string(),
            size: md.len(),
            mtime,
        });
    }
}

/// The same agent_id can appear in two sidecar copies of one session (backup
/// restores, manual dir copies). Chunk ownership is keyed (session, agent), so
/// only ONE copy may ever index: keep the newest-mtime file, deterministically.
fn dedup_agents(mut agents: Vec<AgentFile>) -> Vec<AgentFile> {
    agents.sort_by(|a, b| {
        (&a.parent_session_id, &a.agent_id, b.mtime, &b.path)
            .cmp(&(&b.parent_session_id, &b.agent_id, a.mtime, &a.path))
    });
    agents.dedup_by(|next, kept| {
        kept.parent_session_id == next.parent_session_id && kept.agent_id == next.agent_id
    });
    agents.sort_by(|a, b| a.path.cmp(&b.path));
    agents
}

/// ONE session's subagent transcripts, wherever its sidecar dirs landed.
pub fn scan_session_agents(claude_dir: &Path, session_id: &str) -> Vec<AgentFile> {
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(claude_dir.join("projects")) else { return out };
    for proj in project_dirs.flatten() {
        collect_agents(&proj.path().join(session_id).join("subagents"), session_id, 5, &mut out);
    }
    dedup_agents(out)
}

/// Every subagent transcript under every project dir's session sidecars.
pub fn scan_subagents(claude_dir: &Path) -> Result<Vec<AgentFile>> {
    let projects = claude_dir.join("projects");
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(&projects) else { return Ok(out) };
    for proj in project_dirs.flatten() {
        if !proj.path().is_dir() { continue; }
        let Ok(entries) = std::fs::read_dir(proj.path()) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            let Ok(ft) = e.file_type() else { continue };
            if !ft.is_dir() || !session_uuid(name) { continue; }
            collect_agents(&path.join("subagents"), name, 5, &mut out);
        }
    }
    Ok(dedup_agents(out))
}

pub fn scan_projects(claude_dir: &Path) -> Result<Vec<SessionFile>> {
    let projects = claude_dir.join("projects");
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(&projects) else { return Ok(out) };
    for proj in project_dirs.flatten() {
        if !proj.path().is_dir() { continue; }
        let Ok(entries) = std::fs::read_dir(proj.path()) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_file() || path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            let Ok(md) = e.metadata() else { continue };
            let mtime = md.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(SessionFile { path: path.clone(), session_id: stem.to_string(), size: md.len(), mtime });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_top_level_jsonl_only() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-Users-dev-work");
        fs::create_dir_all(proj.join("11111111-1111-1111-1111-111111111111").join("subagents")).unwrap();
        fs::write(proj.join("11111111-1111-1111-1111-111111111111.jsonl"), "{}").unwrap();
        fs::write(
            proj.join("11111111-1111-1111-1111-111111111111").join("subagents").join("agent-1.jsonl"),
            "{}",
        ).unwrap();
        fs::write(proj.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(proj.join("memory")).unwrap();

        let files = scan_projects(tmp.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].session_id, "11111111-1111-1111-1111-111111111111");
        assert!(files[0].path.ends_with("11111111-1111-1111-1111-111111111111.jsonl"));
        assert!(files[0].size > 0);
    }

    #[test]
    fn missing_projects_dir_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_projects(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn finds_subagents_nested_and_across_project_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "11111111-1111-1111-1111-111111111111";
        let p1 = tmp.path().join("projects").join("-Users-dev-work");
        let p2 = tmp.path().join("projects").join("-Users-dev-work-app");
        // plain agent beside the transcript's project dir
        fs::create_dir_all(p1.join(sid).join("subagents")).unwrap();
        fs::write(p1.join(sid).join("subagents").join("agent-aaa111.jsonl"), "{}").unwrap();
        fs::write(p1.join(sid).join("subagents").join("agent-aaa111.meta.json"), "{}").unwrap();
        // workflow agent nested a level deeper, in a DIFFERENT project dir
        // (sidecars follow the session's current cwd)
        let wf = p2.join(sid).join("subagents").join("workflows").join("wf_x");
        fs::create_dir_all(&wf).unwrap();
        fs::write(wf.join("agent-bbb222.jsonl"), "{}").unwrap();
        // distractors: non-uuid dir, memory dir, tool-results
        fs::create_dir_all(p1.join("memory")).unwrap();
        fs::create_dir_all(p1.join(sid).join("tool-results")).unwrap();
        fs::write(p1.join(sid).join("tool-results").join("x.txt"), "big").unwrap();

        let agents = scan_subagents(tmp.path()).unwrap();
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().all(|a| a.parent_session_id == sid));
        let ids: Vec<&str> = agents.iter().map(|a| a.agent_id.as_str()).collect();
        assert!(ids.contains(&"aaa111") && ids.contains(&"bbb222"));
    }

    #[test]
    fn duplicate_agent_ids_across_dirs_keep_only_the_newest_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "11111111-1111-1111-1111-111111111111";
        let p1 = tmp.path().join("projects").join("-Users-dev-work").join(sid).join("subagents");
        let p2 = tmp.path().join("projects").join("-Users-dev-work-app").join(sid).join("subagents");
        fs::create_dir_all(&p1).unwrap();
        fs::create_dir_all(&p2).unwrap();
        fs::write(p1.join("agent-dup.jsonl"), "old").unwrap();
        fs::write(p2.join("agent-dup.jsonl"), "newer").unwrap();
        // make mtimes deterministic: p1 older
        let old_t = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let f = fs::File::options().append(true).open(p1.join("agent-dup.jsonl")).unwrap();
        f.set_modified(old_t).unwrap();

        let agents = scan_subagents(tmp.path()).unwrap();
        assert_eq!(agents.len(), 1, "one (session, agent) pair → one file");
        assert!(agents[0].path.starts_with(&p2), "newest copy wins");
        assert_eq!(scan_session_agents(tmp.path(), sid).len(), 1, "same rule for the per-session scan");
    }

    #[test]
    fn symlinked_dirs_under_sidecars_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "11111111-1111-1111-1111-111111111111";
        let side = tmp.path().join("projects").join("-Users-dev-work").join(sid).join("subagents");
        fs::create_dir_all(&side).unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("agent-evil.jsonl"), "{}").unwrap();
        std::os::unix::fs::symlink(&outside, side.join("link")).unwrap();
        assert!(scan_subagents(tmp.path()).unwrap().is_empty(), "symlink must not be followed");
    }
}
