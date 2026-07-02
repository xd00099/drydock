use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// PTY registry with no Tauri dependency: callers provide output/exit callbacks,
/// so it unit-tests with plain `cargo test` and wires to any event system.
#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    /// Extra env injected into every spawned process (Drydock settings'
    /// `claude_env`, e.g. ANTHROPIC_BASE_URL for a custom endpoint).
    extra_env: Arc<Vec<(String, String)>>,
}

impl PtyManager {
    /// Construct with environment injected into every spawn.
    pub fn with_env(env: Vec<(String, String)>) -> Self {
        Self { sessions: Default::default(), extra_env: Arc::new(env) }
    }

    /// Spawn `program args` in a fresh PTY under caller-chosen `id`.
    /// `on_output` fires per read chunk; `on_exit` fires once with the exit code.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        id: u32,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        on_output: impl Fn(u32, &[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32, Option<u32>) + Send + 'static,
    ) -> Result<()> {
        if self.sessions.lock().unwrap().contains_key(&id) {
            return Err(anyhow!("pty {id} already exists"));
        }
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        if let Some(c) = cwd {
            cmd.cwd(c);
        }
        cmd.env("TERM", "xterm-256color");
        // xterm.js renders 24-bit color; advertise it so Claude (and other TUIs)
        // emit truecolor instead of quantizing to the 256-color palette.
        cmd.env("COLORTERM", "truecolor");
        // Claude Code's fullscreen renderer draws in the ALTERNATE screen, where
        // the conversation never reaches the terminal's scrollback — ⌘F, wheel
        // scrolling, and selection can't span the session (xterm.js discards
        // lines that scroll off the alt screen). Force the classic inline
        // renderer instead: output flows into normal scrollback like any CLI,
        // and search/scroll behave like iTerm. Overridable via the settings
        // claude_env (extra_env below is applied after, and last write wins).
        cmd.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1");
        for (k, v) in self.extra_env.iter() {
            cmd.env(k, v);
        }
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        self.sessions
            .lock()
            .unwrap()
            .insert(id, Session { master: pair.master, writer, child });

        let sessions = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(id, &buf[..n]),
                }
            }
            let code = {
                let mut map = sessions.lock().unwrap();
                map.remove(&id)
                    .and_then(|mut s| s.child.wait().ok())
                    .map(|st| st.exit_code())
            };
            on_exit(id, code);
        });
        Ok(())
    }

    pub fn write(&self, id: u32, bytes: &[u8]) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(&id).ok_or_else(|| anyhow!("no pty {id}"))?;
        s.writer.write_all(bytes)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or_else(|| anyhow!("no pty {id}"))?;
        s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    /// True when no PTYs are live; the reader thread removes entries on exit,
    /// so a non-empty map means sessions are still running.
    pub fn is_empty(&self) -> bool {
        self.sessions.lock().unwrap().is_empty()
    }

    /// OS process id of the child behind `id`, while it's still live.
    pub fn pid(&self, id: u32) -> Option<u32> {
        self.sessions.lock().unwrap().get(&id).and_then(|s| s.child.process_id())
    }

    /// Kill the child; the reader thread then sees EOF and fires on_exit + cleanup.
    pub fn kill(&self, id: u32) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&id) {
            let _ = s.child.kill();
        }
        Ok(())
    }

    /// Terminate every live session — used when quitting Drydock so no claude
    /// process is left running in the background. Each PTY slave is its own
    /// session/group leader (the pty layer calls setsid), so signalling the
    /// negative pid hits the WHOLE group: claude AND anything it spawned (MCP
    /// servers, tool subprocesses), not just the foreground process. SIGKILL is
    /// deliberate — quitting must be deterministic, and claude persists its
    /// transcript incrementally so there's nothing to flush.
    pub fn kill_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for s in map.values_mut() {
            #[cfg(unix)]
            if let Some(pid) = s.child.process_id() {
                // SAFETY: a plain kill(2); a stale pid just yields ESRCH.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            }
            let _ = s.child.kill(); // fallback (and the non-unix path)
        }
    }
}

