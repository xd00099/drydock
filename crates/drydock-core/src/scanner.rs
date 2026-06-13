use anyhow::Result;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct SessionFile {
    pub path: PathBuf,
    pub session_id: String,
    pub size: u64,
    pub mtime: i64, // epoch millis
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
}
