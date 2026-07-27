use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct LiveSession {
    pub pid: u32,
    pub session_id: String,
    pub status: String, // "busy" | "idle"
    pub updated_at: Option<i64>,
    pub cwd: Option<String>,
    /// Process start time as claude recorded it — `ps -o lstart=` SHAPE, but
    /// rendered in UTC, and carrying no zone to say so. The pid-reuse defense:
    /// compared to the live pid's actual start time before we ever signal it
    /// (see `identity_matches` / `recorded_start_matches`, which compare the
    /// instants — comparing the text made this check fail 100% of the time on
    /// any machine not set to UTC).
    pub proc_start: Option<String>,
}

/// Parse <claude_dir>/sessions/<pid>.json files; keep entries whose pid passes `alive`.
/// Defensive: malformed files and entries without a sessionId are skipped;
/// a missing `status` field (older CLI versions) counts as "idle".
pub fn live_sessions_with(claude_dir: &Path, alive: impl Fn(u32) -> bool) -> Vec<LiveSession> {
    let dir = claude_dir.join("sessions");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(pid) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(session_id) = v.get("sessionId").and_then(Value::as_str) else { continue };
        if !alive(pid) {
            continue;
        }
        let status = match v.get("status").and_then(Value::as_str) {
            Some("busy") => "busy",
            _ => "idle",
        };
        out.push(LiveSession {
            pid,
            session_id: session_id.to_string(),
            status: status.to_string(),
            updated_at: v.get("updatedAt").and_then(Value::as_i64),
            cwd: v.get("cwd").and_then(Value::as_str).map(String::from),
            proc_start: v.get("procStart").and_then(Value::as_str).map(String::from),
        });
    }
    out
}

/// Identity of a running *program*: pid, the exact moment the process started,
/// and the executable name. No later process can reproduce the pid+start pair,
/// which is what makes memoizing the expensive check safe across pid reuse —
/// and `comm` covers the one case that pair misses, since `execve` keeps both
/// the pid and the start time while replacing the program entirely.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcKey {
    pid: u32,
    start_sec: u64,
    start_usec: u64,
    comm: String,
}

/// What one `proc_pidinfo` call tells us about a live process.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq)]
struct ProcInfo {
    /// `pbi_comm`: the executable's basename, cut by the kernel to 15 chars.
    comm: String,
    /// `pbi_name`: the same name with 31 chars of room — it keeps the tail
    /// that `comm` loses.
    name: String,
    key: ProcKey,
}

/// The three answers the kernel gives about a pid. `Denied` exists because
/// collapsing "not allowed to look" into "dead" would silently drop another
/// uid's claude off the radar, and a false negative there is worse than the
/// fork it would save.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq)]
enum Probe {
    Live(ProcInfo),
    /// Exists, belongs to another uid (EPERM) — readable only through `ps`.
    Denied,
    /// No such process: dead, or a zombie its parent hasn't reaped (ESRCH).
    Gone,
}

/// One-syscall snapshot of a process, in place of a fork+exec of `ps`.
///
/// `PROC_PIDTBSDINFO` (flavor 3) fills `struct proc_bsdinfo`, a fixed kernel
/// ABI: 136 bytes, `pbi_comm[16]` at offset 48, `pbi_name[32]` at 64,
/// `pbi_start_tvsec` at 120. Unlike pty.rs's `PROC_PIDVNODEPATHINFO` we don't
/// hand-roll those offsets — libc binds this struct — but the size is still an
/// assumption, so it is checked against the kernel at runtime by
/// `proc_bsdinfo_abi_matches_the_kernel`.
///
/// A zombie reports `Gone`, which is what `ps` effectively said as well
/// ("<defunct>" contains no "claude"). `kill(pid, 0)` would have said ALIVE
/// for a zombie and hung takeover's `wait_gone` poll forever.
///
/// `proc_pidpath` is deliberately not used: it fails outright once the
/// executable has been replaced by a CLI upgrade, which is the normal state of
/// a long-lived claude.
#[cfg(target_os = "macos")]
fn probe_process(pid: u32) -> Probe {
    const SIZE: usize = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: proc_bsdinfo is a POD, so all-zero is a valid value; the kernel
    // writes at most SIZE bytes into it and returns how many it wrote.
    let mut bi: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut bi as *mut libc::proc_bsdinfo as *mut libc::c_void,
            SIZE as libc::c_int,
        )
    };
    if n as usize != SIZE {
        // errno still belongs to the call above: EPERM = someone else's.
        let denied = std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        return if denied { Probe::Denied } else { Probe::Gone };
    }
    let comm = kernel_str(&bi.pbi_comm);
    Probe::Live(ProcInfo {
        name: kernel_str(&bi.pbi_name),
        key: ProcKey {
            pid,
            start_sec: bi.pbi_start_tvsec,
            start_usec: bi.pbi_start_tvusec,
            comm: comm.clone(),
        },
        comm,
    })
}