/// Current working directory of a process via the macOS `proc_pidinfo` KPI.
/// Returns None on any error (incl. a dead pid or a process we can't inspect).
///
/// `PROC_PIDVNODEPATHINFO` fills a fixed-ABI `struct proc_vnodepathinfo`
/// (sizeof 2352); its first member `pvi_cdir.vip_path` — the cwd — begins at
/// offset 152 (= sizeof `struct vnode_info`). These constants are stable kernel
/// ABI and are checked at runtime by `process_cwd_reads_own_dir`.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<String> {
    const PROC_PIDVNODEPATHINFO: libc::c_int = 9;
    const SIZE: usize = 2352;
    const CDIR_PATH_OFFSET: usize = 152;
    let mut buf = [0u8; SIZE];
    // SAFETY: buf is exactly SIZE bytes; the kernel writes at most SIZE and
    // returns the byte count. We read only within buf afterward.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDVNODEPATHINFO,
            0,
            buf.as_mut_ptr() as *mut libc::c_void,
            SIZE as libc::c_int,
        )
    };
    if n as usize != SIZE {
        return None; // error, or kernel didn't fill the whole struct
    }
    let path = &buf[CDIR_PATH_OFFSET..];
    let end = path.iter().position(|&b| b == 0)?;
    if end == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&path[..end]).into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn process_cwd(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[cfg(target_os = "macos")]
    #[test]
    fn process_cwd_reads_own_dir() {
        // Validates the proc_pidinfo struct size/offset against ground truth:
        // our own cwd. A wrong offset or size would mismatch here.
        let got = process_cwd(std::process::id()).expect("self cwd readable");
        let want = std::env::current_dir().unwrap();
        assert_eq!(std::fs::canonicalize(got).unwrap(), std::fs::canonicalize(want).unwrap());
    }

    #[test]
    fn process_cwd_of_dead_pid_is_none() {
        // pid 0 is the kernel/scheduler — never inspectable as a vnode cwd.
        assert!(process_cwd(0).is_none());
    }

    #[test]
    fn spawn_collects_output_and_exit() {
        let mgr = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();
        mgr.spawn(
            7,
            "/bin/sh",
            &["-c".into(), "printf drydock-pty-ok".into()],
            None,
            80,
            24,
            move |_id, bytes| { let _ = out_tx.send(bytes.to_vec()); },
            move |_id, code| { let _ = exit_tx.send(code); },
        )
        .unwrap();
        let code = exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(0));
        let mut all = Vec::new();
        while let Ok(chunk) = out_rx.try_recv() { all.extend(chunk); }
        let text = String::from_utf8_lossy(&all);
        assert!(text.contains("drydock-pty-ok"), "got: {text}");
    }

    #[test]
    fn duplicate_id_is_rejected() {
        let mgr = PtyManager::default();
        let ok = |_: u32, _: &[u8]| {};
        let done = |_: u32, _: Option<u32>| {};
        mgr.spawn(1, "/bin/sh", &["-c".into(), "sleep 1".into()], None, 80, 24, ok, done).unwrap();
        let err = mgr.spawn(1, "/bin/sh", &["-c".into(), "true".into()], None, 80, 24, ok, done);
        assert!(err.is_err());
        mgr.kill(1).unwrap();
    }

    #[test]
    fn alt_screen_disable_is_default_but_user_env_overrides() {
        // default: every PTY gets the classic-renderer var...
        let run = |mgr: PtyManager, id: u32| {
            let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
            let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();
            mgr.spawn(
                id,
                "/bin/sh",
                &["-c".into(), "printf %s \"$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN\"".into()],
                None,
                80,
                24,
                move |_id, bytes| { let _ = out_tx.send(bytes.to_vec()); },
                move |_id, code| { let _ = exit_tx.send(code); },
            )
            .unwrap();
            exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut all = Vec::new();
            while let Ok(chunk) = out_rx.try_recv() { all.extend(chunk); }
            String::from_utf8_lossy(&all).into_owned()
        };
        assert!(run(PtyManager::default(), 20).contains('1'));
        // ...and a same-named key in the settings claude_env wins over it
        let custom = PtyManager::with_env(vec![("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN".into(), "0".into())]);
        assert!(run(custom, 21).contains('0'));
    }

    #[test]
    fn extra_env_is_injected_into_spawned_process() {
        let mgr = PtyManager::with_env(vec![("DRYDOCK_TEST_VAR".into(), "endpoint-ok".into())]);
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();
        mgr.spawn(
            8,
            "/bin/sh",
            &["-c".into(), "printf %s \"$DRYDOCK_TEST_VAR\"".into()],
            None,
            80,
            24,
            move |_id, bytes| { let _ = out_tx.send(bytes.to_vec()); },
            move |_id, code| { let _ = exit_tx.send(code); },
        )
        .unwrap();
        exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut all = Vec::new();
        while let Ok(chunk) = out_rx.try_recv() { all.extend(chunk); }
        assert!(String::from_utf8_lossy(&all).contains("endpoint-ok"));
    }

    #[test]
    fn write_to_unknown_id_errors() {
        let mgr = PtyManager::default();
        assert!(mgr.write(99, b"x").is_err());
    }

    #[test]
    fn is_empty_tracks_live_sessions() {
        let mgr = PtyManager::default();
        assert!(mgr.is_empty());
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        mgr.spawn(
            3,
            "/bin/sh",
            &["-c".into(), "sleep 5".into()],
            None,
            80,
            24,
            |_, _| {},
            move |_, _| { let _ = exit_tx.send(()); },
        )
        .unwrap();
        assert!(!mgr.is_empty());
        mgr.kill(3).unwrap();
        // on_exit fires after the reader thread removes the map entry
        exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(mgr.is_empty());
    }

    #[test]
    fn kill_all_terminates_every_session() {
        let mgr = PtyManager::default();
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        for id in [10u32, 11, 12] {
            let tx = exit_tx.clone();
            mgr.spawn(
                id,
                "/bin/sh",
                &["-c".into(), "sleep 30".into()],
                None,
                80,
                24,
                |_, _| {},
                move |_, _| { let _ = tx.send(()); },
            )
            .unwrap();
        }
        assert!(!mgr.is_empty());
        mgr.kill_all();
        // every session's reader sees EOF and fires on_exit
        for _ in 0..3 {
            exit_rx.recv_timeout(Duration::from_secs(5)).expect("session should exit");
        }
        assert!(mgr.is_empty());
    }
}
