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

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
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
    /// MCP server). Default on; set `false` to opt out entirely — no injection,
    /// the server doesn't accept connections.
    pub artifacts_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            card_model: Some("sonnet".to_string()),
            claude_env: BTreeMap::new(),
            artifacts_enabled: true,
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

    pub fn env_pairs(&self) -> Vec<(String, String)> {
        self.claude_env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
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
}
