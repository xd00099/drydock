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
/// pass back `next_offset` to tail a live session incrementally). async: reads
/// a whole transcript on first load — keep it off the main thread.
#[tauri::command(async)]
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

/// One touched file plus where it lives NOW. Transcripts record absolute paths
/// at edit time; projects get renamed or moved afterwards, so `path` (the
/// recorded one — the stable display key) and `resolved` (open/reveal target)
/// can differ: equal when the file is still in place, a new location when the
/// resolver relocated it, `None` when it's genuinely gone.
#[derive(Debug, serde::Serialize)]
pub struct FileTouchView {
    pub path: String,
    pub resolved: Option<String>,
    pub edits: i64,
    pub writes: i64,
    pub adds: i64,
    pub dels: i64,
    pub created: bool,
    pub last_ts: Option<i64>,
}

/// `path`'s Normal components (drops the root/prefix), for suffix matching.
fn components(path: &Path) -> Vec<&std::ffi::OsStr> {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// How many trailing components two paths share (≥1 for two paths with the
/// same file name).
fn common_suffix_len(a: &Path, b: &Path) -> usize {
    components(a).iter().rev().zip(components(b).iter().rev()).take_while(|(x, y)| x == y).count()
}

enum SuffixMatch {
    Found(PathBuf, PathBuf), // (relocated file, the root it was found under)
    Ambiguous,               // the longest matching suffix hit several roots — don't guess
    None,
}

/// Try progressively shorter trailing-component suffixes of `recorded` under
/// each candidate root, longest first; a unique hit wins. At least two
/// components must match (a bare file name is too weak for this pass — the
/// filename pass below handles that with a tiebreak).
fn suffix_match(recorded: &Path, roots: &[PathBuf]) -> SuffixMatch {
    let comps = components(recorded);
    for take in (2..=comps.len().saturating_sub(1)).rev() {
        let suffix: PathBuf = comps[comps.len() - take..].iter().collect();
        let mut hits: Vec<(PathBuf, PathBuf)> = Vec::new();
        for r in roots {
            let cand = r.join(&suffix);
            if cand.is_file() {
                hits.push((cand, r.clone()));
            }
        }
        match hits.len() {
            0 => continue,
            1 => {
                let (file, root) = hits.pop().unwrap();
                return SuffixMatch::Found(file, root);
            }
            _ => return SuffixMatch::Ambiguous,
        }
    }
    SuffixMatch::None
}

/// file name → every file with that name under `root`. Bounded (depth, entry
/// count) and skips hidden + dependency/build dirs, so a renamed source dir is
/// findable without ever walking node_modules or target.
fn filename_index(root: &Path) -> std::collections::HashMap<std::ffi::OsString, Vec<PathBuf>> {
    const SKIP: [&str; 6] = ["node_modules", "target", "dist", "build", "out", "vendor"];
    let mut map: std::collections::HashMap<std::ffi::OsString, Vec<PathBuf>> = std::collections::HashMap::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if depth > 12 {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 30_000 {
                return map; // huge tree: serve what we indexed so far
            }
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP.iter().any(|s| name == std::ffi::OsStr::new(s)) {
                    stack.push((e.path(), depth + 1));
                }
            } else if ft.is_file() {
                map.entry(name).or_default().push(e.path());
            }
        }
    }
    map
}

/// Among same-named files, the one sharing the longest trailing path with the
/// recorded location — a strict winner only (a tie means we'd be guessing),
/// and the match must extend past the bare file name (≥ 2 trailing components,
/// i.e. name + parent dir): a name-only hit on README.md/mod.rs/index.ts would
/// confidently "relocate" a deleted file onto an unrelated one.
fn best_by_suffix(recorded: &Path, index: &std::collections::HashMap<std::ffi::OsString, Vec<PathBuf>>) -> Option<PathBuf> {
    let cands = index.get(recorded.file_name()?)?;
    let mut best: Option<(usize, &PathBuf)> = None;
    let mut tied = false;
    for c in cands {
        let s = common_suffix_len(recorded, c);
        match &best {
            None => best = Some((s, c)),
            Some((bs, _)) if s > *bs => {
                best = Some((s, c));
                tied = false;
            }
            Some((bs, _)) if s == *bs => tied = true,
            _ => {}
        }
    }
    match (best, tied) {
        (Some((s, p)), false) if s >= 2 => Some(p.clone()),
        _ => None,
    }
}