/// Read a fixed-size kernel char array. It is NUL-terminated when the name
/// fits, but stop at the array bound too rather than trust a terminator we
/// didn't write.
#[cfg(target_os = "macos")]
fn kernel_str(raw: &[libc::c_char]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    let bytes: Vec<u8> = raw[..end].iter().map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Memoized `ps` answers, keyed by process identity.
///
/// A Vec and not a HashMap because `HashMap::new` isn't const — it could not
/// live in a plain `static` without lazy init — and the live set is single
/// digits, where scanning a few tuples beats hashing.
#[cfg(target_os = "macos")]
type ArgvCache = std::sync::Mutex<Vec<(ProcKey, bool)>>;

#[cfg(target_os = "macos")]
static ARGV_CACHE: ArgvCache = std::sync::Mutex::new(Vec::new());

/// Cap on remembered processes. Entries exist only for processes whose
/// executable isn't named claude, so reaching this means a very long uptime
/// with many recycled pids. Forgetting everything costs at most one extra `ps`
/// per still-live session and can never produce a wrong answer.
#[cfg(target_os = "macos")]
const ARGV_CACHE_MAX: usize = 64;

/// Production liveness: the pid exists AND it is a claude (PID-reuse guard — a
/// recycled pid belonging to another claude is vanishingly rare).
///
/// The radar asks this for every session file every 2s forever, so it must not
/// fork: shelling out to `ps` here cost ~259k process spawns a day.
#[cfg(target_os = "macos")]
pub fn process_is_claude(pid: u32) -> bool {
    is_claude_in(&ARGV_CACHE, pid, probe_process(pid), argv_mentions_claude)
}

/// No `proc_pidinfo` outside macOS, and nothing ships there — keep the fork.
#[cfg(not(target_os = "macos"))]
pub fn process_is_claude(pid: u32) -> bool {
    argv_mentions_claude(pid).unwrap_or(false)
}

/// The decision itself, with the kernel probe and the `ps` probe both injected
/// so "at most one fork per process, ever" is testable without spawning
/// anything and without touching the process-wide cache.
#[cfg(target_os = "macos")]
fn is_claude_in(cache: &ArgvCache, pid: u32, probe: Probe, argv: impl Fn(u32) -> Option<bool>) -> bool {
    let info = match probe {
        Probe::Gone => return false,
        // No struct means no identity to key a memo on, so this one pid does
        // keep costing a fork per tick. It is the rare case by construction,
        // and answering it wrongly would hide a running session.
        Probe::Denied => return argv(pid).unwrap_or(false),
        Probe::Live(info) => info,
    };
    // `pbi_comm` is cut to 15 chars and `pbi_name` to 31, so check both: a
    // longer executable name whose "claude" falls past the shorter cut still
    // matches here instead of falling through to a fork.
    let named_claude = info.comm.to_lowercase().contains("claude")
        || info.name.to_lowercase().contains("claude");
    if named_claude {
        return true;
    }
    // Not NAMED claude is not the same as not BEING claude: an npm/node
    // install execs `node` with the CLI as argv[1], and only the full command
    // line reveals that. Read it once, then remember it for this program's
    // whole life — the key pins pid+start+comm, so a recycled pid or an exec
    // is asked again and a dead pid never gets this far.
    if let Some(hit) = cache.lock().unwrap().iter().find(|(k, _)| *k == info.key).map(|e| e.1) {
        return hit;
    }
    // Outside the lock, because this forks; a concurrent probe of the same pid
    // would just compute the identical answer and push a duplicate.
    match argv(pid) {
        // Only a probe that ANSWERED may be memoized. `ps` failing to spawn
        // (EMFILE under a low fd limit, EAGAIN under process pressure) is not
        // evidence that this isn't claude, and caching that "no" would hide a
        // live session for the rest of the app's run — where the old
        // fork-every-tick code silently self-healed 2 seconds later.
        Some(hit) => {
            let mut c = cache.lock().unwrap();
            if c.len() >= ARGV_CACHE_MAX {
                c.clear();
            }
            c.push((info.key, hit));
            hit
        }
        None => false,
    }
}

/// The last-resort identity probe: the FULL command line, which only `ps` can
/// hand us for another process. It stays because an npm/node install of the
/// CLI execs `node` — dropping it would make those users' live sessions
/// silently vanish from the radar, which is far worse than the CPU it costs.
///
/// `None` means ps could not be asked (spawn failed, or it exited non-zero) —
/// distinct from `Some(false)`, "ps answered and this isn't claude", because
/// only the latter is a fact worth remembering.
fn argv_mentions_claude(pid: u32) -> Option<bool> {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("claude"))
}

