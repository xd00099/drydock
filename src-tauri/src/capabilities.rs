//! Read-only enumeration of Claude Code "capabilities" — installed plugin skills
//! and configured MCP servers — surfaced in Drydock's right panel.
//!
//! Reads `~/.claude` only and NEVER writes (the cardinal rule). MCP secrets
//! (`env` / `headers`) are deliberately never returned — only the server name,
//! transport kind, and the command/url. The resolution mirrors Claude Code's own
//! config sources best-effort; it is a reference view, not a live connection.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[derive(Debug, Serialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub plugin: String, // the plugin that provides it (grouping key), or "personal"
}

#[derive(Debug, Serialize)]
pub struct McpServer {
    pub name: String,
    pub kind: String,   // "stdio" | "http" | "sse"
    pub detail: String, // command+args or url; env/headers never read, secrets in argv/url redacted
    pub scope: String,  // where it's configured: "project" | "user" | "global" | "drydock"
    pub builtin: bool,  // true → Drydock's own injected server (drydock-artifacts)
    pub enabled: bool,  // false → Drydock denies its tools to new sessions it launches
    pub tools: Vec<String>, // known tool names (only populated for the builtin server)
}

// ---- skills -------------------------------------------------------------

/// Extract `name` + `description` from a SKILL.md YAML frontmatter block (the
/// region between the first two `---` lines). These files keep both on single
/// lines, so a minimal line parser avoids a YAML dependency.
fn parse_skill_frontmatter(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut name: Option<String> = None;
    let mut description = String::new();
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(v) = line.trim_start().strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').to_string());
        } else if let Some(v) = line.trim_start().strip_prefix("description:") {
            description = v.trim().trim_matches('"').to_string();
        }
    }
    Some((name?, description))
}

/// Each immediate subdir of `dir` that holds a SKILL.md contributes one skill,
/// attributed to `plugin`. Deduped by (plugin, name) so repeated plugin versions
/// don't show the same skill twice.
fn collect_skill_dir(dir: &Path, plugin: &str, out: &mut Vec<Skill>, seen: &mut BTreeSet<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let md = e.path().join("SKILL.md");
        if !md.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&md) else {
            continue;
        };
        if let Some((name, description)) = parse_skill_frontmatter(&text) {
            if seen.insert((plugin.to_string(), name.clone())) {
                out.push(Skill { name, description, plugin: plugin.to_string() });
            }
        }
    }
}

/// Walk `cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md`.
fn collect_plugin_skills(cache: &Path, out: &mut Vec<Skill>, seen: &mut BTreeSet<(String, String)>) {
    let Ok(markets) = std::fs::read_dir(cache) else {
        return;
    };
    for market in markets.flatten() {
        let Ok(plugins) = std::fs::read_dir(market.path()) else {
            continue;
        };
        for plugin in plugins.flatten() {
            let plugin_name = plugin.file_name().to_string_lossy().to_string();
            let Ok(versions) = std::fs::read_dir(plugin.path()) else {
                continue;
            };
            for version in versions.flatten() {
                collect_skill_dir(&version.path().join("skills"), &plugin_name, out, seen);
            }
        }
    }
}

/// All skills available to a session: plugin skills + personal
/// (`~/.claude/skills`) + this project's own (`<project>/.claude/skills`).
/// Personal and project are separate groups (different `plugin` key), so a
/// project skill that shadows a personal one shows under "project" instead of
/// being deduped away.
pub fn skills(project_path: Option<&str>) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    if let Some(home) = home() {
        collect_plugin_skills(&home.join(".claude/plugins/cache"), &mut out, &mut seen);
        collect_skill_dir(&home.join(".claude/skills"), "personal", &mut out, &mut seen);
    }
    if let Some(p) = project_path {
        collect_skill_dir(&Path::new(p).join(".claude/skills"), "project", &mut out, &mut seen);
    }
    out.sort_by(|a, b| a.plugin.cmp(&b.plugin).then_with(|| a.name.cmp(&b.name)));
    out
}

