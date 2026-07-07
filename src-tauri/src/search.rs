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

fn view(r: drydock_core::store::SessionRow, summary: Option<String>) -> SessionView {
    SessionView {
        summary,
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
    drop(store);

    let mut results = Vec::new();
    if p.text.is_empty() {
        // filters only: recency order
        for r in all {
            let summary = summaries.get(&r.session_id).cloned();
            let s = view(r, summary);
            if session_passes(&s, &p) {
                results.push(SearchResult { snippet: s.latest_recap.clone().unwrap_or_default(), session: s });
            }
        }
    } else {
        for (sid, snippet) in best {
            if let Some(r) = all.iter().find(|r| r.session_id == sid) {
                let s = view(r.clone(), summaries.get(&sid).cloned());
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

    #[test]
    fn parses_filters_and_text() {
        let p = parse_query("proj:trading starred: camera 报告");
        assert_eq!(p.proj.as_deref(), Some("trading"));
        assert!(p.starred);
        assert!(!p.live);
        assert_eq!(p.text, "camera 报告");
    }
}
