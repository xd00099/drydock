//! Incremental, read-only briefing facts from Codex rollout events. Mirrored
//! response items and event messages are paired by call id, never counted twice.
use crate::transcript::FileTouch;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PlanStep {
    pub id: String,
    pub subject: String,
    pub active_form: Option<String>,
    pub status: String,
    pub blocked_by: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Briefing {
    pub available: bool,
    pub tasks: Vec<PlanStep>,
    pub updated_at: Option<i64>,
    pub files: Vec<FileTouch>,
    /// Same accounting as the shared index: uncached input, output, cache read,
    /// cache write. Reasoning is already included in output.
    pub usage: HashMap<String, [i64; 4]>,
}

#[derive(Default)]
pub struct Scan {
    offset: u64,
    tail: Vec<u8>,
    cwd: PathBuf,
    model: String,
    totals: [i64; 4],
    pending: HashMap<String, (String, Value, Option<i64>)>,
    completed: HashSet<String>,
    facts: Briefing,
}

impl Scan {
    pub fn advance(&mut self, path: &Path) -> std::io::Result<Briefing> {
        let mut file = std::fs::File::open(path)?;
        let mut reset = file.metadata()?.len() < self.offset;
        if !reset && !self.tail.is_empty() {
            file.seek(SeekFrom::Start(self.offset - self.tail.len() as u64))?;
            let mut probe = vec![0; self.tail.len()];
            file.read_exact(&mut probe)?;
            reset = probe != self.tail;
        }
        if reset { *self = Self::default(); }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let consumed = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        for line in bytes[..consumed].split(|b| *b == b'\n') {
            if let Ok(v) = serde_json::from_slice::<Value>(line) { self.consume(&v); }
        }
        self.offset += consumed as u64;
        self.tail.extend_from_slice(&bytes[..consumed]);
        if self.tail.len() > 64 { self.tail.drain(..self.tail.len() - 64); }
        self.facts.available = true;
        Ok(self.facts.clone())
    }

    fn consume(&mut self, v: &Value) {
        let p = &v["payload"];
        let ts = v["timestamp"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis());
        let kind = v["type"].as_str().unwrap_or("");
        if matches!(kind, "session_meta" | "turn_context") {
            if let Some(cwd) = p["cwd"].as_str() { self.cwd = cwd.into(); }
            if let Some(model) = p["model"].as_str() { self.model = model.into(); }
        }
        let item = p["type"].as_str().unwrap_or("");
        if kind == "event_msg" {
            match item {
                "token_count" => self.usage(&p["info"]["total_token_usage"]),
                "plan_update" => self.plan(p, ts),
                "patch_apply_end" if p["success"].as_bool() == Some(true) => {
                    let id = p["call_id"].as_str().unwrap_or("");
                    if !id.is_empty() && self.completed.insert(id.into()) {
                        self.pending.remove(id);
                        if let Some(changes) = p["changes"].as_object() {
                            // Stable order; do not let JSON map iteration alter the file tree.
                            for (path, change) in changes {
                                let action = change["type"].as_str().unwrap_or("");
                                let (adds, dels) = diff_stats(change["unified_diff"].as_str().unwrap_or(""));
                                let content_lines = change["content"].as_str().map_or(0, |s| s.lines().count() as i64);
                                let dest = change["move_path"].as_str().unwrap_or(path);
                                if dest != path { self.touch(path, false, 0, 0, ts); }
                                self.touch(dest, action == "add", if action == "add" { content_lines } else { adds }, if action == "delete" { content_lines } else { dels }, ts);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if kind != "response_item" { return; }
        let id = p["call_id"].as_str().unwrap_or("");
        if id.is_empty() { return; }
        match item {
            "function_call" | "custom_tool_call" => {
                let name = p["name"].as_str().unwrap_or("").rsplit('.').next().unwrap_or("");
                if !matches!(name, "apply_patch" | "update_plan") || self.completed.contains(id) { return; }
                let args = p.get("arguments").or_else(|| p.get("input")).cloned().unwrap_or(Value::Null);
                let args = args.as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(args);
                self.pending.insert(id.into(), (name.into(), args, ts));
            }
            "function_call_output" | "custom_tool_call_output" => {
                if let Some((name, args, when)) = self.pending.remove(id) {
                    if self.completed.contains(id) || p["is_error"].as_bool() == Some(true) || !successful(&p["output"]) { return; }
                    self.completed.insert(id.into());
                    if name == "update_plan" { self.plan(&args, when); }
                    else if let Some(patch) = args.as_str().or_else(|| args["patch"].as_str()).or_else(|| args["input"].as_str()) { self.patch(patch, when); }
                }
            }
            _ => {}
        }
    }

    fn plan(&mut self, p: &Value, ts: Option<i64>) {
        let Some(plan) = p["plan"].as_array() else { return };
        self.facts.tasks = plan.iter().take(500).enumerate().filter_map(|(i, step)| {
            let subject = step["step"].as_str()?.to_string();
            let status = step["status"].as_str()?;
            if !matches!(status, "pending" | "in_progress" | "completed") { return None; }
            Some(PlanStep { id: (i + 1).to_string(), active_form: (status == "in_progress").then(|| subject.clone()), subject, status: status.into(), blocked_by: vec![] })
        }).collect();
        self.facts.updated_at = ts;
    }

    fn usage(&mut self, usage: &Value) {
        if !usage.is_object() { return; }
        let keys = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens"];
        let totals = keys.map(|k| usage[k].as_i64().unwrap_or(0).max(0));
        // These are cumulative counters. Rate-limit notifications repeat them;
        // adding last_token_usage for every event would multiply the bill.
        let delta = std::array::from_fn::<_, 4, _>(|i| (totals[i] - self.totals[i]).max(0));
        if totals.iter().zip(self.totals).any(|(a, b)| *a < b) {
            // A reset is a new baseline, not fresh billable work.
            self.totals = totals;
            return;
        }
        self.totals = totals;
        let row = self.facts.usage.entry(if self.model.is_empty() { "Codex (model not recorded)".into() } else { self.model.clone() }).or_default();
        row[0] += delta[0].saturating_sub(delta[2]).saturating_sub(delta[3]).max(0);
        for i in 1..4 { row[i] += delta[i]; }
    }

    fn touch(&mut self, path: &str, created: bool, adds: i64, dels: i64, ts: Option<i64>) {
        let path = Path::new(path);
        let path = if path.is_absolute() { path.to_path_buf() } else if self.cwd.is_absolute() { self.cwd.join(path) } else { return };
        let path = path.to_string_lossy().into_owned();
        if let Some(file) = self.facts.files.iter_mut().find(|f| f.path == path) {
            file.edits += i64::from(!created); file.writes += i64::from(created);
            file.adds += adds; file.dels += dels; file.created |= created; file.last_ts = ts.or(file.last_ts);
        } else {
            self.facts.files.push(FileTouch { path, edits: i64::from(!created), writes: i64::from(created), adds, dels, created, last_ts: ts });
        }
    }

    fn patch(&mut self, patch: &str, ts: Option<i64>) {
        let mut current: Option<(String, bool, i64, i64)> = None;
        for line in patch.lines().chain(std::iter::once("*** End Patch")) {
            let header = ["*** Add File: ", "*** Update File: ", "*** Delete File: "].iter().find_map(|prefix| line.strip_prefix(prefix).map(|p| (p, *prefix == "*** Add File: ")));
            if header.is_some() || line == "*** End Patch" {
                if let Some((path, created, a, d)) = current.take() { self.touch(&path, created, a, d, ts); }
                current = header.map(|(p, created)| (p.into(), created, 0, 0));
            } else if let Some((path, _, adds, dels)) = current.as_mut() {
                if let Some(dest) = line.strip_prefix("*** Move to: ") { self.touch(path, false, 0, 0, ts); *path = dest.into(); }
                else if line.starts_with('+') { *adds += 1; }
                else if line.starts_with('-') { *dels += 1; }
            }
        }
    }
}

fn diff_stats(diff: &str) -> (i64, i64) {
    diff.lines().fold((0, 0), |(a, d), line| (a + i64::from(line.starts_with('+') && !line.starts_with("+++")), d + i64::from(line.starts_with('-') && !line.starts_with("---"))))
}

fn successful(output: &Value) -> bool {
    let text = output.as_str().unwrap_or("");
    let decoded = serde_json::from_str::<Value>(text).ok();
    let value = decoded.as_ref().unwrap_or(output);
    if let Some(code) = value.pointer("/metadata/exit_code").and_then(Value::as_i64) { return code == 0; }
    let text = value["output"].as_str().unwrap_or(text).trim();
    text == "Plan updated" || text.starts_with("Success. Updated the following files:")
}

// Bounded cache shared by tasks/files/usage commands; no reread of unchanged
// long sessions on every global index tick. Rewrites invalidate the scan.
static CACHE: std::sync::Mutex<Option<BTreeMap<PathBuf, Scan>>> = std::sync::Mutex::new(None);
pub fn read(path: &Path) -> std::io::Result<Briefing> {
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(BTreeMap::new);
    if cache.len() >= 64 && !cache.contains_key(path) { cache.clear(); }
    cache.entry(path.into()).or_default().advance(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(scan: &mut Scan, payload: Value) {
        scan.consume(&json!({"type":"event_msg","timestamp":"2026-11-05T10:00:00Z","payload":payload}));
    }
    fn call(scan: &mut Scan, id: &str, name: &str, input: Value) {
        scan.consume(&json!({"type":"response_item","payload":{"type":"custom_tool_call","name":name,"call_id":id,"input":input}}));
    }
    fn output(scan: &mut Scan, id: &str, text: &str) {
        scan.consume(&json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":id,"output":text}}));
    }
    fn context(scan: &mut Scan, model: &str) {
        scan.consume(&json!({"type":"turn_context","payload":{"cwd":"/workspace/project","model":model}}));
    }
    fn usage(scan: &mut Scan, input: i64, output: i64, cache: i64) {
        event(scan, json!({"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":cache,"reasoning_output_tokens":7}}}));
    }

    #[test]
    fn cumulative_usage_dedupes_rate_limits_and_attributes_model_changes() {
        let mut scan = Scan::default(); context(&mut scan, "model-a");
        usage(&mut scan, 100, 20, 40);
        usage(&mut scan, 100, 20, 40);
        event(&mut scan, json!({"type":"token_count","info":null}));
        assert_eq!(scan.facts.usage["model-a"], [60, 20, 40, 0]);
        context(&mut scan, "model-b");
        usage(&mut scan, 160, 30, 60);
        assert_eq!(scan.facts.usage["model-b"], [40, 10, 20, 0]);
        // A rewritten/reset usage baseline must not subtract already counted work.
        usage(&mut scan, 10, 2, 0);
        usage(&mut scan, 30, 7, 5);
        assert_eq!(scan.facts.usage["model-b"], [55, 15, 25, 0]);
    }

    #[test]
    fn latest_successful_plan_replaces_prior_plan_and_failed_update_is_ignored() {
        let mut scan = Scan::default();
        call(&mut scan, "p1", "functions.update_plan", json!({"plan":[{"step":"Build reader","status":"in_progress"}]}));
        assert!(scan.facts.tasks.is_empty());
        output(&mut scan, "p1", "Plan updated");
        assert_eq!(scan.facts.tasks[0].active_form.as_deref(), Some("Build reader"));
        call(&mut scan, "p2", "update_plan", json!({"plan":[]}));
        output(&mut scan, "p2", "Error: failed");
        assert_eq!(scan.facts.tasks.len(), 1);
        event(&mut scan, json!({"type":"plan_update","plan":[{"step":"Build reader","status":"completed"},{"step":"Verify","status":"in_progress"}]}));
        assert_eq!(scan.facts.tasks.len(), 2);
        assert_eq!(scan.facts.tasks[0].status, "completed");
        assert!(scan.facts.updated_at.is_some());
    }

    #[test]
    fn patch_events_and_mirrored_tool_outputs_count_once_and_skip_failures() {
        let mut scan = Scan::default(); context(&mut scan, "m");
        let patch = "*** Begin Patch\n*** Update File: src/你好.rs\n@@\n-old\n+new\n+second\n*** End Patch";
        call(&mut scan, "c1", "apply_patch", json!(patch));
        event(&mut scan, json!({"type":"patch_apply_end","call_id":"c1","success":true,"changes":{"src/你好.rs":{"type":"update","unified_diff":"--- a/src/你好.rs\n+++ b/src/你好.rs\n@@ -1 +1,2 @@\n-old\n+new\n+second","move_path":null}}}));
        output(&mut scan, "c1", "Success. Updated the following files:\nM src/你好.rs");
        call(&mut scan, "c2", "apply_patch", json!(patch));
        output(&mut scan, "c2", "apply_patch verification failed");
        assert_eq!(scan.facts.files.len(), 1);
        let f = &scan.facts.files[0];
        assert_eq!(f.path, "/workspace/project/src/你好.rs");
        assert_eq!((f.edits, f.adds, f.dels), (1, 2, 1));
    }

    #[test]
    fn older_tool_only_patches_support_create_delete_and_move() {
        let mut scan = Scan::default(); context(&mut scan, "m");
        call(&mut scan, "c", "apply_patch", json!("*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** Delete File: gone.txt\n*** End Patch"));
        output(&mut scan, "c", r#"{"output":"Success. Updated the following files:","metadata":{"exit_code":0}}"#);
        assert_eq!(scan.facts.files.len(), 4);
        assert!(scan.facts.files[0].created);
        assert_eq!(scan.facts.files[0].adds, 1);
        assert_eq!(scan.facts.files[2].path, "/workspace/project/moved.txt");
        assert_eq!((scan.facts.files[2].adds, scan.facts.files[2].dels), (1, 1));
    }

    #[test]
    fn incremental_scan_waits_for_complete_lines_and_resets_on_rewrite() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("rollout.jsonl");
        let first = json!({"type":"event_msg","payload":{"type":"plan_update","plan":[{"step":"first","status":"pending"}]}}).to_string();
        std::fs::write(&path, &first).unwrap();
        let mut scan = Scan::default();
        assert!(scan.advance(&path).unwrap().tasks.is_empty());
        std::fs::write(&path, format!("{first}\n")).unwrap();
        assert_eq!(scan.advance(&path).unwrap().tasks[0].subject, "first");
        assert_eq!(scan.advance(&path).unwrap().tasks.len(), 1);
        let changed = first.replace("first", "other");
        std::fs::write(&path, format!("{changed}\n")).unwrap();
        assert_eq!(scan.advance(&path).unwrap().tasks[0].subject, "other");
        std::fs::write(&path, "\n").unwrap();
        assert!(scan.advance(&path).unwrap().tasks.is_empty());
    }
}
