use crate::index::{AppDb, SessionView};
use tauri::State;

#[derive(Debug, Default, PartialEq)]
pub struct ParsedQuery {
    pub text: String,
    pub proj: Option<String>,
    pub starred: bool,
    pub live: bool,
}

pub fn parse_query(raw: &str) -> ParsedQuery {
    let mut p = ParsedQuery::default();
    let mut terms = Vec::new();
    for tok in raw.split_whitespace() {
        if let Some(v) = tok.strip_prefix("proj:") {
            p.proj = Some(v.to_lowercase());
        } else if tok == "starred:" {
            p.starred = true;
        } else if tok == "live:" {
            p.live = true;
        } else {
            terms.push(tok);
        }
    }
    p.text = terms.join(" ");
    p
}

#[derive(serde::Serialize)]
pub struct SearchResult {
    pub session: SessionView,
    pub snippet: String,
}

#[derive(serde::Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub semantic: String, // "ready" | "indexing" | "unavailable"
}

fn session_passes(s: &SessionView, p: &ParsedQuery) -> bool {
    if s.hidden {
        return false;
    }
    if let Some(proj) = &p.proj {
        if !s.project_path.to_lowercase().contains(proj) {
            return false;
        }
    }
    if p.starred && !s.starred {
        return false;
    }
    if p.live && s.live_status == "ended" {
        return false;
    }
    true
}

fn view(r: drydock_core::store::SessionRow, summary: Option<String>, name: Option<String>) -> SessionView {
    SessionView {
        summary,
        name,
        session_id: r.session_id,
        project_path: r.project_path,
        title: r.title,
        title_source: r.title_source,
        latest_recap: r.latest_recap,
        last_message_at: r.last_message_at,
        starred: r.starred,
        hidden: r.hidden,
        live_status: r.live_status,
        // search results don't join the attention state; the palette's
        // LiveIndicator falls back to the radar's busy/idle
        attention: None,
        // nor folder membership or hue — the palette doesn't render them
        folder_id: None,
        hue: None,
    }
}

/// Session ids whose user-set name matches the query — ranked FIRST, ahead of
/// the fused chunk results: chunk search can't see names (they aren't
/// transcript text), and naming a session exists precisely so it can be found
/// again by that name. Same courtesy for claude-side custom titles (/rename),
/// which are equally user-set. Snippet = the session's recap (the label would
/// just echo the result row's own title line).
fn named_matches(
    all: &[drydock_core::store::SessionRow],
    names: &std::collections::HashMap<String, String>,
    text: &str,
) -> Vec<(String, String)> {
    let needle = text.to_lowercase();
    all.iter()
        .filter_map(|r| {
            let label = names
                .get(&r.session_id)
                .cloned()
                .or_else(|| (r.title_source == "custom-title").then(|| r.title.clone()))?;
            label
                .to_lowercase()
                .contains(&needle)
                .then(|| (r.session_id.clone(), r.latest_recap.clone().unwrap_or_default()))
        })
        .collect()
}