/// Resolve every touched file to its current on-disk location. Search scope:
/// the session's own project root while it exists; when the whole root is gone
/// (project renamed/moved), every OTHER indexed project root becomes a
/// candidate. Files the suffix pass can't place fall through to a filename
/// search inside the "home" root — the root the session's other files voted
/// for — which catches inner directory renames (crates/old-core → crates/new-core).
pub(crate) fn resolve_touches(touches: Vec<transcript::FileTouch>, session_root: &str, alt_roots: &[String]) -> Vec<FileTouchView> {
    let root_dir = Path::new(session_root);
    let root_lives = !session_root.is_empty() && root_dir.is_dir();
    let candidates: Vec<PathBuf> = if root_lives {
        vec![root_dir.to_path_buf()]
    } else {
        alt_roots.iter().map(PathBuf::from).filter(|p| p.is_dir()).collect()
    };

    let mut resolved: Vec<Option<PathBuf>> = vec![None; touches.len()];
    let mut votes: std::collections::HashMap<PathBuf, usize> = std::collections::HashMap::new();
    let mut for_name_pass: Vec<usize> = Vec::new();
    for (i, t) in touches.iter().enumerate() {
        let p = Path::new(&t.path);
        if p.is_file() {
            resolved[i] = Some(p.to_path_buf());
            continue;
        }
        match suffix_match(p, &candidates) {
            SuffixMatch::Found(file, root) => {
                resolved[i] = Some(file);
                *votes.entry(root).or_insert(0) += 1;
            }
            SuffixMatch::Ambiguous => {} // honestly gone rather than a guess
            SuffixMatch::None => for_name_pass.push(i),
        }
    }

    if !for_name_pass.is_empty() {
        // ties for home get no filename pass — no root earned our trust
        let home: Option<PathBuf> = if root_lives {
            Some(root_dir.to_path_buf())
        } else {
            let best = votes.iter().max_by_key(|(_, n)| **n);
            best.filter(|(_, n)| votes.values().filter(|m| m == n).count() == 1).map(|(r, _)| r.clone())
        };
        if let Some(home) = home {
            let index = filename_index(&home);
            for i in for_name_pass {
                resolved[i] = best_by_suffix(Path::new(&touches[i].path), &index);
            }
        }
    }

    touches
        .into_iter()
        .zip(resolved)
        .map(|(t, r)| FileTouchView {
            path: t.path,
            resolved: r.map(|p| p.display().to_string()),
            edits: t.edits,
            writes: t.writes,
            adds: t.adds,
            dels: t.dels,
            created: t.created,
            last_ts: t.last_ts,
        })
        .collect()
}

/// Files this session changed (Edit/Write tool calls; errored calls dropped),
/// each resolved to where it lives now, for the Briefing panel's
/// "Files changed" section. async: reads the whole transcript and stats/walks
/// the filesystem — that work must not run on the main thread (it re-runs on
/// every index tick while the panel is open).
#[tauri::command(async)]
pub fn session_files(db: State<'_, AppDb>, session_id: String) -> Result<Vec<FileTouchView>, String> {
    let path = transcript_file(&db, &session_id)?;
    let touches = transcript::files_touched(&path).map_err(|e| e.to_string())?;
    let (session_root, alt_roots) = {
        let store = db.0.lock().unwrap();
        let root = store
            .get_session(&session_id)
            .map_err(|e| e.to_string())?
            .map(|r| r.project_path)
            .unwrap_or_default();
        let mut alts: Vec<String> = store
            .list_sessions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| r.project_path)
            .filter(|p| !p.is_empty() && p != &root)
            .collect();
        alts.sort();
        alts.dedup();
        (root, alts)
    };
    Ok(resolve_touches(touches, &session_root, &alt_roots))
}

/// Open a file in the user's editor (reveal=false) or reveal it in Finder
/// (reveal=true). Editor resolution: the settings `editor_cmd` when set (run
/// via a login shell so PATH-installed CLIs like `code` resolve), else macOS
/// `open`, which honors the user's default app for that file type — with one
/// guard: the fallback refuses executables (and .app bundles, which fail the
/// regular-file check), because `open` would RUN those, and these paths come
/// from transcript records, not from the user typing them.
#[tauri::command]
pub fn open_path(path: String, reveal: bool, settings: State<'_, crate::settings::SettingsState>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    if !p.exists() {
        return Err(format!("not found on disk (moved or deleted?): {path}"));
    }
    if reveal {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("couldn't open Finder: {e}"))?;
        return Ok(());
    }
    match settings.editor_cmd() {
        Some(cmd) if !cmd.trim().is_empty() => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let line = format!("{cmd} {}", crate::enricher::sh_single_quote(&path));
            std::process::Command::new(shell)
                .args(["-l", "-c", &line])
                .spawn()
                .map_err(|e| format!("couldn't run editor_cmd: {e}"))?;
        }
        _ => {
            if !launchable_by_default_app(p) {
                return Err("refusing to open an executable with its default app — use Reveal in Finder, or set editor_cmd in settings".into());
            }
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("couldn't open the file: {e}"))?;
        }
    }
    Ok(())
}

