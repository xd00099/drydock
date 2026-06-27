//! Drydock's own settings — NOT ~/.claude. Lives at
//! `<app-data-dir>/settings.json`. Absent file → defaults. A parse error logs
//! and falls back to defaults rather than crashing the app.
//!
//! Example for a LiteLLM / Bedrock / custom-endpoint user:
//! ```json
//! {
//!   "card_model": "my-proxy-sonnet",
//!   "claude_env": { "ANTHROPIC_BASE_URL": "http://localhost:4000" }
//! }
//! ```
//! Set `"card_model": null` to drop the `--model` flag and use the CLI default.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    /// Model for `claude -p --model <x>` card generation. `None` (JSON null)
    /// omits the flag entirely; absent key defaults to "sonnet".
    pub card_model: Option<String>,
    /// Extra environment injected into every claude/shell Drydock spawns —
    /// terminal tabs AND card generation. The escape hatch for endpoints
    /// configured only in `.zshrc` (which a non-interactive login shell skips)
    /// or not in the GUI environment at all.
    pub claude_env: BTreeMap<String, String>,
    /// Whether Drydock injects its Preview-panel artifact tool into the claude
    /// tabs it launches (a per-session `--mcp-config` pointing at the loopback
    /// MCP server). Default on; set `false` to opt out. The loopback server
    /// always listens (it's token-gated), so flipping this only changes whether
    /// new sessions get a token + the injected config.
    pub artifacts_enabled: bool,
    /// Names of the user's own MCP servers that Drydock should hide from the
    /// claude sessions it launches. Drydock never edits ~/.claude; instead it
    /// passes `--disallowedTools mcp__<name>` at spawn, so a disabled server's
    /// tools simply aren't offered to NEW Drydock sessions (its config is left
    /// untouched — re-enable any time).
    pub mcp_disabled: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            card_model: Some("sonnet".to_string()),
            claude_env: BTreeMap::new(),
            artifacts_enabled: true,
            mcp_disabled: Vec::new(),
        }
    }
}

impl Settings {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("drydock settings.json parse error ({e}); using defaults");
                Settings::default()
            }),
            Err(_) => Settings::default(),
        }
    }

    /// Persist to `<data_dir>/settings.json` (Drydock's own dir — never ~/.claude).
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(data_dir.join("settings.json"), json)
    }

    pub fn env_pairs(&self) -> Vec<(String, String)> {
        self.claude_env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

/// Managed Tauri state: the live settings + where to persist them. Toggles from
/// the UI mutate this and write `settings.json`; spawn-time reads (artifact
/// injection, MCP deny-list) pull the current values so a toggle takes effect on
/// the next session without restarting Drydock.
pub struct SettingsState {
    inner: Mutex<Settings>,
    data_dir: PathBuf,
}

impl SettingsState {
    pub fn new(settings: Settings, data_dir: PathBuf) -> Self {
        Self { inner: Mutex::new(settings), data_dir }
    }

    pub fn artifacts_enabled(&self) -> bool {
        self.inner.lock().unwrap().artifacts_enabled
    }

    pub fn mcp_disabled(&self) -> Vec<String> {
        self.inner.lock().unwrap().mcp_disabled.clone()
    }

    pub fn set_artifacts_enabled(&self, on: bool) -> std::io::Result<()> {
        let snapshot = {
            let mut s = self.inner.lock().unwrap();
            s.artifacts_enabled = on;
            s.clone()
        };
        snapshot.save(&self.data_dir)
    }

    /// Add/remove a server name from the deny-list (idempotent), then persist.
    pub fn set_mcp_disabled(&self, name: &str, disabled: bool) -> std::io::Result<()> {
        let snapshot = {
            let mut s = self.inner.lock().unwrap();
            s.mcp_disabled.retain(|n| n != name);
            if disabled {
                s.mcp_disabled.push(name.to_string());
            }
            s.clone()
        };
        snapshot.save(&self.data_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_file_uses_sonnet_default() {
        let s = Settings::load(Path::new("/nonexistent-dir-xyz"));
        assert_eq!(s.card_model.as_deref(), Some("sonnet"));
        assert!(s.claude_env.is_empty());
    }

    #[test]
    fn explicit_null_disables_model_flag() {
        let s: Settings = serde_json::from_str(r#"{"card_model": null}"#).unwrap();
        assert_eq!(s.card_model, None);
    }

    #[test]
    fn parses_custom_model_and_env() {
        let s: Settings = serde_json::from_str(
            r#"{"card_model":"proxy-x","claude_env":{"ANTHROPIC_BASE_URL":"http://localhost:4000"}}"#,
        )
        .unwrap();
        assert_eq!(s.card_model.as_deref(), Some("proxy-x"));
        assert_eq!(s.env_pairs(), vec![("ANTHROPIC_BASE_URL".to_string(), "http://localhost:4000".to_string())]);
    }

    #[test]
    fn absent_card_model_key_still_defaults_to_sonnet() {
        // only claude_env present → card_model falls back to the struct default
        let s: Settings = serde_json::from_str(r#"{"claude_env":{}}"#).unwrap();
        assert_eq!(s.card_model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn artifacts_enabled_defaults_on_and_can_be_disabled() {
        assert!(Settings::default().artifacts_enabled);
        let off: Settings = serde_json::from_str(r#"{"artifacts_enabled": false}"#).unwrap();
        assert!(!off.artifacts_enabled);
        // absent key → struct default (on)
        let absent: Settings = serde_json::from_str(r#"{"claude_env":{}}"#).unwrap();
        assert!(absent.artifacts_enabled);
    }

    #[test]
    fn mcp_disabled_defaults_empty_and_parses() {
        assert!(Settings::default().mcp_disabled.is_empty());
        let s: Settings = serde_json::from_str(r#"{"mcp_disabled":["github","sentry"]}"#).unwrap();
        assert_eq!(s.mcp_disabled, vec!["github".to_string(), "sentry".to_string()]);
    }

    #[test]
    fn settings_state_toggles_persist_and_reload() {
        let dir = std::env::temp_dir().join(format!("drydock-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = SettingsState::new(Settings::default(), dir.clone());

        // deny-list add is idempotent and order-stable
        state.set_mcp_disabled("github", true).unwrap();
        state.set_mcp_disabled("github", true).unwrap();
        state.set_mcp_disabled("sentry", true).unwrap();
        state.set_artifacts_enabled(false).unwrap();
        assert_eq!(state.mcp_disabled(), vec!["github".to_string(), "sentry".to_string()]);
        assert!(!state.artifacts_enabled());

        // re-enabling removes just that name
        state.set_mcp_disabled("github", false).unwrap();
        assert_eq!(state.mcp_disabled(), vec!["sentry".to_string()]);

        // the changes round-trip through settings.json
        let reloaded = Settings::load(&dir);
        assert_eq!(reloaded.mcp_disabled, vec!["sentry".to_string()]);
        assert!(!reloaded.artifacts_enabled);
        std::fs::remove_dir_all(&dir).ok();
    }
}
