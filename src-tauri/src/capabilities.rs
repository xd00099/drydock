//! Read-only enumeration of harness capabilities — installed plugin skills
//! and configured MCP servers — surfaced in Drydock's right panel.
//!
//! Reads harness configuration and NEVER writes it. MCP secrets
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
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct McpServer {
    pub name: String,
    pub kind: String,   // "stdio" | "http" | "sse"
    pub detail: String, // command+args or url; env/headers never read, secrets in argv/url redacted
    pub scope: String,  // where it's configured: "project" | "user" | "global" | "drydock"
    pub builtin: bool,  // true → Drydock's own injected server (drydock-artifacts)
    pub enabled: bool,  // false → Drydock denies its tools to new sessions it launches
    pub configured_enabled: bool, // false → disabled in the harness itself
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
                out.push(Skill { name, description, plugin: plugin.to_string(), path: md.to_string_lossy().to_string() });
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

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".codex")))
}

/// Local Codex skill locations. Repository discovery stops at the Git root;
/// no Claude plugin or personal-skill directory is mixed into this catalog.
fn codex_skills_in(home: &Path, codex: &Path, project: Option<&Path>) -> Vec<Skill> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    collect_skill_dir(&home.join(".agents/skills"), "personal", &mut out, &mut seen);
    collect_skill_dir(&codex.join("skills"), "personal", &mut out, &mut seen);
    collect_skill_dir(&codex.join("skills/.system"), "system", &mut out, &mut seen);
    if let Some(project) = project {
        for ancestor in project.ancestors() {
            collect_skill_dir(&ancestor.join(".agents/skills"), "project", &mut out, &mut seen);
            if ancestor.join(".git").exists() { break; }
        }
    }
    // Only configured/enabled local plugins, not every stale cache version.
    let config = std::fs::read_to_string(codex.join("config.toml")).ok()
        .and_then(|s| toml::from_str::<toml::Value>(&s).ok());
    if let Some(plugins) = config.as_ref().and_then(|c| c.get("plugins")).and_then(toml::Value::as_table) {
        for (id, cfg) in plugins {
            if cfg.get("enabled").and_then(toml::Value::as_bool) != Some(true) { continue; }
            let Some((name, market)) = id.split_once('@') else { continue; };
            if [name, market].iter().any(|v| v.is_empty() || v.contains(['/', '\\']) || *v == "..") { continue; }
            let root = codex.join("plugins/cache").join(market).join(name);
            let mut versions: Vec<_> = std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).collect();
            versions.sort_by_cached_key(|p| p.file_name().unwrap_or_default().to_string_lossy()
                .split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse::<u64>().ok()).collect::<Vec<_>>());
            if let Some(version) = versions.last() {
                collect_skill_dir(&version.join("skills"), name, &mut out, &mut seen);
            }
        }
    }
    // Explicit local disables are part of the catalog as well as the runtime.
    if let Some(rules) = config.as_ref().and_then(|c| c.get("skills")).and_then(|s| s.get("config")).and_then(toml::Value::as_array) {
        out.retain(|skill| {
            rules.iter().filter(|r| r.get("name").and_then(toml::Value::as_str) == Some(&skill.name)
                || r.get("path").and_then(toml::Value::as_str).is_some_and(|path| Path::new(path) == Path::new(&skill.path)))
                .filter_map(|r| r.get("enabled").and_then(toml::Value::as_bool)).next_back().unwrap_or(true)
        });
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
pub(crate) fn describe_server(cfg: &serde_json::Value) -> (String, String) {
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
        out.push(McpServer { name: name.clone(), kind, detail, scope: scope.to_string(), builtin: false, enabled: true, configured_enabled: true, tools: Vec::new() });
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
/// Failure/pending markers are checked BEFORE the connected ones: since
/// 2.1.181 the CLI emits degraded lines like "! Connected · tools fetch
/// failed", which contain the word "connected" but describe an unusable
/// server — matching "connected" first painted those green.
fn classify_status(rest: &str) -> &'static str {
    let lower = rest.to_ascii_lowercase();
    if rest.contains('⏸') || lower.contains("pending") {
        "pending"
    } else if rest.contains('✗') || lower.contains("failed") || lower.contains("error") {
        "failed"
    } else if rest.contains('✓') || lower.contains("connected") {
        "connected"
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
        // classify from the STATUS segment only (after the last " - "): a
        // detail like "npx error-recovery-server" must not trip the keywords
        let status_seg = rest.rsplit_once(" - ").map(|(_, s)| s).unwrap_or(rest);
        out.push((name.to_string(), classify_status(status_seg).to_string(), rest.trim().to_string()));
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
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
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

/// Let Codex resolve its own trusted config layers. JSON contains credentials;
/// only the redacted presentation fields leave this function.
pub fn codex_mcp_servers(project_path: Option<&str>) -> Result<Vec<McpServer>, String> {
    parse_codex_servers(&codex_mcp_output(project_path)?)
}

fn codex_mcp_output(project_path: Option<&str>) -> Result<Vec<u8>, String> {
    codex_mcp_command(project_path, "codex mcp list --json")
}

fn codex_mcp_command(project_path: Option<&str>, command: &str) -> Result<Vec<u8>, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-c", command]);
    if let Some(p) = project_path { cmd.current_dir(p); }
    let out = output_with_timeout(cmd, MCP_LIST_TIMEOUT)
        .ok_or("Could not read Codex MCP configuration. Check that `codex mcp list --json` succeeds in this project.")?;
    Ok(out)
}

/// Raw transport settings stay in the backend and are imported only by an
/// explicit Share action. Authentication state itself belongs to each client.
pub fn server_config(project: &str, agent: &str, name: &str) -> Result<serde_json::Value, String> {
    if agent == "codex" {
        let command = format!("codex mcp get --json -- {}", crate::cli::sh_single_quote(name));
        let entry: serde_json::Value = serde_json::from_slice(&codex_mcp_command(Some(project), &command)?).map_err(|_| "Could not read Codex MCP configuration.")?;
        let mut config = entry.get("transport").and_then(serde_json::Value::as_object).cloned().ok_or("This Codex server is no longer configured.")?;
        for key in ["enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec"] {
            if let Some(value) = entry.get(key).filter(|v| !v.is_null()) { config.insert(key.into(), value.clone()); }
        }
        return Ok(serde_json::Value::Object(config));
    }
    if agent != "claude" { return Err("Choose Claude Code or Codex as the import source.".into()); }
    let read = |path: PathBuf| std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    for path in [".mcp.json", ".claude/settings.json", ".claude/settings.local.json"] {
        if let Some(config) = read(Path::new(project).join(path)).and_then(|v| v.get("mcpServers").and_then(|s| s.get(name)).cloned()) { return Ok(config); }
    }
    if let Some(home) = home() {
        if let Some(v) = read(home.join(".claude.json")) {
            if let Some(config) = v.get("projects").and_then(|v| project_entry(v, project)).and_then(|v| v.get("mcpServers")).and_then(|v| v.get(name)) { return Ok(config.clone()); }
            if let Some(config) = v.get("mcpServers").and_then(|v| v.get(name)) { return Ok(config.clone()); }
        }
        if let Some(config) = read(home.join(".claude/settings.json")).and_then(|v| v.get("mcpServers").and_then(|v| v.get(name)).cloned()) { return Ok(config); }
    }
    Err("This Claude Code server is no longer configured.".into())
}

fn parse_codex_servers(bytes: &[u8]) -> Result<Vec<McpServer>, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "Codex returned an unreadable MCP server list.")?;
    let list = value.as_array().ok_or("Codex returned an unreadable MCP server list.")?;
    let mut out = Vec::new();
    for entry in list {
        let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else { continue; };
        let cfg = entry.get("transport").unwrap_or(entry);
        let (kind, detail) = describe_server(cfg);
        let kind = if kind == "streamable_http" { "http".into() } else { kind };
        let enabled = entry.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
        out.push(McpServer { name: name.to_string(), kind, detail, scope: "codex".into(), builtin: false,
            enabled, configured_enabled: enabled, tools: Vec::new() });
    }
    Ok(out)
}

