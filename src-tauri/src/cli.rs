//! Small shared helpers for invoking installed agent CLIs.
use std::process::Command;

/// Quote one literal argument for a sh/bash/zsh login-shell command.
pub(crate) fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Version string if the Claude CLI resolves in a login shell, else None.
#[tauri::command]
pub fn check_claude() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-l", "-c", "claude --version"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_arguments_are_literal() {
        assert_eq!(sh_single_quote("a'b"), r"'a'\''b'");
        assert_eq!(sh_single_quote("$(cmd) `cmd`"), "'$(cmd) `cmd`'");
    }
}