/// Safe for the `open` fallback: a regular, non-executable file. `open` on an
/// executable (or a .app bundle — a directory, so it fails is_file) launches
/// it rather than viewing it.
fn launchable_by_default_app(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 == 0,
        Err(_) => false,
    }
}

/// Export the whole transcript as Markdown into Downloads (deduped name), then
/// reveal it in Finder. Returns the written path. async: full-transcript read
/// + file write, off the main thread.
#[tauri::command(async)]
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

    // ---- path relocation --------------------------------------------------

    fn touch(path: &Path) -> transcript::FileTouch {
        transcript::FileTouch {
            path: path.display().to_string(),
            edits: 1,
            writes: 0,
            adds: 0,
            dels: 0,
            created: false,
            last_ts: None,
        }
    }

    fn plant(root: &Path, rel: &str) -> PathBuf {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        p
    }

    #[test]
    fn resolve_keeps_files_that_exist_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let f = plant(&root, "src/a.rs");
        let got = resolve_touches(vec![touch(&f)], root.to_str().unwrap(), &[]);
        assert_eq!(got[0].resolved.as_deref(), Some(f.to_str().unwrap()));
    }

    #[test]
    fn resolve_relocates_a_wholesale_project_move() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old"); // never created — the project moved away
        let new = tmp.path().join("new");
        let moved = plant(&new, "src-tauri/src/main.rs");
        let other = tmp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let alts = vec![new.display().to_string(), other.display().to_string()];

        let got = resolve_touches(
            vec![touch(&old.join("src-tauri/src/main.rs")), touch(&old.join("nowhere/gone.rs"))],
            old.to_str().unwrap(),
            &alts,
        );
        assert_eq!(got[0].resolved.as_deref(), Some(moved.to_str().unwrap()), "same relative path under the new root");
        assert_eq!(got[1].resolved, None, "a file that exists nowhere stays gone");
    }

    #[test]
    fn resolve_finds_renamed_dirs_by_filename_with_suffix_tiebreak() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old"); // gone
        let new = tmp.path().join("new");
        plant(&new, "docs/plan.md"); // suffix-resolvable → votes `new` as home
        let renamed = plant(&new, "crates/new-core/src/parser.rs");
        plant(&new, "tools/parser.rs"); // same name, weaker trailing match
        let alts = vec![new.display().to_string()];

        let got = resolve_touches(
            vec![touch(&old.join("docs/plan.md")), touch(&old.join("crates/old-core/src/parser.rs"))],
            old.to_str().unwrap(),
            &alts,
        );
        assert!(got[0].resolved.is_some());
        assert_eq!(
            got[1].resolved.as_deref(),
            Some(renamed.to_str().unwrap()),
            "src/parser.rs beats tools/parser.rs on common trailing components"
        );
    }

    #[test]
    fn resolve_gives_up_on_ambiguity() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old"); // gone
        let r1 = tmp.path().join("r1");
        let r2 = tmp.path().join("r2");
        plant(&r1, "src/util.rs");
        plant(&r2, "src/util.rs");
        let alts = vec![r1.display().to_string(), r2.display().to_string()];
        let got = resolve_touches(vec![touch(&old.join("src/util.rs"))], old.to_str().unwrap(), &alts);
        assert_eq!(got[0].resolved, None, "two equally-good homes means no guess");
    }

    #[test]
    fn resolve_rejects_name_only_matches() {
        // a deleted src/x.rs must NOT "relocate" onto an unrelated x.rs whose
        // only common trailing component is the bare file name
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        plant(&root, "docs/readme-ish.md"); // root exists
        plant(&root, "tests/x.rs"); // same name, different parent — too weak
        let got = resolve_touches(vec![touch(&root.join("src/x.rs"))], root.to_str().unwrap(), &[]);
        assert_eq!(got[0].resolved, None, "bare-name matches are guesses, not relocations");
    }

    #[test]
    fn default_app_guard_rejects_executables_and_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let doc = tmp.path().join("notes.md");
        std::fs::write(&doc, b"hi").unwrap();
        assert!(launchable_by_default_app(&doc));
        let exe = tmp.path().join("evil.command");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!launchable_by_default_app(&exe), "executables would be RUN by `open`");
        assert!(!launchable_by_default_app(tmp.path()), "directories (.app bundles) too");
    }

    #[test]
    fn resolve_never_leaves_a_live_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        plant(&root, "README.md"); // root exists
        let elsewhere = tmp.path().join("elsewhere");
        plant(&elsewhere, "src/x.rs"); // tempting, but out of scope
        let got = resolve_touches(
            vec![touch(&root.join("src/x.rs"))],
            root.to_str().unwrap(),
            &[elsewhere.display().to_string()],
        );
        assert_eq!(got[0].resolved, None, "a live root confines the search — the file was deleted");
    }
}