/// Health-check the user's MCP servers via `claude mcp list`, run in `project_path`
/// (so project-scoped `.mcp.json` servers are included) through a login shell —
/// GUI apps lack PATH, so agent commands use a login shell. Read-only; it
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
pub fn list_skills(project_path: Option<String>, agent: Option<String>, tools: tauri::State<'_, crate::project_tools::ProjectTools>) -> Result<Vec<Skill>, String> {
    let setup = project_path.as_deref().map(|p| tools.get(p)).transpose()?.unwrap_or_default();
    if agent.as_deref() == Some("shared") {
        return Ok(crate::project_tools::skill_views(&setup));
    }
    let agent = agent.as_deref().unwrap_or("claude");
    if agent != "claude" && agent != "codex" { return Ok(Vec::new()); }
    Ok(crate::project_tools::merge_skills(local_skills(project_path.as_deref(), agent), &setup))
}

pub fn local_skills(project_path: Option<&str>, agent: &str) -> Vec<Skill> {
    match agent {
        "claude" => skills(project_path),
        "codex" => match (home(), codex_home()) {
            (Some(home), Some(codex)) => codex_skills_in(&home, &codex, project_path.map(Path::new)),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_skills_use_native_paths_and_stop_at_repo_root() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex = home.join(".codex");
        let repo = temp.path().join("repo");
        let nested = repo.join("src");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        for (path, name) in [
            (home.join(".agents/skills/user"), "user"),
            (codex.join("skills/.system/system"), "system"),
            (repo.join(".agents/skills/repo"), "repo"),
            (temp.path().join(".agents/skills/outside"), "outside"),
            (repo.join(".claude/skills/claude-only"), "claude-only"),
            (codex.join("plugins/cache/market/plugin/1.9.0/skills/old"), "old"),
            (codex.join("plugins/cache/market/plugin/1.10.0/skills/new"), "new"),
        ] {
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("SKILL.md"), format!("---\nname: {name}\ndescription: Example.\n---\n")).unwrap();
        }
        std::fs::write(codex.join("config.toml"), "[plugins.\"plugin@market\"]\nenabled=true\n[[skills.config]]\nname=\"user\"\nenabled=false\n").unwrap();
        let names: Vec<_> = codex_skills_in(&home, &codex, Some(&nested)).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["new", "repo", "system"]);
    }

    #[test]
    fn codex_mcp_json_redacts_secrets_and_preserves_native_disables() {
        let servers = parse_codex_servers(br#"[
            {"name":"local","enabled":false,"transport":{"type":"stdio","command":"node","args":["server.js","--token=secret"],"env":{"SECRET":"hidden"}}},
            {"name":"remote","enabled":true,"transport":{"type":"streamable_http","url":"https://user:password@example.com/mcp","http_headers":{"Authorization":"hidden"}}}
        ]"#).unwrap();
        assert!(!servers[0].enabled);
        assert!(!servers[0].configured_enabled);
        assert_eq!(servers[0].detail, "node server.js --token=<redacted>");
        assert_eq!(servers[1].detail, "https://example.com/mcp");
        assert_eq!(servers[1].kind, "http");
        let text = serde_json::to_string(&servers).unwrap();
        for secret in ["hidden", "password", "=secret"] { assert!(!text.contains(secret)); }
        assert!(parse_codex_servers(b"not json").is_err());
    }

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
    fn status_keywords_in_the_detail_do_not_misclassify() {
        // "error"/"connected" inside the COMMAND text must not decide the dot —
        // only the segment after the last " - " is the status
        let got = parse_mcp_list("recover: npx error-recovery-server - ✓ Connected");
        assert_eq!(got[0].1, "connected");
        let got = parse_mcp_list("relay: npx connected-relay - ✗ Failed to connect");
        assert_eq!(got[0].1, "failed");
    }

    #[test]
    fn degraded_connected_lines_are_not_green() {
        // 2.1.181+: connected transport, broken tools listing — must not read
        // as healthy just because the word "Connected" appears
        let got = parse_mcp_list("broken: npx broken-server - ! Connected · tools fetch failed");
        assert_eq!(got[0].1, "failed");
        // and 2.1.154+ pending-approval phrasing without the ⏸ glyph
        let got = parse_mcp_list("newsrv: ./server.js - Pending approval (project .mcp.json)");
        assert_eq!(got[0].1, "pending");
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