// ---- mcp servers --------------------------------------------------------

/// A flag name that conventionally carries a secret value.
fn flag_is_secretish(flag: &str) -> bool {
    let f = flag.trim_start_matches('-').to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "auth", "credential"]
        .iter()
        .any(|needle| f.contains(needle))
}

/// Redact likely-secret command-line args while keeping the useful package/flag
/// names. `--api-key sk-x` → `--api-key <redacted>`; `--token=x` → `--token=<redacted>`.
/// env/headers are never read; this only guards the rare case of a secret in argv.
fn redact_args(args: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for a in args {
        if redact_next {
            out.push("<redacted>".to_string());
            redact_next = false;
            continue;
        }
        if let Some((flag, _)) = a.split_once('=') {
            if flag.starts_with('-') && flag_is_secretish(flag) {
                out.push(format!("{flag}=<redacted>"));
                continue;
            }
        }
        if a.starts_with('-') && flag_is_secretish(a) {
            out.push(a.to_string());
            redact_next = true; // the following arg is its value
            continue;
        }
        out.push(a.to_string());
    }
    out
}

/// Strip `user:pass@` userinfo from a URL's authority so embedded credentials
/// never reach the UI; the rest of the URL is shown as configured.
fn redact_url(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        let after = &url[scheme_end + 3..];
        let authority_end = after.find('/').unwrap_or(after.len());
        if let Some(at) = after[..authority_end].find('@') {
            return format!("{}://{}", &url[..scheme_end], &after[at + 1..]);
        }
    }
    url.to_string()
}

/// Describe a single server config as (kind, detail), reading only non-secret
/// fields. `url` ⇒ http/sse; `command` ⇒ stdio. env/headers are never read, URL
/// userinfo and secret-shaped args are redacted.
fn describe_server(cfg: &serde_json::Value) -> (String, String) {
    if let Some(url) = cfg.get("url").and_then(|u| u.as_str()) {
        let kind = cfg.get("type").and_then(|t| t.as_str()).unwrap_or("http");
        return (kind.to_string(), redact_url(url));
    }
    if let Some(cmd) = cfg.get("command").and_then(|c| c.as_str()) {
        let args: Vec<&str> = cfg
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let detail = if args.is_empty() {
            cmd.to_string()
        } else {
            format!("{} {}", cmd, redact_args(&args).join(" "))
        };
        return ("stdio".to_string(), detail);
    }
    ("stdio".to_string(), String::new())
}

/// Add every `{ name: config }` entry of an `mcpServers`-shaped object. The first
/// occurrence of a name wins, so callers add higher-precedence sources first.
fn add_servers(obj: &serde_json::Value, scope: &str, out: &mut Vec<McpServer>, seen: &mut BTreeSet<String>) {
    let Some(map) = obj.as_object() else {
        return;
    };
    for (name, cfg) in map {
        if !seen.insert(name.clone()) {
            continue;
        }
        let (kind, detail) = describe_server(cfg);
        // enabled/builtin/tools are filled by the command layer, which knows the
        // Drydock deny-list and the loopback server; here every config-sourced
        // server starts as an enabled, non-builtin entry with no known tools.
        out.push(McpServer { name: name.clone(), kind, detail, scope: scope.to_string(), builtin: false, enabled: true, tools: Vec::new() });
    }
}

/// Read a JSON file and add its top-level `mcpServers` object, if any. Covers
/// `.mcp.json` and `.claude/settings*.json` (both nest under `mcpServers`).
fn add_from_file(path: &Path, scope: &str, out: &mut Vec<McpServer>, seen: &mut BTreeSet<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    if let Some(obj) = v.get("mcpServers") {
        add_servers(obj, scope, out, seen);
    }
}

