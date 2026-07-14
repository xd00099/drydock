//! Filesystem navigation for the ⌘N new-session dialog: directory listing for
//! path autocomplete, and create-on-demand for not-yet-existing project
//! folders. Policy: Drydock never writes inside ~/.claude — ensure_dir refuses
//! it (checked both pre- and post-canonicalization so a symlink can't sneak
//! a folder in there).

use std::path::{Path, PathBuf};

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `~` / `~/x` expansion against an explicit home (testable); other paths pass
/// through untouched.
fn expand_home_in(path: &str, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(rest) = path.strip_prefix("~/") {
        home.map(|h| h.join(rest))
    } else if path == "~" {
        home.map(Path::to_path_buf)
    } else {
        Some(PathBuf::from(path))
    }
}

fn list_dirs_in(parent: &str, home: Option<&Path>) -> Vec<String> {
    let Some(dir) = expand_home_in(parent.trim(), home) else { return vec![] };
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.truncate(500);
    names
}

/// Canonicalize a path whose tail may not exist yet: resolve the deepest
/// existing ancestor (following symlinks), then re-append the pending
/// remainder. `None` for unresolvable shapes (a `..` at a nonexistent depth).
fn canonicalize_pending(p: &Path) -> Option<PathBuf> {
    let mut base = p;
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match base.canonicalize() {
            Ok(mut c) => {
                for seg in rest.iter().rev() {
                    c.push(seg);
                }
                return Some(c);
            }
            Err(_) => {
                rest.push(base.file_name()?.to_os_string());
                base = base.parent()?;
            }
        }
    }
}

fn ensure_dir_in(path: &str, home: Option<&Path>) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let p = expand_home_in(trimmed, home).ok_or("cannot resolve home directory")?;
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    // Resolve symlinks BEFORE creating anything: `~/foo → ~/.claude` must be
    // refused with nothing left on disk. The ~/.claude anchor canonicalizes
    // the same way, so a symlinked $HOME can't skew the comparison.
    let canon = canonicalize_pending(&p).ok_or("cannot resolve path")?;
    if let Some(h) = home {
        let claude = canonicalize_pending(&h.join(".claude")).ok_or("cannot resolve path")?;
        if canon.starts_with(&claude) {
            return Err("Drydock does not create folders inside ~/.claude".into());
        }
    }
    std::fs::create_dir_all(&canon).map_err(|e| e.to_string())?;
    let real = canon.canonicalize().map_err(|e| e.to_string())?;
    Ok(real.to_string_lossy().into_owned())
}

/// Subdirectory names of `parent` (~-expanded): dirs only, hidden skipped,
/// case-insensitive sort, capped at 500. Nonexistent/unreadable → empty.
#[tauri::command]
pub fn list_dirs(parent: String) -> Vec<String> {
    list_dirs_in(&parent, home_dir().as_deref())
}

/// ~-expand, validate, `create_dir_all`, return the canonicalized path.
#[tauri::command]
pub fn ensure_dir(path: String) -> Result<String, String> {
    ensure_dir_in(&path, home_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_visible_directories_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("beta")).unwrap();
        std::fs::create_dir(tmp.path().join("Alpha")).unwrap();
        std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
        std::fs::write(tmp.path().join("file.txt"), "x").unwrap();
        let got = list_dirs_in(tmp.path().to_str().unwrap(), None);
        assert_eq!(got, vec!["Alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn missing_parent_lists_empty() {
        assert!(list_dirs_in("/nonexistent/definitely/not", None).is_empty());
    }

    #[test]
    fn tilde_expands_against_home() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("proj")).unwrap();
        let got = list_dirs_in("~", Some(tmp.path()));
        assert_eq!(got, vec!["proj".to_string()]);
    }

    #[test]
    fn creates_nested_and_returns_canonical() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("a/b/c");
        let got = ensure_dir_in(target.to_str().unwrap(), None).unwrap();
        assert!(target.is_dir());
        assert_eq!(PathBuf::from(&got), target.canonicalize().unwrap());
    }

    #[test]
    fn idempotent_on_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let got = ensure_dir_in(tmp.path().to_str().unwrap(), None).unwrap();
        assert_eq!(PathBuf::from(&got), tmp.path().canonicalize().unwrap());
    }

    #[test]
    fn rejects_empty_and_relative() {
        assert!(ensure_dir_in("", None).is_err());
        assert!(ensure_dir_in("  ", None).is_err());
        assert!(ensure_dir_in("relative/path", None).is_err());
    }

    #[test]
    fn refuses_claude_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::create_dir(home.join(".claude")).unwrap();
        let err = ensure_dir_in("~/.claude/evil", Some(home)).unwrap_err();
        assert!(err.contains(".claude"));
        assert!(!home.join(".claude/evil").exists());
    }

    #[test]
    fn refuses_symlink_escape_into_claude() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::create_dir(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.join(".claude"), home.join("innocent")).unwrap();
        let err = ensure_dir_in("~/innocent/evil", Some(home)).unwrap_err();
        assert!(err.contains(".claude"));
        // the refusal must happen BEFORE anything is created through the link
        assert!(!home.join(".claude/evil").exists());
    }

    #[test]
    fn tilde_create_expands_against_home() {
        let tmp = tempfile::tempdir().unwrap();
        let got = ensure_dir_in("~/newproj", Some(tmp.path())).unwrap();
        assert!(tmp.path().join("newproj").is_dir());
        assert!(got.ends_with("newproj"));
    }
}
