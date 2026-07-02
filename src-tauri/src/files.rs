//! Session-file commands: full-fidelity transcript pages for the rich
//! transcript view, and markdown export to the Downloads folder. All reads go
//! through the synced transcript path recorded by the indexer — nothing here
//! writes under ~/.claude.

use crate::index::AppDb;
use drydock_core::transcript::{self, Entry, Page};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

fn transcript_file(db: &State<AppDb>, session_id: &str) -> Result<PathBuf, String> {
    let store = db.0.lock().unwrap();
    let p = store
        .transcript_path(session_id)
        .map_err(|e| e.to_string())?
        .ok_or("no transcript file for this session yet")?;
    Ok(PathBuf::from(p))
}

/// Structured transcript entries from `from_offset` (0 for the initial load;
/// pass back `next_offset` to tail a live session incrementally).
#[tauri::command]
pub fn session_transcript(db: State<'_, AppDb>, session_id: String, from_offset: u64) -> Result<Page, String> {
    let path = transcript_file(&db, &session_id)?;
    transcript::read_page(&path, from_offset).map_err(|e| e.to_string())
}

/// A non-colliding path in `dir` for `filename`: the name as-is if free, else
/// "stem (1).ext", "stem (2).ext", … like a browser's download de-duping.
pub fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let first = dir.join(filename);
    if !first.exists() {
        return first;
    }
    let p = Path::new(filename);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("artifact");
    let ext = p.extension().and_then(|e| e.to_str());
    for n in 1..1000 {
        let name = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    first // give up after 999 — fall back to overwriting the original name
}

fn fmt_ts(ts: Option<i64>) -> String {
    use chrono::TimeZone;
    ts.and_then(|ms| chrono::Local.timestamp_millis_opt(ms).single())
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Render entries as a readable Markdown document. Thinking, tool results and
/// meta/caveat noise are left out; tool calls become one-line bullets so the
/// narrative of what happened survives without the raw output dumps.
fn export_markdown(title: &str, project: &str, entries: &[Entry]) -> String {
    let mut out = format!("# {title}\n\n*Claude Code session · {project} · exported from Drydock*\n");
    for e in entries {
        match e.kind.as_str() {
            "user" if !e.meta => {
                let when = fmt_ts(e.ts);
                let suffix = if when.is_empty() { String::new() } else { format!(" · {when}") };
                out.push_str(&format!("\n---\n\n**You{suffix}:**\n\n{}\n", e.text));
            }
            "assistant" => out.push_str(&format!("\n**Claude:**\n\n{}\n", e.text)),
            "tool_use" => {
                let tool = e.tool.as_deref().unwrap_or("tool");
                out.push_str(&format!("\n- ⏺ {tool}: {}\n", e.text));
            }
            "recap" => out.push_str(&format!("\n> ※ recap: {}\n", e.text)),
            "compact" => out.push_str("\n> *(conversation compacted)*\n"),
            _ => {} // thinking, tool_result, meta noise
        }
    }
    out
}

/// Export the whole transcript as Markdown into Downloads (deduped name), then
/// reveal it in Finder. Returns the written path.
#[tauri::command]
pub fn export_transcript(app: AppHandle, db: State<'_, AppDb>, session_id: String) -> Result<String, String> {
    let (title, project) = {
        let store = db.0.lock().unwrap();
        let row = store
            .get_session(&session_id)
            .map_err(|e| e.to_string())?
            .ok_or("session not indexed")?;
        (row.title, row.project_path)
    };
    let path = transcript_file(&db, &session_id)?;
    let page = transcript::read_page(&path, 0).map_err(|e| e.to_string())?;
    let md = export_markdown(&title, &project, &page.entries);
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "couldn't find your Downloads folder".to_string())?;
    let dest = unique_path(&dir, &format!("{}.md", crate::artifacts::sanitize_filename(&title)));
    std::fs::write(&dest, md).map_err(|e| format!("couldn't write the file: {e}"))?;
    let _ = std::process::Command::new("open").arg("-R").arg(&dest).spawn();
    Ok(dest.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(kind: &str, text: &str) -> Entry {
        Entry {
            kind: kind.into(),
            text: text.into(),
            tool: None,
            tool_use_id: None,
            meta: false,
            error: false,
            ts: None,
        }
    }

    #[test]
    fn unique_path_dedupes_existing_names() {
        let dir = std::env::temp_dir().join(format!("drydock-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // free name → used as-is
        assert_eq!(unique_path(&dir, "x.html"), dir.join("x.html"));
        // taken → next free " (n)" variant, extension preserved
        std::fs::write(dir.join("x.html"), b"").unwrap();
        assert_eq!(unique_path(&dir, "x.html"), dir.join("x (1).html"));
        std::fs::write(dir.join("x (1).html"), b"").unwrap();
        assert_eq!(unique_path(&dir, "x.html"), dir.join("x (2).html"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_includes_dialog_and_tools_but_not_noise() {
        let mut caveat = e("user", "<local-command-caveat>x</local-command-caveat>");
        caveat.meta = true;
        let mut tool = e("tool_use", "src/app.ts");
        tool.tool = Some("Edit".into());
        let entries = vec![
            caveat,
            e("user", "fix the bug"),
            e("thinking", "hmm let me look"),
            e("assistant", "On it — patching now."),
            tool,
            e("tool_result", "updated"),
            e("recap", "Fixed the bug."),
            e("compact", "conversation compacted"),
        ];
        let md = export_markdown("Bug fix", "/Users/dev/work", &entries);
        assert!(md.starts_with("# Bug fix"));
        assert!(md.contains("**You:**\n\nfix the bug"));
        assert!(md.contains("**Claude:**\n\nOn it — patching now."));
        assert!(md.contains("- ⏺ Edit: src/app.ts"));
        assert!(md.contains("> ※ recap: Fixed the bug."));
        assert!(md.contains("*(conversation compacted)*"));
        assert!(!md.contains("local-command-caveat"), "meta noise stays out");
        assert!(!md.contains("hmm let me look"), "thinking stays out");
        assert!(!md.contains("updated"), "tool results stay out");
    }

    #[test]
    fn export_stamps_timestamped_user_turns() {
        let mut u = e("user", "hello");
        u.ts = Some(1_780_308_000_000); // 2026-06-01 UTC
        let md = export_markdown("T", "/p", &[u]);
        assert!(md.contains("**You · 2026-"), "user turn carries its date: {md}");
    }
}