/// Look up a project entry in `~/.claude.json`'s `projects` map, tolerating a
/// trailing-slash difference between our project_path and the stored key.
fn project_entry<'a>(projects: &'a serde_json::Value, p: &str) -> Option<&'a serde_json::Value> {
    if let Some(v) = projects.get(p) {
        return Some(v);
    }
    let want = p.trim_end_matches('/');
    projects.as_object()?.iter().find(|(k, _)| k.trim_end_matches('/') == want).map(|(_, v)| v)
}

/// Servers declared inside a parsed `~/.claude.json`: this project's first (so
/// they win the dedup), then any global top-level ones. Pure (no IO) for testing.
fn servers_from_claude_json(v: &serde_json::Value, project_path: Option<&str>, out: &mut Vec<McpServer>, seen: &mut BTreeSet<String>) {
    if let Some(p) = project_path {
        if let Some(obj) = v.get("projects").and_then(|x| project_entry(x, p)).and_then(|x| x.get("mcpServers")) {
            add_servers(obj, "user", out, seen);
        }
    }
    if let Some(obj) = v.get("mcpServers") {
        add_servers(obj, "user", out, seen);
    }
}

/// Servers available to `project_path`, merged across config sources in
/// precedence order (project-local first). With no project, only the user/global
/// sources apply.
pub fn mcp_servers(project_path: Option<&str>) -> Vec<McpServer> {
    let mut out: Vec<McpServer> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    if let Some(p) = project_path {
        let proj = Path::new(p);
        add_from_file(&proj.join(".mcp.json"), "project", &mut out, &mut seen);
        add_from_file(&proj.join(".claude/settings.json"), "project", &mut out, &mut seen);
        add_from_file(&proj.join(".claude/settings.local.json"), "project", &mut out, &mut seen);
    }

    if let Some(home) = home() {
        if let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                servers_from_claude_json(&v, project_path, &mut out, &mut seen);
            }
        }
        add_from_file(&home.join(".claude/settings.json"), "global", &mut out, &mut seen);
    }

    out
}

// ---- live status (claude mcp list) --------------------------------------

/// Map one server's trailing status text to a stable token the UI styles.
fn classify_status(rest: &str) -> &'static str {
    let lower = rest.to_ascii_lowercase();
    if rest.contains('✓') || lower.contains("connected") {
        "connected"
    } else if rest.contains('✗') || lower.contains("failed") {
        "failed"
    } else if rest.contains('⏸') || lower.contains("pending") {
        "pending"
    } else {
        "unknown"
    }
}

/// Parse `claude mcp list` human output into (server name, status token, raw
/// status text) triples. Each configured line looks like
/// `name: <detail> - ✓ Connected`; headers ("Checking MCP server health…"),
/// blanks, and the "No MCP servers configured" notice have no leading `name:`
/// token and are skipped. The raw text rides along so the UI can show exactly
/// what the CLI said (a stale green can't hide behind a token). Pure (no IO).
pub fn parse_mcp_list(output: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for line in output.lines() {
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim();
        // server names are identifiers (no spaces); this drops prose lines that
        // happen to contain a colon.
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue;
        }
        out.push((name.to_string(), classify_status(rest).to_string(), rest.trim().to_string()));
    }
    out
}

/// How long the health check may run before it's killed. `claude mcp list`
/// spawns/pings every configured server, so slow is normal — hung is not.
const MCP_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Run a command to completion with a deadline; on timeout the child's whole
/// PROCESS GROUP is killed (None returned). The child here is a login shell
/// that may fork — not exec — the real command (EXIT traps in a profile, or a
/// wrapper-script `claude`): killing just the shell would orphan a grandchild
/// still holding the stdout pipe, wedging the reader thread — and this fn —
/// forever. Stdout is drained on a thread so a chatty child can't deadlock on
/// a full pipe.
fn output_with_timeout(mut cmd: std::process::Command, timeout: std::time::Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group, so the timeout can kill all descendants
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return reader.join().ok(),
            Ok(None) if std::time::Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL); // the whole group
                }
                let _ = child.kill();
                let _ = child.wait();
                // detach instead of join: if some descendant escaped the group
                // and still holds the pipe, a leaked thread beats a wedged command
                drop(reader);
                return None; // partial output mid-check would misreport — say "timed out"
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(120)),
            Err(_) => return None,
        }
    }
}