#[tauri::command]
pub fn search(db: State<'_, AppDb>, query: String) -> Result<SearchResponse, String> {
    let p = parse_query(&query);
    // embed before taking the DB lock so other IPC commands don't queue behind inference
    let query_vec = if p.text.is_empty() { None } else { crate::embedder::imp::embed_query(&p.text) };
    let store = db.0.lock().unwrap();

    // best snippet per session, sessions ordered by fused rank
    let mut best: Vec<(String, String)> = Vec::new();
    if !p.text.is_empty() {
        let kw = store.search_keyword(&p.text, 50).map_err(|e| e.to_string())?;
        let sem = query_vec
            .as_deref()
            .map(|qv| store.search_semantic(qv, 50).unwrap_or_default())
            .unwrap_or_default();
        // reciprocal rank fusion across the two lists, then dedupe per session
        use std::collections::HashMap;
        let mut score: HashMap<i64, (f64, String, String)> = HashMap::new();
        for (i, h) in kw.iter().enumerate() {
            let e = score.entry(h.chunk_id).or_insert((0.0, h.session_id.clone(), h.snippet.clone()));
            e.0 += 1.0 / (60.0 + i as f64);
        }
        for (i, h) in sem.iter().enumerate() {
            let e = score.entry(h.chunk_id).or_insert((0.0, h.session_id.clone(), h.snippet.clone()));
            e.0 += 1.0 / (60.0 + i as f64);
        }
        let mut fused: Vec<(f64, String, String)> = score.into_values().collect();
        fused.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, sid, snippet) in fused {
            if !best.iter().any(|(s, _)| s == &sid) {
                best.push((sid, snippet));
            }
        }
    }

    let all = store.list_sessions().map_err(|e| e.to_string())?;
    let summaries: std::collections::HashMap<String, String> =
        store.card_summaries().map_err(|e| e.to_string())?.into_iter().collect();
    let names: std::collections::HashMap<String, String> =
        store.session_names().map_err(|e| e.to_string())?.into_iter().collect();
    drop(store);

    let mut results = Vec::new();
    if p.text.is_empty() {
        // filters only: recency order
        for r in all {
            let summary = summaries.get(&r.session_id).cloned();
            let name = names.get(&r.session_id).cloned();
            let s = view(r, summary, name);
            if session_passes(&s, &p) {
                results.push(SearchResult { snippet: s.latest_recap.clone().unwrap_or_default(), session: s });
            }
        }
    } else {
        // Name matches PROMOTE over their own chunk rank (rank-first promise);
        // when a named session also content-matched, its chunk snippet is more
        // informative than the recap, so carry it over.
        let named: Vec<(String, String)> = named_matches(&all, &names, &p.text)
            .into_iter()
            .map(|(sid, recap)| {
                let snip = best.iter().find(|(s, _)| s == &sid).map(|(_, sn)| sn.clone()).unwrap_or(recap);
                (sid, snip)
            })
            .collect();
        let named_ids: std::collections::HashSet<String> = named.iter().map(|(s, _)| s.clone()).collect();
        let rest = best.into_iter().filter(|(sid, _)| !named_ids.contains(sid));
        for (sid, snippet) in named.into_iter().chain(rest) {
            if let Some(r) = all.iter().find(|r| r.session_id == sid) {
                let s = view(r.clone(), summaries.get(&sid).cloned(), names.get(&sid).cloned());
                if session_passes(&s, &p) {
                    results.push(SearchResult { session: s, snippet });
                }
            }
        }
    }
    results.truncate(30);
    Ok(SearchResponse { results, semantic: crate::embedder::semantic_status().into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(sid: &str, title: &str, source: &str) -> drydock_core::store::SessionRow {
        drydock_core::store::SessionRow {
            session_id: sid.into(),
            project_path: "/Users/dev/work".into(),
            title: title.into(),
            title_source: source.into(),
            latest_recap: None,
            first_prompt: None,
            last_prompt: None,
            last_message_at: None,
            message_count: 0,
            user_message_count: 0,
            git_branch: None,
            cli_version: None,
            ai_title: None,
            custom_title: None,
            slug: None,
            starred: false,
            hidden: false,
            live_status: "ended".into(),
            live_pid: None,
        }
    }

    #[test]
    fn named_sessions_match_by_name_and_rank_first() {
        let mut r1 = row("s1", "long first prompt text", "first-prompt");
        r1.latest_recap = Some("built the release CI".into());
        let all = vec![r1, row("s2", "修复相机", "custom-title"), row("s3", "other", "recap")];
        let names: std::collections::HashMap<String, String> =
            [("s1".to_string(), "Release Pipeline".to_string())].into();

        // Drydock name matches, case-insensitive; snippet = the recap, never
        // an echo of the label
        let m = named_matches(&all, &names, "pipeline");
        assert_eq!(m, vec![("s1".to_string(), "built the release CI".to_string())]);
        // claude-side custom titles match too (CJK)
        let m = named_matches(&all, &names, "相机");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].0, "s2");
        // ordinary (non-user-set) title text is the chunk search's job — it
        // does NOT match here, even though s1's raw title contains it
        assert!(named_matches(&all, &names, "first prompt").is_empty());
        // no match → empty
        assert!(named_matches(&all, &names, "zzz").is_empty());
    }

    #[test]
    fn parses_filters_and_text() {
        let p = parse_query("proj:trading starred: camera 报告");
        assert_eq!(p.proj.as_deref(), Some("trading"));
        assert!(p.starred);
        assert!(!p.live);
        assert_eq!(p.text, "camera 报告");
    }
}