pub fn live_sessions(claude_dir: &Path) -> Vec<LiveSession> {
    live_sessions_with(claude_dir, process_is_claude)
}

/// When the live pid started, in epoch seconds. `None` if the pid is gone.
///
/// An INSTANT, not a rendered string, because the two sides of the identity
/// check don't agree on how to render one: claude writes `procStart` in UTC,
/// while `ps -o lstart=` prints local time. Comparing the text made
/// `identity_matches` false for every session on any machine not set to UTC —
/// i.e. takeover was dead — and no amount of care in the formatting would have
/// made string equality the right tool. See `recorded_start_matches`.
#[cfg(target_os = "macos")]
pub fn process_start_epoch(pid: u32) -> Option<i64> {
    match probe_process(pid) {
        Probe::Live(info) => Some(info.key.start_sec as i64),
        // Another uid's process: the kernel won't describe it to us, but ps will.
        Probe::Denied => start_epoch_via_ps(pid),
        Probe::Gone => None,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn process_start_epoch(pid: u32) -> Option<i64> {
    start_epoch_via_ps(pid)
}

/// Start time for a process we can't inspect directly, via ps(1). Its `lstart`
/// is rendered in LOCAL time, so that's how it is read back.
fn start_epoch_via_ps(pid: u32) -> Option<i64> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let naive = chrono::NaiveDateTime::parse_from_str(&text, LSTART_FMT).ok()?;
    chrono::TimeZone::from_local_datetime(&chrono::Local, &naive).earliest().map(|t| t.timestamp())
}

/// The shape both claude and ps(1) render a start time in: `Mon Jul 27
/// 21:24:44 2026`. `%e` is the space-padded day, which is what strftime's `%c`
/// produces in the C and en_US locales.
const LSTART_FMT: &str = "%a %b %e %H:%M:%S %Y";

/// Seconds of slack between the recorded start and the kernel's. Both are
/// whole seconds describing the same event, so this only absorbs a rounding
/// difference — it stays far too tight for an unrelated process to slip
/// through, which is the entire job of this check.
const START_TOLERANCE_SECS: i64 = 1;

/// Does the `procStart` string a session recorded describe a process that
/// started at `actual` (epoch seconds)?
///
/// The string carries no zone. Observed reality (every session file on this
/// machine, across CLI 2.1.187 and 2.1.220) is that claude renders it in UTC,
/// so that reading is tried first — but a build that rendered LOCAL time would
/// be indistinguishable from the text alone, and silently failing every
/// takeover is exactly the bug this replaces. So either reading is accepted:
/// the wrong one is simply off by the UTC offset and never matches, while
/// requiring the right one to be guessed would re-introduce the failure.
///
/// An unparseable string means we learned nothing, and is treated like a
/// session that recorded no `procStart` at all (see `identity_matches_with`):
/// the "is it still a claude" test carries the check on its own rather than
/// making an unknown format refuse every takeover.
fn recorded_start_matches(recorded: &str, actual: i64) -> bool {
    let Ok(naive) = chrono::NaiveDateTime::parse_from_str(recorded.trim(), LSTART_FMT) else {
        return true; // unreadable, so it cannot contradict anything
    };
    let as_utc = naive.and_utc().timestamp();
    let as_local = chrono::TimeZone::from_local_datetime(&chrono::Local, &naive)
        .earliest()
        .map(|t| t.timestamp());
    let close = |t: i64| (t - actual).abs() <= START_TOLERANCE_SECS;
    close(as_utc) || as_local.is_some_and(close)
}

/// Exact identity of a pid-file entry: the pid is a live claude AND — when the
/// file recorded a `procStart` — the live pid's start time still matches. This
/// is what makes killing safe: a recycled pid now owned by an unrelated
/// "claude"-ish process (Claude.app, an MCP server, `claude mcp serve`) fails
/// the start-time check even though it passes the command substring test. A
/// file with no procStart (older CLI) falls back to the substring guard.
pub fn identity_matches(s: &LiveSession) -> bool {
    identity_matches_with(s, process_is_claude, process_start_epoch)
}

pub fn identity_matches_with(
    s: &LiveSession,
    is_claude: impl Fn(u32) -> bool,
    start: impl Fn(u32) -> Option<i64>,
) -> bool {
    if !is_claude(s.pid) {
        return false;
    }
    match &s.proc_start {
        // A pid with no readable start time can't be vouched for: it is gone
        // (so there is nothing to take over) or unreadable, and either way we
        // must not hand it to a kill.
        Some(recorded) => start(s.pid).is_some_and(|actual| recorded_start_matches(recorded, actual)),
        None => true,
    }
}

/// Locate the live process owning one session — the takeover locator. Unlike
/// the radar's display scan this VERIFIES identity (pid-reuse safe) and, when
/// stale duplicate files claim the same sessionId (a SIGKILLed claude never
/// unlinks its file), picks the freshest surviving one by `updatedAt` rather
/// than arbitrary directory order. None = not verifiably running right now.
pub fn find_live(claude_dir: &Path, session_id: &str) -> Option<LiveSession> {
    find_live_with(claude_dir, session_id, identity_matches)
}

pub fn find_live_with(claude_dir: &Path, session_id: &str, ok: impl Fn(&LiveSession) -> bool) -> Option<LiveSession> {
    let mut matches: Vec<LiveSession> = live_sessions_with(claude_dir, |_| true)
        .into_iter()
        .filter(|s| s.session_id == session_id && ok(s))
        .collect();
    matches.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)); // freshest first
    matches.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_reg(dir: &std::path::Path, pid: u32, json: &str) {
        let d = dir.join("sessions");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(format!("{pid}.json")), json).unwrap();
    }

    #[test]
    fn parses_registry_and_filters_dead_pids() {
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 101, r#"{"pid":101,"sessionId":"aaa","cwd":"/p","status":"busy","updatedAt":5}"#);
        write_reg(tmp.path(), 102, r#"{"pid":102,"sessionId":"bbb","status":"idle"}"#);
        write_reg(tmp.path(), 103, r#"{"pid":103,"sessionId":"ccc","status":"busy"}"#);
        write_reg(tmp.path(), 104, r#"not json"#);
        // v2.1.114-era entry without status — counts as idle
        write_reg(tmp.path(), 105, r#"{"pid":105,"sessionId":"eee"}"#);

        let live = live_sessions_with(tmp.path(), |pid| pid != 103); // 103 is dead
        let mut ids: Vec<_> = live.iter().map(|l| (l.session_id.as_str(), l.status.as_str())).collect();
        ids.sort();
        assert_eq!(ids, vec![("aaa", "busy"), ("bbb", "idle"), ("eee", "idle")]);
    }

    #[test]
    fn missing_registry_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(live_sessions_with(tmp.path(), |_| true).is_empty());
    }

    #[test]
    fn find_live_matches_session_and_respects_liveness() {
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 201, r#"{"pid":201,"sessionId":"want","status":"busy","cwd":"/w"}"#);
        write_reg(tmp.path(), 202, r#"{"pid":202,"sessionId":"other","status":"idle"}"#);
        let hit = find_live_with(tmp.path(), "want", |_| true).unwrap();
        assert_eq!((hit.pid, hit.status.as_str(), hit.cwd.as_deref()), (201, "busy", Some("/w")));
        assert!(find_live_with(tmp.path(), "want", |s| s.pid != 201).is_none()); // fails identity
        assert!(find_live_with(tmp.path(), "missing", |_| true).is_none());
    }

    #[test]
    fn find_live_prefers_freshest_of_duplicate_session_files() {
        // A SIGKILLed claude leaves its pid file behind; on pid reuse two files
        // can claim one sessionId. The freshest updatedAt wins deterministically.
        let tmp = tempfile::tempdir().unwrap();
        write_reg(tmp.path(), 301, r#"{"pid":301,"sessionId":"dup","status":"idle","updatedAt":100}"#);
        write_reg(tmp.path(), 302, r#"{"pid":302,"sessionId":"dup","status":"busy","updatedAt":900}"#);
        let hit = find_live_with(tmp.path(), "dup", |_| true).unwrap();
        assert_eq!(hit.pid, 302);
    }

    /// Epoch seconds for a UTC wall-clock, for readable fixtures below.
    fn utc(s: &str) -> i64 {
        chrono::NaiveDateTime::parse_from_str(s, LSTART_FMT).unwrap().and_utc().timestamp()
    }

    #[test]
    fn identity_matches_checks_start_time_when_present() {
        let base = LiveSession {
            pid: 42, session_id: "s".into(), status: "idle".into(),
            updated_at: None, cwd: None, proc_start: Some("Fri Jul 10 17:05:10 2026".into()),
        };
        let started = utc("Fri Jul 10 17:05:10 2026");
        // right command, right start time → ok
        assert!(identity_matches_with(&base, |_| true, |_| Some(started)));
        // right command, DIFFERENT start time (pid reused) → refused
        assert!(!identity_matches_with(&base, |_| true, |_| Some(utc("Thu Jan  1 00:00:00 2026"))));
        // not claude at all → refused regardless of start time
        assert!(!identity_matches_with(&base, |_| false, |_| Some(started)));
        // a pid whose start time can't be read is gone or unreadable — either
        // way it must not be handed to a kill
        assert!(!identity_matches_with(&base, |_| true, |_| None));
        // older CLI wrote no procStart → substring guard alone decides
        let no_start = LiveSession { proc_start: None, ..base.clone() };
        assert!(identity_matches_with(&no_start, |_| true, |_| None));
        assert!(!identity_matches_with(&no_start, |_| false, |_| None));
    }

    #[test]
    fn a_utc_recorded_start_matches_a_local_machine() {
        // THE BUG: claude renders procStart in UTC, ps -o lstart= prints local
        // time, and the old code compared the two as strings — so on any
        // machine not set to UTC every takeover was refused with "session is
        // not running anymore". Real values captured from this machine
        // (America/Los_Angeles, UTC-7): the registry said 21:24:44 while ps
        // said 14:24:44, for one and the same process.
        let recorded = "Mon Jul 27 21:24:44 2026";
        let actual = utc(recorded); // what the kernel reports for that process
        assert!(recorded_start_matches(recorded, actual), "the UTC reading must match");

        let s = LiveSession {
            pid: 78609, session_id: "s".into(), status: "idle".into(),
            updated_at: None, cwd: None, proc_start: Some(recorded.into()),
        };
        assert!(identity_matches_with(&s, |_| true, |_| Some(actual)), "takeover must be possible");
    }

    #[test]
    fn a_locally_rendered_start_also_matches() {
        // Robustness, not observed behaviour: the string carries no zone, so a
        // build that wrote LOCAL time would be textually identical. Accepting
        // both readings means such a build degrades to "no extra guard"
        // instead of silently refusing every takeover — the failure we just
        // spent this change removing.
        let naive =
            chrono::NaiveDateTime::parse_from_str("Fri Jul 10 17:05:10 2026", LSTART_FMT).unwrap();
        let as_local = chrono::TimeZone::from_local_datetime(&chrono::Local, &naive)
            .earliest()
            .unwrap()
            .timestamp();
        assert!(recorded_start_matches("Fri Jul 10 17:05:10 2026", as_local));
    }

    #[test]
    fn the_pid_reuse_guard_still_bites() {
        let recorded = "Mon Jul 27 21:24:44 2026";
        let actual = utc(recorded);
        // a second either way is rounding; a minute is a different process
        assert!(recorded_start_matches(recorded, actual + 1));
        assert!(recorded_start_matches(recorded, actual - 1));
        assert!(!recorded_start_matches(recorded, actual + 60));
        assert!(!recorded_start_matches(recorded, actual - 60));
        // ...and the classic case: same pid, recycled hours later
        assert!(!recorded_start_matches(recorded, actual + 3 * 3600));
    }

    #[test]
    fn an_unreadable_recorded_start_does_not_refuse_everything() {
        // A format we can't parse tells us nothing, so it must behave like the
        // older CLIs that wrote no procStart at all: fall back to the
        // is-it-claude test rather than making every takeover impossible.
        assert!(recorded_start_matches("whenever o'clock", 1_785_187_484));
        assert!(recorded_start_matches("", 1_785_187_484));
        // single-digit days are space-padded by strftime %e — still parseable
        assert!(recorded_start_matches("Tue Jul  7 09:05:01 2026", utc("Tue Jul  7 09:05:01 2026")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn process_start_epoch_agrees_with_ps_for_our_own_process() {
        // Ground truth both ways: the syscall's epoch must describe the same
        // instant ps(1) prints in local time for this very process.
        let me = std::process::id();
        let ours = process_start_epoch(me).expect("our own start time");
        let via_ps = start_epoch_via_ps(me).expect("ps knows it too");
        assert!((ours - via_ps).abs() <= 1, "syscall {ours} vs ps {via_ps}");

        let now = chrono::Utc::now().timestamp();
        assert!(ours <= now && ours > now - 86_400, "a plausible start time: {ours}");
        assert_eq!(process_start_epoch(999_999), None, "a pid that cannot exist");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn proc_bsdinfo_abi_matches_the_kernel() {
        // The same guard pty.rs puts on its proc_pidinfo offsets: check the
        // layout assumption against ground truth we can derive independently.
        // A kernel ABI change or a libc struct edit surfaces here instead of as
        // live sessions quietly disappearing from the radar.
        assert_eq!(std::mem::size_of::<libc::proc_bsdinfo>(), 136, "proc_bsdinfo size moved");

        let me = std::process::id();
        let Probe::Live(info) = probe_process(me) else { panic!("our own pid must be Live") };
        assert_eq!(info.key.pid, me, "pbi_pid offset moved");

        // pbi_comm is the executable basename cut to 15 chars, pbi_name to 31.
        let exe = std::env::current_exe().unwrap();
        let base = exe.file_name().unwrap().to_string_lossy().into_owned();
        assert!(base.starts_with(&info.comm), "comm {:?} not a prefix of {:?}", info.comm, base);
        assert!(base.starts_with(&info.name), "name {:?} not a prefix of {:?}", info.name, base);
        assert_eq!(info.comm.len(), base.len().min(15), "pbi_comm offset/truncation moved");
        assert_eq!(info.name.len(), base.len().min(31), "pbi_name offset/truncation moved");

        // A start time that is neither garbage nor in the future proves we read
        // the timeval and not a neighbouring field.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(info.key.start_sec > 1_600_000_000, "start_sec {}", info.key.start_sec);
        assert!(info.key.start_sec <= now, "start {} is in the future", info.key.start_sec);
        assert!(info.key.start_usec < 1_000_000, "tvusec {} out of range", info.key.start_usec);

        // macOS pids top out at 99999, so this one can never exist.
        assert_eq!(probe_process(999_999), Probe::Gone);
        // launchd exists but is root's: telling EPERM apart from ESRCH is what
        // keeps another uid's claude on the radar instead of dropping it.
        assert_eq!(probe_process(1), Probe::Denied, "tests must not run as root");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn argv_probe_runs_once_per_process_identity() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache: ArgvCache = std::sync::Mutex::new(Vec::new());
        let forks = AtomicUsize::new(0);
        let yes = |_: u32| {
            forks.fetch_add(1, Ordering::SeqCst);
            Some(true)
        };
        let node = |pid: u32, start: u64| {
            Probe::Live(ProcInfo {
                comm: "node".into(),
                name: "node".into(),
                key: ProcKey { pid, start_sec: start, start_usec: 0, comm: "node".into() },
            })
        };

        // The 2s radar tick asks the same question forever; it must fork once.
        for _ in 0..50 {
            assert!(is_claude_in(&cache, 7, node(7, 100), yes));
        }
        assert_eq!(forks.load(Ordering::SeqCst), 1, "one ps per process, not per tick");

        // pid 7 recycled: a different start time is a different process, so the
        // stale answer must not be reused.
        assert!(is_claude_in(&cache, 7, node(7, 200), yes));
        assert_eq!(forks.load(Ordering::SeqCst), 2);

        // An executable actually named claude never reaches the fallback.
        let named = Probe::Live(ProcInfo {
            comm: "claude.exe".into(),
            name: "claude.exe".into(),
            key: ProcKey { pid: 8, start_sec: 1, start_usec: 0, comm: "claude.exe".into() },
        });
        assert!(is_claude_in(&cache, 8, named, yes));
        assert_eq!(forks.load(Ordering::SeqCst), 2);

        // A dead pid is dead without asking anyone.
        assert!(!is_claude_in(&cache, 9, Probe::Gone, yes));
        assert_eq!(forks.load(Ordering::SeqCst), 2);

        // Negatives are cached too, or a stale pid file whose pid got recycled
        // by something unrelated would fork every 2s forever.
        let no = |_: u32| {
            forks.fetch_add(1, Ordering::SeqCst);
            Some(false)
        };
        for _ in 0..50 {
            assert!(!is_claude_in(&cache, 10, node(10, 5), no));
        }
        assert_eq!(forks.load(Ordering::SeqCst), 3);

        // Another uid's process has no readable identity to memoize, but it
        // must still be asked every time rather than silently dropped.
        assert!(is_claude_in(&cache, 11, Probe::Denied, yes));
        assert!(is_claude_in(&cache, 11, Probe::Denied, yes));
        assert_eq!(forks.load(Ordering::SeqCst), 5);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_ps_that_could_not_run_is_never_remembered() {
        // The memo's hazard: `ps` failing to SPAWN (EMFILE when many PTY tabs
        // and DB handles are open, EAGAIN under process pressure) is not
        // evidence that a process isn't claude. Caching that "no" would drop a
        // live session off the radar for the rest of the app's run, where the
        // old fork-every-tick code recovered 2 seconds later.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache: ArgvCache = std::sync::Mutex::new(Vec::new());
        let calls = AtomicUsize::new(0);
        // fails once, then answers truthfully forever after
        let flaky = |_: u32| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 { None } else { Some(true) }
        };
        let node = Probe::Live(ProcInfo {
            comm: "node".into(),
            name: "node".into(),
            key: ProcKey { pid: 42, start_sec: 7, start_usec: 0, comm: "node".into() },
        });

        assert!(!is_claude_in(&cache, 42, node.clone(), flaky), "no answer -> not claimed live");
        assert!(cache.lock().unwrap().is_empty(), "a failed probe must not be memoized");
        // the very next tick recovers, and only THAT answer is remembered
        assert!(is_claude_in(&cache, 42, node.clone(), flaky), "the session comes back");
        assert!(is_claude_in(&cache, 42, node, flaky));
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one retry, then memoized");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_exec_invalidates_the_memo() {
        // execve keeps the pid AND the start time while replacing the program,
        // so pid+start alone would hand a wrapper's answer to whatever it
        // became. comm is in the key precisely to catch that.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache: ArgvCache = std::sync::Mutex::new(Vec::new());
        let forks = AtomicUsize::new(0);
        let ask = |_: u32| {
            forks.fetch_add(1, Ordering::SeqCst);
            Some(true)
        };
        let as_prog = |prog: &str| {
            Probe::Live(ProcInfo {
                comm: prog.into(),
                name: prog.into(),
                key: ProcKey { pid: 5, start_sec: 9, start_usec: 9, comm: prog.into() },
            })
        };
        assert!(is_claude_in(&cache, 5, as_prog("sh"), ask));
        assert!(is_claude_in(&cache, 5, as_prog("sh"), ask));
        assert_eq!(forks.load(Ordering::SeqCst), 1, "same program, memoized");
        // same pid, same start time, different program: ask again
        assert!(is_claude_in(&cache, 5, as_prog("node"), ask));
        assert_eq!(forks.load(Ordering::SeqCst), 2, "exec must miss the memo");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn argv_cache_stays_bounded() {
        // Weeks of uptime with recycled pids must not turn the memo into a slow
        // leak. Forgetting is always safe: it costs one extra ps, never a wrong
        // answer, because every entry is re-derived from a live process.
        let cache: ArgvCache = std::sync::Mutex::new(Vec::new());
        for i in 0..(ARGV_CACHE_MAX * 3) as u64 {
            let p = Probe::Live(ProcInfo {
                comm: "node".into(),
                name: "node".into(),
                key: ProcKey { pid: i as u32, start_sec: i, start_usec: 0, comm: "node".into() },
            });
            is_claude_in(&cache, i as u32, p, |_| Some(true));
        }
        assert!(cache.lock().unwrap().len() <= ARGV_CACHE_MAX);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn argv0_only_claude_is_live_and_a_zombie_is_not() {
        use std::time::Duration;
        // An npm/node install execs a binary that is NOT named claude, so only
        // the full argv identifies it. `exec -a` reproduces exactly that shape.
        let mut child = std::process::Command::new("/bin/bash")
            .args(["-c", "exec -a claude sleep 30"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut seen = None;
        for _ in 0..100 {
            if let Probe::Live(i) = probe_process(pid) {
                if i.comm == "sleep" {
                    seen = Some(i); // the in-place exec has landed
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let info = seen.expect("child should exec /bin/sleep");
        assert!(!info.comm.contains("claude") && !info.name.contains("claude"));
        assert!(process_is_claude(pid), "argv-only claude must not vanish from the radar");

        // takeover's wait_gone depends on this: a killed child stays a zombie
        // until its parent reaps it, and kill(pid, 0) SUCCEEDS on a zombie —
        // which is why liveness is proc_pidinfo and not kill(pid, 0).
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        let mut gone = false;
        for _ in 0..100 {
            if !process_is_claude(pid) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "a zombie must not read as a live claude");
        assert_eq!(probe_process(pid), Probe::Gone);
        let _ = child.wait(); // reap only after asserting on the zombie
    }
}