/// Health-check the user's MCP servers via `claude mcp list`, run in `project_path`
/// (so project-scoped `.mcp.json` servers are included) through a login shell —
/// GUI apps lack PATH, matching the enricher's claude invocation. Read-only; it
/// never writes config. Errors (can't spawn, timed out) surface to the caller so
/// the UI can say so instead of silently showing nothing.
pub fn mcp_status(project_path: Option<&str>) -> Result<Vec<(String, String, String)>, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-c", "claude mcp list"]);
    if let Some(p) = project_path {
        cmd.current_dir(p);
    }
    let out = output_with_timeout(cmd, MCP_LIST_TIMEOUT)
        .ok_or("health check didn't finish (claude missing from PATH, or `claude mcp list` hung past 45s)")?;
    Ok(parse_mcp_list(&String::from_utf8_lossy(&out)))
}

// ---- tauri commands -----------------------------------------------------

#[tauri::command]
pub fn list_skills(project_path: Option<String>) -> Vec<Skill> {
    skills(project_path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_line_frontmatter() {
        let md = "---\nname: my-skill\ndescription: Does a thing. Use when X.\nlicense: foo\n---\nbody";
        let (name, desc) = parse_skill_frontmatter(md).unwrap();
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "Does a thing. Use when X.");
    }

    #[test]
    fn skills_picks_up_project_scoped_skill() {
        let root = std::env::temp_dir().join(format!("drydock-skills-test-{}", std::process::id()));
        let skill_dir = root.join(".claude/skills/proj-helper");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: proj-helper\ndescription: A project skill.\n---\nbody",
        )
        .unwrap();
        let got = skills(Some(root.to_str().unwrap()));
        let found = got.iter().find(|s| s.name == "proj-helper").expect("project skill listed");
        assert_eq!(found.plugin, "project");
        assert_eq!(found.description, "A project skill.");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn frontmatter_requires_leading_fence_and_name() {
        assert!(parse_skill_frontmatter("no frontmatter here").is_none());
        // present block but no name key → None
        assert!(parse_skill_frontmatter("---\ndescription: x\n---\n").is_none());
    }

    #[test]
    fn describe_stdio_joins_command_and_args() {
        let cfg = serde_json::json!({ "command": "npx", "args": ["-y", "some-mcp"], "env": { "TOKEN": "secret" } });
        assert_eq!(describe_server(&cfg), ("stdio".into(), "npx -y some-mcp".into()));
    }

    #[test]
    fn describe_http_uses_url_and_type() {
        let sse = serde_json::json!({ "type": "sse", "url": "https://mcp.example/sse", "headers": { "Authorization": "secret" } });
        assert_eq!(describe_server(&sse), ("sse".into(), "https://mcp.example/sse".into()));
        let http = serde_json::json!({ "url": "https://mcp.example" });
        assert_eq!(describe_server(&http), ("http".into(), "https://mcp.example".into()));
    }

    #[test]
    fn redacts_secret_args_and_url_userinfo() {
        let cfg = serde_json::json!({ "command": "node", "args": ["srv.js", "--api-key", "sk-secret", "--port=8080"] });
        assert_eq!(describe_server(&cfg).1, "node srv.js --api-key <redacted> --port=8080");
        let eq = serde_json::json!({ "command": "x", "args": ["--token=abc123", "--keep=me"] });
        assert_eq!(describe_server(&eq).1, "x --token=<redacted> --keep=me");
        let url = serde_json::json!({ "url": "https://user:pw@mcp.example/sse" });
        assert_eq!(describe_server(&url).1, "https://mcp.example/sse");
    }

    #[test]
    fn claude_json_project_servers_win_and_tolerate_trailing_slash() {
        let v = serde_json::json!({
            "mcpServers": { "shared": { "url": "https://global" } },
            "projects": {
                "/work/app": { "mcpServers": {
                    "proj": { "command": "npx", "args": ["-y", "p"] },
                    "shared": { "url": "https://project-override" }
                } }
            }
        });
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        servers_from_claude_json(&v, Some("/work/app/"), &mut out, &mut seen); // trailing slash tolerated
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"proj"));
        // the project's `shared` is added first, so it wins over the top-level one
        assert_eq!(out.iter().find(|s| s.name == "shared").unwrap().detail, "https://project-override");
    }

    #[test]
    fn parse_mcp_list_extracts_names_status_and_raw_text() {
        let out = "Checking MCP server health...\n\n\
            github: https://api.githubcopilot.com/mcp/ (HTTP) - ✓ Connected\n\
            sentry: npx -y @sentry/mcp-server - ✗ Failed to connect\n\
            local-fs: /usr/local/bin/fs-server (stdio) - ⏸ Pending approval\n";
        let got = parse_mcp_list(out);
        let brief: Vec<(&str, &str)> = got.iter().map(|(n, s, _)| (n.as_str(), s.as_str())).collect();
        assert_eq!(brief, vec![("github", "connected"), ("sentry", "failed"), ("local-fs", "pending")]);
        // the raw CLI text rides along for the UI tooltip
        assert_eq!(got[1].2, "npx -y @sentry/mcp-server - ✗ Failed to connect");
    }

    #[test]
    fn parse_mcp_list_skips_prose_and_empty() {
        // the no-servers notice and headers carry no `name:` identifier token
        assert!(parse_mcp_list("No MCP servers configured. Use `claude mcp add` to add a server.").is_empty());
        assert!(parse_mcp_list("Checking MCP server health...\n\n").is_empty());
        // a url-bearing detail still yields just the leading name + a status
        let got = parse_mcp_list("x: https://h:443/mcp - ✓ Connected");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].0.as_str(), got[0].1.as_str()), ("x", "connected"));
    }

    #[test]
    fn output_with_timeout_kills_a_hung_child_and_reads_a_quick_one() {
        let mut quick = std::process::Command::new("/bin/sh");
        quick.args(["-c", "printf hello"]);
        let out = output_with_timeout(quick, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(out, b"hello");

        let mut hung = std::process::Command::new("/bin/sh");
        hung.args(["-c", "sleep 30"]);
        let t0 = std::time::Instant::now();
        assert!(output_with_timeout(hung, std::time::Duration::from_millis(300)).is_none());
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "killed at the deadline, not at exit");
    }

    #[test]
    fn output_with_timeout_kills_grandchildren_holding_the_pipe() {
        // the shell forks a background grandchild that inherits stdout; killing
        // only the shell would leave the pipe open and wedge the reader forever
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        let t0 = std::time::Instant::now();
        assert!(output_with_timeout(cmd, std::time::Duration::from_millis(300)).is_none());
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "group kill reaps the grandchild too");
    }

    #[test]
    fn add_servers_first_occurrence_wins() {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let hi = serde_json::json!({ "linear": { "command": "a" } });
        let lo = serde_json::json!({ "linear": { "command": "b" }, "sentry": { "url": "https://s" } });
        add_servers(&hi, "project", &mut out, &mut seen);
        add_servers(&lo, "user", &mut out, &mut seen);
        assert_eq!(out.len(), 2);
        let linear = out.iter().find(|s| s.name == "linear").unwrap();
        assert_eq!(linear.detail, "a"); // project source kept, not overwritten by user
        assert_eq!(linear.scope, "project");
        assert_eq!(out.iter().find(|s| s.name == "sentry").unwrap().kind, "http");
    }
}
