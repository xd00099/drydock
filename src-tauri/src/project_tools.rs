//! Drydock-owned project tools, shared by supported harnesses. Vendor config
//! remains read-only; imports are explicit and launch files stay private.
use crate::capabilities::{self, McpServer, Skill};
use crate::cli::sh_single_quote;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SharedSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SharedMcp {
    pub config: Value,
    pub enabled: bool,
    pub source: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ProjectSetup {
    #[serde(default)]
    pub skills: Vec<SharedSkill>,
    #[serde(default)]
    pub servers: BTreeMap<String, SharedMcp>,
}

pub struct ProjectTools {
    dir: PathBuf,
    gate: Mutex<()>,
}
impl ProjectTools {
    pub fn new(dir: PathBuf) -> Self { Self { dir, gate: Mutex::new(()) } }
    fn path(&self, project: &str) -> Result<PathBuf, String> {
        let root = project_root(project)?;
        let key = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        Ok(self.dir.join(format!("{key}.json")))
    }
    pub fn get(&self, project: &str) -> Result<ProjectSetup, String> {
        let _gate = self.gate.lock().unwrap();
        self.read(&self.path(project)?)
    }
    fn read(&self, path: &Path) -> Result<ProjectSetup, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|_| "Drydock's shared project setup could not be read.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ProjectSetup::default()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn update(&self, project: &str, edit: impl FnOnce(&mut ProjectSetup) -> Result<(), String>) -> Result<(), String> {
        let _gate = self.gate.lock().unwrap();
        let path = self.path(project)?;
        let mut setup = self.read(&path)?;
        edit(&mut setup)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(serde_json::to_string_pretty(&setup).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn project_root(project: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(project).map_err(|_| "The project directory is unavailable.")?;
    if !path.is_dir() { return Err("Choose a project directory.".into()); }
    Ok(path.ancestors().find(|p| p.join(".git").exists()).unwrap_or(&path).to_path_buf())
}

pub fn skill_views(setup: &ProjectSetup) -> Vec<Skill> {
    setup.skills.iter().map(|s| Skill { name: s.name.clone(), description: s.description.clone(), plugin: "shared project".into(), path: s.path.clone() }).collect()
}
pub fn server_views(setup: &ProjectSetup) -> Vec<McpServer> {
    setup.servers.iter().map(|(name, s)| {
        let (kind, detail) = capabilities::describe_server(&s.config);
        McpServer { name: name.clone(), kind, detail, scope: "shared".into(), builtin: false, enabled: s.enabled, configured_enabled: true, tools: Vec::new() }
    }).collect()
}

/// Match launch precedence: shared connections override a harness's connection
/// with the same name. A shared skill already discovered locally is listed once.
pub fn merge_servers(local: Vec<McpServer>, setup: &ProjectSetup) -> Vec<McpServer> {
    let mut servers = server_views(setup);
    servers.extend(local.into_iter().filter(|s| !setup.servers.contains_key(&s.name)));
    servers
}

pub fn merge_skills(mut local: Vec<Skill>, setup: &ProjectSetup) -> Vec<Skill> {
    let mut paths: std::collections::BTreeSet<String> = local.iter().map(|s| s.path.clone()).collect();
    local.extend(skill_views(setup).into_iter().filter(|s| paths.insert(s.path.clone())));
    local
}

#[tauri::command]
pub fn project_share_skill(project_path: String, agent: String, path: String, tools: State<'_, ProjectTools>) -> Result<(), String> {
    let skills = capabilities::local_skills(Some(&project_path), &agent);
    let skill = skills.into_iter().find(|s| s.path == path).ok_or("This skill is no longer available. Reload the list.")?;
    tools.update(&project_path, |setup| {
        if setup.skills.iter().any(|s| s.name == skill.name && s.path != skill.path) {
            return Err("A different shared skill already uses this name. Remove it first.".into());
        }
        setup.skills.retain(|s| s.name != skill.name);
        setup.skills.push(SharedSkill { name: skill.name, description: skill.description, path: skill.path, source: agent });
        Ok(())
    })
}
#[tauri::command(async)]
pub fn project_share_mcp(project_path: String, agent: String, name: String, tools: State<'_, ProjectTools>) -> Result<(), String> {
    if name == crate::artifacts::SERVER_NAME { return Err("Drydock's native tools are already shared.".into()); }
    let config = capabilities::server_config(&project_path, &agent, &name)?;
    validate_server(&config)?;
    tools.update(&project_path, |setup| {
        if setup.servers.contains_key(&name) { return Err("This server is already shared with the project.".into()); }
        setup.servers.insert(name, SharedMcp { config, enabled: true, source: agent });
        Ok(())
    })
}
#[tauri::command]
pub fn project_remove_tool(project_path: String, kind: String, name: String, tools: State<'_, ProjectTools>) -> Result<(), String> {
    tools.update(&project_path, |setup| {
        match kind.as_str() {
            "skill" => setup.skills.retain(|s| s.name != name),
            "mcp" => { setup.servers.remove(&name); },
            _ => return Err("Unknown project tool kind.".into()),
        }
        Ok(())
    })
}
#[tauri::command]
pub fn project_set_mcp_enabled(project_path: String, name: String, enabled: bool, tools: State<'_, ProjectTools>) -> Result<(), String> {
    tools.update(&project_path, |setup| {
        setup.servers.get_mut(&name).ok_or("The shared server is no longer available.")?.enabled = enabled;
        Ok(())
    })
}

fn validate_server(config: &Value) -> Result<(), String> {
    if config.get("enabled_tools").is_some_and(|v| !v.is_null())
        || config.get("disabled_tools").and_then(Value::as_array).is_some_and(|v| !v.is_empty()) {
        return Err("This server has harness-specific tool restrictions. Keep it in that harness, or use a shared connection with restrictions enforced by the server.".into());
    }
    if config.get("type").and_then(Value::as_str) == Some("sse") { return Err("This server uses legacy SSE. Use a Streamable HTTP or stdio server to share it with Codex.".into()); }
    if config.get("command").and_then(Value::as_str).is_some() || config.get("url").and_then(Value::as_str).is_some() { return Ok(()); }
    Err("Only stdio and HTTP MCP servers can be shared.".into())
}

pub struct Prepared {
    pub claude: serde_json::Map<String, Value>,
    pub codex: toml::Table,
    pub env: Vec<(String, String)>,
    pub files: Vec<PathBuf>,
    pub env_script: Option<PathBuf>,
}
impl Prepared {
    pub fn new() -> Self { Self { claude: Default::default(), codex: Default::default(), env: Vec::new(), files: Vec::new(), env_script: None } }
    /// Reuse a private script for stdio servers so credentials and secret argv
    /// stay off the Codex command line. HTTP headers use unique env references.
    pub fn prepare(setup: &ProjectSetup, cwd: &str, dir: &Path, id: u32) -> Result<Self, String> {
        let mut prepared = Self::new();
        for (index, (name, server)) in setup.servers.iter().enumerate() {
            let mut config = toml::Table::new();
            let cfg = &server.config;
            validate_server(cfg)?;
            if let Some(command) = cfg.get("command").and_then(Value::as_str) {
                let mut script = String::from("#!/bin/sh\n");
                script.push_str(&format!("cd {} || exit 1\n", sh_single_quote(cwd)));
                if let Some(working) = cfg.get("cwd").and_then(Value::as_str) {
                    script.push_str(&format!("cd {} || exit 1\n", quote_config_value(working)));
                }
                if let Some(env) = cfg.get("env").and_then(Value::as_object) {
                    for (key, value) in env {
                        if !valid_env_name(key) { return Err(format!("Invalid environment name in shared server {name}.")); }
                        let value = value.as_str().ok_or("MCP environment values must be strings.")?;
                        script.push_str(&format!("export {key}={}\n", quote_config_value(value)));
                    }
                }
                script.push_str(&format!("exec {}", quote_config_value(command)));
                if let Some(args) = cfg.get("args").and_then(Value::as_array) {
                    for arg in args { script.push_str(&format!(" {}", quote_config_value(arg.as_str().ok_or("MCP arguments must be strings.")?))); }
                }
                script.push('\n');
                let path = dir.join(format!("shared-{id}-{index}.sh"));
                write_private(&path, script.as_bytes())?;
                prepared.files.push(path.clone());
                let argv = vec![Value::String(path.to_string_lossy().into_owned())];
                prepared.claude.insert(name.clone(), serde_json::json!({"command":"/bin/sh","args":argv}));
                config.insert("command".into(), toml::Value::String("/bin/sh".into()));
                config.insert("args".into(), toml::Value::Array(vec![toml::Value::String(path.to_string_lossy().into_owned())]));
            } else {
                let url = cfg.get("url").and_then(Value::as_str).ok_or("Missing MCP URL.")?;
                config.insert("url".into(), toml::Value::String(url.into()));
                let mut headers = cfg.get("http_headers").or_else(|| cfg.get("headers")).and_then(Value::as_object).cloned().unwrap_or_default();
                if let Some(vars) = cfg.get("env_http_headers").and_then(Value::as_object) {
                    for (header, var) in vars {
                        let var = var.as_str().ok_or("Invalid header environment reference.")?;
                        if !valid_env_name(var) { return Err("Invalid header environment reference.".into()); }
                        headers.insert(header.clone(), Value::String(format!("${{{var}}}")));
                    }
                }
                if let Some(var) = cfg.get("bearer_token_env_var").and_then(Value::as_str) {
                    if !valid_env_name(var) { return Err("Invalid token environment reference.".into()); }
                    headers.insert("Authorization".into(), Value::String(format!("Bearer ${{{var}}}")));
                }
                let mut env_headers = toml::Table::new();
                for (hindex, (header, value)) in headers.iter().enumerate() {
                    let var = format!("DRYDOCK_MCP_{id}_{index}_{hindex}");
                    prepared.env.push((var.clone(), value.as_str().ok_or("MCP header values must be strings.")?.to_string()));
                    env_headers.insert(header.clone(), toml::Value::String(var));
                }
                if !env_headers.is_empty() { config.insert("env_http_headers".into(), toml::Value::Table(env_headers)); }
                prepared.claude.insert(name.clone(), serde_json::json!({"type":"http","url":url,"headers":headers}));
            }
            for key in ["startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools"] {
                if let Some(value) = cfg.get(key) { if let Ok(value) = toml::Value::try_from(value) { config.insert(key.into(), value); } }
            }
            if !server.enabled { prepared.claude.remove(name); }
            config.insert("enabled".into(), toml::Value::Boolean(server.enabled));
            prepared.codex.insert(name.clone(), toml::Value::Table(config));
        }
        if !prepared.env.is_empty() {
            let path = dir.join(format!("shared-env-{id}.sh"));
            let script: String = prepared.env.iter().map(|(key, value)| format!("export {key}={}\n", quote_config_value(value))).collect();
            write_private(&path, script.as_bytes())?;
            prepared.files.push(path.clone());
            prepared.env_script = Some(path);
        }
        Ok(prepared)
    }
}
impl Drop for Prepared {
    fn drop(&mut self) { for path in &self.files { let _ = std::fs::remove_file(path); } }
}
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c == '_' || c.is_ascii_alphabetic()) && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Expand only explicit ${ENV} references. Everything else, including shell
/// syntax in literal values, stays quoted data. Expansion happens in the login
/// shell so project tools can use the same credentials as the coding agents.
fn quote_config_value(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let Some(end) = rest[start + 2..].find('}').map(|n| n + start + 2) else { break; };
        let reference = &rest[start + 2..end];
        let (name, fallback) = reference.split_once(":-").map(|(a, b)| (a, Some(b))).unwrap_or((reference, None));
        if !valid_env_name(name) { break; }
        result.push_str(&sh_single_quote(&rest[..start]));
        let suffix = match fallback {
            Some(default) => format!(":-{}", default.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`")),
            None => String::new(),
        };
        result.push_str(&format!("\"${{{name}{suffix}}}\""));
        rest = &rest[end + 1..];
    }
    result.push_str(&sh_single_quote(rest));
    result
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid launch file.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn harness_view_deduplicates_shared_skills_and_uses_shared_connection_precedence() {
        let setup = ProjectSetup {
            skills: vec![
                SharedSkill { name: "local-workflow".into(), description: "Already installed".into(), path: "/local/SKILL.md".into(), source: "claude".into() },
                SharedSkill { name: "shared-workflow".into(), description: "Shared only".into(), path: "/shared/SKILL.md".into(), source: "codex".into() },
            ],
            servers: BTreeMap::from([("notes".into(), SharedMcp { config: json!({"command":"shared-server"}), enabled: true, source: "claude".into() })]),
        };
        let skills = merge_skills(vec![Skill { name: "local-workflow".into(), description: "Local".into(), path: "/local/SKILL.md".into(), plugin: "personal".into() }], &setup);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].plugin, "personal");
        assert_eq!(skills[1].name, "shared-workflow");
        let local = McpServer { name: "notes".into(), detail: "native-server".into(), kind: "stdio".into(), scope: "codex".into(), builtin: false, enabled: false, configured_enabled: false, tools: Vec::new() };
        let servers = merge_servers(vec![local], &setup);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].detail, "shared-server");
        assert_eq!(servers[0].scope, "shared");
        assert!(servers[0].enabled);
    }

    #[test]
    fn setup_is_shared_across_subfolders_and_persists_without_vendor_edits() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let tools = ProjectTools::new(temp.path().join("data"));
        tools.update(repo.to_str().unwrap(), |setup| {
            setup.skills.push(SharedSkill { name: "workflow".into(), description: "Do work".into(), path: "/original/SKILL.md".into(), source: "claude".into() });
            setup.servers.insert("notes".into(), SharedMcp { config: json!({"command":"node","env":{"TOKEN":"secret"}}), enabled: true, source: "codex".into() });
            Ok(())
        }).unwrap();
        let setup = ProjectTools::new(temp.path().join("data")).get(repo.join("src").to_str().unwrap()).unwrap();
        assert_eq!(setup.skills[0].name, "workflow");
        assert_eq!(setup.servers["notes"].config["env"]["TOKEN"], "secret");
        assert!(!serde_json::to_string(&server_views(&setup)).unwrap().contains("secret"));
        assert!(!repo.join(".claude").exists());
        assert!(!repo.join(".codex").exists());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(tools.path(repo.to_str().unwrap()).unwrap()).unwrap().permissions().mode() & 0o077, 0);
        }
        tools.update(repo.to_str().unwrap(), |s| { s.skills.clear(); s.servers.clear(); Ok(()) }).unwrap();
        assert!(tools.get(repo.to_str().unwrap()).unwrap().servers.is_empty());
    }

    #[test]
    fn stdio_adapters_preserve_env_and_literal_arguments_and_clean_up_private_files() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("project's space");
        std::fs::create_dir(&cwd).unwrap();
        let injected = cwd.join("must-not-exist");
        let secret = format!("secret'$(touch {})", injected.display());
        let setup = ProjectSetup { skills: vec![], servers: BTreeMap::from([("node".into(), SharedMcp {
            config: json!({"command":"/bin/sh","args":["-c","printf '%s\\n' \"$API_KEY\" \"$1\" \"$PWD\"","ignored",secret],"env":{"API_KEY":"${IMPORT_TOKEN:-fallback}"}}), enabled: true, source: "claude".into()
        })]) };
        let prepared = Prepared::prepare(&setup, cwd.to_str().unwrap(), &temp.path().join("launch"), 7).unwrap();
        let script = prepared.files[0].clone();
        let output = std::process::Command::new("/bin/sh").arg(&script).env("IMPORT_TOKEN", "real-token").output().unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.starts_with("real-token\n"));
        assert!(text.contains(&secret));
        assert!(text.contains(cwd.to_str().unwrap()));
        assert!(!injected.exists());
        assert!(!toml::Value::Table(prepared.codex.clone()).to_string().contains("secret"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o077, 0);
        }
        drop(prepared);
        assert!(!script.exists());
    }

    #[test]
    fn http_adapters_use_login_environment_without_putting_headers_on_argv() {
        let temp = tempfile::tempdir().unwrap();
        let setup = ProjectSetup { skills: vec![], servers: BTreeMap::from([("remote.name".into(), SharedMcp {
            config: json!({"url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${IMPORT_TOKEN}"}}), enabled: true, source: "claude".into()
        })]) };
        let prepared = Prepared::prepare(&setup, temp.path().to_str().unwrap(), temp.path(), 8).unwrap();
        let value = toml::Value::Table(prepared.codex.clone()).to_string();
        assert!(value.contains("env_http_headers"));
        assert!(!value.contains("Bearer"));
        let script = prepared.env_script.as_ref().unwrap();
        let command = format!(". {}; printf '%s' \"$DRYDOCK_MCP_8_0_0\"", sh_single_quote(&script.to_string_lossy()));
        let output = std::process::Command::new("/bin/sh").args(["-c", &command]).env("IMPORT_TOKEN", "abc-token").output().unwrap();
        assert_eq!(output.stdout, b"Bearer abc-token");
    }

    #[test]
    fn failed_preparation_cleans_prior_files_and_legacy_sse_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let setup = ProjectSetup { skills: vec![], servers: BTreeMap::from([
            ("a".into(), SharedMcp { config: json!({"command":"node"}), enabled: true, source: "codex".into() }),
            ("b".into(), SharedMcp { config: json!({"type":"sse","url":"https://example.test/sse"}), enabled: true, source: "claude".into() })
        ]) };
        assert!(Prepared::prepare(&setup, temp.path().to_str().unwrap(), temp.path(), 1).is_err());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        assert!(validate_server(&json!({"command":"node","enabled_tools":["read"]})).is_err());
        assert!(validate_server(&json!({"command":"node","disabled_tools":["write"]})).is_err());
    }

    #[test]
    fn disabled_shared_servers_keep_a_valid_codex_transport_without_claude_injection() {
        let temp = tempfile::tempdir().unwrap();
        let setup = ProjectSetup { skills: vec![], servers: BTreeMap::from([("disabled".into(), SharedMcp {
            config: json!({"command":"node"}), enabled: false, source: "codex".into()
        })]) };
        let prepared = Prepared::prepare(&setup, temp.path().to_str().unwrap(), temp.path(), 1).unwrap();
        assert!(prepared.claude.is_empty());
        assert_eq!(prepared.codex["disabled"].get("enabled").unwrap().as_bool(), Some(false));
        assert_eq!(prepared.codex["disabled"].get("command").unwrap().as_str(), Some("/bin/sh"));
    }
}
