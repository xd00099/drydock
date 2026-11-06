//! Delete through Codex's own CLI so paginated history and descendants are
//! removed by their owner. Drydock never edits Codex's databases directly.
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

fn valid_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

fn delete_command(shell: &str, executable: &str, dir: &Path, id: &str) -> Result<Command, String> {
    if !valid_uuid(id) { return Err("Refusing to delete a Codex session without an exact UUID.".into()); }
    let mut cmd = Command::new(shell);
    // Login-shell PATH resolution matches agent launches. Pass all data as
    // positional arguments, and pin CODEX_HOME after shell startup so the CLI
    // deletes from the same store that discovery scanned.
    cmd.args(["-l", "-c", r#"CODEX_HOME="$2" exec "$3" delete --force "$1""#,
        "drydock-delete", id]).arg(dir).arg(executable).current_dir(dir);
    Ok(cmd)
}

pub fn delete(dir: &Path, id: &str, cfg: &crate::settings::Settings) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = delete_command(&shell, "codex", dir, id)?;
    for (key, value) in cfg.env_pairs() { cmd.env(key, value); }
    run(cmd)
}

fn run(cmd: Command) -> Result<(), String> {
    crate::collaboration::execute(cmd, Path::new("/dev/null"), &AtomicBool::new(false), Duration::from_secs(30), None)
        .map(|_| ())
        .map_err(|e| format!("Codex could not permanently delete this session: {e}. If your CLI doesn't support `codex delete --force`, update Codex and retry."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    const ID: &str = "01a1aff8-4210-7b01-a7ff-47034045b17a";

    fn executable(dir: &Path, script: &str) -> std::path::PathBuf {
        let path = dir.join("fake codex");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn native_delete_uses_exact_uuid_and_scanned_home_even_with_shell_characters() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("codex home ' $(touch should-not-exist)");
        std::fs::create_dir(&home).unwrap();
        let fake = executable(tmp.path(), "#!/bin/sh\nprintf '%s\\n' \"$CODEX_HOME\" \"$@\" > \"$CODEX_HOME/args\"\n");
        let mut cmd = delete_command("/bin/sh", fake.to_str().unwrap(), &home, ID).unwrap();
        cmd.env("CODEX_HOME", "/wrong-store");
        run(cmd).unwrap();
        let args = std::fs::read_to_string(home.join("args")).unwrap();
        assert_eq!(args.lines().collect::<Vec<_>>(), vec![home.to_str().unwrap(), "delete", "--force", ID]);
        assert!(!home.join("should-not-exist").exists());
    }

    #[test]
    fn delete_refuses_names_partial_ids_and_shell_input() {
        for id in ["session name", "01a1aff8", "------------------------------------", "$(touch /tmp/oops)"] {
            assert!(delete_command("/bin/sh", "codex", Path::new("/tmp"), id).is_err());
        }
    }

    #[test]
    fn native_delete_errors_reach_the_confirmation_dialog() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = executable(tmp.path(), "#!/bin/sh\necho 'thread is running' >&2\nexit 2\n");
        let error = run(delete_command("/bin/sh", fake.to_str().unwrap(), tmp.path(), ID).unwrap()).unwrap_err();
        assert!(error.contains("thread is running"));
    }
}
