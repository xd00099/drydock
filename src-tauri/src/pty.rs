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

    /// Kill the child; the reader thread then sees EOF and fires on_exit + cleanup.
    pub fn kill(&self, id: u32) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&id) {
            let _ = s.child.kill();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

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
}
