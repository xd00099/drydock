//! "Is there a newer Drydock?" — a lightweight check against GitHub Releases.
//!
//! Deliberately dependency-free: macOS ships curl, and this is one small GET
//! per day, so shelling out beats compiling a whole HTTP stack into the app.
//! The command is `(async)` so the network wait never blocks the main thread.

use std::process::Command;

/// The page the update button opens. Fixed constant — no frontend-supplied
/// URL ever reaches `open`.
const RELEASES_PAGE: &str = "https://github.com/xd00099/drydock/releases/latest";
const RELEASES_API: &str = "https://api.github.com/repos/xd00099/drydock/releases/latest";

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    /// Latest released version, normalized (no leading `v`).
    pub latest: String,
    pub newer: bool,
}

/// "v1.2.3" / "1.2.3" / "1.2.3-beta.1" → (1, 2, 3). None if unparseable —
/// callers treat that as "not newer" rather than erroring at the user.
fn parse_ver(s: &str) -> Option<(u64, u64, u64)> {
    let base = s.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = base.split('.');
    let maj = parts.next()?.parse().ok()?;
    let min = parts.next().unwrap_or("0").parse().ok()?;
    let pat = parts.next().unwrap_or("0").parse().ok()?;
    Some((maj, min, pat))
}

fn evaluate(current: &str, tag: &str) -> UpdateInfo {
    let newer = match (parse_ver(current), parse_ver(tag)) {
        (Some(c), Some(t)) => t > c,
        _ => false,
    };
    UpdateInfo {
        current: current.to_string(),
        latest: tag.trim().trim_start_matches(['v', 'V']).to_string(),
        newer,
    }
}

fn extract_tag(body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "unexpected response from GitHub".to_string())?;
    v.get("tag_name")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no releases published yet".to_string())
}

#[tauri::command(async)]
pub fn check_update() -> Result<UpdateInfo, String> {
    let out = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "10",
            "-H",
            "User-Agent: drydock-update-check",
            "-H",
            "Accept: application/vnd.github+json",
            RELEASES_API,
        ])
        .output()
        .map_err(|e| format!("couldn't run curl: {e}"))?;
    if !out.status.success() {
        return Err("update check failed (offline, or no releases yet)".into());
    }
    let tag = extract_tag(&out.stdout)?;
    Ok(evaluate(env!("CARGO_PKG_VERSION"), &tag))
}

#[tauri::command]
pub fn open_releases_page() -> Result<(), String> {
    Command::new("open")
        .arg(RELEASES_PAGE)
        .spawn()
        .map_err(|e| format!("couldn't open the releases page: {e}"))?;
    Ok(())
}

/// Version shown in the sidebar footer. Comes from Cargo.toml, which the
/// release script keeps in lockstep with package.json / tauri.conf.json.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_version_shapes() {
        assert_eq!(parse_ver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_ver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_ver("V0.10.0"), Some((0, 10, 0)));
        assert_eq!(parse_ver("1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_ver("2.0"), Some((2, 0, 0)));
        assert_eq!(parse_ver("nightly"), None);
        assert_eq!(parse_ver(""), None);
    }

    #[test]
    fn newer_means_strictly_greater_semver_not_string_order() {
        assert!(evaluate("0.1.0", "v0.2.0").newer);
        assert!(evaluate("0.9.0", "v0.10.0").newer, "numeric, not lexicographic");
        assert!(!evaluate("0.2.0", "v0.2.0").newer);
        assert!(!evaluate("0.3.0", "v0.2.9").newer, "running a dev build ahead of releases");
    }

    #[test]
    fn unparseable_tags_never_claim_newer() {
        let info = evaluate("0.1.0", "latest");
        assert!(!info.newer);
        assert_eq!(info.latest, "latest");
    }

    #[test]
    fn extracts_tag_from_release_json_and_rejects_junk() {
        let body = br#"{"tag_name": "v0.2.0", "name": "Drydock 0.2.0", "assets": []}"#;
        assert_eq!(extract_tag(body).unwrap(), "v0.2.0");
        assert!(extract_tag(b"not json").is_err());
        // GitHub's "no releases" 404 body has no tag_name
        assert!(extract_tag(br#"{"message": "Not Found"}"#).is_err());
    }
}
