//! Semantic session colors: sessions about similar things wear similar hues.
//!
//! A session's "topic" is the mean of its chunk embeddings (already computed
//! for semantic search). That mean is projected onto a 2D basis — the top two
//! principal components of the session-mean population — and the projection's
//! ANGLE becomes the hue: angles are circular like the hue wheel, so nearby
//! topics land on nearby colors and unrelated ones drift apart.
//!
//! The basis is fitted ONCE (first time enough sessions have embeddings) and
//! persisted in meta under `hue_basis_v1`, so existing sessions keep their
//! colors as the index grows; new sessions just project onto the same axes.
//! Sessions without embeddings keep the old id-hash color (frontend fallback).

use drydock_core::store::Store;

const META_KEY: &str = "hue_basis_v1";
/// Don't fit axes to a handful of points — the frontend hash fallback holds
/// until the population says something.
const MIN_SESSIONS_FOR_BASIS: usize = 8;
/// Per refresh tick, at most this many sessions get re-tinted (keeps the tick
/// bounded; the rest are picked up next tick).
const STALE_BATCH: i64 = 64;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Basis {
    mean: Vec<f32>,
    p1: Vec<f32>,
    p2: Vec<f32>,
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn normalize(v: &mut [f32]) -> bool {
    let n = dot(v, v).sqrt();
    if n < 1e-12 {
        return false;
    }
    for x in v.iter_mut() {
        *x /= n;
    }
    true
}

/// Top principal component of centered `data` by power iteration on the
/// implicit covariance (Xᵀ(Xv) — never materializes a d×d matrix). With
/// `ortho`, the iterate is deflated against it each step, yielding the runner-up
/// component. Deterministic start (no RNG) so refits reproduce.
fn principal(data: &[Vec<f32>], ortho: Option<&[f32]>) -> Option<Vec<f32>> {
    let d = data.first()?.len();
    let mut v: Vec<f32> = (0..d).map(|i| ((i as u32).wrapping_mul(2_654_435_761) % 997) as f32 / 997.0 - 0.5).collect();
    if let Some(o) = ortho {
        let s = dot(&v, o);
        for (x, y) in v.iter_mut().zip(o) {
            *x -= s * y;
        }
    }
    if !normalize(&mut v) {
        return None;
    }
    for _ in 0..60 {
        let mut w = vec![0.0f32; d];
        for row in data {
            let s = dot(row, &v);
            for (wi, ri) in w.iter_mut().zip(row) {
                *wi += s * ri;
            }
        }
        if let Some(o) = ortho {
            let s = dot(&w, o);
            for (x, y) in w.iter_mut().zip(o) {
                *x -= s * y;
            }
        }
        if !normalize(&mut w) {
            return None;
        }
        v = w;
    }
    Some(v)
}

impl Basis {
    /// Fit the 2D basis from session-mean embeddings.
    pub fn fit(means: &[Vec<f32>]) -> Option<Basis> {
        if means.len() < MIN_SESSIONS_FOR_BASIS {
            return None;
        }
        let d = means[0].len();
        let mut center = vec![0.0f32; d];
        for m in means {
            if m.len() != d {
                return None;
            }
            for (c, x) in center.iter_mut().zip(m) {
                *c += x;
            }
        }
        for c in &mut center {
            *c /= means.len() as f32;
        }
        let centered: Vec<Vec<f32>> = means
            .iter()
            .map(|m| m.iter().zip(&center).map(|(x, c)| x - c).collect())
            .collect();
        let p1 = principal(&centered, None)?;
        let p2 = principal(&centered, Some(&p1))?;
        Some(Basis { mean: center, p1, p2 })
    }

    /// Hue in degrees [0, 360) for one session-mean embedding.
    pub fn hue(&self, v: &[f32]) -> Option<f64> {
        if v.len() != self.mean.len() {
            return None;
        }
        let centered: Vec<f32> = v.iter().zip(&self.mean).map(|(x, c)| x - c).collect();
        let x = dot(&centered, &self.p1) as f64;
        let y = dot(&centered, &self.p2) as f64;
        if x == 0.0 && y == 0.0 {
            return None; // dead center: no direction, keep the fallback color
        }
        Some(y.atan2(x).to_degrees().rem_euclid(360.0))
    }
}

/// The persisted basis, fitting and saving it on first use once enough
/// sessions have embeddings. None until then (frontend hash fallback holds).
fn load_or_fit(store: &Store) -> Option<Basis> {
    if let Ok(Some(json)) = store.meta_get(META_KEY) {
        if let Ok(b) = serde_json::from_str::<Basis>(&json) {
            return Some(b);
        }
    }
    let means: Vec<Vec<f32>> = store
        .all_session_embedding_means()
        .ok()?
        .into_iter()
        .map(|(_, m)| m)
        .collect();
    let basis = Basis::fit(&means)?;
    if let Ok(json) = serde_json::to_string(&basis) {
        let _ = store.meta_set(META_KEY, &json);
    }
    Some(basis)
}

/// One maintenance tick: re-tint sessions whose hue is missing or whose
/// embedded-chunk population grew. Best-effort; returns how many changed.
pub fn refresh(store: &Store) -> usize {
    let stale = store.sessions_with_stale_hues(STALE_BATCH).unwrap_or_default();
    if stale.is_empty() {
        return 0;
    }
    let Some(basis) = load_or_fit(store) else { return 0 };
    let mut changed = 0;
    for sid in stale {
        let Ok(Some((mean, n))) = store.session_embedding_mean(&sid) else { continue };
        let Some(hue) = basis.hue(&mean) else { continue };
        if store.set_session_hue(&sid, hue, n).is_ok() {
            changed += 1;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use drydock_core::accumulator::SessionDelta;
    use drydock_core::chunker::Chunk;

    /// A store holding `n` sessions per cluster, with synthetic embeddings
    /// around two orthogonal directions (small dims — the math is dim-agnostic).
    fn seeded_store() -> Store {
        let mut s = Store::open_in_memory().unwrap();
        for i in 0..10 {
            let sid = format!("00000000-0000-0000-0000-0000000000{i:02}");
            let d = SessionDelta {
                session_id: Some(sid.clone()),
                project_path: Some("/Users/dev/work".into()),
                first_prompt: Some(format!("prompt {i}")),
                message_count: 1,
                ..Default::default()
            };
            s.apply_delta(&sid, &d, &[Chunk { role: "user".into(), text: format!("chunk {i}"), ts: None }]).unwrap();
        }
        // embed: sessions 0-4 cluster on axis A, 5-9 on axis B (slight per-item jitter)
        let pending = s.chunks_without_embeddings(100).unwrap();
        assert_eq!(pending.len(), 10);
        for (idx, (chunk_id, _)) in pending.iter().enumerate() {
            let j = idx as f32 * 0.01;
            let v: Vec<f32> = if idx < 5 {
                vec![1.0, j, 0.0, j, 0.0, 0.0, j, 0.0]
            } else {
                vec![0.0, j, 1.0, 0.0, j, 0.0, 0.0, j]
            };
            s.put_embedding(*chunk_id, &v).unwrap();
        }
        s
    }

    fn circ_dist(a: f64, b: f64) -> f64 {
        let d = (a - b).abs() % 360.0;
        d.min(360.0 - d)
    }

    #[test]
    fn refresh_gives_clusters_close_hues_and_separates_them() {
        let s = seeded_store();
        let n = refresh(&s);
        assert_eq!(n, 10, "every embedded session gets a hue");
        let hues: std::collections::HashMap<String, f64> = s.session_hues().unwrap().into_iter().collect();
        let hue = |i: usize| hues[&format!("00000000-0000-0000-0000-0000000000{i:02}")];
        for i in 1..5 {
            assert!(circ_dist(hue(0), hue(i)) < 30.0, "cluster A stays together: {} vs {}", hue(0), hue(i));
        }
        for i in 6..10 {
            assert!(circ_dist(hue(5), hue(i)) < 30.0, "cluster B stays together");
        }
        assert!(circ_dist(hue(0), hue(5)) > 90.0, "the clusters read as different colors: {} vs {}", hue(0), hue(5));
    }

    #[test]
    fn basis_is_persisted_and_hues_stay_stable() {
        let s = seeded_store();
        refresh(&s);
        let before: std::collections::HashMap<String, f64> = s.session_hues().unwrap().into_iter().collect();
        assert!(s.meta_get(META_KEY).unwrap().is_some(), "basis persisted");
        // a second refresh with nothing new is a no-op…
        assert_eq!(refresh(&s), 0);
        // …and existing colors never move once assigned
        let after: std::collections::HashMap<String, f64> = s.session_hues().unwrap().into_iter().collect();
        assert_eq!(before, after);
    }

    #[test]
    fn no_basis_below_population_floor() {
        assert!(Basis::fit(&vec![vec![1.0, 0.0]; 3]).is_none());
    }
}
